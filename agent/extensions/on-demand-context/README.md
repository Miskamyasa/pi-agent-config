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
line. Expand it to read the full text that the model received.

Commands:

- `/list-context` — show each loaded file, grouped by directory, and the
  current config.
- `/odc-working-dir-only on|off` — turn the launch-dir limit on or off. Run it
  with no argument to see the current value. The extension saves the new value
  to the global config.
- `/odc-hide-contents on|off` — turn the display of injected text on or off.
  The extension saves the new value to the global config.

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
| `hideContents` | `false` | The TUI never shows the injected text, even when you expand the message. It shows only the `loaded <paths>` line. |

Current global values: `workingDirOnly: false`, `hideContents: false`.

Limits: the extension cuts each file at 64 KB. It skips empty files.

## Changes from upstream

- **Skip files the model reads.** When the model reads a context file with the
  `read` tool, the file text is already in the conversation. The extension
  marks it as seen and does not inject it. Only `read` counts. `edit` and
  `write` results show diffs, so the extension still injects after them.
- **Config and commands.** Upstream has no config file and no commands. This
  fork adds the two config files, the two `/odc-*` commands, and
  `/list-context`.
- **Launch-dir limit.** The extension walks up from the touched directory, but
  it stops at pi's launch dir. When `workingDirOnly` is on, it also skips
  directories outside the launch dir.
- **Windows paths.** msys and git-bash give paths like `/c/Users/...`. The
  extension converts them to `C:\...`. It also makes path keys use one
  separator and one letter case, so the same path always matches.
- **Fast injection.** The extension finds and injects the files inside the
  `tool_result` handler. It does not wait. So the context arrives before the
  next model turn, not one turn later.

## Unchanged from upstream

These parts are the same as upstream:

- the file names: `CLAUDE.md` and `AGENTS.md`;
- the steer message that carries the files;
- the order: deeper files first, and a deeper file wins over a parent file;
- the text that says the files are reference context, not new user
  instructions;
- the skip of files that pi already loaded at startup.
