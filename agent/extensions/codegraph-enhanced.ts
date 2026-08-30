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

/**
 * Records the most recent index action (startup gate or manual command) for
 * the /codegraph status panel. Carries a `source` so the panel can distinguish
 * "last startup: synced" from "last manual sync: busy" — otherwise a transient
 * manual lock would overwrite a clean startup record and mislead the user.
 */
export let lastIndexAction: CodeGraphIndexAction | undefined;

/** Test-only seam to inject an index action for status rendering. */
export function setLastIndexActionForTest(action: CodeGraphIndexAction | undefined): void {
  lastIndexAction = action;
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
/** Short cap for the cheap --version liveness probe. */
export const VersionProbeTimeoutMs = 10_000;

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
    // Only `status --json` needs stdout; everything else (init/index/sync)
    // emits progress we never read, so drop stdout to avoid unbounded buffering.
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

const CodegraphDir = ".codegraph";
const LockFailureMarker = "could not acquire file lock";

interface CodeGraphStatus {
  initialized?: boolean;
  pendingChanges?: {
    added?: number;
    modified?: number;
    removed?: number;
  };
}

function parseStatusJson(stdout: string): CodeGraphStatus | undefined {
  try {
    return JSON.parse(stdout) as CodeGraphStatus;
  } catch {
    return undefined;
  }
}

function pendingChangesTotal(status: CodeGraphStatus | undefined): number {
  const pending = status?.pendingChanges;
  if (!pending) return 0;
  return (pending.added ?? 0) + (pending.modified ?? 0) + (pending.removed ?? 0);
}

function looksLikeLockFailure(result: CodeGraphRunResult): boolean {
  return result.code !== 0 && result.stderr.toLowerCase().includes(LockFailureMarker);
}

/**
 * Ensures the CodeGraph index for `projectPath` is present and fresh.
 *
 * Branches:
 *  - codegraph not on PATH         → unavailable
 *  - .codegraph/ missing           → `codegraph init -i`
 *  - present, status failed (corrupt/unreadable) → `codegraph index -f`
 *  - present, status timed out OR lock busy      → busy (skip; another process owns the index)
 *  - present, drift detected       → `codegraph sync`
 *  - present, clean                → skipped
 *
 * Throws only on a runner exception; the caller (the hook) swallows it. Never
 * blocks the agent — the watcher inside `codegraph serve --mcp` is the live
 * safety net for in-session edits.
 */
export async function ensureCodeGraphIndex(
  projectPath: string,
  runner: CodeGraphRunner = defaultCodeGraphRunner,
): Promise<CodeGraphStartupAction> {
  // Fail-safe: bail out cheaply if the codegraph CLI isn't installed, so we
  // never report a false "initialized" from a spawn ENOENT, and don't waste a
  // long timeout window on every startup in an environment without it.
  const probe = await runWithTimeout(
    runner,
    ["--version"],
    projectPath,
    "version",
    VersionProbeTimeoutMs,
  );
  if (probe.code !== 0) {
    return { action: "unavailable", projectPath };
  }

  const codegraphPath = path.join(projectPath, CodegraphDir);
  let dirExists = false;
  try {
    const info = await stat(codegraphPath);
    dirExists = info.isDirectory();
  } catch {
    dirExists = false;
  }

  if (!dirExists) {
    const initResult = await runWithTimeout(runner, ["init", "-i"], projectPath, "init");
    // init racing another process (e.g. a /reload) loses the lock — let that one win.
    if (looksLikeLockFailure(initResult)) return { action: "busy", projectPath };
    return { action: initResult.code === 0 ? "initialized" : "unavailable", projectPath };
  }

  const statusResult = await runWithTimeout(
    runner,
    ["status", "--json"],
    projectPath,
    "status",
  );

  // A timed-out or lock-busy status does NOT mean corruption: treat it as "another
  // process owns the index right now" and skip. A forced reindex in response to a
  // slow status is the most expensive possible reaction to a transient condition.
  if (statusResult.timedOut || looksLikeLockFailure(statusResult)) {
    return { action: "busy", projectPath };
  }

  const status = parseStatusJson(statusResult.stdout);
  const statusFailed = statusResult.code !== 0 || status === undefined || status.initialized === false;

  if (statusFailed) {
    const rebuild = await runWithTimeout(runner, ["index", "-f", "-q"], projectPath, "index");
    if (looksLikeLockFailure(rebuild)) return { action: "busy", projectPath };
    return { action: "rebuilt", projectPath };
  }

  if (pendingChangesTotal(status) > 0) {
    const sync = await runWithTimeout(runner, ["sync", "-q"], projectPath, "sync");
    if (looksLikeLockFailure(sync)) return { action: "busy", projectPath };
    return { action: "synced", projectPath };
  }

  return { action: "skipped", projectPath };
}

export type CodeGraphStartupAction =
  | { action: "initialized"; projectPath: string }
  | { action: "rebuilt"; projectPath: string }
  | { action: "synced"; projectPath: string }
  | { action: "skipped"; projectPath: string }
  | { action: "unavailable"; projectPath: string }
  | { action: "busy"; projectPath: string };

/**
 * A recorded index action, tagged with whether it came from the startup gate
 * or a manual `/codegraph init` / `/codegraph sync`. The display uses `source`
 * to avoid a manual command silently overwriting the startup record.
 */
export type CodeGraphIndexAction = CodeGraphStartupAction & {
  source: "startup" | "manual";
};

/**
 * Dedups overlapping ensureCodeGraphIndex calls against the same project within
 * one module instance. pi re-imports the extension module on /reload
 * (`createJiti({ moduleCache: false })` in the loader), so this guard only
 * covers a rapid double-fire within a single session — cross-reload overlap is
 * backstopped by codegraph's own .lock file (handled as the `busy` action).
 */
const inFlight = new Map<string, Promise<CodeGraphStartupAction>>();

export function ensureCodeGraphIndexOnce(
  projectPath: string,
  runner: CodeGraphRunner = defaultCodeGraphRunner,
): Promise<CodeGraphStartupAction> {
  const existing = inFlight.get(projectPath);
  if (existing) return existing;
  const p = ensureCodeGraphIndex(projectPath, runner).finally(() => {
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

/**
 * Surfaces the startup action to the user via the footer/notifications, when UI
 * is available. Silent in headless/print mode (hasUI === false). Swallows any UI
 * error so a TUI glitch can't reject the fire-and-forget chain.
 */
function reportStartupAction(result: CodeGraphStartupAction, ctx: ExtensionContext): void {
  lastIndexAction = { ...result, source: "startup" };
  if (!ctx.hasUI) return;
  const ui = ctx.ui;
  switch (result.action) {
    case "initialized":
    case "rebuilt":
    case "synced":
      ui.setStatus("codegraph", `🔍 CodeGraph: ${result.action}`);
      break;
    case "busy":
      ui.setStatus("codegraph", "🔍 CodeGraph: index busy (run `codegraph unlock` if stuck)");
      break;
    case "unavailable":
      // The most actionable signal: warn once that auto-index is off.
      ui.notify(
        "CodeGraph unavailable; auto-index disabled. Ensure the codegraph CLI is installed and on PATH (`npm i -g @colbymchenry/codegraph`).",
        "warning",
      );
      break;
    case "skipped":
    default:
      ui.setStatus("codegraph", undefined);
      break;
  }
}

/** Builds the read-only /codegraph status panel: every flag + last action. */
export function renderCodeGraphStatus(pi: ExtensionAPI): string {
  const flagLines = FLAGS.map(
    (f) => `  ${pi.getFlag(f.name) === false ? "[ ]" : "[x]"} ${f.name}  — ${f.description}`,
  );
  const action = lastIndexAction
    ? `last index action: ${lastIndexAction.source} ${lastIndexAction.action} (${lastIndexAction.projectPath})`
    : "last index action: (none yet this session)";
  return [
    "CodeGraph settings",
    "",
    "flags:",
    ...flagLines,
    "",
    action,
    "",
    "toggle: /codegraph toggle <flag>   (shorthand: /codegraph <flag>)",
    "init:   /codegraph init            (index this folder now, ignoring the flag)",
    "sync:   /codegraph sync            (refresh the existing index from source now)",
  ].join("\n");
}

/**
 * `/codegraph init` — runs the auto-managed index gate on demand in `cwd`,
 * ignoring the codegraph-auto-index flag. Fire-and-forget; notifies the outcome
 * (and records it for the status panel). Used when the flag is off (the default)
 * but the user wants this folder indexed now.
 */
export function runManualInit(ctx: ExtensionContext): void {
  const projectPath = ctx.cwd ?? process.cwd();
  const ui = ctx.hasUI ? ctx.ui : undefined;
  // A TUI glitch must never reject this fire-and-forget chain.
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* swallow */
    }
  };

  // Status-bar-only start signal: persists as the in-flight indicator without
  // adding a toast (the completion toast closes the loop). Skipped entirely in
  // headless/print mode, where ctx.hasUI is false.
  if (ui) safe(() => ui.setStatus("codegraph", "🔍 CodeGraph: indexing…"));

  ensureCodeGraphIndexOnce(projectPath)
    .then((result) => {
      lastIndexAction = { ...result, source: "manual" };
      if (!ui) return;
      safe(() => {
        switch (result.action) {
          case "initialized":
          case "rebuilt":
          case "synced":
            ui.setStatus("codegraph", `🔍 CodeGraph: ${result.action}`);
            ui.notify(`CodeGraph: ${result.action} (${projectPath})`, "info");
            break;
          case "busy":
            ui.setStatus("codegraph", "🔍 CodeGraph: index busy (run `codegraph unlock` if stuck)");
            ui.notify(`CodeGraph: busy (${projectPath})`, "info");
            break;
          case "unavailable":
            // Manual init is the explicit path: surface the install hint, not
            // a terse "unavailable". Mirrors reportStartupAction.
            ui.setStatus("codegraph", undefined);
            ui.notify(
              "CodeGraph unavailable; init aborted. Install the codegraph CLI and ensure it's on PATH (`npm i -g @colbymchenry/codegraph`).",
              "warning",
            );
            break;
          default: // skipped — already up to date
            ui.setStatus("codegraph", undefined);
            ui.notify(`CodeGraph: already up to date (${projectPath})`, "info");
        }
      });
    })
    .catch(() => {
      // Never leave a stale "indexing…" status after a silent failure, and
      // never re-throw out of .catch (would be an unhandled rejection).
      if (!ui) return;
      safe(() => {
        ui.setStatus("codegraph", undefined);
        ui.notify("CodeGraph: init failed", "error");
      });
    });
}

/**
 * `/codegraph sync` — force a sync of the existing `.codegraph/` index in
 * `cwd` against the current source tree, on demand. Unlike the startup gate
 * (ensureCodeGraphIndex), this never inits or rebuilds: it is the explicit
 * "refresh what's already indexed" path. Fire-and-forget; notifies the
 * outcome. Requires an existing index — if none is present, the user is pointed
 * at `/codegraph init` instead of silently creating one.
 *
 * Failure handling is deliberately distinct (not collapsed into one "busy"
 * bucket): a lock conflict or timeout reports `busy` with the unlock hint,
 * while a corrupt/unreadable index (`status` fails / `initialized:false`) or a
 * non-zero sync exit surfaces a dedicated message pointing at `/codegraph init`.
 * `runner` is injectable for tests; every other CLI entry point takes one too.
 */
export function runManualSync(
  ctx: ExtensionContext,
  runner: CodeGraphRunner = defaultCodeGraphRunner,
): void {
  const projectPath = ctx.cwd ?? process.cwd();
  const ui = ctx.hasUI ? ctx.ui : undefined;
  // A TUI glitch must never reject this fire-and-forget chain.
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* swallow */
    }
  };

  const record = (action: CodeGraphStartupAction["action"]): void => {
    lastIndexAction = { action, projectPath, source: "manual" };
  };

  if (ui) safe(() => ui.setStatus("codegraph", "🔍 CodeGraph: syncing…"));

  (async () => {
    // Fail fast if the CLI is absent: never report a false "synced" from a
    // spawn ENOENT, and don't burn the full startup timeout window.
    const probe = await runWithTimeout(
      runner,
      ["--version"],
      projectPath,
      "version",
      VersionProbeTimeoutMs,
    );
    if (probe.code !== 0) {
      record("unavailable");
      if (!ui) return;
      safe(() => {
        ui.setStatus("codegraph", undefined);
        ui.notify(
          "CodeGraph unavailable; sync aborted. Install the codegraph CLI and ensure it's on PATH (`npm i -g @colbymchenry/codegraph`).",
          "warning",
        );
      });
      return;
    }

    // sync only makes sense against an existing index. Distinguish a genuinely
    // missing index (ENOENT / not-a-directory → redirect to init) from a
    // permission or I/O error (surface the real message, since init would fail
    // the same way and loop).
    try {
      const info = await stat(path.join(projectPath, CodegraphDir));
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch (err: any) {
      const missing = err?.code === "ENOENT" || err?.message === "not a directory";
      if (!missing) {
        if (ui) safe(() => {
          ui.setStatus("codegraph", undefined);
          ui.notify(`Cannot read .codegraph/: ${err?.message ?? err}`, "error");
        });
        return;
      }
      if (!ui) return;
      safe(() => {
        ui.setStatus("codegraph", undefined);
        ui.notify(
          `No .codegraph index in ${projectPath}. Run /codegraph init first.`,
          "warning",
        );
      });
      return;
    }

    // Probe index health BEFORE attempting sync: a corrupt or uninitialized DB
    // (initialized:false, unparseable status, or non-zero exit) makes `sync`
    // exit non-zero, which the old code mis-reported as "busy / unlock". Report
    // the real condition and point at init/rebuild instead.
    const statusResult = await runWithTimeout(
      runner,
      ["status", "--json"],
      projectPath,
      "status",
    );
    if (statusResult.timedOut || looksLikeLockFailure(statusResult)) {
      record("busy");
      if (!ui) return;
      safe(() => {
        ui.setStatus("codegraph", "🔍 CodeGraph: index busy (run `codegraph unlock` if stuck)");
        ui.notify(`CodeGraph: sync did not complete — index busy (${projectPath})`, "info");
      });
      return;
    }
    const status = parseStatusJson(statusResult.stdout);
    const statusFailed =
      statusResult.code !== 0 || status === undefined || status.initialized === false;
    if (statusFailed) {
      if (!ui) return;
      safe(() => {
        ui.setStatus("codegraph", undefined);
        ui.notify(
          `CodeGraph index is corrupt or unreadable in ${projectPath}. Run /codegraph init to rebuild.`,
          "warning",
        );
      });
      return;
    }

    const result = await runWithTimeout(runner, ["sync", "-q"], projectPath, "sync");

    // Three distinct outcomes, not one bucket: lock/timeout = busy (unlock
    // hint), other non-zero = genuine failure (try init), zero = synced.
    if (result.timedOut || looksLikeLockFailure(result)) {
      record("busy");
      if (!ui) return;
      safe(() => {
        ui.setStatus("codegraph", "🔍 CodeGraph: index busy (run `codegraph unlock` if stuck)");
        ui.notify(`CodeGraph: sync did not complete — index busy (${projectPath})`, "info");
      });
      return;
    }
    if (result.code !== 0) {
      if (!ui) return;
      safe(() => {
        ui.setStatus("codegraph", undefined);
        ui.notify(
          `CodeGraph: sync failed (exit ${result.code}) in ${projectPath}. Try /codegraph init.`,
          "error",
        );
      });
      return;
    }

    record("synced");
    if (!ui) return;
    safe(() => {
      ui.setStatus("codegraph", "🔍 CodeGraph: synced");
      ui.notify(`CodeGraph: synced (${projectPath})`, "info");
    });
  })().catch(() => {
    // Never leave a stale "syncing…" status after a silent failure, and never
    // re-throw out of .catch (would be an unhandled rejection).
    if (!ui) return;
    safe(() => {
      ui.setStatus("codegraph", undefined);
      ui.notify("CodeGraph: sync failed", "error");
    });
  });
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

  pi.on("resources_discover", async (event, ctx) => {
    // Opt-in creation, always-on maintenance. The codegraph-auto-index flag
    // (default false) gates only CREATING indexes in folders that have none.
    // But if .codegraph/ already exists (indexed manually via /codegraph init
    // or `codegraph init -i`, or by a previous enabled session), we always
    // run the gate to keep it fresh (sync drift, rebuild on corruption) —
    // otherwise the index would silently go stale every session.
    if (pi.getFlag(FLAGS[0].name) !== true) {
      let alreadyIndexed = false;
      try {
        const info = await stat(path.join(event.cwd, CodegraphDir));
        alreadyIndexed = info.isDirectory();
      } catch {
        alreadyIndexed = false;
      }
      if (!alreadyIndexed) return; // flag off + no existing index: nothing to do
    }
    // Fire-and-forget: never block session start on index maintenance. The
    // watcher inside `codegraph serve --mcp` is the live safety net.
    ensureCodeGraphIndexOnce(event.cwd)
      .then((result) => reportStartupAction(result, ctx))
      .catch(() => {});
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
    description: "CodeGraph: show settings, init or sync the index now, or toggle a flag. Usage: /codegraph [init | sync | toggle <flag>]",
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
        runManualInit(ctx);
        return;
      }

      // /codegraph sync — refresh the existing .codegraph index in the current
      // project on demand, regardless of the codegraph-auto-index flag. This is
      // the explicit "pull source changes into the index" path for users who
      // want a fresh sync without waiting for the startup gate. Fire-and-forget,
      // with a notify of the outcome so the user knows what happened.
      if (trimmed === "sync") {
        runManualSync(ctx);
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
        ctx.ui.notify(renderCodeGraphStatus(pi), "info");
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

  pi.on("before_agent_start", async (event) => {
    const guidance = [
      "CodeGraph tools are available as codegraph_* Pi tools.",
      "For architecture, flow, where-is-symbol, impact, and codebase navigation questions, use CodeGraph tools directly before grep/read.",
      "Use codegraph_explore first for broad questions, codegraph_search for symbol-name lookup, codegraph_files for project structure, codegraph_node for a known symbol, and codegraph_callers for impact/flow analysis.",
      "If codegraph_search returns no exact result, try codegraph_explore or codegraph_files/codegraph_node before falling back to grep/read; CodeGraph symbol search may miss literal constants or generated names that still exist in source text.",
      "Only use grep/read after CodeGraph is insufficient or when the user asks for literal text matching.",
    ].join("\n");

    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${guidance}` : guidance,
    };
  });

  for (const tool of ToolDefinitions) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.description,
      promptGuidelines: [
        `${tool.name} is available for structural code questions backed by the local CodeGraph index.`,
      ],
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
}
