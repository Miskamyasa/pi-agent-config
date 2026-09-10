import {
  BorderedLoader,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getMarkdownTheme,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { getConfigPath, readConfig, type ModelReference } from "./config.ts";
import { completeModel, lowestSupportedThinkingLevel, type ThinkingLevel } from "./completion.ts";
import { buildTranscript, completeAnswer, type AnswerOutcome } from "./answer.ts";

const USAGE = "Usage: /aside <question>";
const ANSWER_ENTRY_TYPE = "aside.answer";
const ANSWER_HEADING = "🫥 Aside:";

type PiModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;
type UsableModel = { model: PiModel; thinkingLevel: ThinkingLevel };
type AnswerEntryData = { question: string; display: string };

export default function aside(pi: ExtensionAPI): void {
  let hasShownStartupWarning = false;

  pi.registerEntryRenderer<AnswerEntryData>(ANSWER_ENTRY_TYPE, (entry, _options, theme) => {
    const data = parseAnswerEntryData(entry.data);
    if (data === undefined) {
      return undefined;
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.bold(`${ANSWER_HEADING} ${data.question}`), 0, 0));
    box.addChild(new Markdown(data.display, 0, 1, getMarkdownTheme()));
    return box;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }

    const config = await readConfig(getConfigPath());
    if (config.kind === "missing") {
      notifyStartupWarning(ctx, 'Aside is not configured. Add "aside": { "model": "<provider>/<model>" } to settings.json.');
      return;
    }
    if (config.kind === "invalid") {
      notifyStartupWarning(ctx, `Aside configuration is invalid at ${config.path}.`);
      return;
    }
    if (resolveUsableModel(ctx, config.config.model) === undefined) {
      notifyStartupWarning(ctx, "Aside's selected model is unavailable or lacks configured auth.");
    }
  });

  pi.registerCommand("aside", {
    description: "Ask a side question answered by a separate model",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        return;
      }

      const question = args.trim();
      if (question === "") {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      await runAnswer(question, ctx);
    },
  });

  pi.registerCommand("aside:copy", {
    description: "Copy the last Aside answer to the clipboard",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        return;
      }

      await copyLastAnswer(ctx);
    },
  });

  function notifyStartupWarning(ctx: ExtensionContext, message: string): void {
    if (hasShownStartupWarning) {
      return;
    }

    hasShownStartupWarning = true;
    ctx.ui.notify(message, "warning");
  }

  async function runAnswer(question: string, ctx: ExtensionCommandContext): Promise<void> {
    const config = await readConfig(getConfigPath());
    if (config.kind === "missing") {
      ctx.ui.notify('Aside is not configured. Add "aside": { "model": "<provider>/<model>" } to settings.json.', "warning");
      return;
    }
    if (config.kind === "invalid") {
      ctx.ui.notify(`Aside configuration is invalid at ${config.path}.`, "warning");
      return;
    }

    const usable = resolveUsableModel(ctx, config.config.model);
    if (usable === undefined) {
      ctx.ui.notify("Aside's selected model is unavailable or lacks configured auth.", "warning");
      return;
    }

    const transcript = buildTranscript(ctx.sessionManager.getBranch());

    const outcome = await ctx.ui.custom<AnswerOutcome>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Answering on the side…");
      loader.onAbort = () => done({ kind: "cancelled" });

      completeAnswer(transcript, question, loader.signal, (context, options) =>
        completeModel(ctx.modelRegistry, usable.model, context, options),
      ).then(done);

      return loader;
    });

    if (outcome.kind === "cancelled") {
      return;
    }
    if (outcome.kind === "failed") {
      ctx.ui.notify("Aside could not produce an answer.", "warning");
      return;
    }

    // Custom entries do not participate in LLM context: the main session model never sees the answer.
    pi.appendEntry<AnswerEntryData>(ANSWER_ENTRY_TYPE, { question, display: outcome.display });
  }

  async function copyLastAnswer(ctx: ExtensionCommandContext): Promise<void> {
    const entry = findLastAnswerEntry(ctx.sessionManager.getBranch());
    if (entry === undefined) {
      ctx.ui.notify("No Aside answer to copy yet.", "warning");
      return;
    }

    try {
      await copyToClipboard(entry.display);
    } catch (error) {
      ctx.ui.notify(`Could not copy to clipboard: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }

    ctx.ui.notify("Copied last Aside answer to clipboard.", "info");
  }
}

function findLastAnswerEntry(branch: readonly SessionEntry[]): AnswerEntryData | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === ANSWER_ENTRY_TYPE) {
      const data = parseAnswerEntryData(entry.data);
      if (data !== undefined) {
        return data;
      }
    }
  }

  return undefined;
}

function parseAnswerEntryData(data: unknown): AnswerEntryData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  if (!("question" in data) || typeof data.question !== "string") {
    return undefined;
  }
  if (!("display" in data) || typeof data.display !== "string") {
    return undefined;
  }

  return { question: data.question, display: data.display };
}

function resolveUsableModel(ctx: ExtensionContext, reference: ModelReference): UsableModel | undefined {
  const model = ctx.modelRegistry.find(reference.provider, reference.id);
  if (model === undefined) {
    return undefined;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    return undefined;
  }

  const thinkingLevel = lowestSupportedThinkingLevel(model);
  if (thinkingLevel === undefined) {
    return undefined;
  }

  return { model, thinkingLevel };
}
