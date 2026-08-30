import { spawn } from "node:child_process";
import path from "node:path";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Output caps: stop collecting at MAX_BUFFER, hand the model at most MAX_OUTPUT.
const MAX_BUFFER = 1024 * 1024;
const MAX_OUTPUT = 50 * 1024;

const PARAMETERS = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regex (or literal with literal=true) to search for." },
    path: { type: "string", description: "File or directory to search. Default: current directory." },
    glob: { type: "string", description: "Include only files matching this glob, e.g. '*.ts'." },
    fileType: { type: "string", description: "Restrict to a file type, e.g. ts, md, py." },
    ignoreCase: { type: "boolean", description: "Case-insensitive search." },
    literal: { type: "boolean", description: "Treat pattern as a fixed string (-F)." },
    pcre2: { type: "boolean", description: "Use PCRE2 for lookarounds/backreferences." },
    context: { type: "number", description: "Lines of context around matches (-C)." },
    before: { type: "number", description: "Lines before matches (-B)." },
    after: { type: "number", description: "Lines after matches (-A)." },
    maxCount: { type: "number", description: "Maximum matches per file (--max-count)." },
    filesWithMatches: { type: "boolean", description: "List only file paths with matches (-l)." },
  },
  required: ["pattern"],
} as const;

function buildArgs(params: Record<string, unknown>): string[] {
  const args = ["--color=never", "--line-number", "--hidden"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.pcre2) args.push("--pcre2");
  if (params.filesWithMatches) args.push("--files-with-matches");
  if (params.glob) args.push("--glob", String(params.glob));
  if (params.fileType) args.push("--type", String(params.fileType));
  if (params.maxCount) args.push("--max-count", String(params.maxCount));
  if (params.context) args.push("--context", String(params.context));
  if (params.before) args.push("--before", String(params.before));
  if (params.after) args.push("--after", String(params.after));
  args.push("--", String(params.pattern), String(params.path ?? "."));
  return args;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "rg",
    label: "rg",
    description:
      "Full ripgrep search: file-type filters, separate before/after context, PCRE2, per-file match caps, file lists. Respects .gitignore. Use instead of grep when you need flags the grep tool does not expose.",
    promptSnippet:
      "The rg tool runs ripgrep with full flag access (type filters, -A/-B context, PCRE2, --max-count, files-with-matches). Prefer it over grep when those flags are needed.",
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = buildArgs(params as Record<string, unknown>);
      const cwd = ctx?.cwd ?? process.cwd();
      const searchPath = path.resolve(cwd, String(params.path ?? "."));

      return await new Promise((resolve) => {
        let child;
        try {
          child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        } catch {
          resolve({
            content: [{ type: "text" as const, text: "rg is not available. Install it: brew install ripgrep (macOS) or apt install ripgrep (Linux)." }],
            details: { error: "spawn-failed" },
          });
          return;
        }

        let stdout = "";
        let stderr = "";
        let truncated = false;
        let settled = false;

        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });

        const finish = (text: string, details: Record<string, unknown>) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve({ content: [{ type: "text" as const, text }], details });
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdout.length < MAX_BUFFER) {
            stdout += chunk.toString("utf8");
          } else if (!truncated) {
            truncated = true;
            child.kill("SIGKILL");
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
          const hint =
            err.code === "ENOENT"
              ? "rg not found on PATH. Install it: brew install ripgrep (macOS) or apt install ripgrep (Linux)."
              : String(err.message);
          finish(hint, { error: err.code ?? "spawn-error" });
        });

        child.on("close", (code) => {
          // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
          if (code === 2 && stderr) {
            finish(`rg failed: ${stderr.trim()}`, { error: "rg-error" });
            return;
          }

          const matchCount = (stdout.match(/^$/gm) ?? []).length;
          let text = stdout.slice(0, MAX_OUTPUT);
          if (stdout.length > MAX_OUTPUT) {
            truncated = true;
            text = text.slice(0, text.lastIndexOf("\n", MAX_OUTPUT));
          }
          if (truncated) {
            text += `\n[Truncated at ${MAX_OUTPUT / 1024}KB]`;
          }
          if (!text.trim()) {
            text = "No matches.";
          }
          finish(text, { matchCount, truncated });
        });
      });
    },

    renderCall(args: Record<string, unknown>, theme: any, _context: any) {
      const title = theme.fg("toolTitle", theme.bold("rg"));
      const pattern = typeof args?.pattern === "string" ? args.pattern.slice(0, 80) : "...";
      const scope = typeof args?.path === "string" && args.path ? args.path : ".";
      let suffix = "";
      if (typeof args?.glob === "string" && args.glob) suffix += ` (${args.glob})`;
      if (typeof args?.fileType === "string" && args.fileType) suffix += ` (-t ${args.fileType})`;
      if (args?.context || args?.before || args?.after) suffix += " +ctx";
      return new Text(`${title} ${theme.fg("accent", `/${pattern}/`)}${theme.fg("toolOutput", ` in ${scope}${suffix}`)}`, 0, 0);
    },

    renderResult(result: { content?: Array<{ type: string; text?: string }> }, options: any, theme: any, _context: any) {
      const text = (result?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

      if (!text || text === "No matches.") {
        return new Text(theme.fg("muted", "↳ no matches"), 0, 0);
      }

      const lines = text.split("\n");
      if (options.expanded) {
        return new Text(lines.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
      }

      const PREVIEW = 6;
      const preview = lines.slice(0, PREVIEW);
      const remaining = lines.length - preview.length;
      let out = theme.fg("muted", `↳ ${lines.length} lines • ${keyHint("app.tools.expand", "to expand")}`);
      out += "\n" + preview.map((line) => theme.fg("toolOutput", line)).join("\n");
      if (remaining > 0) {
        out += theme.fg("muted", `\n... (${remaining} more lines)`);
      }
      return new Text(out, 0, 0);
    },
  });
}
