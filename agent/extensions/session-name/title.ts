/**
 * Session-name distillation.
 *
 * The name is the first row of the session bar. It comes from the stored
 * session name when one exists. Otherwise one model call sees the first user
 * message and a small slice of the project README and agent instructions.
 * Any failure falls back to a heuristic cut of the first user message.
 */
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRef } from "./config.ts";

const MAX_NAME_CHARS = 120;
const MAX_CONTEXT_CHARS = 2048;
const PROJECT_FILES = ["README.md", "AGENTS.md", "CLAUDE.md"];

const FILLER_PREFIX =
  /^(can you |could you |please |i want you to |i'd like you to |i need you to |help me |i need to |let's |let us )+/i;

/** Collapse whitespace and cap the length. Code points stay intact. */
export function oneLine(text: string, limit = MAX_NAME_CHARS): string {
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

/** Text of the first user message in an entry list, or "". */
export function firstUserText(entries: readonly SessionEntry[]): string {
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    if (entry.message.role !== "user") continue;
    return extractUserText(entry.message.content);
  }
  return "";
}

/** Text of the last user message in an entry list, or "". */
export function lastUserText(entries: readonly SessionEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role !== "user") continue;
    return extractUserText(entry.message.content);
  }
  return "";
}

/** Name used when the model is unavailable or its answer is unusable. */
export function heuristicTitle(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const stripped = firstLine.replace(FILLER_PREFIX, "").trim().replace(/[.。]+$/, "");
  const capitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return oneLine(capitalized);
}

/** Read a small slice of the project README and agent instructions. */
export async function readProjectContext(cwd: string, files = PROJECT_FILES): Promise<string> {
  const parts: string[] = [];
  for (const name of files) {
    try {
      const slice = (await readFile(join(cwd, name), "utf8")).slice(0, MAX_CONTEXT_CHARS);
      if (slice.trim() !== "") parts.push(`# ${name}\n${slice}`);
    } catch {
      // Missing file: skip it.
    }
  }
  return parts.join("\n\n");
}

/** Find the configured model. Return null when it is unknown or unauthenticated. */
export function resolveModel(registry: ModelRegistry, ref: ModelRef): Model<Api> | null {
  const model = registry.find(ref.provider, ref.id);
  if (!model || !registry.hasConfiguredAuth(model)) return null;
  return model;
}

export interface DistillOptions {
  registry: ModelRegistry;
  model: Model<Api>;
  prompt: string;
  projectContext: string;
  signal: AbortSignal;
}

/**
 * Ask the configured model for a name of one or two sentences.
 * Return null on any failure so the caller keeps the heuristic name.
 */
export async function distillTitle(options: DistillOptions): Promise<string | null> {
  const { registry, model, prompt, projectContext, signal } = options;
  const instruction = [
    "Name this coding session in one or two short sentences.",
    "Start with an action verb.",
    "Use the README.md and AGENTS.md excerpts below, when present, to pick accurate project terms.",
    "Answer with the name only: plain text, no quotes, no markdown.",
  ].join(" ");
  const body = projectContext === ""
    ? `Request:\n${prompt}`
    : `Project files:\n${projectContext}\n\nRequest:\n${prompt}`;

  try {
    const response = await registry.complete(
      model,
      { messages: [{ role: "user", content: `${instruction}\n\n${body}`, timestamp: Date.now() }] },
      { maxTokens: 96, temperature: 0, signal },
    );
    return oneLine(contentText(response.content)) || null;
  } catch {
    return null;
  }
}
