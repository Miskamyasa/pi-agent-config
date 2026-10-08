# slye

Local patched fork of [wtfzambo/speak-like-you-eat](https://github.com/wtfzambo/speak-like-you-eat).

Rewrites the assistant's last response in a more human, conversational tone and
appends it to the session as a custom entry under **🤌 Speak like you eat:**.

## How it works

- After each agent turn (`agent_end`), the extension picks the last eligible
  assistant message (at least 200 prose characters; code fences are stripped),
  sends it with short prior context to the configured model, and appends the
  rewritten text to the session.
- `/slye` with no argument rewrites the last assistant message on demand.
- TUI mode only. If the rewrite fails, a one-time warning is shown.

## Configuration

- Global: `extensions/slye/config.json` in the agent dir (`enabled`,
  `model: { provider, id }`).
- Project override: `.pi/slye.json` in a trusted project. It wins over the
  global file.

## Commands

- `/slye model` — pick a model (and scope: all projects or this project) and
  enable.
- `/slye on` / `/slye off` — toggle using the saved model.
- `/slye` — rewrite the last assistant message now.
