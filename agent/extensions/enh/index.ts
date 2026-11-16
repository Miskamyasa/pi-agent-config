/**
 * Prompt enhancer.
 *
 * /enh <text> sends the text to the configured model and puts the rewritten
 * text into the prompt editor, where the user can review it before sending.
 * The main conversation is untouched.
 */
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../shared/model.ts";
import { buildPrompt, ENH_TIMEOUT_MS, loadConfig } from "./config.ts";

/** Result of one model call. */
type EnhOutcome = { kind: "ok"; text: string } | { kind: "failed"; reason: string };

/**
 * Ask the model to rewrite the text. Report the failure reason instead of
 * swallowing it: an empty answer from a reasoning model looks identical to a
 * transport error otherwise. The given signal cancels the call, so the user
 * can abort the loader while the request is in flight.
 */
async function enhance(
  registry: ModelRegistry,
  model: Model<Api>,
  text: string,
  signal: AbortSignal,
): Promise<EnhOutcome> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  const timeout = setTimeout(() => controller.abort(), ENH_TIMEOUT_MS);
  try {
    const response = await registry.complete(
      model,
      { messages: [{ role: "user", content: buildPrompt(text), timestamp: Date.now() }] },
      { signal: controller.signal },
    );
    const result = contentText(response.content).trim();
    if (result !== "") return { kind: "ok", text: result };
    const blocks = response.content.map((block) => block.type).join(", ") || "none";
    const detail = response.errorMessage ?? `stopReason: ${response.stopReason}, blocks: ${blocks}`;
    return { kind: "failed", reason: detail };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
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
      const lookup = resolveModel(ctx.modelRegistry, config);
      if ("reason" in lookup) {
        ctx.ui.notify(`/enh: model ${config.provider}/${config.id} ${lookup.reason}`, "error");
        return;
      }

      const outcome = await ctx.ui.custom<EnhOutcome | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, `Enhancing text with ${config.provider}/${config.id}…`);
        loader.onAbort = () => done(null);
        enhance(ctx.modelRegistry, lookup.model, text, loader.signal).then(done);
        return loader;
      });

      if (outcome === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }
      if (outcome.kind === "failed") {
        ctx.ui.notify(`/enh failed: ${outcome.reason}`, "error");
        return;
      }
      ctx.ui.setEditorText(outcome.text);
      // setEditorText() does not request a TUI render (pi issue #5620), so the
      // new text stays invisible until the next key press. The notification
      // forces the repaint and confirms the result.
      ctx.ui.notify("Enhanced. Review the prompt, then send.", "info");
    },
  });
}
