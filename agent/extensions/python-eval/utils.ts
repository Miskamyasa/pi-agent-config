/**
 * python-eval — execution, install, and rendering helpers.
 *
 * The helpers are exported so they stay testable and visible to CodeGraph.
 * `index.ts` wires them into the tool.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  DynamicBorder,
  formatSize,
  keyHint,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { Type, type Static } from "typebox";
import { findBlockedCommand } from "../shared/shell.ts";
import {
  CODE_PARAM_DESCRIPTION,
  EXECUTABLE_SUFFIX_PATTERN,
  EXPAND_HINT,
  FRAME_COLOR,
  GLYPH_FAIL,
  GLYPH_OK,
  GLYPH_RUNNING,
  INSTALL_OUTPUT_TAIL_CHARS,
  INSTALL_TIMEOUT_MS,
  INTERPRETERS,
  MAX_STREAM_BYTES,
  MODULE_TO_PACKAGE,
  NO_OUTPUT_TEXT,
  PARTIAL_UPDATE_MS,
  PREVIEW_LINES,
  PROBE_TIMEOUT_MS,
  PYTHON_COMMAND_PATTERN,
  RUN_TIMEOUT_MS,
  RUNNING_TEXT,
  SOURCE_LABEL,
  STDERR_LABEL,
  TOOL_NAME,
} from "./config.ts";

export const PythonEvalParams = Type.Object({
  code: Type.String({ description: CODE_PARAM_DESCRIPTION }),
});
export type PythonEvalInput = Static<typeof PythonEvalParams>;

export interface PythonEvalDetails {
  exitCode: number | null;
  exitSignal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Truncated stream text, ready to render. */
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Packages installed for this call. */
  installed: string[];
  installError: string | null;
  interpreter: string;
  version: string;
  /** Short lines about the run: timeout, cancellation, install, truncation. */
  notes: string[];
  /** True while the interpreter is still running (streamed updates only). */
  partial: boolean;
}

export interface Interpreter {
  bin: string;
  version: string;
}

export interface RunOutcome {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the interpreter could not be started at all. */
  spawnError: string | null;
}

interface InstallResult {
  ok: boolean;
  output: string;
  usedBreakSystemPackages: boolean;
}

let interpreter: Interpreter | null = null;
let interpreterResolved = false;

/** Probe one candidate for a working Python 3 interpreter. */
export function probeInterpreter(bin: string): Interpreter | null {
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const match = /Python (\d+\.\d+\.\d+)/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  return match ? { bin, version: match[1] } : null;
}

/** Resolve python3, then python, once per extension load. */
export function resolveInterpreter(): Interpreter | null {
  if (interpreterResolved) return interpreter;
  interpreterResolved = true;
  for (const bin of INTERPRETERS) {
    const found = probeInterpreter(bin);
    if (found) {
      interpreter = found;
      return found;
    }
  }
  return null;
}

/**
 * Return the Python executable the bash command runs, or null. python_eval
 * replaces every Python call in bash, so a match is blocked.
 */
export function findPythonCommand(command: string): string | null {
  return findBlockedCommand(command, (name) =>
    PYTHON_COMMAND_PATTERN.test(name.replace(EXECUTABLE_SUFFIX_PATTERN, "")),
  );
}

/** Pull the top-level module name out of a ModuleNotFoundError traceback. */
export function extractMissingModule(text: string): string | null {
  const match = /ModuleNotFoundError: No module named '([^']+)'/.exec(text);
  return match?.[1]?.split(".")[0] ?? null;
}

/**
 * Run one script and collect its output. Never rejects: a start failure comes
 * back as `spawnError` so the caller decides whether that is fatal.
 */
