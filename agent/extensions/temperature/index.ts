/**
 * Per-model temperature overrides.
 *
 * Reads a flat map from agent/extensions/temperature/config.json:
 *   { "*": 0.2, "provider/model": 0.7, "model-id": null }
 * "*" applies to every model. A bare key matches the model id under any
 * provider. A null value (read as undefined) explicitly leaves a model
 * untouched. The most specific key wins: "provider/model", then bare
 * model id, then "*".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_PATH = join(getAgentDir(), "extensions", "temperature", "config.json");

type LoadedConfig = { kind: "ok"; values: Map<string, number | undefined> } | { kind: "invalid" };

export default async function temperature(pi: ExtensionAPI): Promise<void> {
  const config = await loadConfig();

  if (config.kind === "invalid") {
    let warned = false;
    pi.on("session_start", async (_event, ctx) => {
      if (warned) return;
      warned = true;
      ctx.ui.notify(`temperature: invalid config — fix or remove ${CONFIG_PATH}`, "warning");
    });
    return;
  }

  if (config.values.size === 0) return;

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const value = resolveTemperature(config.values, model.provider, model.id);
    if (value === undefined) return;
    return { ...(event.payload as Record<string, unknown>), temperature: value };
  });
}

/**
 * Most specific key wins: "provider/model", then bare model id, then "*".
 * An undefined entry means "leave untouched" and suppresses less specific keys.
 */
export function resolveTemperature(
  values: ReadonlyMap<string, number | undefined>,
  provider: string,
  modelId: string,
): number | undefined {
  for (const key of [`${provider}/${modelId}`, modelId, "*"]) {
    if (values.has(key)) {
      return values.get(key);
    }
  }
  return undefined;
}

async function loadConfig(): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(CONFIG_PATH, "utf8");
  } catch {
    return { kind: "ok", values: new Map() };
  }

  if (text.trim() === "") {
    return { kind: "ok", values: new Map() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }

  const values = new Map<string, number | undefined>();
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      return { kind: "invalid" };
    }
    values.set(key, value === null ? undefined : value);
  }
  return { kind: "ok", values };
}
