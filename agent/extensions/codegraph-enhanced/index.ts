import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { Static } from "typebox";
import { Type } from "typebox";
import { getSettingsListTheme, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";

/**
 * Single source of truth for the CodeGraph settings flags. Drives registerFlag,
 * the /codegraph status display, autocomplete, the toggle subcommand, and the
 * interactive SettingsList menu. One flag today; structured so more can land
 * without touching the command surface.
 */
const FLAGS = [
  {
    name: "codegraph-auto-index",
    label: "Auto-index on startup",
    description:
      "Create the .codegraph index automatically in folders that don't have one, on every session start. Off by default. Existing indexes are always kept fresh (sync/rebuild) regardless of this flag. /codegraph init indexes the current folder on demand.",
  },
];

export const codegraphFlagNames = FLAGS.map((f) => f.name);

// ── File-backed flag persistence ─────────────────────────────────────────────
// pi's extension flags (pi.registerFlag) are in-memory only: seeded from
// `default` and CLI `--flag` args at process start. There is no setFlag on
// ExtensionAPI, and `pi config set <flag>` is not a real command (pi config
// only accepts -l/--approve/--no-approve; any positional arg throws). So flag
// settings persist in our own file at <piDir>/pi-codegraph-enhanced.json as a
// { "<flagName>": bool } map. It is read at factory load to seed each
// registerFlag default, and written through on every toggle; the subsequent
// ctx.reload() re-runs the factory, which re-seeds the defaults from disk —
// that re-seed is the apply path (the current handler keeps running in the
// pre-reload frame, so we notify first, reload last, and return). `piDir`
// resolves the same way pi does (dist/config.js getAgentDir): the env override
// wins, else ~/.pi/agent.
const FLAG_SETTINGS_FILENAME = "pi-codegraph-enhanced.json";

function getPiDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

function getFlagSettingsPath(): string {
  return path.join(getPiDir(), FLAG_SETTINGS_FILENAME);
}

/**
 * Read the persisted flag map. Missing or corrupt file → {} (flags fall back
 * to their built-in default of false).
 */
function loadFlagSettings(): Record<string, boolean> {
  try {
    const p = getFlagSettingsPath();
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge one flag value into the settings file and write it back. Creates the
 * piDir if missing. Returns true on success; false means the disk write failed
 * (permissions, read-only fs) and the caller should report an error. The next
 * loadFlagSettings() reflects the new value immediately.
 */
function saveFlagSetting(name: string, value: boolean): boolean {
  try {
    const dir = getPiDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const merged = { ...loadFlagSettings(), [name]: value };
    writeFileSync(getFlagSettingsPath(), JSON.stringify(merged, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

const StatusKey = "codegraph";

/**
 * Every result of an index refresh. The footer renders all of them, because an
 * absent entry makes "nothing to do" and "did not work" look the same.
 */
export type CodeGraphPhase =
  | { kind: "checking" }
  | { kind: "missing" }
  | { kind: "syncing" }
  | { kind: "ready"; how: "initialized" | "synced" | "rebuilt"; root: string }
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

let phase: CodeGraphPhase | undefined;
let phaseAt: number | undefined;
let lastError: string | undefined;

/** Footer text for one phase. Total by construction: every phase has text. */
export function renderPhase(current: CodeGraphPhase): string {
  switch (current.kind) {
    case "checking":
      return "🔍 CG: checking…";
    case "missing":
      return "🔍 CG: no index (/codegraph init)";
    case "syncing":
      return "🔍 CG: syncing…";
    case "ready":
      return current.how === "rebuilt" ? "🔍 CG: rebuilt" : "🔍 CG: ready";
    case "busy":
      return "🔍 CG: busy (locked)";
    case "unavailable":
      return "🔍 CG: unavailable";
    case "error":
      return "🔍 CG: failed — /codegraph for details";
  }
}

const OptionalProjectPath = Type.Optional(Type.String({
  description: "Path to a different project with .codegraph/ initialized. Defaults to current project.",
}));

const ToolKind = Type.Optional(Type.Union([
  Type.Literal("function"),
  Type.Literal("method"),
  Type.Literal("class"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("variable"),
  Type.Literal("route"),
  Type.Literal("component"),
]));

const ToolDefinitions = [
  {
    name: "codegraph_search",
    label: "CodeGraph Search",
    description: "Quick symbol search by name. Returns locations only.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name." }),
      kind: ToolKind,
      limit: Type.Optional(Type.Number({ default: 10 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find all functions or methods that call a specific symbol.",
    parameters: Type.Object({
      symbol: Type.String(),
      limit: Type.Optional(Type.Number({ default: 20 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find all functions or methods that a specific symbol calls.",
    parameters: Type.Object({
      symbol: Type.String(),
      limit: Type.Optional(Type.Number({ default: 20 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze the impact radius of changing a symbol.",
    parameters: Type.Object({
      symbol: Type.String(),
      depth: Type.Optional(Type.Number({ default: 2 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description: "Return source for several related symbols grouped by file.",
    parameters: Type.Object({
      query: Type.String({ description: "Specific symbols, files, or code terms to explore." }),
      maxFiles: Type.Optional(Type.Number({ default: 12 })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_node",
    label: "CodeGraph Node",
    description: "Get one symbol's details plus callers and callees trail.",
    parameters: Type.Object({
      symbol: Type.String(),
      includeCode: Type.Optional(Type.Boolean({ default: false })),
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Get CodeGraph index status.",
    parameters: Type.Object({
      projectPath: OptionalProjectPath,
    }),
  },
  {
    name: "codegraph_files",
    label: "CodeGraph Files",
    description: "Get project file structure from the CodeGraph index.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      pattern: Type.Optional(Type.String()),
      format: Type.Optional(Type.Union([
        Type.Literal("tree"),
        Type.Literal("flat"),
        Type.Literal("grouped"),
      ], { default: "tree" })),
      includeMetadata: Type.Optional(Type.Boolean({ default: true })),
      maxDepth: Type.Optional(Type.Number()),
      projectPath: OptionalProjectPath,
    }),
  },
] as const;

const CodegraphToolNames: readonly string[] = ToolDefinitions.map((t) => t.name);

/**
 * Loader tool for the eight codegraph tools. They stay registered but inactive,
 * so the provider only sees their schemas after the model asks for them.
 * Inactive tools cost nothing: registration alone never reaches the provider.
 */
const LoaderToolName = "codegraph_load";

type ToolName = (typeof ToolDefinitions)[number]["name"];
type ToolParams = Record<string, unknown> & { projectPath?: string };
type JsonRpcRequest = (method: string, params: Record<string, unknown>) => Promise<any>;
type PendingJsonRpcRequests = Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>;

export const MaxDiagnosticLength = 1000;
export const SessionTimeoutMs = 20_000;

/** Max wall-clock time for a startup index/init/sync command before we abort it. */
export const StartupTimeoutMs = 5 * 60_000;

/** Result of a single CLI invocation: stdout + exit code. */
export interface CodeGraphRunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True if the command was aborted by the timeout. Distinct from a real failure. */
  timedOut: boolean;
}

/**
 * Runs a codegraph CLI command in the given project.
 *
 * The AbortSignal fires on timeout; the runner MUST kill its child and resolve
 * (never reject) so the caller can distinguish a timeout from a real failure.
 * Injectable for tests.
 */
export type CodeGraphRunner = (
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<CodeGraphRunResult>;

export const defaultCodeGraphRunner: CodeGraphRunner = (args, cwd, signal) =>
  new Promise((resolve) => {
    // stdout is captured only for callers that ask for JSON; the index commands
    // emit progress we never read, so dropping it avoids unbounded buffering.
    const captureStdout = args.includes("--json");
    const stdio: ("pipe" | "ignore")[] = ["ignore", captureStdout ? "pipe" : "ignore", "pipe"];
    const child = spawnCodeGraphProcess(args, cwd, stdio);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    if (child.stdout) child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    if (child.stderr) child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const finish = (code: number, timedOut: boolean): void =>
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code: timedOut ? -1 : code,
        timedOut,
      });

    const onAbort = (): void => {
      if (!child.killed) child.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: String(err),
        code: -1,
        timedOut: signal.aborted,
      });
    });
    child.on("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      finish(code ?? -1, signal.aborted);
    });
  });

const LockFailureMarker = "could not acquire file lock";

function looksLikeLockFailure(result: CodeGraphRunResult): boolean {
  return result.code !== 0 && result.stderr.toLowerCase().includes(LockFailureMarker);
}

/**
 * The fields of `codegraph status --json` that this extension reads.
 * `projectPath` is the resolved index root, which can be an ancestor of the
 * directory the CLI ran in.
 */
interface CodeGraphStatus {
  initialized?: boolean;
  projectPath?: string;
}

function parseStatusJson(stdout: string): CodeGraphStatus | undefined {
  try {
    return JSON.parse(stdout) as CodeGraphStatus;
  } catch {
    return undefined;
  }
}

/**
 * Brings the CodeGraph index for the tree containing `projectPath` into a known
 * state.
 *
 * CodeGraph resolves the nearest ancestor `.codegraph`, so the index root can be
 * above `projectPath`. `codegraph status --json` reports both facts needed here:
 * `initialized` and `projectPath` (the resolved root). This is why there is no
 * directory check and no separate liveness probe: a CLI that cannot run shows up
 * as `code === -1 && !timedOut`.
 *
 * Branches:
 *  - status could not run                   → unavailable
 *  - no index in the tree, creation allowed → `codegraph init -i` → ready
 *  - no index in the tree, creation denied  → missing
 *  - index found, another process owns it   → busy
 *  - index found, sync succeeds             → ready
 *  - index found, sync fails (corrupt DB)   → one `codegraph index -f` → ready, else error
 *
 * `allowInit` is false for the startup gate when `codegraph-auto-index` is off
 * and for `/codegraph sync`, which never creates an index. `onPhase` reports the
 * in-flight `syncing` phase so the footer can show work in progress.
 *
 * Throws only on a runner exception; the caller swallows it. Never blocks the
 * agent — the watcher inside `codegraph serve --mcp` is the live safety net for
 * in-session edits.
 */
export async function refreshIndex(
  projectPath: string,
  allowInit: boolean,
  runner: CodeGraphRunner = defaultCodeGraphRunner,
  onPhase?: (next: CodeGraphPhase) => void,
): Promise<CodeGraphPhase> {
  const statusRun = await runWithTimeout(runner, ["status", "--json"], projectPath, "status");
  if (statusRun.timedOut) return { kind: "error", message: "status timed out" };
  if (looksLikeLockFailure(statusRun)) return { kind: "busy" };
  // A process that never started resolves with code -1 and no timeout; a real
  // CLI failure exits with a normal non-zero code.
  if (statusRun.code === -1) return { kind: "unavailable" };
  if (statusRun.code !== 0) return { kind: "error", message: cliFailure(statusRun) };

  const status = parseStatusJson(statusRun.stdout);
  if (status === undefined) return { kind: "error", message: "unreadable status output" };

  const root = status.projectPath ?? projectPath;

  if (status.initialized !== true) {
    if (!allowInit) return { kind: "missing" };
    onPhase?.({ kind: "syncing" });
    const init = await runWithTimeout(runner, ["init", "-i"], root, "init");
    if (init.timedOut) return { kind: "error", message: "init timed out" };
    // init racing another process (e.g. a /reload) loses the lock — let that one win.
    if (looksLikeLockFailure(init)) return { kind: "busy" };
    return init.code === 0
      ? { kind: "ready", how: "initialized", root }
      : { kind: "error", message: cliFailure(init) };
  }

  onPhase?.({ kind: "syncing" });

  // Sync the resolved root, not the directory the CLI ran in.
  const sync = await runWithTimeout(runner, ["sync", "-q"], root, "sync");
  if (sync.timedOut) return { kind: "error", message: "sync timed out" };
  if (looksLikeLockFailure(sync)) return { kind: "busy" };
  if (sync.code === 0) return { kind: "ready", how: "synced", root };

  // A non-zero sync means the index itself is unusable (uninitialized or
  // corrupt store). One forced rebuild is the recovery; a second failure is
  // reported instead of retried.
  const rebuild = await runWithTimeout(runner, ["index", "-f", "-q"], root, "index");
  if (rebuild.timedOut) return { kind: "error", message: "rebuild timed out" };
  if (looksLikeLockFailure(rebuild)) return { kind: "busy" };
  return rebuild.code === 0
    ? { kind: "ready", how: "rebuilt", root }
    : { kind: "error", message: cliFailure(rebuild) };
}

/** Redacted CLI diagnostic, or the exit code when the CLI printed nothing. */
function cliFailure(result: CodeGraphRunResult): string {
  const diagnostic = sanitizeDiagnostic(result.stderr.trim());
  return diagnostic || `exit ${result.code}`;
}

/**
 * Dedups overlapping refreshIndex calls against the same project within one
 * module instance. pi re-imports the extension module on /reload
 * (`createJiti({ moduleCache: false })` in the loader), so this guard only
 * covers a rapid double-fire within a single session — cross-reload overlap is
 * backstopped by codegraph's own .lock file (handled as `busy`).
 */
const inFlight = new Map<string, Promise<CodeGraphPhase>>();

export function refreshIndexOnce(
  projectPath: string,
  allowInit: boolean,
  runner: CodeGraphRunner = defaultCodeGraphRunner,
  onPhase?: (next: CodeGraphPhase) => void,
): Promise<CodeGraphPhase> {
  const existing = inFlight.get(projectPath);
  if (existing) return existing;
  const p = refreshIndex(projectPath, allowInit, runner, onPhase).finally(() => {
    if (inFlight.get(projectPath) === p) inFlight.delete(projectPath);
  });
  inFlight.set(projectPath, p);
  return p;
}

async function runWithTimeout(
  runner: CodeGraphRunner,
  args: string[],
  cwd: string,
  label: string,
  timeoutMs: number = StartupTimeoutMs,
): Promise<CodeGraphRunResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await runner(args, cwd, ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

export const codegraphToolNames = ToolDefinitions.map((tool) => tool.name);

function windowsCodeGraphLaunchScript(codegraphArgs: string[]): string {
  // Render the codegraph invocation as PowerShell-safe quoted tokens.
  const invocation = codegraphArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(" ");
  return [
    "& {",
    "$ErrorActionPreference = 'Stop';",
    "$cmd = Get-Command codegraph -CommandType Application -ErrorAction Stop | Select-Object -First 1;",
    "if (-not $cmd) { throw 'codegraph command not found'; }",
    `& $cmd.Source ${invocation};`,
    "exit $LASTEXITCODE;",
    "}",
  ].join(" ");
}

/**
 * Spawns `codegraph <args>` in `cwd`, platform-aware. On Windows, Node's direct
 * spawn can miss npm/Scoop command shims, so we route through PowerShell
 * Get-Command discovery (same path the MCP launcher uses). Shared by the MCP
 * server launcher and the startup CLI runner so Windows shim handling lives in
 * exactly one place.
 */
function spawnCodeGraphProcess(
  args: string[],
  cwd: string,
  stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe"],
): ChildProcess {
  if (process.platform !== "win32") {
    return spawn("codegraph", args, { cwd, env: process.env, stdio });
  }

  return spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    windowsCodeGraphLaunchScript(args),
  ], {
    cwd,
    env: process.env,
    stdio,
    windowsHide: true,
  });
}

function spawnCodeGraphServer(cwd: string): ChildProcessWithoutNullStreams {
  // Server always uses full-pipe stdio, so the streams are non-null.
  return spawnCodeGraphProcess(["serve", "--mcp", "--path", cwd], cwd) as ChildProcessWithoutNullStreams;
}

export async function withCodeGraphMcp<T>(
  projectPath: string | undefined,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  const cwd = await resolveProjectCwd(projectPath);
  const child = spawnCodeGraphServer(cwd);

  const session = runJsonRpcSession(child, cwd, signal, fn);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbortClearTimer = () => clearTimeout(timer);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!child.killed) child.kill();
      reject(new Error(
        "CodeGraph MCP session timed out after " + SessionTimeoutMs + "ms. " +
        'Try running "codegraph unlock" in the project directory, then restart pi.'
      ));
    }, SessionTimeoutMs);
    signal?.addEventListener("abort", onAbortClearTimer, { once: true });
  });

  session.catch(() => {});
  timeout.catch(() => {});
  return Promise.race([session, timeout]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbortClearTimer);
  });
}

export function normalizeWindowsPath(inputPath: string): string {
  let normalized = inputPath.trim();

  if (process.platform !== "win32") return normalized;

  const wslMatch = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (wslMatch) {
    normalized = wslMatch[1].toUpperCase() + ":\\" + wslMatch[2].replace(/\//g, "\\");
  }

  const gitBashMatch = normalized.match(/^\/([a-zA-Z])\/(.*)$/);
  if (gitBashMatch) {
    normalized = gitBashMatch[1].toUpperCase() + ":\\" + gitBashMatch[2].replace(/\//g, "\\");
  }

  return normalized;
}

export async function resolveProjectCwd(projectPath: string | undefined): Promise<string> {
  const cwd = normalizeWindowsPath(projectPath || process.cwd());

  if (!path.isAbsolute(cwd)) {
    throw new Error("CodeGraph projectPath must be an absolute path.");
  }

  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error("CodeGraph projectPath does not exist or is not accessible.");
  }

  if (!info.isDirectory()) {
    throw new Error("CodeGraph projectPath must point to a directory.");
  }

  return cwd;
}

export function normalizeFilesPath(inputPath?: string, projectCwd?: string): string | undefined {
  if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;

  const trimmed = inputPath.trim();
  let expanded = trimmed;
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  if (projectCwd && path.isAbsolute(expanded)) {
    const relative = path.relative(projectCwd, expanded);
    if (relative === "") return undefined;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }

  return trimmed.split(path.sep).join("/");
}

const EmptyFilesMarker = "No files found matching the criteria.";

export function annotateFilesResult(resultText: string, originalPath?: string): string {
  if (!originalPath || !resultText.includes(EmptyFilesMarker)) return resultText;

  return `${resultText}\n\nHint: codegraph_files interprets "path" as a root-relative POSIX prefix (e.g. "src/components"). The filter "${originalPath}" did not match any indexed path.`;
}

export function sanitizeDiagnostic(value: string): string {
  const withoutAnsi = value.replace(/\u001b\[[0-9;]*m/g, "");
  const redacted = withoutAnsi
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|AUTH)[A-Z0-9_]*=)\S+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/--(?:token|secret|password|api-key|apikey|otp)(?:=|\s+)\S+/gi, "--[redacted]");

  return redacted.length > MaxDiagnosticLength
    ? `${redacted.slice(0, MaxDiagnosticLength)}...`
    : redacted;
}

async function runJsonRpcSession<T>(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  signal: AbortSignal | undefined,
  fn: (request: JsonRpcRequest) => Promise<T>,
): Promise<T> {
  const pending: PendingJsonRpcRequests = new Map();
  const stderr = { value: "" };
  const cleanup = () => cleanupJsonRpcChild(child, pending);
  const onAbort = () => cleanup();

  signal?.addEventListener("abort", onAbort, { once: true });
  attachJsonRpcHandlers(child, pending, stderr);

  try {
    const sendRequest = createJsonRpcRequestSender(child, pending);
    await initializeJsonRpcSession(cwd, sendRequest, sendJsonRpcNotification.bind(undefined, child));
    return await fn(sendRequest);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cleanup();
  }
}

function cleanupJsonRpcChild(
  child: ChildProcessWithoutNullStreams,
  pending: PendingJsonRpcRequests,
): void {
  rejectPendingJsonRpcRequests(
    pending,
    new Error("CodeGraph MCP process closed before responding."),
  );
  if (!child.killed) child.kill();
}

function rejectPendingJsonRpcRequests(
  pending: PendingJsonRpcRequests,
  error: Error,
): void {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function attachJsonRpcHandlers(
  child: ChildProcessWithoutNullStreams,
  pending: PendingJsonRpcRequests,
  stderr: { value: string },
): void {
  const stdout = { value: "" };

  child.stdout.on("data", (chunk) => {
    handleJsonRpcStdout(chunk, stdout, pending);
  });
  child.stderr.on("data", (chunk) => {
    stderr.value += chunk.toString("utf-8");
  });
  child.on("error", (err) => rejectPendingJsonRpcRequests(pending, err));
  child.on("exit", (code) => rejectPendingJsonRpcOnExit(pending, stderr.value, code));
}

function handleJsonRpcStdout(
  chunk: Buffer,
  stdout: { value: string },
  pending: PendingJsonRpcRequests,
): void {
  stdout.value += chunk.toString("utf-8");
  let newline;
  while ((newline = stdout.value.indexOf("\n")) !== -1) {
    const line = stdout.value.slice(0, newline).trim();
    stdout.value = stdout.value.slice(newline + 1);
    if (line) resolveJsonRpcLine(line, pending);
  }
}

function resolveJsonRpcLine(line: string, pending: PendingJsonRpcRequests): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id === undefined || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id)!;
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
  else resolve(msg.result);
}

function rejectPendingJsonRpcOnExit(
  pending: PendingJsonRpcRequests,
  stderr: string,
  code: number | null,
): void {
  if (pending.size === 0) return;
  const diagnostic = sanitizeDiagnostic(stderr.trim());
  const msg = diagnostic || `CodeGraph MCP process exited with code ${code}`;
  rejectPendingJsonRpcRequests(pending, new Error(msg));
}

function createJsonRpcRequestSender(
  child: ChildProcessWithoutNullStreams,
  pending: PendingJsonRpcRequests,
): JsonRpcRequest {
  let nextId = 1;
  return (method, params) => {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  };
}

function sendJsonRpcNotification(
  child: ChildProcessWithoutNullStreams,
  method: string,
  params: Record<string, unknown>,
): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function initializeJsonRpcSession(
  cwd: string,
  sendRequest: JsonRpcRequest,
  sendNotification: (method: string, params: Record<string, unknown>) => void,
): Promise<void> {
  const rootUri = pathToFileURL(cwd).href;
  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: cwd.split(/[\\/]/).pop() || cwd }],
    capabilities: {},
    clientInfo: { name: "pi-codegraph", version: "0.1.0" },
  });
  sendNotification("initialized", {});
}

async function prepareToolArguments(
  name: ToolName,
  params: ToolParams,
): Promise<{ args: ToolParams; originalFilesPath?: string }> {
  if (name !== "codegraph_files") return { args: params };

  const projectPath = typeof params.projectPath === "string" ? params.projectPath : undefined;
  const projectCwd = await resolveProjectCwd(projectPath);
  const originalFilesPath = typeof params.path === "string" ? params.path : undefined;
  const normalizedPath = normalizeFilesPath(originalFilesPath, projectCwd);

  const args: ToolParams = { ...params };
  if (normalizedPath === undefined) {
    delete args.path;
  } else {
    args.path = normalizedPath;
  }

  return { args, originalFilesPath };
}

export async function callCodeGraphTool(
  name: ToolName,
  params: ToolParams,
  signal?: AbortSignal,
): Promise<string> {
  const { args, originalFilesPath } = await prepareToolArguments(name, params);

  const result = await withCodeGraphMcp(
    typeof args.projectPath === "string" ? args.projectPath : undefined,
    signal,
    (request) =>
      request("tools/call", {
        name,
        arguments: args,
      }),
  );

  const text = (result?.content || [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");

  if (result?.isError) throw new Error(text || "CodeGraph tool failed.");
  const finalText = text || JSON.stringify(result);
  return name === "codegraph_files" ? annotateFilesResult(finalText, originalFilesPath) : finalText;
}

/** A TUI glitch must never reject a fire-and-forget chain. */
function safeUi(fn: () => void): void {
  try {
    fn();
  } catch {
    /* swallow */
  }
}

/** The only writer of the footer status key. */
function publish(ctx: ExtensionContext, next: CodeGraphPhase): void {
  phase = next;
  phaseAt = Date.now();
  if (next.kind === "error") lastError = next.message;
  if (!ctx.hasUI) return;
  safeUi(() => ctx.ui.setStatus(StatusKey, renderPhase(next)));
}

/**
 * Notifies only the phases that need attention. `checking`, `syncing` and
 * `ready` are carried by the footer, so they stay silent.
 */
function notifyPhase(
  ctx: ExtensionContext,
  result: CodeGraphPhase,
  projectPath: string,
  mode: "auto" | "manual",
): void {
  if (!ctx.hasUI) return;
  safeUi(() => {
    switch (result.kind) {
      case "missing":
        if (mode === "manual") {
          ctx.ui.notify(
            `No .codegraph index in ${projectPath}. Run /codegraph init first.`,
            "warning",
          );
        }
        break;
      case "unavailable":
        ctx.ui.notify(
          "CodeGraph unavailable. Install the CLI and ensure it is on PATH (`npm i -g @colbymchenry/codegraph`).",
          "warning",
        );
        break;
      case "busy":
        ctx.ui.notify(
          `CodeGraph: index busy (${projectPath}). Run \`codegraph unlock\` if stuck.`,
          "info",
        );
        break;
      case "error":
        ctx.ui.notify(`CodeGraph: ${result.message} (${projectPath})`, "error");
        break;
      default:
        break;
    }
  });
}

/**
 * Adds or removes `codegraph_load`. Inactive tools cost nothing: registration
 * alone never reaches the provider. A no-op state change is skipped, so one
 * refresh does not rebuild the system prompt on every phase.
 */
let loaderActive: boolean | undefined;

function applyLoader(pi: ExtensionAPI, active: boolean): void {
  if (loaderActive === active) return;
  loaderActive = active;
  const base = pi.getActiveTools().filter(
    (name) => name !== LoaderToolName && !CodegraphToolNames.includes(name),
  );
  pi.setActiveTools(active ? [...base, LoaderToolName] : base);
}

/**
 * Runs one index refresh and publishes every phase it passes through. Used by
 * the startup gate and by `/codegraph init` / `/codegraph sync`; the only
 * differences are `allowInit` and the notification set. Fire-and-forget: index
 * maintenance must never block a turn.
 *
 * Tool availability follows the same phases, so the loader reflects the resolved
 * index state instead of a second, separate directory check. A folder without an
 * index pays zero codegraph tokens; the auto-index flag predicts that an index
 * is about to exist, so the loader stays available there too.
 */
function startIndexRefresh(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  projectPath: string,
  allowInit: boolean,
  mode: "auto" | "manual",
): void {
  const apply = (next: CodeGraphPhase): void => {
    publish(ctx, next);
    applyLoader(pi, next.kind === "ready" || allowInit);
  };
  apply({ kind: "checking" });
  refreshIndexOnce(projectPath, allowInit, defaultCodeGraphRunner, apply)
    .then((result) => {
      apply(result);
      notifyPhase(ctx, result, projectPath, mode);
    })
    .catch(() => {
      // Never leave a stale in-flight status, and never re-throw out of .catch
      // (would be an unhandled rejection).
      apply({ kind: "error", message: "refresh failed" });
      if (!ctx.hasUI) return;
      safeUi(() => ctx.ui.notify(`CodeGraph: refresh failed (${projectPath})`, "error"));
    });
}

/** Builds the read-only /codegraph status panel: every flag + the current phase. */
export function renderCodeGraphStatus(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const flagLines = FLAGS.map(
    (f) => `  ${pi.getFlag(f.name) === false ? "[ ]" : "[x]"} ${f.name}  — ${f.description}`,
  );
  const projectPath = ctx.cwd ?? process.cwd();
  const state = phase
    ? `${renderPhase(phase)}${phaseAt === undefined ? "" : ` (${new Date(phaseAt).toLocaleTimeString()})`}`
    : "not checked yet this session";
  return [
    "CodeGraph settings",
    "",
    "flags:",
    ...flagLines,
    "",
    `status:  ${state}`,
    `cwd:     ${projectPath}`,
    ...(phase?.kind === "ready" ? [`index:   ${phase.root}`] : []),
    ...(lastError === undefined ? [] : [`error:   ${lastError}`]),
    "",
    "toggle: /codegraph toggle <flag>   (shorthand: /codegraph <flag>)",
    "init:   /codegraph init            (index this folder now, ignoring the flag)",
    "sync:   /codegraph sync            (refresh the existing index from source now)",
  ].join("\n");
}

/**
 * `/codegraph init` — indexes the current folder now, ignoring the
 * codegraph-auto-index flag. Used when the flag is off (the default) but the
 * user wants this folder indexed on demand.
 */
export function runManualInit(pi: ExtensionAPI, ctx: ExtensionContext): void {
  startIndexRefresh(pi, ctx, ctx.cwd ?? process.cwd(), true, "manual");
}

/**
 * `/codegraph sync` — refreshes the existing `.codegraph/` index in `cwd`
 * against the current source tree, on demand. Never creates an index: a folder
 * without one is reported as `missing` with a hint to run `/codegraph init`.
 */
export function runManualSync(pi: ExtensionAPI, ctx: ExtensionContext): void {
  startIndexRefresh(pi, ctx, ctx.cwd ?? process.cwd(), false, "manual");
}

export default function codegraphExtension(pi: ExtensionAPI): void {
  // Register flags at factory load time, NOT inside a session hook.
  // registerFlag is static setup; calling it per session would clobber user
  // preferences on every /new or /reload. The default is seeded from the
  // persisted flag settings file (if present) so toggles survive restarts;
  // otherwise the built-in default of false applies.
  const flagSettings = loadFlagSettings();
  for (const f of FLAGS) {
    const persisted = flagSettings[f.name];
    pi.registerFlag(f.name, {
      description: f.description,
      type: "boolean",
      default: typeof persisted === "boolean" ? persisted : false,
    });
  }

  pi.on("resources_discover", (event, ctx) => {
    // Opt-in creation, always-on maintenance. The codegraph-auto-index flag
    // (default false) gates only CREATING an index in a folder that has none; an
    // existing index is always refreshed. Every outcome is published, so the
    // footer never leaves the user guessing whether CodeGraph ran.
    startIndexRefresh(pi, ctx, event.cwd, pi.getFlag(FLAGS[0].name) === true, "auto");
  });

  // The footer text is module state, so it is dropped with the session. The next
  // resources_discover publishes again; on /reload that runs after this.
  pi.on("session_shutdown", (_event, ctx) => {
    phase = undefined;
    phaseAt = undefined;
    lastError = undefined;
    if (!ctx.hasUI) return;
    safeUi(() => ctx.ui.setStatus(StatusKey, undefined));
  });

  // /codegraph — status display by default; `toggle <flag>` (or bare
  // `<flag>`) flips a boolean. In TUI, bare /codegraph opens an interactive
  // SettingsList menu (same component /settings uses). ExtensionAPI exposes
  // no live setFlag, so a toggle writes through to the flag settings file
  // (<piDir>/pi-codegraph-enhanced.json) and reloads; the factory re-seeds
  // registerFlag defaults from disk, so the in-memory value picks up the
  // change. ctx is stale after reload() — we notify first, reload last, and
  // return immediately.
  pi.registerCommand("codegraph", {
    description: "CodeGraph settings. Usage: /codegraph [init | sync | toggle <flag>]",
    getArgumentCompletions: (prefix: string) => {
      const trailingSpace = /\s$/.test(prefix);
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      const flagNames = FLAGS.map((f) => f.name);
      const root = ["init", "sync", "toggle", ...flagNames];
      const toggleComplete =
        (tokens.length === 1 && tokens[0] === "toggle") ||
        (tokens.length >= 2 && tokens[0] === "toggle");
      if (toggleComplete) {
        const partial = tokens.length >= 2 ? tokens[tokens.length - 1] : "";
        const hits = flagNames.filter((n) => n.startsWith(partial));
        return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
      }
      if (tokens.length <= 1 && !trailingSpace) {
        const hits = root.filter((o) => o.startsWith(tokens[0] ?? ""));
        return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // /codegraph init — run the auto-managed index gate NOW in the current
      // project, regardless of the codegraph-auto-index flag. This is the
      // manual escape hatch for users who keep the flag off (the default) and
      // want to index a specific folder on demand. Fire-and-forget, with a
      // notify of the outcome so the user knows what happened.
      if (trimmed === "init") {
        runManualInit(pi, ctx);
        return;
      }

      // /codegraph sync — refresh the existing .codegraph index in the current
      // project on demand, regardless of the codegraph-auto-index flag. This is
      // the explicit "pull source changes into the index" path for users who
      // want a fresh sync without waiting for the startup gate. Fire-and-forget,
      // with a notify of the outcome so the user knows what happened.
      if (trimmed === "sync") {
        runManualSync(pi, ctx);
        return;
      }

      // Toggle mode: /codegraph toggle <flag> or /codegraph <flag>.
      // Bare /codegraph toggle (no flag) falls through to the menu.
      if (trimmed !== "" && trimmed !== "status" && trimmed !== "toggle") {
        const tokens = trimmed.split(/\s+/).filter(Boolean);
        const flagName = tokens[0] === "toggle" ? tokens[1] : tokens[0];
        const meta = FLAGS.find((f) => f.name === flagName);
        if (!meta) {
          ctx.ui.notify(
            `Unknown flag "${flagName}". Valid: ${FLAGS.map((f) => f.name).join(", ")}`,
            "warning",
          );
          return;
        }
        const current = pi.getFlag(meta.name) === true;
        const next = !current;
        if (!saveFlagSetting(meta.name, next)) {
          ctx.ui.notify(`Failed to set ${meta.name}: could not write settings file`, "error");
          return;
        }
        ctx.ui.notify(`${meta.name}: ${current} → ${next}. Reloading...`, "info");
        await ctx.reload();
        return;
      }

      // Status/menu mode. In TUI, open an interactive SettingsList so the
      // user can flip flags in one visit; changes persist via the flag
      // settings file and a single reload fires on close. Outside TUI, fall
      // back to the read-only status panel — custom components are terminal-only.
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderCodeGraphStatus(pi, ctx), "info");
        return;
      }

      const pending = new Map<string, boolean>();
      const items: SettingItem[] = FLAGS.map((f) => ({
        id: f.name,
        label: f.label,
        description: f.description,
        currentValue: pi.getFlag(f.name) === false ? "off" : "on",
        values: ["on", "off"],
      }));

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("CodeGraph settings")), 1, 1));
        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            pending.set(id, newValue === "on");
          },
          () => done(undefined),
        );
        container.addChild(settingsList);
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });

      // Dialog closed. Drop net-zero flips, persist genuine deltas, reload once.
      const deltas: Array<[string, boolean]> = [];
      for (const [name, val] of pending) {
        const currentlyOn = pi.getFlag(name) === true;
        if (currentlyOn === val) continue;
        deltas.push([name, val]);
      }
      if (deltas.length === 0) return;

      const failures: string[] = [];
      for (const [name, val] of deltas) {
        if (!saveFlagSetting(name, val)) failures.push(name);
      }
      if (failures.length > 0) {
        ctx.ui.notify(`Failed to apply: ${failures.join("; ")}`, "error");
        return;
      }
      ctx.ui.notify(`Applied ${deltas.length} change(s). Reloading...`, "info");
      await ctx.reload();
    },
  });

  // One line, not five, and only while the loader is active. The tool
  // description carries the rest; a longer block just repeats it.
  pi.on("before_agent_start", async (event) => {
    const active = pi.getActiveTools();
    // Stay silent once anything is loaded. The loader stays active for the
    // whole session, so a loader-only check would repeat stale advice and
    // invite a pointless second codegraph_load call.
    if (!active.includes(LoaderToolName) || CodegraphToolNames.some((name) => active.includes(name))) {
      return;
    }
    const guidance =
      `CodeGraph structural tools are inactive. Call ${LoaderToolName} once, then prefer codegraph_* over grep/read for symbol, flow, and impact questions.`;

    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${guidance}` : guidance,
    };
  });

  for (const tool of ToolDefinitions) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      // No promptSnippet/promptGuidelines: both duplicate the description in the
      // system prompt, and prompt metadata forces a system-prompt rebuild when
      // the tool is activated mid-session.
      parameters: tool.parameters,
      async execute(_toolCallId, params: Static<typeof tool.parameters>, signal) {
        const text = await callCodeGraphTool(tool.name, (params || {}) as ToolParams, signal);
        return {
          content: [{ type: "text" as const, text }],
          details: {},
        };
      },

      renderCall(args: Record<string, unknown>, theme: any, _context: any) {
        const title = theme.fg("toolTitle", theme.bold(tool.name));
        const primary = args?.query ?? args?.symbol ?? args?.path;
        if (typeof primary === "string" && primary) {
          const shown = primary.length > 80 ? `${primary.slice(0, 77)}...` : primary;
          return new Text(`${title} ${theme.fg("accent", shown)}`, 0, 0);
        }
        return new Text(title, 0, 0);
      },

      renderResult(result: { content?: Array<{ type: string; text?: string }> }, options: any, theme: any, _context: any) {
        if (options.isPartial) {
          return new Text(theme.fg("warning", "running..."), 0, 0);
        }

        const text = (result?.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");

        if (!text) {
          return new Text(theme.fg("muted", "↳ (no output)"), 0, 0);
        }

        const lines = text.split("\n");
        const lineCount = lines.length;

        if (options.expanded) {
          const body = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
          return new Text(body, 0, 0);
        }

        const PREVIEW_LINES = 6;
        const preview = lines.slice(0, PREVIEW_LINES);
        const remaining = lineCount - preview.length;

        let out = theme.fg("muted", `↳ ${lineCount} ${lineCount === 1 ? "line" : "lines"} returned`);
        out += theme.fg("muted", ` • ${keyHint("app.tools.expand", "to expand")}`);

        if (preview.length > 0) {
          out += "\n" + preview.map((line) => theme.fg("toolOutput", line)).join("\n");
        }
        if (remaining > 0) {
          out += "\n" + theme.fg("muted", `... (${remaining} more ${remaining === 1 ? "line" : "lines"})`);
        }

        return new Text(out, 0, 0);
      },
    });
  }

  pi.registerTool({
    name: LoaderToolName,
    label: "Load CodeGraph tools",
    description:
      `Activate CodeGraph structural-analysis tools for this session, then call them. Available: ${CodegraphToolNames.join(", ")}. Omit tools to activate all.`,
    parameters: Type.Object({
      tools: Type.Optional(Type.Array(Type.String({ description: "CodeGraph tool names to activate." }))),
    }),
    async execute(_toolCallId, params) {
      const requested = params.tools?.length ? params.tools : [...CodegraphToolNames];
      const unknown = requested.filter((name) => !CodegraphToolNames.includes(name));
      const active = pi.getActiveTools();
      const added = requested.filter((name) => CodegraphToolNames.includes(name) && !active.includes(name));
      pi.setActiveTools([...new Set([...active, ...added])]);

      const text = unknown.length
        ? `Unknown tool(s): ${unknown.join(", ")}. Available: ${CodegraphToolNames.join(", ")}.`
        : added.length
          ? `Activated: ${added.join(", ")}`
          : `Already active: ${requested.join(", ")}`;
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