export function runPython(
  bin: string,
  code: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress?: (outcome: RunOutcome) => void,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(bin, ["-u", "-c", code], {
      cwd,
      // A process group leader lets kill() reach grandchildren too.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let spawnError: string | null = null;
    let timedOut = false;
    let cancelled = false;
    let killed = false;
    let settled = false;
    let lastProgressSize = 0;

    const snapshot = (): RunOutcome => ({
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      exitCode,
      exitSignal,
      durationMs: Date.now() - startedAt,
      timedOut,
      cancelled,
      spawnError,
    });

    const kill = (): void => {
      if (killed) return;
      killed = true;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: PROBE_TIMEOUT_MS,
        });
        return;
      }
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, RUN_TIMEOUT_MS);

    const progressTimer = setInterval(() => {
      if (settled) return;
      const size = stdoutBytes + stderrBytes;
      if (size === lastProgressSize) return;
      lastProgressSize = size;
      onProgress?.(snapshot());
    }, PARTIAL_UPDATE_MS);

    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progressTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(snapshot());
    };

    // Output past the cap is dropped, not buffered: the pipe must keep draining
    // or the child blocks on a full buffer and never exits.
    const collect = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const seen = stream === "stdout" ? stdoutBytes : stderrBytes;
      if (seen >= MAX_STREAM_BYTES) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      if (stream === "stdout") {
        stdout += chunk.toString("utf8");
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STREAM_BYTES) stdoutTruncated = true;
      } else {
        stderr += chunk.toString("utf8");
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STREAM_BYTES) stderrTruncated = true;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", (err) => {
      spawnError = err.message;
      finish();
    });
    child.on("close", (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      finish();
    });

    if (signal?.aborted) {
      cancelled = true;
      kill();
    }
  });
}

