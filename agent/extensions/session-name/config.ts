/**
 * Session-bar configuration.
 *
 * agent/extensions/session-name/config.json holds one key:
 *   { "model": "provider/model" }
 * The model distills the session name once per session. A missing, unreadable,
 * or malformed file, a bad model string, or an unknown or unauthenticated model
 * only disables distillation. The bar keeps working with the heuristic name and
 * reports the reason once per session.
 */
import { loadModelConfig, type ModelRef } from "../shared/config.ts";

export function loadConfig(): ModelRef | null {
  return loadModelConfig("session-name");
}
