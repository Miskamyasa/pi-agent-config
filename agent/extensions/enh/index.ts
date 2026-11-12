/**
 * Prompt enhancer.
 *
 * /enh <text> sends the text to the configured model and puts the rewritten
 * text into the prompt editor, where the user can review it before sending.
 * The main conversation is untouched.
 */
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildPrompt, ENH_TIMEOUT_MS, loadConfig, type ModelRef } from "./config.ts";

/** Find the configured model. Return null when it is unknown or unauthenticated. */
function resolveModel(registry: ModelRegistry, ref: ModelRef): Model<Api> | null {
  const model = registry.find(ref.provider, ref.id);
  if (!model || !registry.hasConfiguredAuth(model)) return null;
  return model;
}

/** Ask the model to rewrite the text. Return null on any failure. */
async function enhance(registry: ModelRegistry, model: Model<Api>, text: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENH_TIMEOUT_MS);
  try {
    const response = await registry.complete(
      model,
      { messages: [{ role: "user", content: buildPrompt(text), timestamp: Date.now() }] },
      { maxTokens: 4096, temperature: 0, signal: controller.signal },
    );
    return contentText(response.content).trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export default function enh(pi: ExtensionAPI): void {
  const config = loadConfig();

  pi.registerCommand("enh", {
    description: "Fix spelling and grammar of the given text and put the result in the prompt box",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/enh requires interactive TUI mode", "error");
        return;
      }
      const text = args.trim();
      if (text === "") {
        ctx.ui.notify("/enh needs text: /enh <text>", "error");
        return;
      }
      if (!config) {
        ctx.ui.notify("/enh is disabled: set \"model\" in extensions/enh/config.json", "error");
        return;
      }
      const model = resolveModel(ctx.modelRegistry, config);
      if (!model) {
        ctx.ui.notify(`/enh: model ${config.provider}/${config.id} is unknown or has no credentials`, "error");
        return;
      }

      ctx.ui.notify("Enhancing text…", "info");
      const result = await enhance(ctx.modelRegistry, model, text);
      if (result === null) {
        ctx.ui.notify("/enh failed: the model returned no usable text", "error");
        return;
      }
      ctx.ui.setEditorText(result);
    },
  });
}
