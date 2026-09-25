/**
 * Session name and last-message status.
 *
 * The session name is distilled once per session from the first user message
 * plus a small slice of the project README and agent instructions, then stored
 * with pi.setSessionName so the host shows it. The last user message is
 * published as a status-bar item.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import {
  distillTitle,
  extractUserText,
  firstUserText,
  heuristicTitle,
  lastUserText,
  oneLine,
  readProjectContext,
  resolveModel,
} from "./title.ts";

/** Status key. The insertion order of this key fixes its slot in the status bar. */
const STATUS_KEY = "session-name";
const MAX_STATUS_CHARS = 110;

export default function sessionName(pi: ExtensionAPI): void {
  const config = loadConfig();

  let abort: AbortController | undefined;

  let titleGen = 0;
  let titleStarted = false;
  let nameOwner: "none" | "self" | "external" = "none";
  let name = "";
  let lastMessage = "";

  /** Resolve the name once. One model call, then the heuristic as a fallback. */
  async function beginTitle(extensionCtx: ExtensionContext, prompt: string): Promise<void> {
    const firstPrompt = prompt.trim();
    if (titleStarted || firstPrompt === "") return;
    titleStarted = true;

    const gen = titleGen;
    const model = config ? resolveModel(extensionCtx.modelRegistry, config) : null;

    let title: string | null = null;
    if (model && abort) {
      const projectContext = await readProjectContext(extensionCtx.cwd);
      title = await distillTitle({
        registry: extensionCtx.modelRegistry,
        model,
        prompt: firstPrompt,
        projectContext,
        signal: abort.signal,
      });
    }

    // A shutdown, a session change, or a user rename discards this result.
    if (gen !== titleGen || nameOwner !== "none") return;
    const resolved = title ?? heuristicTitle(firstPrompt);
    if (resolved === "") {
      // An unusable prompt: let a later prompt try again.
      titleStarted = false;
      return;
    }

    name = resolved;
    nameOwner = "self";
    try {
      pi.setSessionName(name);
    } catch {
      // Naming is best effort.
    }
  }

  /** Publish the last user message. Repeated updates keep the key's status slot. */
  function publish(extensionCtx: ExtensionContext): void {
    extensionCtx.ui.setStatus(
      STATUS_KEY, lastMessage === ""
        ? undefined :
        "-> " + lastMessage
    );
  }

  pi.on("session_start", (_event, ctx) => {
    titleGen += 1;
    titleStarted = false;
    abort?.abort();
    abort = new AbortController();

    // Seed from the branch so resume, reload, and fork show the last message.
    lastMessage = oneLine(lastUserText(ctx.sessionManager.getBranch()), MAX_STATUS_CHARS);

    const stored = ctx.sessionManager.getSessionName();
    if (stored) {
      nameOwner = "external";
      name = stored;
    } else {
      nameOwner = "none";
      name = "";
      void beginTitle(ctx, firstUserText(ctx.sessionManager.getBranch()));
    }
    publish(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // A name that a stored session name or branch already produced is left alone.
    if (nameOwner !== "none" || titleStarted || name !== "") return;
    void beginTitle(ctx, event.prompt);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const text = oneLine(extractUserText(event.message.content), MAX_STATUS_CHARS);
    if (text === lastMessage) return;
    lastMessage = text;
    publish(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    lastMessage = oneLine(lastUserText(branch), MAX_STATUS_CHARS);

    const stored = ctx.sessionManager.getSessionName();
    if (stored) {
      nameOwner = "external";
      name = stored;
    } else if (nameOwner === "none") {
      name = heuristicTitle(firstUserText(branch));
    }
    publish(ctx);
  });

  pi.on("session_info_changed", (event) => {
    if (event.name === name) return;
    if (event.name) {
      nameOwner = "external";
      titleGen += 1;
      name = event.name;
      return;
    }
    // A cleared name keeps the shown name; no second distillation.
    nameOwner = "none";
  });

  pi.on("session_shutdown", (_event, ctx) => {
    titleGen += 1;
    abort?.abort();
    abort = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    lastMessage = "";
    name = "";
  });
}
