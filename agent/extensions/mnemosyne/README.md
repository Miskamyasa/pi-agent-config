# Mnemosyne extension

Long-term semantic memory for pi. Short, durable facts about the user or the
project are stored on a remote Mnemosyne server and can be recalled
automatically or requested through a tool.

## How it works

- On session start the extension reads its config, creates an HTTP client, and
  checks that the server is reachable.
- In **passive** mode it quietly looks up the three most relevant memories
  whenever the user types something, and inserts them as a special message
  before the model answers.
- If `captureTurns` is on, each interaction (the user prompt and every
  assistant reply until the agent settles) is sent to a small "distill"
  model. The model returns up to five short, durable facts, which are stored
  in the active write bank (`hybrid` writes to the project bank). A failed
  distillation is reported in the status line.
- In **active** mode the model can call the `mnemosyne_memory` tool to search,
  add, get, delete, or view stats for memories.
- When the session ends the extension can ask the server to consolidate old
  memories.
- `memoryMode` selects the side: `"passive"`, `"active"`, or `"hybrid"`
  (default; both sides on).

## Config

Lives in `agent/extensions/mnemosyne/config.json`, merged with a project-local
`<cwd>/.pi/mnemosyne.json` (trusted projects only; project keys win per field).
String values support `${ENV_VAR}` expansion.

- `url` — address of the Mnemosyne MCP endpoint.
- `token` — secret token used for authentication.
- `memoryMode` — `"passive"`, `"active"`, or `"hybrid"` (default).
- `topK` — how many recall results to fetch per bank.
- `captureTurns` — `true` enables distillation after each agent run.
- `distillModel` — model reference used to distil facts
  (default `openai/gpt-5.6-luna`).
- `consolidateOnShutdown` — whether to run server-side consolidation on exit.
- `bank` (project-only) — short name that becomes the project bank
  `project--<name>`.
- `bankScope` — `"global"`, `"project"`, or `"hybrid"` (default). `hybrid` reads
  from both banks and writes to the project bank unless overridden. The
  single-bank scopes collapse both write targets onto that bank.
- `insecure` — skip TLS verification.
- `requestTimeoutMs` — HTTP timeout in milliseconds.

Fallback env vars: `MNEMOSYNE_URL`, `MEMORY_MCP_TOKEN` (or
`MNEMOSYNE_MCP_TOKEN`), `MNEMOSYNE_INSECURE=1`.

## Backend

The extension talks to a hosted Mnemosyne MCP server over HTTPS using the
streamable-HTTP JSON-RPC protocol. It creates a session, keeps the session id
in a header, and retries once if the server reports an expired session.

It calls the standard Mnemosyne RPC methods: `mnemosyne_remember`,
`mnemosyne_recall`, `mnemosyne_get`, `mnemosyne_forget`, `mnemosyne_stats`, and
`mnemosyne_sleep`.

Memories live in two logical banks: a shared `global` bank and a
project-specific bank (`project--<name>` or `project--<cwd-derived>`). With
`bankScope: "hybrid"` reads fan out over both.

## Safety

Before any text is sent to the server, common secrets are redacted (private
keys, bearer tokens, passwords, api keys). Recalled memories are wrapped as
untrusted data and scanned for jailbreak-style patterns; a threat is replaced
with a blocked placeholder. Recalled memory is never injected into the system
prompt.

## Docker compose example

Runs the hosted Mnemosyne MCP server behind SWAG. No host port is published;
SWAG reaches the container through `swag-network`.

```yaml
networks:
  swag-network:
    external: true

services:
  mnemosyne:
    image: miskamyasa/mnemosyne:4.0.0b2
    container_name: mnemosyne
    restart: unless-stopped
    networks:
      - swag-network
    expose:
      - "8080"
    volumes:
      - /opt/appdata/mnemosyne:/data
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      HOME: "/tmp"
      MNEMOSYNE_DATA_DIR: "/data"
      MNEMOSYNE_MCP_TOKEN: >-
        ${MNEMOSYNE_MCP_TOKEN:?MNEMOSYNE_MCP_TOKEN is required}
      MNEMOSYNE_MCP_ALLOWED_HOSTS: >-
        ${MNEMOSYNE_MCP_ALLOWED_HOSTS:?MNEMOSYNE_MCP_ALLOWED_HOSTS is required}
      MNEMOSYNE_EMBEDDING_API_URL: >-
        ${MNEMOSYNE_EMBEDDING_API_URL:?MNEMOSYNE_EMBEDDING_API_URL is required}
      MNEMOSYNE_EMBEDDING_API_KEY: >-
        ${MNEMOSYNE_EMBEDDING_API_KEY:?MNEMOSYNE_EMBEDDING_API_KEY is required}
      MNEMOSYNE_EMBEDDING_MODEL: >-
        ${MNEMOSYNE_EMBEDDING_MODEL:?MNEMOSYNE_EMBEDDING_MODEL is required}
      MNEMOSYNE_EMBEDDING_DIM: >-
        ${MNEMOSYNE_EMBEDDING_DIM:?MNEMOSYNE_EMBEDDING_DIM is required}
      MNEMOSYNE_FORCE_LOCAL: false
      MNEMOSYNE_LLM_ENABLED: true
      MNEMOSYNE_LLM_BASE_URL: >-
        ${MNEMOSYNE_LLM_BASE_URL:?MNEMOSYNE_LLM_BASE_URL is required}
      MNEMOSYNE_LLM_API_KEY: >-
        ${MNEMOSYNE_LLM_API_KEY:?MNEMOSYNE_LLM_API_KEY is required}
      MNEMOSYNE_LLM_MODEL: >-
        ${MNEMOSYNE_LLM_MODEL:?MNEMOSYNE_LLM_MODEL is required}
      MNEMOSYNE_LLM_TIMEOUT: 60
    command:
      - "--transport"
      - "streamable-http"
      - "--host"
      - "0.0.0.0"
      - "--port"
      - "8080"
      - "--path"
      - "/mcp"
    security_opt:
      - no-new-privileges:true
    stop_grace_period: 30s
```

## Commands

- `/mnemosyne status` — show url, banks, and mode.
- `/mnemosyne health` — show server stats per bank.
- `/mnemosyne search <query>` — search memories.
- `/mnemosyne add [global|project] <text>` — store a fact.
- `/mnemosyne delete <memory_id>` — delete a memory.
- `/mnemosyne sleep` — run server-side consolidation.
