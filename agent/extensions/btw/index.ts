import {
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
import { buildTranscript, completeAnswer } from "./answer.ts";

const USAGE = "Usage: /btw <question>";
const ANSWER_ENTRY_TYPE = "btw.answer";
const ANSWER_HEADING = "🫥 BTW:";

type PiModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;
type UsableModel = { model: PiModel; thinkingLevel: ThinkingLevel };
type AnswerEntryData = { question: string; display: string };

export default function byTheWay(pi: ExtensionAPI): void {
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
      notifyStartupWarning(ctx, 'BTW is not configured. Add "btw": { "model": "<provider>/<model>" } to settings.json.');
      return;
    }
    if (config.kind === "invalid") {
      notifyStartupWarning(ctx, `BTW configuration is invalid at ${config.path}.`);
      return;
    }
    if (resolveUsableModel(ctx, config.config.model) === undefined) {
      notifyStartupWarning(ctx, "BTW's selected model is unavailable or lacks configured auth.");
    }
  });

  pi.registerCommand("btw", {
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

  pi.registerCommand("btw:copy", {
    description: "Copy the last BTW answer to the clipboard",
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
      ctx.ui.notify('BTW is not configured. Add "btw": { "model": "<provider>/<model>" } to settings.json.', "warning");
      return;
    }
    if (config.kind === "invalid") {
      ctx.ui.notify(`BTW configuration is invalid at ${config.path}.`, "warning");
      return;
    }

    const usable = resolveUsableModel(ctx, config.config.model);
    if (usable === undefined) {
      ctx.ui.notify("BTW's selected model is unavailable or lacks configured auth.", "warning");
      return;
    }

    const transcript = buildTranscript(ctx.sessionManager.getBranch());

    ctx.ui.setWorkingMessage("Answering on the side…");
    let outcome;
    try {
      outcome = await completeAnswer(transcript, question, ctx.signal, (context, options) =>
        completeModel(ctx.modelRegistry, usable.model, context, options),
      );
    } finally {
      ctx.ui.setWorkingMessage();
    }

    if (outcome.kind === "cancelled") {
      return;
    }
    if (outcome.kind === "failed") {
      ctx.ui.notify("BTW could not produce an answer.", "warning");
      return;
    }

    // Custom entries do not participate in LLM context: the main session model never sees the answer.
    pi.appendEntry<AnswerEntryData>(ANSWER_ENTRY_TYPE, { question, display: outcome.display });
  }

  async function copyLastAnswer(ctx: ExtensionCommandContext): Promise<void> {
    const entry = findLastAnswerEntry(ctx.sessionManager.getBranch());
    if (entry === undefined) {
      ctx.ui.notify("No BTW answer to copy yet.", "warning");
      return;
    }

    try {
      await copyToClipboard(entry.display);
    } catch (error) {
      ctx.ui.notify(`Could not copy to clipboard: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }

    ctx.ui.notify("Copied last BTW answer to clipboard.", "info");
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
