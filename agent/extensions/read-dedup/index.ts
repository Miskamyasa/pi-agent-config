/**
 * Repeated read deduplication.
 *
 * When the model reads a file that is unchanged since an earlier read in the
 * same conversation, the new tool result becomes a short notice. The earlier
 * result is still in the model context, so a second copy would only add
 * tokens. A changed file, a different range, or an earlier result that left
 * the context (compaction) returns the real content.
 */
import { isReadToolResult, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

/** Marks a result this extension replaced. */
const NOTICE_PREFIX = "[read-dedup]";

interface PriorRead {
  toolCallId: string;
  path: string;
  offset?: number;
  limit?: number;
  text: string;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

/** Text of a single-text-block result. Images and multi-block results return undefined. */
export function textOf(content: readonly { type: string; text?: string }[]): string | undefined {
  if (content.length !== 1 || content[0].type !== "text") return undefined;
  return content[0].text;
}

/**
 * Reads on the branch that still carry file content, oldest first.
 * Results this extension replaced are skipped: they hold no content and must
 * not hide the original read from a later comparison.
 */
export function collectPriorReads(entries: SessionEntry[], cwd: string): PriorRead[] {
  const calls = new Map<string, Record<string, unknown>>();
  const reads: PriorRead[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === "read") calls.set(block.id, block.arguments);
      }
      continue;
    }

    if (message.role !== "toolResult" || message.toolName !== "read" || message.isError) continue;
    const args = calls.get(message.toolCallId);
    if (args === undefined || typeof args.path !== "string") continue;
    const text = textOf(message.content);
    if (text === undefined || text.startsWith(NOTICE_PREFIX)) continue;

    reads.push({
      toolCallId: message.toolCallId,
      path: resolve(cwd, args.path),
      offset: numberArg(args, "offset"),
      limit: numberArg(args, "limit"),
      text,
    });
  }

  return reads;
}

/** Tool call IDs that the next model request still sees. */
export function visibleReadIds(messages: readonly { role: string; toolCallId?: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId !== undefined) ids.add(message.toolCallId);
  }
  return ids;
}

export function notice(read: PriorRead): string {
  const range =
    read.offset === undefined && read.limit === undefined
      ? "the whole file"
      : `offset=${read.offset ?? 1}${read.limit === undefined ? "" : `, limit=${read.limit}`}`;

  return (
    `${NOTICE_PREFIX} ${read.path} is unchanged since your earlier read of ${range}. ` +
    "That content is still in your context, so this result was not repeated."
  );
}

export default function readDedup(pi: ExtensionAPI): void {
  pi.on("tool_result", (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) return;

    const text = textOf(event.content);
    if (text === undefined) return;

    const rawPath = event.input.path;
    if (typeof rawPath !== "string") return;

    const cwd = ctx.sessionManager.getCwd();
    const path = resolve(cwd, rawPath);
    const visible = visibleReadIds(ctx.sessionManager.buildSessionProjection().messages);
    const prior = collectPriorReads(ctx.sessionManager.getBranch(), cwd).find(
      (read) =>
        read.toolCallId !== event.toolCallId &&
        read.path === path &&
        read.text === text &&
        visible.has(read.toolCallId),
    );

    if (prior === undefined) return;

    return {
      content: [{ type: "text" as const, text: notice(prior) }],
      details: undefined,
    };
  });
}
