/**
 * Session-bar configuration.
 *
 * agent/extensions/session-name/config.json holds one key:
 *   { "model": "provider/model" }
 * The model distills the session name once per session. A missing, unreadable,
 * or malformed file, a bad model string, or an unknown or unauthenticated model
 * only disables distillation. The bar keeps working with the heuristic name.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(getAgentDir(), "extensions", "session-name", "config.json");

export interface ModelRef {
  provider: string;
  id: string;
}

/** Split "provider/model" at the first slash. Return null for anything else. */
export function parseModelRef(value: unknown): ModelRef | null {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function loadConfig(): ModelRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parseModelRef((parsed as { model?: unknown }).model);
}
