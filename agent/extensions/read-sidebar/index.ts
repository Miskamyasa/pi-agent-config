/**
 * Read sidebar.
 *
 * `/files` toggles a persistent right-side overlay listing files with read
 * results retained in the current context, largest token estimate first.
 * The overlay never takes keyboard focus, so typing keeps working while it
 * is visible. It spans 40% of the terminal height, sticks to the top, and
 * keeps the prompt bar clear.
 */
import {
  estimateTokens,
  isReadToolResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionProjection,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, resolve } from "node:path";
import { truncateToWidth, visibleWidth, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

/** One file with a successful read result in the current context. */
export interface ReadRecord {
  path: string;
  /** Number of successful reads. */
  count: number;
  /** Highest token estimate among the reads of this file. */
  tokens: number;
}

/** Fraction of the terminal height covered by the sidebar. */
const HEIGHT_FRACTION = 0.4;
const PANEL_WIDTH = 40;
/** Hide the panel on terminals too narrow for content plus the panel. */
const MIN_TERMINAL_WIDTH = 70;
/** Border rows around the file list. */
const CHROME_ROWS = 3;

export function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

/** Parent folder name, or "" when the file has no meaningful parent. */
export function parentName(path: string): string {
  const parent = basename(dirname(path));
  return parent === "." || parent === "/" || parent === "" ? "" : parent;
}

export interface CollectedRead {
  path: string;
  tokens: number;
}

/** Successful reads in projected context, in read order, with token estimates. */
export function collectReads(messages: SessionProjection["messages"], cwd: string): CollectedRead[] {
  const calls = new Map<string, string>();
  const reads: CollectedRead[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === "read" && typeof block.arguments.path === "string") {
          calls.set(block.id, resolve(cwd, block.arguments.path));
        }
      }
      continue;
    }

    if (message.role !== "toolResult" || message.toolName !== "read" || message.isError) continue;
    const path = calls.get(message.toolCallId);
    if (path !== undefined) reads.push({ path, tokens: estimateTokens(message) });
  }

  return reads;
}

/** Highest token estimate first; then alphabetical for a stable order. */
export function sortedReads(reads: Iterable<ReadRecord>): ReadRecord[] {
  return [...reads].sort((a, b) => {
    if (a.tokens !== b.tokens) return b.tokens - a.tokens;
    return a.path.localeCompare(b.path);
  });
}

/**
 * The visible sidebar. It is shown as a non-capturing overlay, so it never
 * receives keyboard input and only renders.
 */
