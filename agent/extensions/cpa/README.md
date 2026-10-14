# cpa

One pi provider, `cpa`, that reaches many AI providers through a custom
OpenAI-compatible proxy. Keep several upstream accounts behind one endpoint, 
then pick the model that fits the task.

The extension targets
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and similar
OpenAI-compatible proxies. The proxy must answer `GET /v1/models` with an
OpenAI-style `{"data": [...]}` list, and it must accept the requests that pi
sends.

## How it works

1. The extension registers the `cpa` provider in pi.
2. It reads the model list from `<baseUrl>/v1/models` and registers every
   returned id.
3. `cpa` sends each request to the proxy. The proxy routes the request to the
   upstream provider that owns the model.

pi never talks to the upstream providers directly. Add, remove, or re-key a
provider in the proxy, then refresh the catalog in pi. A new model needs no pi
settings change.

## Setup

1. Start the proxy. Default address: `http://localhost:8317`.
2. Set `CPA_BASE_URL` when the proxy runs elsewhere. The extension appends
   `/v1`.
3. Set `CPA_API_KEY` to a proxy client key. pi uses it for the catalog fetch and
   for the requests to the proxy. For the catalog fetch, the extension sends
   `Authorization: Bearer <key>` when pi has a key, and no header when it does
   not; a protected proxy then rejects the call. pi also hides `cpa` models
   from `/model` when the provider has no usable credentials.

The proxy returns raw model ids, for example `nube/glm-5.3`. A pi model
reference is `cpa/` plus that raw id, so `cpa/nube/glm-5.3`. Select a model
with `/model`. Press `Ctrl+S` there to save it as the startup default.

`enabledModels` in `agent/settings.json` limits the startup selection and the
`Ctrl+P` cycle. It is optional; it does not filter the `/model` list:

```json
{
  "enabledModels": [
    "cpa/nube/glm-5.3",
    "cpa/deepseek/deepseek-v4.1-flash",
    "cpa/neuralwatt/glm-5.3-flash"
  ]
}
```

To set a startup default by hand, set both fields. `defaultModel` is the raw
proxy id, without the `cpa/` prefix:

```json
{
  "defaultProvider": "cpa",
  "defaultModel": "nube/glm-5.3"
}
```

## Catalog and cache

- At startup and on `/reload`, the extension fetches `/v1/models` when the
  cache has expired and registers the result.
- The result is cached for 24 hours in `<agentDir>/pi-cpa.json`. This file is
  generated. Do not edit it by hand.
- `/cpa:refresh` forces a fetch and re-registers the models.
- A failed fetch at startup or on `/reload` keeps a non-empty cached catalog
  and stays silent. When the cache is empty or missing, startup shows a
  warning.
- `/cpa:refresh` reports a failed fetch: a warning when it falls back to a
  cached catalog, an error when there is no cached catalog to fall back to.

## Model metadata

pi needs a context limit, an output limit, and prices for each model. The
extension reads them from [models.dev](https://models.dev):

- A `provider/model` id uses `provider` as the lookup key.
- `cdx/*` and `codex/*` map to the models.dev `openai` provider.
- `claude-*` maps to `anthropic`.
- `gpt-*` maps to `openai`.
- When the provider is unknown or has no match, the extension searches the flat
  models.dev catalog by model name.

The extension fetches the models.dev catalog once per process. `/cpa:refresh`
does not retry it. When models.dev has no usable entry, or the extension cannot
fetch that catalog, the fallback values apply:

- context window: `199984`,
- max output tokens: `65536`,
- cost: zero.

Zero cost means pi shows no price estimate for that model. Let the proxy bill
the upstream account.

Images pass through only when models.dev lists image input for the model.
Otherwise, the model accepts text only.

## Limits

- Thinking levels: pi offers `off`, `high`, and `max` for `cpa` models. The
  levels `minimal`, `low`, `medium`, and `xhigh` are unsupported.
- Every `cpa` model reports reasoning support.
- Requests never use the OpenAI `developer` role, because a proxy may reject
  it.

## Troubleshooting

- `CPA: couldn't load models` at startup — the proxy is down, `CPA_BASE_URL`
  is wrong, or the proxy rejected the key. Check `GET <baseUrl>/v1/models`.
- A model is missing from `/model` — `cpa` has no usable credentials, or the
  catalog does not contain the id. Check `CPA_API_KEY`, run `/cpa:refresh`, and
  open `/model` again.
- A model has no price estimate — models.dev has no usable match, or the
  extension could not fetch that catalog. The zero cost is expected; the proxy
  still bills the upstream account.
