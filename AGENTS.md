# AGENTS.md — pi agent config

This repository is a personal configuration and extension set for **pi**, the
coding agent. It is NOT the pi source. Do not edit files under `node_modules/`
or assume pi internals beyond the `@earendil-works/pi-*` extension APIs.

Remote: `github:Miskamyasa/pi-agent-config.git`. Branch: `main`.

## Layout

- `agent/extensions/` — custom TypeScript extensions (the main code here).
- `agent/agents/` — subagent definitions: `scout.md`, `reviewer.md`, `worker.md`.
- `agent/prompts/` — slash-command prompts: `plan.md`, `review.md`.
- `agent/skills/` — skill instruction files (e.g. `mnemosyne-memory/`).
- `agent/themes/` — theme JSON files (e.g. `e-ink.json`, `e-ink-dark.json`).
- `agent/npm/` — install root for npm pi packages (tracked `package.json`, gitignored `node_modules`).
- `agent/settings.json` — main pi settings (provider, model, theme).
- `agent/*.json` — agent-level settings and machine-local state; extension
  config lives in each extension folder (see "Config & state files").
- `.codegraph/` — CodeGraph index database. Machine-local, gitignored.
- `README.md`, `LICENSE`, `.gitignore`.

## Extensions

Each extension is one folder under `agent/extensions/` with an `index.ts` that
default-exports a function:

```ts
export default function name(pi: ExtensionAPI) { ... }
```

pi auto-discovers these folders and loads the TypeScript source at runtime.
There is no build step and no committed `dist/`. Do not add one.

Conventions when editing or adding an extension:

- One folder per extension. The folder name is the extension name.
- Default-export the entry function. Register commands, shortcuts, event
  handlers, and message renderers through the `ExtensionAPI` argument.
- Share the root `agent/extensions/package.json` and `tsconfig.json`. Do not
  add per-folder `package.json` files.
