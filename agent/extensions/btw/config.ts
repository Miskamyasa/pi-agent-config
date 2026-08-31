import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ModelReference = {
  provider: string;
  id: string;
};

export type BtwConfig = {
  model: ModelReference;
};

export type ConfigReadResult =
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string }
  | { kind: "valid"; path: string; config: BtwConfig };

export function getConfigPath(): string {
  return join(getAgentDir(), "settings.json");
}

export async function readConfig(path: string): Promise<ConfigReadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { kind: "missing", path };
  }

  let settings: unknown;
  try {
    settings = JSON.parse(text) as unknown;
  } catch {
    return { kind: "invalid", path };
  }

  if (!isPlainObject(settings) || !("btw" in settings)) {
    return { kind: "missing", path };
  }

  const config = parseBtwConfig(settings.btw);
  return config === undefined ? { kind: "invalid", path } : { kind: "valid", path, config };
}

export function parseModelReference(value: unknown): ModelReference | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const separatorIndex = value.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return undefined;
  }

  const provider = value.slice(0, separatorIndex).trim();
  const id = value.slice(separatorIndex + 1).trim();
  if (provider === "" || id === "") {
    return undefined;
  }

  return { provider, id };
}

function parseBtwConfig(value: unknown): BtwConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "model") {
    return undefined;
  }

  const model = parseModelReference(value.model);
  return model === undefined ? undefined : { model };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
