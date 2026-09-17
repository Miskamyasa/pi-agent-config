/**
 * python-eval — run inline Python with readable call and result rendering.
 *
 * Every call spawns a fresh interpreter, so no state survives between calls.
 * The code travels as one argv element (`-c`): there is no shell and no temp
 * file, so quoting and cleanup are non-issues. A missing import installs with
 * pip and retries the same code once.
 *
 * Layout: constants live in `./config.ts`, helpers in `./utils.ts`, and this
 * file only registers the tool and its lifecycle hook.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  MODULE_TO_PACKAGE,
  NO_PYTHON_HINT,
  TOOL_DESCRIPTION,
  TOOL_LABEL,
  TOOL_NAME,
  TOOL_PROMPT_GUIDELINES,
  TOOL_PROMPT_SNIPPET,
} from "./config.ts";
import {
  buildResult,
  extractMissingModule,
  installPackage,
  resolveInterpreter,
  resultText,
  runPython,
  sourceComponent,
  PythonEvalParams,
  type PythonEvalDetails,
  type RunOutcome,
} from "./utils.ts";

export default function pythonEval(pi: ExtensionAPI): void {
  // Resolve the interpreter once per extension load, so the model gets a clear
  // warning before it plans work instead of a failed call.
  pi.on("session_start", (_event, ctx) => {
    if (!resolveInterpreter() && ctx.hasUI) {
      ctx.ui.notify(NO_PYTHON_HINT, "warning");
    }
  });

  pi.registerTool(
    defineTool<typeof PythonEvalParams, PythonEvalDetails>({
      name: TOOL_NAME,
      label: TOOL_LABEL,
      description: TOOL_DESCRIPTION,
      promptSnippet: TOOL_PROMPT_SNIPPET,
      promptGuidelines: TOOL_PROMPT_GUIDELINES,
      parameters: PythonEvalParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const code = params.code;
        if (!code.trim()) throw new Error("python_eval requires non-empty 'code'.");

        const found = resolveInterpreter();
        if (!found) throw new Error(NO_PYTHON_HINT);

        const installed: string[] = [];
        let installError: string | null = null;
        const progress = onUpdate
          ? (outcome: RunOutcome): void =>
              onUpdate(buildResult(outcome, { interpreter: found, installed, installError, partial: true }))
          : undefined;

        let outcome = await runPython(found.bin, code, ctx.cwd, signal, progress);

        const aborted = signal?.aborted === true;
        const canInstall =
          !outcome.spawnError && outcome.exitCode !== 0 && !outcome.timedOut && !outcome.cancelled && !aborted;

        if (canInstall) {
          const missing = extractMissingModule(outcome.stderr) ?? extractMissingModule(outcome.stdout);
          if (missing) {
            const pkg = MODULE_TO_PACKAGE[missing] ?? missing;
            const install = await installPackage(found.bin, pkg);
            if (install.ok) {
              installed.push(install.usedBreakSystemPackages ? `${pkg} (--break-system-packages)` : pkg);
              if (!signal?.aborted) {
                outcome = await runPython(found.bin, code, ctx.cwd, signal, progress);
              }
            } else {
              installError = `'${missing}' → ${pkg}\n${install.output}`;
            }
          }
        }

        if (outcome.spawnError) {
          throw new Error(`python_eval could not start ${found.bin}: ${outcome.spawnError}`);
        }

        return buildResult(outcome, { interpreter: found, installed, installError, partial: false });
      },

      renderCall(args, theme, context) {
        return sourceComponent(args.code, theme, context.expanded, context.lastComponent);
      },

      renderResult(result, options, theme, context) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const details = result.details;
        if (!details) {
          const raw = result.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n");
          text.setText(theme.fg("toolOutput", raw));
          return text;
        }
        text.setText(resultText(details, options.expanded, theme, context.args.code));
        return text;
      },
    }),
  );
}
