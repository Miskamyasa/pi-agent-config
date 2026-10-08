# on-demand-context

This extension loads `CLAUDE.md` and `AGENTS.md` files when the model works in
a directory. The model does not need to restart the session. This is a patched
fork of
[@quartermaster-labs/pi-on-demand-context](https://github.com/quartermaster-labs/pi-on-demand-context)
(v0.3.0).

When a tool touches a directory, the extension looks for context files there
and in the parent directories. A tool touches a directory when it:

- runs a bash `cd` command, or
- runs `read`, `edit`, `write`, `grep`, `ls`, or `find` on a path in it.

The extension sends the files to the model once, before the next model turn.
It does not send a file again. Files that pi already loaded at startup are
also skipped.

## Usage

You do not need a command. The extension loads context files when a tool
reaches a directory that has them. The TUI shows a short `loaded <paths>`
line. Press `Ctrl+O` or click the line (fullscreen mode) to read the full
text that the model received.

Commands:

- `/list-context` — show each loaded file, grouped by directory, and the
  current config.
- `/odc-working-dir-only on|off` — turn the launch-dir limit on or off. Run it
  with no argument to see the current value. The extension saves the new value
  to the global config.

The state resets on startup, `/new`, `/resume`, `/fork`, and `/reload`. Config
changes apply after the next reload.

## Configuration

The global config file is `<agentDir>/extensions/on-demand-context/config.json`.
A project can add `<cwd>/.pi/on-demand-context.json`, but only if pi trusts the
project. If both files set a key, the project value wins. The extension drops
unknown keys and non-boolean values.

| Key | Default | Meaning |
|---|---|---|
| `workingDirOnly` | `true` | Load context files only under pi's launch dir. This stops files like `~/CLAUDE.md` from other places. |

Current global value: `workingDirOnly: false`.

Limits: the extension cuts each file at 64 KB. It skips empty files.

## Changes from upstream

- **Skip files the model reads.** When the model reads a context file with the
  `read` tool, the file text is already in the conversation. The extension
  marks it as seen and does not inject it. Only `read` counts. `edit` and
  `write` results show diffs, so the extension still injects after them.
- **Config file location.** Upstream keeps its config at
  `~/.pi/agent/on-demand-context.json`. This fork keeps it at
  `<agentDir>/extensions/on-demand-context/config.json`, next to the code.

## Unchanged from upstream

These parts are the same as upstream:

- the file names: `CLAUDE.md` and `AGENTS.md`;
- the steer message that carries the files;
- the order: deeper files first, and a deeper file wins over a parent file;
- the text that says the files are reference context, not new user
  instructions;
- the skip of files that pi already loaded at startup;
- the config keys, the `/list-context` command, and the `/odc-*` commands;
- the launch-dir limit and the walk-up ceiling at pi's launch dir;
- the Windows path handling for msys and git-bash (`/c/Users/...` becomes
  `C:\...`), and the path keys that use one separator and one letter case.
