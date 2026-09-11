# pi config

My personal configuration and extensions for **pi**, the coding agent.
Download pi at [https://pi.dev/](https://pi.dev/).

## Extensions

### NPM packages

- [pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud) - use [Ollama Cloud](https://ollama.com/) models and fetch tools.
- [pi-mcp-adapter](github.com/nicobailon/pi-mcp-adapter) - bridge for MCP servers and their tools.
- [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) - powerline-style status footer.
- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) - styled tool output.
- [@miskamyasa/pi-model-project-persist](https://github.com/miskamyasa/pi-model-project-persist) - remember the model choice per project.

### Custom

- `subagent` - sub-agents (single, parallel, chain) with an isolated context (based on the pi extension examples).
- `slye` - response rewriting in more human language (patched fork of [wtfzambo/speak-like-you-eat](https://github.com/wtfzambo/speak-like-you-eat)).
- `btw` - ask a quick side question in an overlay without interrupting the main conversation (patched fork of [L2ncE/pi-btw](https://github.com/L2ncE/pi-btw)).
- `mnemosyne` - semantic memory backed by a hosted Mnemosyne server (patched fork of [TGYD-helige/pi-memory-mem0](https://github.com/TGYD-helige/pi/tree/master/packages/pi-memory-mem0)).
- `on-demand-context` - auto-load `CLAUDE.md` / `AGENTS.md` when the model touches a directory (patched fork of [@quartermaster-labs/pi-on-demand-context](https://github.com/Quartermaster-Labs/pi-on-demand-context)).
- `codegraph-enhanced` - codegraph navigation tools and indexing controls (patched fork of [EstebanForge/pi-codegraph-enhanced](https://github.com/EstebanForge/pi-codegraph-enhanced)).
- `rg` - ripgrep search tool (modified grep tool with extended capabilities).
- `cpa` - aggregates several AI providers behind one `cpa` provider using [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) backend.

## License

MIT. See [LICENSE](LICENSE).
