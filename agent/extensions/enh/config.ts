/**
 * Prompt enhancer configuration.
 *
 * agent/extensions/enh/config.json holds one key:
 *   { "model": "provider/model" }
 * The model rewrites the text that /enh receives. A missing, unreadable, or
 * malformed file, a bad model string, or an unknown or unauthenticated model
 * only disables the command.
 */
import { loadModelConfig, type ModelRef } from "../shared/config.ts";

export function loadConfig(): ModelRef | null {
  return loadModelConfig("enh");
}

/** Abort the model call after this delay, so a hung request cannot block the editor. */
export const ENH_TIMEOUT_MS = 60_000;

/** Instruction sent to the model. {selection} is replaced with the given text. */
export const ENH_PROMPT = [
  "Act as a spelling corrector, content writer, and text improver/editor. Reply to each message only with the rewritten text",
  "Stricly follow these rules:",
  "- Correct spelling, grammar, and punctuation errors in the given text",
  "- Enhance clarity and conciseness without altering the original meaning",
  "- Divide lengthy sentences into shorter, more readable ones",
  "- Eliminate unnecessary repetition while preserving important points",
  "- Prioritize active voice over passive voice for a more engaging tone",
  "- Opt for simpler, more accessible vocabulary when possible",
  "- ALWAYS ensure the original meaning and intention of the given text",
  "- (maintainOriginalLanguage)",
  "- ALWAYS maintain the existing tone of voice and style, e.g. formal, casual, polite, etc.",
  "- NEVER surround the improved text with quotes or any additional formatting",
  "- If the text is already well-written and requires no improvement, don't change the given text",
  "",
  "Text: {selection}",
  "",
  "Improved Text:",
].join("\n");

/** Fill the prompt template. Every occurrence of the placeholder is replaced. */
export function buildPrompt(selection: string): string {
  return ENH_PROMPT.replaceAll("{selection}", selection);
}
