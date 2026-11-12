/**
 * Shared extension configuration helpers.
 *
 * Hand-edited config lives in <agentDir>/extensions/<name>/config.json. The
 * path follows the agent directory, not the code location, so an npm-installed
 * or project-local copy of an extension still reads the agent-dir config.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Absolute path of a file in an extension folder. */
export function extensionFilePath(name: string, file = "config.json"): string {
  return join(getAgentDir(), "extensions", name, file);
}

/** Parsed JSON of an extension file. Return undefined when it is unreadable. */
export function readExtensionJson(name: string, file = "config.json"): unknown {
  try {
    return JSON.parse(readFileSync(extensionFilePath(name, file), "utf8"));
  } catch {
    return undefined;
  }
}

/** The "model" key of an extension config. Return null when unusable. */
export function loadModelConfig(name: string): ModelRef | null {
  const parsed = readExtensionJson(name);
  if (typeof parsed !== "object" || parsed === null) return null;
  return parseModelRef((parsed as { model?: unknown }).model);
}
