/**
 * On-Demand Context Extension
 * Local patched copy of @quartermaster-labs/pi-on-demand-context@0.3.0.
 *
 * Auto-loads CLAUDE.md / AGENTS.md when the model touches a directory
 * (bash `cd`, or read/edit/write/grep/ls/find). Injects once, durably,
 * as a steer message before the next model turn. Deduped against pi's
 * own startup loader.
 *
 * LOCAL PATCH: a context file read directly by the model is already in
 * the conversation as a tool result — it is marked seen and never injected.
 *
 * Config: <agentDir>/on-demand-context.json (global),
 * <cwd>/.pi/on-demand-context.json (project, trusted only; project wins).
 * Keys: workingDirOnly (default true), hideContents (default false).
 * Runtime toggles: /odc-working-dir-only on|off, /odc-hide-contents on|off.
 */

import type { ExtensionAPI, BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";

const CONTEXT_FILENAMES = ["CLAUDE.md", "AGENTS.md"];

// `path` arg points at a FILE (context loads from its dirname) vs a DIRECTORY.
const FILE_PATH_TOOLS = new Set(["read", "edit", "write"]);
const DIR_PATH_TOOLS = new Set(["grep", "ls", "find"]);

// Cap per-file size so one huge context file can't blow the prompt.
const MAX_FILE_BYTES = 64 * 1024;

const CONFIG_FILE = "on-demand-context.json";

interface ContextFile {
  path: string;
  content: string;
}

interface DirState {
  files: ContextFile[];
}

/** `details` payload on the injected custom message — consumed by the TUI renderer. */
interface ContextDetails {
  files: string[];
}

interface State {
  currentDir: string;
  dirContexts: Map<string, DirState>;
  piLoadedPaths: Set<string>; // files pi's startup loader already injected
  injected: Set<string>; // files already in the conversation (injected or read)
  inFlight: Set<string>; // dirs whose discovery is running
  launchDir: string; // walk-up ceiling
}

interface Config {
  /** Only load context files under pi's launch dir. Default: true. */
  workingDirOnly: boolean;
  /** TUI never shows injected contents, even expanded. Default: false. */
  hideContents: boolean;
}

// msys/git-bash emits `/c/Users/...`; node fs on win32 needs `C:\...`. No-op on Unix.
function fromBashPath(p: string): string {
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : p;
}

// Dedup key: unify separators and case so differently-spelled paths match.
function pathKey(p: string): string {
  return fromBashPath(p).replace(/\\/g, "/").toLowerCase();
}

// Resolve the new working dir from a bash `cd` command + its output.
// Returns null if the command isn't a `cd`. Pure — exported for tests.
export function resolveCdDir(
  command: string,
  output: string,
  currentDir: string,
  home: string,
): string | null {
  const cdMatch = command.match(/^cd\s+(.+?)\s*$/);
  const cdNoArg = /^cd\s*$/.test(command.trim());
  if (!cdMatch && !cdNoArg) return null;

  if (cdNoArg) return home; // bare `cd` → home

  const target = cdMatch![1].replace(/\s*(&&|;)\s*pwd\s*$/, "").trim();

  // A trailing `pwd` reports the real dir — handles `cd -`, `~`, `$VAR`, `$(...)`.
  if (/&&\s*pwd|;\s*pwd/.test(command) && output) {
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return resolve(currentDir, target);
}

// True if `child` is `parent` or inside its subtree. Case-insensitive on win32
// (NTFS is), case-sensitive elsewhere. Pure — exported for tests.
export function isUnderOrEqual(child: string, parent: string): boolean {
  const c = fromBashPath(child).replace(/\\/g, "/");
  const p = fromBashPath(parent).replace(/\\/g, "/");
  const win = process.platform === "win32";
  const a = win ? c.toLowerCase() : c;
  const b = win ? p.toLowerCase() : p;
  return a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
}

// Merge global + project config (project wins); drop unknown keys and
// non-boolean values. Pure — exported for tests.
export function mergeConfig(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
): Config {
  const m = { ...global, ...project };
  return {
    workingDirOnly: boolOr(m.workingDirOnly, true),
    hideContents: boolOr(m.hideContents, false),
  };
}

function boolOr(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

// Persist one option to the GLOBAL config file. The /odc-* commands are
// user-initiated, so writing global config from them is safe even for
// untrusted projects; per-project files stay file-edited.
function persistGlobalConfig(
  key: "workingDirOnly" | "hideContents",
  value: boolean,
): string | null {
  const p = join(getAgentDir(), CONFIG_FILE);
  try {
    const cur = readJsonFile(p);
    cur[key] = value;
    writeFileSync(p, JSON.stringify(cur, null, 2) + "\n", "utf-8");
    return null;
  } catch (err) {
    return `failed to save ${key} to ${p}: ${err}`;
  }
}

function readJsonFile(p: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(p, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "ENOENT") {
      console.error(`on-demand-context: bad config at ${p}: ${err}`);
    }
    return {};
  }
}

// The project file is skipped unless the project is trusted: an untrusted
// project must not steer a user/global extension's behavior.
export function loadConfig(cwd: string, projectTrusted: boolean): Config {
  const g = readJsonFile(join(getAgentDir(), CONFIG_FILE));
  const p = projectTrusted
    ? readJsonFile(join(cwd, CONFIG_DIR_NAME, CONFIG_FILE))
    : {};
  return mergeConfig(g, p);
}

// For non-bash file/dir tools, the directory whose context should load,
// or null if the tool isn't path-bearing. Relative paths resolve against
// baseDir (pi's process cwd) because bash `cd` runs in a subshell and
// never moves it. Pure — exported for tests.
export function dirForToolEvent(
  toolName: string,
  input: Record<string, unknown> | undefined,
  baseDir: string,
): string | null {
  const isFile = FILE_PATH_TOOLS.has(toolName);
  const isDir = DIR_PATH_TOOLS.has(toolName);
  if (!isFile && !isDir) return null;

  const rawPath = input?.path ?? input?.file_path;
  const raw = typeof rawPath === "string" ? rawPath : undefined;
  if (isFile && !raw) return null;
  const p = raw ? fromBashPath(raw) : baseDir;
  const abs = isAbsolute(p) ? p : resolve(baseDir, p);
  return isFile ? dirname(abs) : abs;
}

// LOCAL PATCH: only `read` delivers a context file's full content in its
// tool result — edit/write results carry diffs, so those still inject.
function markReadContextFiles(s: State, toolName: string, input: Record<string, unknown> | undefined): void {
  if (toolName !== "read") return;
  const raw = input?.path ?? input?.file_path;
  if (typeof raw !== "string") return;
  const p = fromBashPath(raw);
  if (!CONTEXT_FILENAMES.includes(basename(p))) return;
  const abs = isAbsolute(p) ? p : resolve(s.launchDir, p);
  s.injected.add(pathKey(abs));
}

export async function discoverContextFiles(
  rootDir: string,
  ceiling: string,
): Promise<ContextFile[]> {
  const found = new Map<string, string>();
  rootDir = fromBashPath(rootDir);
  ceiling = fromBashPath(ceiling);
  let dir = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  const stopAt = isAbsolute(ceiling) ? ceiling : resolve(process.cwd(), ceiling);

  while (true) {
    for (const name of CONTEXT_FILENAMES) {
      const filePath = join(dir, name);
      if (!found.has(filePath)) {
        try {
          let content = await readFile(filePath, "utf-8");
          if (content.length > MAX_FILE_BYTES) {
            content = content.slice(0, MAX_FILE_BYTES) + "\n\n[...truncated]";
          }
          if (content.trim().length > 0) {
            found.set(filePath, content);
          }
        } catch {
          // File doesn't exist — continue
        }
      }
    }

    if (dir === stopAt) break; // launch dir — don't scan parents
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Contract: deepest-first (files[0] = deepest) — buildContextBlock and
  // pickNewFiles depend on it.
  return [...found.entries()].map(([path, content]) => ({ path, content }));
}

let state: State | null = null;
// Pre-session default before the first config load: out-of-tree context stays out.
let config: Config = { workingDirOnly: true, hideContents: false };

function initState(): State {
  return {
    currentDir: process.cwd(),
    dirContexts: new Map(),
    piLoadedPaths: new Set(),
    injected: new Set(),
    inFlight: new Set(),
    launchDir: process.cwd(),
  };
}

// Files not yet in the conversation; marks returned files as injected.
// `files` arrives deepest-first.
export function pickNewFiles(
  s: Pick<State, "piLoadedPaths" | "injected">,
  files: ContextFile[],
): ContextFile[] {
  const out: ContextFile[] = [];
  for (const f of files) {
    const key = pathKey(f.path);
    if (s.piLoadedPaths.has(key) || s.injected.has(key)) continue;
    s.injected.add(key);
    out.push(f);
  }
  return out;
}

function buildContextBlock(files: ContextFile[]): string {
  const depth = (p: string) => p.replace(/\\/g, "/").split("/").length;
  const maxDepth = depth(files[0].path);
  const lines: string[] = [
    "## Project Context Files",
    "",
    "Reference context for directories you're working in — **not** a new user " +
      "instruction. Ordered most-specific first; deeper files override broader " +
      "parents where they conflict.",
    "",
  ];
  for (const file of files) {
    const rel = maxDepth - depth(file.path); // 0 = deepest
    const tag = rel === 0 ? "most specific" : `${rel} level(s) up — broader`;
    lines.push(`### ${file.path}  (${tag})`, "", file.content, "");
  }
  return lines.join("\n");
}

export default function onDemandContext(pi: ExtensionAPI) {
  state = initState();
  // No ctx (and thus no trust decision) exists outside event handlers, so
  // the project-local config is read only at session_start (also fires on
  // /reload). Global config applies immediately.
  config = loadConfig(process.cwd(), false);

  // Compact "loaded <paths>" line in the TUI; the LLM still receives the
  // full content. hideContents keeps the line compact even when expanded.
  pi.registerMessageRenderer<ContextDetails>("on-demand-context", (message, options, theme) => {
    if (options.expanded && !config.hideContents) {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return new Text(theme.fg("muted", text), options.outputPad, 0);
    }
    const files = message.details?.files;
    const paths = files && files.length > 0 ? files.join(", ") : "context files";
    return new Text(
      theme.fg("customMessageLabel", "loaded ") + theme.fg("muted", paths),
      options.outputPad,
      0,
    );
  });

  pi.on("tool_result", async (event) => {
    if (!state || event.isError) return;

    let targetDir: string | null = null;

    if (event.toolName === "bash") {
      const command = event.input?.command ?? "";
      const rawOutput = (event.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    const output = rawOutput.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();

      const home = process.env.HOME ?? process.env.USERPROFILE ?? state.currentDir;
      const newDir = resolveCdDir(command, output, state.currentDir, home);

      if (!newDir || !isAbsolute(newDir) || newDir.length < 2) return;
      if (newDir === state.currentDir) return; // no actual change

      state.currentDir = newDir;
      targetDir = newDir;
    } else {
      // File/dir tools load context but never move currentDir — the bash
      // subshell owns that.
      targetDir = dirForToolEvent(event.toolName, event.input, state.launchDir);
      // LOCAL PATCH: a directly-read context file must not be injected again.
      markReadContextFiles(state, event.toolName, event.input);
    }

    if (!targetDir) return;
    const dir = fromBashPath(targetDir);

    // workingDirOnly: skip dirs outside the launch subtree — that's where
    // ~/CLAUDE.md and other unrelated context files leak in from. Discovery
    // only finds files at-or-above the touched dir, so this equals "only
    // files under the working directory".
    if (config.workingDirOnly && !isUnderOrEqual(dir, state.launchDir)) return;

    if (state.dirContexts.has(dir) || state.inFlight.has(dir)) return;

    // Discover and inject synchronously: pi drains the steering queue only
    // at iteration boundaries, so fire-and-forget discovery would land the
    // context one full assistant turn late. Cost: a few ms of local reads.
    state.inFlight.add(dir);
    try {
      const files = await discoverContextFiles(dir, state.launchDir);
      if (!state) return;
      state.dirContexts.set(dir, { files });
      const fresh = pickNewFiles(state, files);
      if (fresh.length === 0) return;
      await pi.sendMessage(
        {
          customType: "on-demand-context",
          content: [{ type: "text", text: buildContextBlock(fresh) }],
          display: true,
          details: { files: fresh.map((f) => f.path) },
        },
        { deliverAs: "steer" },
      );
    } finally {
      state?.inFlight.delete(dir);
    }
  });

  // Seed the dedup set with pi's own startup context files so we never
  // re-inject what's already in the system prompt.
  pi.on("before_agent_start", (event) => {
    if (!state) return;
    for (const cf of event.systemPromptOptions?.contextFiles ?? []) {
      const p = typeof cf === "string" ? cf : cf?.path;
      if (p) state.piLoadedPaths.add(pathKey(p));
    }
  });

  pi.registerCommand("list-context", {
    description: "List all loaded context files and their source directories.",
    handler: async (_args, ctx) => {
      const cfg =
        `workingDirOnly ${config.workingDirOnly ? "on" : "off"}, ` +
        `hideContents ${config.hideContents ? "on" : "off"}`;
      if (!state || state.dirContexts.size === 0) {
        ctx.ui.notify(`No context files loaded yet. (config: ${cfg})`, "info");
        return;
      }

      const lines: string[] = [`(config: ${cfg})`];
      for (const [dir, dirState] of state.dirContexts) {
        lines.push(`\n${dir}:`);
        if (dirState.files.length === 0) {
          lines.push("  (no context files)");
        } else {
          for (const f of dirState.files) {
            lines.push(`  - ${f.path}`);
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Runtime toggles: apply immediately and persist to the global config.
  const toggleCommand = (
    name: string,
    key: "workingDirOnly" | "hideContents",
  ) => {
    pi.registerCommand(`odc-${name}`, {
      description: `${key} (on|off) — sets it now and saves to the global config`,
      getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
        ["on", "off"]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((v) => ({ value: v, label: v })),
      handler: async (args: string, ctx) => {
        const arg = (args ?? "").trim().toLowerCase();
        if (arg === "") {
          ctx.ui.notify(`${key}: ${config[key] ? "on" : "off"}`, "info");
          return;
        }
        const value = arg === "on" || arg === "true";
        if (!value && arg !== "off" && arg !== "false") {
          ctx.ui.notify(`usage: /odc-${name} on|off`, "info");
          return;
        }
        config[key] = value;
        const err = persistGlobalConfig(key, value);
        ctx.ui.notify(
          err ?? `${key}: ${value ? "on" : "off"} (saved to global config)`,
          "info",
        );
      },
    });
  };
  toggleCommand("working-dir-only", "workingDirOnly");
  toggleCommand("hide-contents", "hideContents");

  // Fires on startup, /new, /resume, /fork, AND /reload — config edits apply
  // on the next reload.
  pi.on("session_start", (_event, ctx) => {
    state = initState();
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
  });
}