/** Run a command and merge its output. Used for pip, which must not block the TUI. */
function runCapture(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let capped = false;

    const collect = (chunk: Buffer): void => {
      if (capped) return;
      output += chunk.toString("utf8");
      if (output.length > MAX_STREAM_BYTES) {
        output = output.slice(0, MAX_STREAM_BYTES);
        capped = true;
      }
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}

let installQueue: Promise<unknown> = Promise.resolve();

/** Installs run one at a time: parallel calls must not race pip. */
export function installPackage(bin: string, pkg: string): Promise<InstallResult> {
  const task = installQueue.then(() => pipInstall(bin, pkg));
  installQueue = task.catch(() => undefined);
  return task;
}

async function pipInstall(bin: string, pkg: string): Promise<InstallResult> {
  const base = ["-m", "pip", "install"];
  const first = await runCapture(bin, [...base, pkg], INSTALL_TIMEOUT_MS);
  if (first.code === 0) {
    return { ok: true, output: tailOf(first.output), usedBreakSystemPackages: false };
  }
  // PEP 668 environments (Homebrew, Debian) refuse a plain install.
  if (first.output.includes("externally-managed-environment")) {
    const retry = await runCapture(bin, [...base, pkg, "--break-system-packages"], INSTALL_TIMEOUT_MS);
    return { ok: retry.code === 0, output: tailOf(retry.output), usedBreakSystemPackages: true };
  }
  return { ok: false, output: tailOf(first.output), usedBreakSystemPackages: false };
}

function tailOf(text: string): string {
  return text.length > INSTALL_OUTPUT_TAIL_CHARS
    ? `…${text.slice(-INSTALL_OUTPUT_TAIL_CHARS)}`
    : text;
}

export interface BuildInfo {
  interpreter: Interpreter;
  installed: string[];
  installError: string | null;
  partial: boolean;
}

/** Turn one run into the tool result: bounded text for the model, data for the UI. */
export function buildResult(
  outcome: RunOutcome,
  info: BuildInfo,
): {
  content: [{ type: "text"; text: string }];
  details: PythonEvalDetails;
} {
  const out = truncateTail(outcome.stdout, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  const err = truncateTail(outcome.stderr, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

  const notes: string[] = [];
  if (outcome.timedOut) {
    notes.push(`timed out after ${RUN_TIMEOUT_MS / 1000}s — interpreter killed`);
  } else if (outcome.cancelled) {
    notes.push("cancelled — interpreter killed");
  }
  if (info.installed.length > 0) {
    notes.push(`installed for this call: ${info.installed.join(", ")}`);
  }
  if (info.installError) {
    notes.push(`automatic install failed:\n${info.installError}`);
  }
  if (out.truncated || outcome.stdoutTruncated) {
    notes.push(`stdout truncated: ${formatSize(out.outputBytes)} of ${formatSize(out.totalBytes)} shown`);
  }
  if (err.truncated || outcome.stderrTruncated) {
    notes.push(`stderr truncated: ${formatSize(err.outputBytes)} of ${formatSize(err.totalBytes)} shown`);
  }

  const details: PythonEvalDetails = {
    exitCode: outcome.exitCode,
    exitSignal: outcome.exitSignal,
    durationMs: outcome.durationMs,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    stdout: out.content,
    stderr: err.content,
    stdoutBytes: out.totalBytes,
    stderrBytes: err.totalBytes,
    stdoutTruncated: out.truncated || outcome.stdoutTruncated,
    stderrTruncated: err.truncated || outcome.stderrTruncated,
    installed: info.installed,
    installError: info.installError,
    interpreter: info.interpreter.bin,
    version: info.interpreter.version,
    notes,
    partial: info.partial,
  };

  return { content: [{ type: "text", text: formatText(details) }], details };
}

/** The text the model reads. Status first, then stdout, then stderr. */
export function formatText(details: PythonEvalDetails): string {
  const parts: string[] = [];
  if (details.partial) parts.push(RUNNING_TEXT);
  for (const note of details.notes) parts.push(`[${note}]`);
  if (details.stdout.trim()) parts.push(details.stdout.trimEnd());
  if (details.stderr.trim()) parts.push(`${STDERR_LABEL}\n${details.stderr.trimEnd()}`);
  const failed = details.exitCode !== null && details.exitCode !== 0;
  // A timeout or cancellation is already explained by its note; the SIGKILL
  // that killed the interpreter would only repeat it.
  if (!details.timedOut && !details.cancelled && (failed || details.exitSignal)) {
    parts.push(
      `[exit code ${details.exitCode ?? "none"}${details.exitSignal ? ` signal ${details.exitSignal}` : ""}]`,
    );
  }
  if (parts.length === 0) parts.push(NO_OUTPUT_TEXT);
  return parts.join("\n");
}

/** Title line of the call slot, above the frame. */
export function sourceHeader(code: string | undefined, theme: Theme): string {
  const count = sourceLines(code).length;
  const label = `${count} line${count === 1 ? "" : "s"}`;
  return `${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("muted", label)}`;
}

/** Numbered source lines, without the title. */
export function sourceBody(code: string | undefined, theme: Theme, expanded: boolean): string {
  const lines = sourceLines(code);
  const width = String(lines.length).length;
  const style = (line: string, index: number): string =>
    theme.fg("dim", `${String(index + 1).padStart(width, " ")} │ `) + theme.fg("toolOutput", line);

  if (expanded) return lines.map(style).join("\n");

  const preview = lines.slice(0, PREVIEW_LINES);
  const rows = preview.map(style);
  if (lines.length > preview.length) {
    rows.push(theme.fg("muted", `${" ".repeat(width + 3)}… (+${lines.length - preview.length} more lines)`));
  }
  return rows.join("\n");
}

/** Title plus body, for the expanded view inside the result slot. */
export function sourceText(code: string | undefined, theme: Theme, expanded: boolean): string {
  return [sourceHeader(code, theme), sourceBody(code, theme, expanded)].join("\n");
}

/** The call slot: title, rule, numbered source, rule — framed like edit and write. */
export function sourceComponent(
  code: string | undefined,
  theme: Theme,
  expanded: boolean,
  previous: Component | undefined,
): Container {
  const container = previous instanceof Container ? previous : new Container();
  container.clear();
  container.addChild(new Text(sourceHeader(code, theme), 0, 0));
  container.addChild(rule(theme));
  container.addChild(new Text(sourceBody(code, theme, expanded), 0, 0));
  container.addChild(rule(theme));
  return container;
}

/**
 * A full-width rule. `DynamicBorder` reads a module-global theme that jiti may
 * leave undefined, so the color function is always passed explicitly.
 */
function rule(theme: Theme): DynamicBorder {
  return new DynamicBorder((text) => theme.fg(FRAME_COLOR, text));
}

function sourceLines(code: string | undefined): string[] {
  const source = (code ?? "").replace(/\n+$/, "");
  return source.length > 0 ? source.split("\n") : [""];
}

/** Part 2 of the visual feedback: the output of that call. */
export function resultText(
  details: PythonEvalDetails,
  expanded: boolean,
  theme: Theme,
  code: string | undefined,
): string {
  const rows: string[] = [statusLine(details, theme)];

  const hasStdout = details.stdout.trim().length > 0;
  const hasStderr = details.stderr.trim().length > 0;
  const stdoutLines = hasStdout ? details.stdout.trimEnd().split("\n") : [];
  const stderrLines = hasStderr ? details.stderr.trimEnd().split("\n") : [];

  if (hasStdout) rows.push(...clip(stdoutLines, expanded, theme, (line) => theme.fg("toolOutput", line)));
  if (hasStderr) {
    rows.push(theme.fg("warning", STDERR_LABEL));
    rows.push(...clip(stderrLines, expanded, theme, (line) => theme.fg("warning", line)));
  }
  if (!hasStdout && !hasStderr && !details.partial) {
    rows.push(theme.fg("muted", NO_OUTPUT_TEXT));
  }
  for (const note of details.notes) {
    rows.push(theme.fg("muted", `[${note}]`));
  }
  if (expanded && code !== undefined) {
    rows.push(theme.fg("muted", SOURCE_LABEL));
    rows.push(sourceText(code, theme, true));
  }
  return rows.join("\n");
}

function statusLine(details: PythonEvalDetails, theme: Theme): string {
  const seconds = `${(details.durationMs / 1000).toFixed(2)}s`;
  const interpreter = theme.fg("muted", `Python ${details.version}`);
  if (details.partial) {
    return `${theme.fg("warning", `${GLYPH_RUNNING} running`)} ${theme.fg("muted", seconds)} ${interpreter}`;
  }
  if (details.timedOut) {
    return `${theme.fg("error", `${GLYPH_FAIL} timed out after ${RUN_TIMEOUT_MS / 1000}s`)} ${interpreter}`;
  }
  if (details.cancelled) {
    return `${theme.fg("warning", `${GLYPH_FAIL} cancelled`)} ${theme.fg("muted", seconds)} ${interpreter}`;
  }
  if (details.exitCode === 0) {
    return `${theme.fg("success", `${GLYPH_OK} exit 0`)} ${theme.fg("muted", seconds)} ${interpreter}`;
  }
  const signal = details.exitSignal ? ` signal ${details.exitSignal}` : "";
  const failed = `${GLYPH_FAIL} exit ${details.exitCode ?? "none"}${signal}`;
  return `${theme.fg("error", failed)} ${theme.fg("muted", seconds)} ${interpreter}`;
}

function clip(
  lines: string[],
  expanded: boolean,
  theme: Theme,
  style: (line: string) => string,
): string[] {
  if (expanded || lines.length <= PREVIEW_LINES + 1) return lines.map(style);
  const hidden = lines.length - PREVIEW_LINES;
  return [
    ...lines.slice(0, PREVIEW_LINES).map(style),
    theme.fg("muted", `… (+${hidden} more lines) ${keyHint("app.tools.expand", EXPAND_HINT)}`),
  ];
}
