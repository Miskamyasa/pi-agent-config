# btw

Ask a quick side question in a floating overlay without interrupting the main
conversation. A patched fork of [L2ncE/pi-btw](https://github.com/L2ncE/pi-btw).

`/btw <question>` opens a top-center overlay and streams the answer from a
separate, read-only side agent. The main agent keeps running. Nothing the side
agent does is ever written back to the main conversation; the side thread lives
only in this extension instance.

## Usage

- `/btw <question>` — open the overlay and ask immediately.
- `/btw` (no args) — open the overlay on the latest history entry.

The side agent is a real in-memory pi sub-session seeded with the main
session's messages as background context. It has read-only tools only:
`read`, `grep`, `find`, `ls` — no bash, no edits.

Overlay keys:

| Key | Action |
|---|---|
| `Enter` | submit the typed question |
| `Esc` | abort while answering; close when idle |
| `Tab` | cycle the side model |
| `Alt+N` | start a new side session |
| `Alt+←` / `Alt+→` | switch side session |
| `Alt+C` | copy the current answer to the clipboard |
| `←` / `→` (input empty) | page this session's Q&A history |
| `↑` / `↓` (input empty) | scroll a long answer |
| `Alt+/` / `Ctrl+Alt+W` | focus the overlay; inside it, unfocus back to the main editor |

## Configuration

`config.json` is empty and unused.

The side model comes from the global `enabledModels` setting, not a per-extension
file. `Tab` cycles the session's scoped models (`ctx.scopedModels`, the same set
as `/scoped-models`) filtered by `modelRegistry.hasConfiguredAuth`. If no scoped
model has credentials, the side agent follows the main session's model.

Thinking level follows the main session (`pi.getThinkingLevel()`), or a scoped
model's pinned level from the `enabledModels` pattern (e.g.
`provider/model:high`) when one is selected.

Caps: 20 history exchanges per side session, 10 side sessions maximum (oldest
evicted). `/new`, restarts, and reloads clear the side threads.

## Changes from upstream

- **Model selection.** Removed `~/.pi/agent/btw.json` pinning (`model` /
  `thinking`, `readBtwModelResolution`, `BTW_CONFIG_FILENAME`,
  `BTW_THINKING_LEVELS`). The side model now comes from the global
  `enabledModels` setting via `ctx.scopedModels` + `Tab` cycling, filtered by
  configured auth. Thinking follows the main session or the scoped model's
  pinned level.
- **Multi-session.** Upstream keeps one sub-session per pi session. This fork
  keeps up to 10 `BtwSession`s (`Alt+N` new, `Alt+←`/`Alt+→` switch), with
  oldest eviction.
- **Sub-session extensions.** `noExtensions: true` is removed from the
  sub-session's `DefaultResourceLoader`, so provider extensions (e.g. `cpa`)
  re-register inside it and their models get auth.
- **Input widget.** Single-line `Input` replaced with a multi-line `Editor`
  (custom `EditorTheme`, blank `borderColor`). Input rendering now wraps to
  multiple rows.
- **Copy key.** Plain `c`/`C` changed to `Alt+C`.
- **UI text.** Title shows `session N/M` instead of `btw · side question`. Hint
  line rewritten: `alt+n new · alt+c copy · ←→ history · alt+←→ session · alt+/
  editor · tab model`.
- **File layout.** Upstream is a single `extensions/btw.ts`. This fork is
  `index.ts` plus an empty, unused `config.json`.

## Unchanged from upstream

Overlay geometry, abort/copy/close logic, the read-only tool whitelist
`["read", "grep", "find", "ls"]`, the `BTW_SYSTEM_PROMPT`, in-memory
`SettingsManager` (sub-session model switches never touch global pi settings),
and the journal-seeding approach (`buildSessionContext` + `convertToLlm` into
`SessionManager.inMemory`) are unchanged.