- `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and
  `@earendil-works/pi-tui` are peer packages supplied by the pi host at
  runtime. Never vendor a local copy — a duplicate module instance would
  break `instanceof` checks and event typing.
- TypeScript is `strict`, `noEmit`. Prefer pure helpers (exported, no side
  effects) so they stay testable and show up in CodeGraph.
- Five extensions are patched forks. Preserve any `LOCAL PATCH` markers and
  upstream attribution when editing them. Only `on-demand-context` actually
  carries `LOCAL PATCH` markers in its source; the others are forks without
  them.
  - `on-demand-context` — fork of `@quartermaster-labs/pi-on-demand-context`.
  - `codegraph-enhanced` — fork of `EstebanForge/pi-codegraph-enhanced`.
  - `slye` — fork of `wtfzambo/speak-like-you-eat`.
  - `btw` — fork of `L2ncE/pi-btw`.
  - `mnemosyne` — fork of `TGYD-helige/pi-memory-mem0`, reworked to
    use a hosted Mnemosyne server.
- `subagent` is based on the pi extension examples. `cpa` and `rg` are
  original to this repo.

Custom extensions in this repo: `on-demand-context`, `codegraph-enhanced`,
`rg`, `subagent`, `slye`, `btw`, `cpa`, `mnemosyne`. The
`pi-tool-display` folder holds only a `config.json` (the code is the npm
package `pi-tool-display`, declared in `settings.json` `packages`).

## Config & state files

Extension config lives in the extension folder:
`<agentDir>/extensions/<name>/config.json`, that is
`agent/extensions/<name>/config.json` by default. This matches
`pi-tool-display`, whose folder holds only its `config.json`.

The goal is the config that belongs to the agent-dir install, not to a code
copy. `__dirname` and `import.meta.url` resolve the code location, which is
`agent/npm/node_modules/<pkg>` for an npm install, differs for a project-local
`.pi/extensions/<name>/` copy, and ignores `PI_CODING_AGENT_DIR`. Resolve the
file with `join(getAgentDir(), "extensions", "<name>", "config.json")`.

Global:

- `extensions/on-demand-context/config.json` — `workingDirOnly`,
  `hideContents`. Currently `workingDirOnly: false`, so context files load from
  outside the launch dir.
- `extensions/btw/config.json`, `extensions/slye/config.json`,
  `extensions/mnemosyne/config.json` — per-extension config.

A dynamic state file stays under `agent/`, not in the extension folder, because
nothing hand-edits it and its path is an extension constant:

- `pi-cpa.json` — `cpa` extension's fetched model cache. Kept separate from
  `models-store.json` because `cpa/index.ts` sets a custom `STATE_PATH`.

Project-local (trusted projects only) — override the matching global config:

- `.pi/slye.json`.
- `.pi/on-demand-context.json`.

Agent-level files:

- `settings.json` — main settings. String values may use `${ENV_VAR}`
  expansion for secrets (e.g. `"token": "${MEMORY_MCP_TOKEN}"`).

Machine-local (gitignored — caches, credentials, per-project state):

- `auth.json` — provider credentials. Never commit.
- `trust.json` — per-project trust flags.
- `models-store.json` — default model store.
- `pi-cpa.json` — `cpa` model cache.
- `sessions/` — session journals.

When you add an extension, put hand-edited config in
`<agentDir>/extensions/<name>/config.json` via `getAgentDir()`. Do not reuse
another extension's file. Put generated, dynamic state in
`<agentDir>/<name>.json` instead, so it cannot overwrite hand-edited config, and
add the path to the root `.gitignore`. `pi-cpa.json` is the precedent.

## Validating changes

1. Typecheck from `agent/extensions/`:

   ```
   pnpm exec tsc --noEmit
   ```

   This is the only static check. There is no test suite (the `test` script
   is a stub).

2. Reload pi (`/reload`) or restart to load the changed extension. The
   `on-demand-context` extension re-inits on `/reload` (its `session_start`
   handler fires on startup, `/new`, `/resume`, `/fork`, and `/reload`); verify
   other extensions' reload behavior from their own `session_start` hooks.

## CodeGraph

The `.codegraph/codegraph.db` index covers `agent/extensions/**/*.ts`. Use
the `codegraph_*` tools for symbol, caller, callee, and impact analysis
before editing — prefer them over speculative `read`/`grep`.

- `.codegraph/` is gitignored except its own `.gitignore`. The database is
  machine-local; never commit it.
- After structural changes (renamed/moved symbols, new files), re-index via
  the `codegraph-enhanced` extension's sync command before relying on the
  graph.
- JSON and `.md` files are not in the graph; read them directly. (Two
  `pnpm-workspace.yaml` files are indexed, but YAML is not the norm here.)

## on-demand-context (self-reference)

This `AGENTS.md` is auto-loaded by the `on-demand-context` extension when an
agent touches a file in this repository. It is injected once per directory,
as a steer message, before the next model turn.

- A context file read directly with the `read` tool is already in the
  conversation, so `on-demand-context` does not inject it again.
- Each context file is capped at 64 KB.
- Deeper files override broader parents where they conflict; files are
  ordered most-specific first.

When editing this file, keep it lean — it is injected into every session
that works in this repo.

## Git conventions

- Short, lowercase, descriptive subject line. Optional `scope:` prefix for
  extension-scoped changes (e.g. `btw: load extensions in side session for
  provider auth`). No body unless context is genuinely needed.
- Do not commit generated files, `.codegraph/codegraph.db`, `auth.json`,
  `models-store.json`, `pi-cpa.json`, `trust.json`, `sessions/`, or any
  token/credential. The `.gitignore` already covers these.
- `agent/npm/node_modules/` is install output — never edit it by hand.

## Consumers of this file

- `agent/prompts/plan.md` requires reading the root `AGENTS.md` before
  producing an implementation plan.
- `agent/agents/worker.md` requires following `AGENTS.md` for any file a
  worker touches.

Keep these consumers accurate: if you add a standing rule or invariant,
document it here so scout/worker/reviewer agents pick it up.
