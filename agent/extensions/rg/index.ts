import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isToolCallEventType, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { findSearchCommand } from "./utils.ts";

// Output caps: hand the model at most MAX_OUTPUT bytes, MAX_LINE_LENGTH chars
// per line, and DEFAULT_LIMIT matches. MAX_BUFFER guards a line that never
// ends, which no newline would ever flush.
const MAX_BUFFER = 100 * 1024;
const MAX_OUTPUT = 20 * 1024;
const MAX_LINE_LENGTH = 100;
const DEFAULT_LIMIT = 100;
// A line this long means minified or generated content. Its match is dropped,
// so one bundle cannot spend the output budget.
const HARD_LINE_LENGTH = 500;

// Path prefix of a match line, absent when the search path is a single file.
const MATCH_PATH = /^(.*?):\d+:/;

// A match line is `path:NUM:text`, or `NUM:text` when the search path is a
// single file. Context lines use `-NUM-` and separators are `--`, so neither
// counts. Used in context mode only, where match and context lines mix.
const MATCH_LINE = /^(?:.*?:)?\d+:/;

const RG_MISSING_HINT =
  "rg not found on PATH. Install it: brew install ripgrep (macOS) or apt install ripgrep (Linux).";

// Set by the session_start probe. The bash grep block stays off when rg is
// missing, so content search remains possible.
let rgAvailable = false;

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
    limit: { type: "number", description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT}).` },
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
      `Full ripgrep search: file-type filters, separate before/after context, PCRE2, per-file match caps, file lists. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${MAX_OUTPUT / 1024}KB (whichever is hit first). Long lines keep their first ${MAX_LINE_LENGTH} chars, and a match on a line over ${HARD_LINE_LENGTH} chars is skipped. Use instead of grep when you need flags the grep tool does not expose.`,
    promptSnippet:
      "The rg tool runs ripgrep with full flag access (type filters, -A/-B context, PCRE2, --max-count, files-with-matches). Prefer it over grep when those flags are needed.",
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = buildArgs(params as Record<string, unknown>);
      const cwd = ctx?.cwd ?? process.cwd();
      const rawLimit = typeof params.limit === "number" ? params.limit : DEFAULT_LIMIT;
      const limit = Math.max(1, Math.floor(rawLimit));
      // Without context every printed line is a match, so counting is exact.
      const hasContext = Boolean(params.context || params.before || params.after);
      const hasAfterContext = Boolean(params.context || params.after);
      const countsEveryLine = Boolean(params.filesWithMatches) || !hasContext;

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

        const decoder = new StringDecoder("utf8");
        const lines: string[] = [];
        let pending = "";
        let outputBytes = 0;
        let matchCount = 0;
        let stderr = "";
        let truncated = false;
        let matchLimitReached = false;
        let linesTruncated = false;
        let stopRequested = false;
        let skippedMatches = 0;
        let bufferGuardHit = false;
        const skippedFiles = new Set<string>();
        let settled = false;

        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });

        const finish = (text: string, details: Record<string, unknown>) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve({ content: [{ type: "text" as const, text }], details });
        };

        // The kill is asynchronous and the pipe keeps its buffered data, so
        // the flag must stop collection before the next chunk arrives.
        const stopCollecting = () => {
          if (stopRequested) return;
          stopRequested = true;
          child.kill("SIGKILL");
        };

        const collectLine = (line: string) => {
          if (stopRequested) return;

          const isMatch = countsEveryLine || MATCH_LINE.test(line);
          // rg prints trailing context after its match line, so the last
          // admitted match keeps its context until the next group starts.
          if (matchLimitReached && (isMatch || line === "--")) {
            stopCollecting();
            return;
          }
          if (line.length > HARD_LINE_LENGTH) {
            if (isMatch) {
              skippedMatches++;
              // With -l the whole line is the path; otherwise take its prefix.
              skippedFiles.add(
                params.filesWithMatches
                  ? line
                  : (MATCH_PATH.exec(line)?.[1] ?? String(params.path ?? ".")),
              );
            }
            return;
          }

          let text = line;
          if (text.length > MAX_LINE_LENGTH) {
            text = `${text.slice(0, MAX_LINE_LENGTH)}... [truncated]`;
            linesTruncated = true;
          }

          const cost = Buffer.byteLength(text, "utf8") + (lines.length > 0 ? 1 : 0);
          if (outputBytes + cost > MAX_OUTPUT) {
            truncated = true;
            stopCollecting();
            return;
          }
          lines.push(text);
          outputBytes += cost;

          // Count only a match the caller receives, so the count matches the
          // output when the byte cap rejects the next line.
          if (isMatch) matchCount++;
          if (matchCount >= limit) {
            matchLimitReached = true;
            if (!hasAfterContext) stopCollecting();
          }
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stopRequested) return;
          pending += decoder.write(chunk);
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            collectLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (stopRequested) return;
            newline = pending.indexOf("\n");
          }
          if (Buffer.byteLength(pending, "utf8") > MAX_BUFFER) {
            // No newline ever flushes this line, so the buffer would grow
            // without bound. Account for the line, then stop.
            collectLine(pending);
            pending = "";
            bufferGuardHit = true;
            stopCollecting();
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
          const hint = err.code === "ENOENT" ? RG_MISSING_HINT : String(err.message);
          finish(hint, { error: err.code ?? "spawn-error" });
        });

        child.on("close", (code) => {
          // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
          if (code === 2 && stderr) {
            finish(`rg failed: ${stderr.trim()}`, { error: "rg-error" });
            return;
          }

          // rg output normally ends with a newline; flush a last partial line.
          pending += decoder.end();
          if (pending) collectLine(pending);

          let text = lines.join("\n");
          if (!text.trim()) {
            text = "No matches.";
          }

          const notices: string[] = [];
          if (matchLimitReached) {
            notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
          }
          if (truncated) {
            notices.push(`${MAX_OUTPUT / 1024}KB limit reached`);
          }
          if (linesTruncated) {
            notices.push(`Some lines kept only their first ${MAX_LINE_LENGTH} chars. Use the read tool to see full lines`);
          }
          if (bufferGuardHit) {
            notices.push(
              `search stopped: a line over ${MAX_BUFFER / 1024}KB (likely minified or generated). Narrow the search with glob/fileType/path`,
            );
          }
          if (skippedMatches > 0) {
            notices.push(
              `${skippedMatches} matches skipped in ${skippedFiles.size} files (likely minified or generated). Narrow the search with glob/fileType/path, or use the read tool`,
            );
          }
          if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;

          finish(text, {
            matchCount,
            truncated,
            matchLimitReached,
            linesTruncated,
            skippedMatches,
            bufferGuardHit,
          });
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

  // grep duplicates rg. Drop the builtin so the model sees one search tool
  // instead of two near-identical ones, and save its schema. Keep it when
  // ripgrep is missing: otherwise nothing can search file contents.
  pi.on("session_start", (_event, ctx) => {
    // Bounded: a hung rg on PATH must not stall session start or /reload.
    const probe = spawnSync("rg", ["--version"], { stdio: "ignore", timeout: 5_000 });
    rgAvailable = probe.status === 0;
    if (rgAvailable) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "grep"));
      return;
    }

    // hasUI is false in print mode, where a notice would go nowhere.
    const reason =
      (probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        ? RG_MISSING_HINT
        : `rg is not usable (${probe.error?.message ?? `exit code ${probe.status}`}).`;
    if (ctx.hasUI) ctx.ui.notify(`${reason} The built-in grep tool stays active.`, "warning");
  });

  // The builtin grep tool is removed above, but the model can still reach a
  // search CLI through bash. Block the grep family and rg itself, so every
  // content search goes through the rg tool and its output caps.
  pi.on("tool_call", (event) => {
    if (!rgAvailable) return undefined;
    if (!isToolCallEventType("bash", event)) return undefined;

    const search = findSearchCommand(event.input.command);
    if (!search) return undefined;

    return {
      block: true,
      reason: `Blocked: the ${search} CLI is not allowed in bash. Use the rg tool instead.`,
    };
  });
}