class ReadSidebar implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly reads: Map<string, ReadRecord>;

  constructor(tui: TUI, theme: Theme, reads: Map<string, ReadRecord>) {
    this.tui = tui;
    this.theme = theme;
    this.reads = reads;
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const border = (text: string) => th.fg("border", text);
    const pad = (text: string) => truncateToWidth(text, innerW, "…", true);

    const all = sortedReads(this.reads.values());
    const totalTokens = all.reduce((sum, read) => sum + read.tokens, 0);
    const title = truncateToWidth(
      th.fg("accent", ` files read · ${all.length} · ${formatTokens(totalTokens)} tokens `),
      innerW,
    );
    const titleWidth = visibleWidth(title);
    const leftDash = "─".repeat(Math.floor((innerW - titleWidth) / 2));
    const rightDash = "─".repeat(Math.max(0, innerW - titleWidth - leftDash.length));

    const height = Math.max(1, Math.floor(this.tui.terminal.rows * HEIGHT_FRACTION));
    const listRows = Math.max(1, height - CHROME_ROWS);
    const content: string[] = [];
    if (all.length === 0) {
      content.push(th.fg("dim", " No read results in context"));
    } else {
      // Basenames appearing more than once get a parent-folder suffix.
      const seen = new Map<string, number>();
      for (const read of all) {
        const base = basename(read.path);
        seen.set(base, (seen.get(base) ?? 0) + 1);
      }
      for (const read of all.slice(0, listRows)) {
        content.push(this.row(read, innerW, (seen.get(basename(read.path)) ?? 0) > 1));
      }
    }
    while (content.length < listRows) content.push("");

    const overflow = Math.max(0, all.length - listRows);
    const footer = overflow > 0 ? th.fg("dim", ` +${overflow} more`) : "";

    const lines = [border(`╭${leftDash}`) + title + border(`${rightDash}╮`)];
    for (const line of content) lines.push(border("│") + pad(line) + border("│"));
    lines.push(border("│") + pad(footer) + border("│"));
    lines.push(border(`╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  private row(read: ReadRecord, innerW: number, shared: boolean): string {
    const th = this.theme;
    const tokens = formatTokens(read.tokens);
    const prefix = read.count > 1 ? th.fg("dim", `${read.count}× `) : "";
    const suffix = shared ? ` (${parentName(read.path)})` : "";
    const labelWidth = Math.max(
      1,
      innerW - 2 - visibleWidth(tokens) - 1 - visibleWidth(prefix) - visibleWidth(suffix),
    );
    const label = truncateToWidth(basename(read.path), labelWidth);
    const name = `${prefix}${label}${suffix}`;
    const gap = " ".repeat(Math.max(1, innerW - 2 - visibleWidth(name) - visibleWidth(tokens)));
    return ` ${name}${gap}${th.fg("dim", tokens)}`;
  }

  /** No cached state: every render recomputes from the live read set. */
  invalidate(): void {}
}

/** Zero-height widget used only to capture the TUI instance. */
const BOOTSTRAP_CONTROLLER: Component = {
  render: () => [],
  invalidate: () => {},
};

/** Widget key for the throwaway TUI capture; removed immediately. */
const CAPTURE_WIDGET_KEY = "read-sidebar.capture";

export default function readSidebar(pi: ExtensionAPI): void {
  const reads = new Map<string, ReadRecord>();
  let tui: TUI | null = null;
  let handle: OverlayHandle | null = null;
  // Intended visibility. The overlay itself can disappear without our consent.
  let visible = false;

  function record(path: string, tokens: number): void {
    const existing = reads.get(path);
    if (existing) {
      existing.count += 1;
      // A repeated read can be a short dedup notice; keep the largest estimate.
      existing.tokens = Math.max(existing.tokens, tokens);
    } else {
      reads.set(path, { path, count: 1, tokens });
    }
  }

  function rebuild(ctx: ExtensionContext): void {
    const messages = ctx.sessionManager.buildSessionProjection().messages;
    reads.clear();
    for (const read of collectReads(messages, ctx.sessionManager.getCwd())) record(read.path, read.tokens);
    tui?.requestRender();
  }

  /**
   * The TUI is only reachable through a UI component factory. A zero-height
   * widget avoids `ctx.ui.custom`, whose cleanup hides the topmost overlay and
   * could close an unrelated overlay instead of a throwaway component.
   */
  function ensureTui(ctx: ExtensionCommandContext): TUI | null {
    if (tui) return tui;
    ctx.ui.setWidget(CAPTURE_WIDGET_KEY, (captured) => {
      tui = captured;
      return BOOTSTRAP_CONTROLLER;
    });
    ctx.ui.setWidget(CAPTURE_WIDGET_KEY, undefined);
    return tui;
  }

  function hideSidebar(): void {
    handle?.hide();
    handle = null;
    visible = false;
  }

  function showSidebar(ctx: ExtensionCommandContext, captured: TUI): void {
    hideSidebar();
    handle = captured.showOverlay(new ReadSidebar(captured, ctx.ui.theme, reads), {
      nonCapturing: true,
      anchor: "top-right",
      width: PANEL_WIDTH,
      margin: { right: 1 },
      visible: (termWidth) => termWidth >= MIN_TERMINAL_WIDTH,
    });
    visible = true;
  }

  /**
   * `getBounds()` returns undefined once the overlay leaves the stack. Another
   * overlay's `ctx.ui.custom` cleanup hides the topmost overlay, which can be
   * this one, so a cached handle alone cannot prove the sidebar is still shown.
   */
  function isOnScreen(): boolean {
    return visible && handle !== null && handle.getBounds() !== undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    // The UI reset hides only the topmost overlay; drop any surviving sidebar.
    hideSidebar();
    rebuild(ctx);
  });
  pi.on("session_tree", (_event, ctx) => rebuild(ctx));
  pi.on("session_compact", (_event, ctx) => rebuild(ctx));
  pi.on("session_shutdown", () => hideSidebar());

  pi.on("tool_result", (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) return;
    const rawPath = event.input.path;
    if (typeof rawPath !== "string") return;

    const tokens = estimateTokens({
      role: "toolResult",
      toolCallId: event.toolCallId,
      toolName: "read",
      content: event.content,
      isError: false,
      timestamp: 0,
    });
    record(resolve(ctx.sessionManager.getCwd(), rawPath), tokens);
    tui?.requestRender();
  });

  pi.registerCommand("files", {
    description: "Toggle files read in current context (by token estimate)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/files needs interactive mode", "error");
        return;
      }

      const captured = ensureTui(ctx);
      if (!captured) return;

      if (isOnScreen()) {
        hideSidebar();
        return;
      }
      if (captured.terminal.columns < MIN_TERMINAL_WIDTH) {
        ctx.ui.notify(`/files needs a terminal at least ${MIN_TERMINAL_WIDTH} columns wide`, "warning");
        return;
      }
      showSidebar(ctx, captured);
    },
  });
}
