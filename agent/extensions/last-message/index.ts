/**
 * Shows the last user message in a widget below the editor.
 *
 * The widget is seeded from the session branch at start and reseeded on /tree
 * navigation, because those paths add no user message_start event.
 */
import type { ExtensionAPI, ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "last-message";
const LABEL = "last ▸ ";
const MAX_CHARS = 200;

/** Collapse whitespace and cap the length. Code points stay intact. */
export function truncateMessage(text: string, limit = MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : collapsed;
}

/** Join the text blocks of stored user content. Return "" for other content. */
export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    const block = part as { type?: unknown; text?: unknown } | null;
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join(" ");
}

/** Return the text of the last user message in an entry list, or "". */
export function findLastUserText(entries: readonly SessionEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role !== "user") continue;
    return extractUserText(entry.message.content);
  }
  return "";
}

export default function lastMessage(pi: ExtensionAPI): void {
  let tui: TUI | undefined;
  let ui: ExtensionUIContext | undefined;
  let text = "";

  function update(next: string): void {
    if (next === text) return;
    text = next;
    tui?.requestRender();
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    text = findLastUserText(ctx.sessionManager.getBranch());
    ui = ctx.ui;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (widgetTui) => {
        tui = widgetTui;
        return {
          render(width: number): string[] {
            if (text === "") return [];
            // Read the theme at render time so a theme switch applies here.
            const body = truncateMessage(text);
            const label = ui ? ui.theme.fg("dim", LABEL) : LABEL;
            return [truncateToWidth(label + body, width)];
          },
          invalidate(): void {},
        };
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    update(extractUserText(event.message.content));
  });

  pi.on("session_tree", (_event, ctx) => {
    update(findLastUserText(ctx.sessionManager.getBranch()));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    tui = undefined;
  });
}
