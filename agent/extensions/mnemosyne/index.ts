/**
 * mnemosyne — Mnemosyne semantic memory extension for pi.
 * Local patched copy of TGYD-helige/pi-memory-mem0, reworked to use a hosted
 * Mnemosyne server.
 *
 * Memory modes ("memoryMode"):
 * - **passive**: automatic capture + recall injection only
 * - **active**: LLM-callable mnemosyne_memory tool only
 * - **hybrid** (default): both
 *
 * Passive side: on input, a recall is prefetched in the background; on
 * before_agent_start the result is injected as a custom message on the user
 * channel (never the system prompt) and wrapped as untrusted data. Injection
 * shows at most the 3 highest-ranked memories not yet recalled this session;
 * duplicates are skipped and the block is omitted when nothing is new. The
 * seen-ids map resets on session start and after compaction. Turn
 * capture is OPT-IN via "captureTurns": true — each finished turn is first
 * redacted, then distilled client-side by a registry model ("distillModel",
 * default openai/gpt-5.6-luna) into 0-5 durable facts, and only those facts
 * are stored (source pi-fact). Turns with nothing durable save nothing; a
 * failed distillation skips the turn instead of storing raw text.
 * mnemosyne consolidates aged rows into episodic summaries during `sleep`,
 * which runs best-effort on session_shutdown. Active side: the
 * mnemosyne_memory tool exposes search / add / get / delete / stats. There is
 * no get_all action because the mnemosyne MCP surface has no list-all tool.
 *
 * Backend: a hosted `mnemosyne mcp --transport streamable-http` server.
 * Configuration via <agentDir>/extensions/mnemosyne/config.json or environment
 * (MNEMOSYNE_URL, MEMORY_MCP_TOKEN, MNEMOSYNE_INSECURE=1). Bank scoping
 * maps to mnemosyne memory banks: "bankScope" is "exact" (one shared bank),
 * "project" / "hybrid" (shared bank plus a per-project bank named from the
 * cwd path, e.g. /Users/dzaitsev/.pi → project--Users-dzaitsev--pi: reads
 * fan out over both, writes default to the project bank, and the
 * mnemosyne_memory add action can target "global").
 */
import {
  getMarkdownTheme,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createMnemosyneProvider,
  loadMnemosyneConfig,
  resolveBanks,
  searchBanks,
  type BankSet,
  type BankTarget,
  type MemoryItem,
  type MnemosyneProvider,
} from "./client.ts";
import { formatRecalledMemory, redactMemoryText } from "./privacy.ts";
import { distillFacts } from "./distill.ts";

const STATUS_KEY = "mnemo";
const MAX_ENTRY_CHARS = 1_000;
const MAX_RECALL_BYTES = 8 * 1024;
const MAX_RECALL_LINES = 50;
const MAX_RECALL_ENTRIES = 3;

/** Stored rows are one-line facts; only the trust wrappers are
 * display-only clutter. The model still sees the raw content. */
function displayFact(entry: string): string {
  return entry
    .replace(/\[UNTRUSTED MEMORY DATA\]\s*/g, "")
    .replace(/\[BLOCKED UNTRUSTED MEMORY[^\]]*\]/g, "[blocked]")
    .replace(/\s+/g, " ")
    .trim();
}
const MAX_BLOCK_BYTES = 16 * 1024;
const MAX_BLOCK_LINES = 200;
const MAX_STATS_CHARS = 600;

interface PendingRecall {
  query: string;
  promise: Promise<MemoryItem[]>;
}

