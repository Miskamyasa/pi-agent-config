# temperature

Per-model sampling temperature overrides for outgoing model requests.

## Configuration

Edit `agent/extensions/temperature/config.json` (in the pi agent dir).
Keys are `"provider/model"` for an exact match, or a bare model id to
match the model under any provider. Values are numbers sent as the
top-level `temperature` field of every provider request for that model:

```json
{
  "*": 0.2,
  "ollama-cloud/gpt-oss:120b": 0.7,
  "anthropic/claude-opus-5": null,
  "gpt-5.6-sol": null
}
```

- `"*"` sets the default for all models.
- `null` (read as undefined — JSON has no undefined) explicitly leaves a
  model untouched, even when `"*"` or a less specific key would match.
- Precedence: exact `"provider/model"`, then bare model id, then `"*"`.
- A missing file, an empty file, or `{}` disables the extension.
- An invalid file (bad JSON, values that are not a number or null)
  disables the override and shows a warning at session start.
- Run `/reload` after editing.

Unlike pi's native `samplingParams` (OpenAI-compatible APIs only), this
rewrites the final request payload, so it also covers Anthropic and other
APIs.