export default function mnemosyneExtension(pi: ExtensionAPI) {
  let provider: MnemosyneProvider | undefined;
  let prefetch: PendingRecall | null = null;
  // Ids of memories injected this session; later turns skip them to avoid
  // re-injecting facts the model already has in context.
  let recalledIds = new Set<string>();
  let banks: BankSet = resolveBanks({ bank: "default", bankScope: "exact" }, "");
  let topK = 5;
  let captureTurns = false;
  let distillModel = "openai/gpt-5.6-luna";
  let consolidateOnShutdown = true;
  let modelRegistry: Parameters<typeof distillFacts>[0] | undefined;
  let activeMemoryMode = "";
  let activeUrl = "";
  let lastUserText = "";
  let pendingWrite = Promise.resolve();
  let sessionEpoch = 0;

  pi.on("session_start", async (_event, ctx) => {
    const epoch = ++sessionEpoch;
    provider = undefined;
    prefetch = null;
    recalledIds = new Set<string>();

    const config = loadMnemosyneConfig();
    if (!config) {
      ctx.ui.setStatus(STATUS_KEY, "💾 MEM: disabled (config)");
      return;
    }

    provider = createMnemosyneProvider(config);
    banks = resolveBanks(config, ctx.cwd ?? process.cwd());
    topK = config.topK;
    captureTurns = config.captureTurns;
    distillModel = config.distillModel;
    consolidateOnShutdown = config.consolidateOnShutdown;
    modelRegistry = ctx.modelRegistry;
    activeMemoryMode = config.memoryMode;
    activeUrl = config.url;

    // Fire-and-forget reachability probe so the status line reports the
    // real server state, not just local config presence.
    provider
      .stats(banks.all[0])
      .then(() => {
        if (epoch === sessionEpoch) ctx.ui.setStatus(STATUS_KEY, `💾 MEM: http/${activeMemoryMode}`);
      })
      .catch((err: unknown) => {
        console.error(err)
        if (epoch === sessionEpoch) {
          ctx.ui.setStatus(STATUS_KEY, "💾 MEM: unreachable");
          ctx.ui.notify(
            `Mnemosyne unreachable: ${err instanceof Error ? err.message : String(err)}`,
            "warning",
          );
        }
      });

    if (config.memoryMode !== "passive") {
      pi.registerTool(
        createMnemosyneMemoryTool({
          getProvider: () => provider,
          isEnabled: () => provider !== undefined,
          banks: () => banks,
          topK,
        }),
      );
    }
  });

  pi.on("input", async (event) => {
    if (activeMemoryMode === "active" || !provider) return;
    const text = event.text ?? "";
    if (!text.trim()) return;
    const query = redactMemoryText(text);
    const promise = searchBanks(provider, query, topK, banks.all);
    // A replaced or never-consumed search must not surface as an unhandled rejection.
    promise.catch(() => {});
    prefetch = { query, promise };
    lastUserText = text;
  });

  pi.on("turn_end", async (event) => {
    if (!captureTurns || !provider || activeMemoryMode === "active" || !lastUserText) return;
    const msg = event.message;
    if (msg.role !== "assistant") return;
    const assistantText = extractText(msg);
    if (!assistantText.trim()) return;

    const userText = redactMemoryText(lastUserText);
    lastUserText = "";
    const activeProvider = provider;
    const activeWriteBank = banks.defaultWrite;
    const activeRegistry = modelRegistry;
    const activeDistillModel = distillModel;
    const transcript = `## User\n\n${userText}\n\n## Assistant\n\n${redactMemoryText(assistantText)}`;
    pendingWrite = pendingWrite
      .catch(() => {})
      .then(async () => {
        if (!activeRegistry) throw new Error("model registry unavailable");
        const facts = await distillFacts(activeRegistry, activeDistillModel, transcript);
        if (facts.length === 0) return;
        await activeProvider.saveFacts(facts, activeWriteBank);
      })
      .catch((err: unknown) => {
        console.error(
          `[mnemosyne] failed to distill turn: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  });

  pi.on("before_agent_start", async () => {
    if (!prefetch) return;
    const pending = prefetch;
    prefetch = null;
    const memories = await Promise.race([
      pending.promise,
      new Promise<MemoryItem[]>((resolve) => setTimeout(() => resolve([]), 3000)),
    ]);
    const fresh = memories
      .filter((m) => m.memory.trim() && !recalledIds.has(m.id))
      .slice(0, MAX_RECALL_ENTRIES);
    fresh.forEach((m) => recalledIds.add(m.id));
    const lines = fresh.map((m) => `- ${formatRecalledMemory(truncateLine(m.memory.trim(), MAX_ENTRY_CHARS).text)}`);
    if (lines.length === 0) return;
    return {
      message: {
        customType: "mnemosyne-recall",
        content: truncateHead(`## Recalled Memories (Mnemosyne)\n${lines.join("\n")}`, {
          maxBytes: MAX_RECALL_BYTES,
          maxLines: MAX_RECALL_LINES,
        }).content,
        display: true,
      },
    };
  });

  pi.registerMessageRenderer(
    "mnemosyne-recall",
    (message, _options, theme) => {
      const raw =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n");
      const entries = raw
        .split("\n")
        .filter((line: string) => line.startsWith("- "))
        .map((line: string) => displayFact(line.slice(2)));
      // Same panel style as the slye rewrite entry: custom-message background,
      // bold heading, markdown body.
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(
        new Text(
          theme.bold(
            `🧠 Recalled Memories — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, untrusted`,
          ),
          0,
          0,
        ),
      );
      box.addChild(new Markdown(entries.join("\n\n"), 0, 1, getMarkdownTheme()));
      return box;
    },
  );

  pi.on("session_compact", () => {
    // Compaction summarizes old recall blocks out of context, so facts shown
    // before compaction become offerable again.
    recalledIds.clear();
  });

  pi.on("session_shutdown", async () => {
    sessionEpoch++;
    recalledIds.clear();
    await pendingWrite;
    if (provider && consolidateOnShutdown) {
      // Consolidation is server-side maintenance; never fail shutdown on it.
      for (const bank of banks.all) {
        try {
          await provider.sleep(bank);
        } catch (err: unknown) {
          if (process.env.DEBUG?.includes("mnemosyne")) {
            console.error(
              `[mnemosyne] sleep failed on ${bank}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
    await provider?.close();
    provider = undefined;
    prefetch = null;
    lastUserText = "";
    pendingWrite = Promise.resolve();
  });

  pi.registerCommand("mnemosyne", {
    description:
      "Mnemosyne memory commands. Subcommands: status, health, search <query>, add [global|project] <text>, delete <memory_id>, sleep.",
    handler: async (args, ctx) => {
      if (!provider) {
        ctx.ui.notify("Mnemosyne is not active (missing url/token).", "warning");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "status";
      const rest = parts.slice(1).join(" ").trim();
      switch (sub) {
        case "status": {
          ctx.ui.notify(
            `Mnemosyne: ${activeUrl} (banks: ${banks.all.join(", ")}, memoryMode: ${activeMemoryMode || "hybrid"})`,
            "info",
          );
          break;
        }
        case "health": {
          const reports: string[] = [];
          for (const bank of banks.all) {
            reports.push(`[${bank}]\n${formatHealth(await provider.stats(bank))}`);
          }
          ctx.ui.notify(`Mnemosyne health:\n${reports.join("\n")}`, "info");
          break;
        }
        case "search": {
          if (!rest) {
            ctx.ui.notify("Usage: /mnemosyne search <query>", "warning");
            break;
          }
          const results = await searchBanks(provider, rest, 10, banks.all);
          if (results.length === 0) {
            ctx.ui.notify("No relevant memories found.", "info");
          } else {
            const lines = results.map((r, i) => `${i + 1}. ${r.id}: ${formatRecalledMemory(r.memory)}`);
            ctx.ui.notify(`Mnemosyne search results:\n${lines.join("\n")}`, "info");
          }
          break;
        }
        case "add": {
          if (!rest) {
            ctx.ui.notify("Usage: /mnemosyne add [global|project] <text>", "warning");
            break;
          }
          const words = rest.split(/\s+/);
          const lead = words[0]?.toLowerCase();
          let target: BankTarget | undefined;
          if (words.length > 1) {
            switch (lead) {
              case "global":
              case "project":
                target = lead;
                break;
            }
          }
          const content = redactMemoryText((target ? words.slice(1) : words).join(" "));
          const bank = banks.resolve(target);
          await provider.add(content, bank);
          ctx.ui.notify(`Saved to ${bank}: ${formatRecalledMemory(content)}`, "info");
          break;
        }
        case "delete": {
          if (!rest) {
            ctx.ui.notify("Usage: /mnemosyne delete <memory_id>", "warning");
            break;
          }
          const status = await deleteFromAnyBank(provider, rest, banks.all);
          ctx.ui.notify(
            status === "deleted" ? `Deleted memory ${rest}.` : `Memory ${rest} not found.`,
            "info",
          );
          break;
        }
        case "sleep": {
          for (const bank of banks.all) await provider.sleep(bank);
          ctx.ui.notify("Mnemosyne consolidation finished.", "info");
          break;
        }
        default:
          ctx.ui.notify(
            "Unknown subcommand. Available: status, health, search, add, delete, sleep.",
            "warning",
          );
      }
    },
  });

  function createMnemosyneMemoryTool(opts: {
    getProvider: () => MnemosyneProvider | undefined;
    isEnabled: () => boolean;
    banks: () => BankSet;
    topK: number;
  }) {
    return {
      name: "mnemosyne_memory",
      label: "Mnemosyne Memory",
      description:
        "Read and manage long-term semantic memories about the user and their projects. " +
        "Memories are durable facts stored in Mnemosyne (BEAM: working + episodic memory).\n\n" +
        "Actions:\n" +
        "- search: hybrid vector+keyword search over memories (requires query)\n" +
        "- add: store a durable fact (requires content; optional importance 0-1, optional bank global|project)\n" +
        "- get: fetch one memory by id (requires memory_id from search results)\n" +
        "- delete: remove a memory by id (requires memory_id)\n" +
        "- stats: show server memory statistics\n" +
        "There is no get_all action; use search instead.",
      promptSnippet: "Search and manage long-term Mnemosyne memories.",
      promptGuidelines: [
        "Search mnemosyne_memory BEFORE answering when the request could depend on the user’s past work, preferences, or prior decisions.",
        "Save durable facts proactively — user preferences, corrections, environment facts. Do not save task progress or temporary session state.",
        "Route adds with the bank param: global for user-wide facts (profile, preferences, requirements), the default project bank for project-specific facts (tech stack, conventions).",
      ],
      parameters: Type.Object({
        action: StringEnum(["search", "add", "get", "delete", "stats"], {
          description: "The memory operation to perform.",
        }),
        query: Type.Optional(Type.String({ description: "Search query. Required for search." })),
        content: Type.Optional(Type.String({ description: "Memory content to store. Required for add." })),
        memory_id: Type.Optional(
          Type.String({
            description: "Memory id to fetch or remove. Required for get and delete.",
          }),
        ),
        importance: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 1,
            description: "Importance for add, between 0 and 1. Defaults to 0.5.",
          }),
        ),
        bank: Type.Optional(
          StringEnum(["global", "project"], {
            description:
              "Target bank for add. global = shared across all projects (user profile, preferences, " +
              "cross-project requirements); project = current project only (tech stack, project conventions). " +
              "Defaults to project.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const action = String(params.action ?? "");
        if (!opts.isEnabled()) return errorResult("mnemosyne_memory is disabled in this session.");
        const active = opts.getProvider();
        if (!active) return errorResult("Mnemosyne is not active.");
        const bs = opts.banks();
        try {
          switch (action) {
            case "search": {
              const query = String(params.query ?? "").trim();
              if (!query) return errorResult("query is required for the search action.");
              return formatBlock(`## Memories matching "${query}"`, await searchBanks(active, query, opts.topK, bs.all));
            }
            case "add": {
              const content = redactMemoryText(String(params.content ?? "").trim());
              if (!content) return errorResult("content is required for the add action.");
              const importance = typeof params.importance === "number" ? params.importance : undefined;
              let target: BankTarget | undefined;
              switch (params.bank) {
                case "global":
                case "project":
                  target = params.bank;
                  break;
              }
              const bank = bs.resolve(target);
              const memoryId = await active.add(content, bank, importance);
              return textResult(`Saved memory ${memoryId} (bank ${bank}): ${formatRecalledMemory(content)}`);
            }
            case "get": {
              const memoryId = String(params.memory_id ?? "").trim();
              if (!memoryId) return errorResult("memory_id is required for the get action.");
              const memory = await getFromAnyBank(active, memoryId, bs.all);
              if (!memory) return textResult(`Memory ${memoryId} not found.`);
              return textResult(formatMemory(memory));
            }
            case "delete": {
              const memoryId = String(params.memory_id ?? "").trim();
              if (!memoryId) return errorResult("memory_id is required for the delete action.");
              const status = await deleteFromAnyBank(active, memoryId, bs.all);
              return textResult(status === "deleted" ? `Deleted memory ${memoryId}.` : `Memory ${memoryId} not found.`);
            }
            case "stats": {
              const stats: Record<string, Record<string, unknown>> = {};
              for (const bank of bs.all) stats[bank] = await active.stats(bank);
              return textResult(JSON.stringify(stats).slice(0, MAX_STATS_CHARS * 2));
            }
            default:
              return errorResult(`Unknown action "${action}". Available: search, add, get, delete, stats.`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[mnemosyne] mnemosyne_memory ${action} failed: ${message}`);
          return errorResult(`mnemosyne_memory ${action} failed: ${message}`);
        }
      },
    };
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }], details: undefined };
}

function formatBlock(title: string, entries: MemoryItem[]) {
  const lines = entries
    .filter((e) => e.memory.trim())
    .map((e) => `- ${e.id}: ${formatRecalledMemory(truncateLine(e.memory.trim(), MAX_ENTRY_CHARS).text)}`);
  if (lines.length === 0) return textResult("No memories found.");
  return textResult(
    truncateHead(`${title}\n${lines.join("\n")}`, { maxBytes: MAX_BLOCK_BYTES, maxLines: MAX_BLOCK_LINES })
      .content,
  );
}

/** Ids are bank-local: try each bank in order until one resolves. */
async function getFromAnyBank(
  provider: MnemosyneProvider,
  memoryId: string,
  banks: string[],
): Promise<Record<string, unknown> | undefined> {
  for (const bank of banks) {
    const memory = await provider.get(memoryId, bank);
    if (memory) return memory;
  }
  return undefined;
}

async function deleteFromAnyBank(
  provider: MnemosyneProvider,
  memoryId: string,
  banks: string[],
): Promise<"deleted" | "not_found"> {
  for (const bank of banks) {
    if ((await provider.delete(memoryId, bank)) === "deleted") return "deleted";
  }
  return "not_found";
}

function formatMemory(memory: Record<string, unknown>): string {
  const content = typeof memory.content === "string" ? memory.content : "";
  const id = typeof memory.id === "string" ? memory.id : "";
  const tier = typeof memory.tier === "string" ? memory.tier : "";
  return `Memory ${id}${tier ? ` (${tier})` : ""}:\n${formatRecalledMemory(content)}`;
}

function formatHealth(h: Record<string, unknown>): string {
  const stats = h.stats && typeof h.stats === "object" ? JSON.stringify(h.stats) : "{}";
  return `- provider: ${h.provider ?? "?"}\n- session: ${h.session_id ?? "?"}\n- stats: ${stats.slice(0, MAX_STATS_CHARS)}`;
}

function extractText(msg: { content: string | Array<{ type: string; text?: string }> }): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}
