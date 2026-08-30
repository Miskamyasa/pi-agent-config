import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────

const envUrl = typeof process !== "undefined" ? process.env?.CPA_BASE_URL : undefined;
const BASE_URL = envUrl || "http://localhost:8317";

// Settings file, stores cached model catalog.
const STATE_PATH = join(getAgentDir(), "pi-cpa.json");

// Catalog lifetime; the endpoint sends no Cache‑Control hint.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h.

// Fallbacks when models.dev has no provider/model match.
const DEFAULT_CONTEXT_WINDOW = 199984;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

// models.dev catalogs: source of per-provider model pricing and limits.
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_MODELS_URL = "https://models.dev/models.json";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CPA_COMPAT = { supportsDeveloperRole: false };

const EMPTY_STATE: State = { modelsFetchedAt: null, modelsExpireAt: null, models: null };

let state: State = { ...EMPTY_STATE };
let refreshInFlight: Promise<ProviderModelConfig[]> | null = null;

// ─── Entry Point ────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Load cached state and register any cached models.
  state = await readState();
  registerModels(pi, state.models ?? []);

  // Refresh catalog on process start/reload.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    try {
      await ensureModels(pi, ctx, { force: false });
    } catch (err: any) {
      ctx.ui.notify(`CPA: couldn't load models — ${err.message}.`, "warning");
    }
  });

  // Command /cpa:refresh.
  pi.registerCommand("cpa:refresh", {
    description: "Refresh the CPA model catalog from /v1/models",
    handler: async (_args, ctx) => {
      const before = state.modelsFetchedAt;
      try {
        const models = await ensureModels(pi, ctx, { force: true });
        if (before !== null && state.modelsFetchedAt === before) {
          ctx.ui.notify(
            `CPA: refresh failed — using ${models.length} cached models (from ${new Date(before).toLocaleString()})`,
            "warning",
          );
        } else {
          ctx.ui.notify(`CPA: refreshed ${models.length} models`, "info");
        }
      } catch (err: any) {
        ctx.ui.notify(`CPA: model refresh failed — ${err.message}`, "error");
      }
    },
  });
}

// ─── Model Catalog ─────────────────────────────────────────────────

function registerModels(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider("cpa", {
    name: "CPA",
    baseUrl: BASE_URL + "/v1",
    apiKey: "$CPA_API_KEY",
    api: "openai-completions",
    compat: CPA_COMPAT,
    models,
  });
}

async function ensureModels(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { force: boolean },
): Promise<ProviderModelConfig[]> {
  if (refreshInFlight) return refreshInFlight;
  if (!opts.force && state.modelsExpireAt !== null && Date.now() < state.modelsExpireAt) {
    return state.models ?? [];
  }
  refreshInFlight = refreshModels(pi, ctx).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshModels(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ProviderModelConfig[]> {
  try {
    const models = await fetchModels(ctx);
    registerModels(pi, models);
    return models;
  } catch (err) {
    if (state.models?.length) return state.models;
    throw err;
  }
}

/** Fetch /v1/models, map to ProviderModelConfig, and cache the result. */
async function fetchModels(ctx: ExtensionContext): Promise<ProviderModelConfig[]> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("cpa");
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE_URL}/v1/models`, { headers });
  if (!res.ok) throw new Error(`/v1/models returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: OpenAiModel[] };
  const entries = body.data ?? [];
  if (!entries.length) throw new Error("/v1/models returned empty list");

  const cat = await catalog();
  const models: ProviderModelConfig[] = entries.map((m) => buildModel(m.id, cat));
  state = { modelsFetchedAt: Date.now(), modelsExpireAt: Date.now() + CACHE_TTL_MS, models };
  await writeState(state);
  return models;
}

/**
 * Build a ProviderModelConfig for one CPA model id, sourcing limits and costs
 * from models.dev. Lookup order: by provider (api.json), then by model name in
 * the flat catalog (models.json). Unknown providers/models fall back to
 * DEFAULT_* constants and zero cost.
 */
function buildModel(id: string, cat: ModelsDevData | null): ProviderModelConfig {
  const provider = resolveProvider(id);
  let entry: ModelsDevModel | undefined =
    cat?.providers && provider
      ? findModel(cat.providers[provider]?.models ?? {}, modelKey(id))
      : undefined;
  // Fallback: no provider (or no match there) → search the flat catalog by model name.
  if (!entry && cat?.flat) entry = findInFlat(cat.flat, id);
  const limit = entry?.limit;
  if (!entry || !limit || !isPositive(limit.context) || !isPositive(limit.output)) {
    return {
      id,
      name: formatName(id),
      reasoning: false,
      input: ["text"],
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      cost: ZERO_COST,
      compat: CPA_COMPAT,
    };
  }
  const cost = entry.cost ?? {};
  return {
    id,
    name: formatName(id),
    reasoning: entry.reasoning === true,
    input: (entry.modalities?.input ?? ["text"]).filter((t) => t === "text" || t === "image"),
    contextWindow: limit.context,
    maxTokens: limit.output,
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cache_read ?? 0,
      cacheWrite: cost.cache_write ?? 0,
    },
    compat: CPA_COMPAT,
  };
}

// Fetch and cache the models.dev catalogs in memory for this process.
let catalogPromise: Promise<ModelsDevData | null> | null = null;
async function catalog(): Promise<ModelsDevData | null> {
  catalogPromise ??= fetchCatalog().catch(() => null);
  return catalogPromise;
}

async function fetchCatalog(): Promise<ModelsDevData | null> {
  const [providers, flat] = await Promise.all([
    fetchJson(MODELS_DEV_URL).catch(() => null),
    fetchJson(MODELS_DEV_MODELS_URL).catch(() => null),
  ]);
  return { providers, flat };
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** Map a CPA model id to its models.dev provider key. */
function resolveProvider(id: string): string | null {
  if (id.includes("/")) {
    const prefix = id.split("/")[0].toLowerCase();
    // cdx/codex ids exist under the openai provider on models.dev.
    if (prefix === "cdx" || prefix === "codex") return "openai";
    return prefix;
  }
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gpt-")) return "openai";
  return null;
}

/** The model key to look up inside a provider's models map. */
function modelKey(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

/**
 * Provider lookup in api.json: exact model key, then normalized
 * (case/separator-insensitive) key. No substring matching — a model id must map
 * to a single concrete models.dev model.
 */
function findModel(models: Record<string, ModelsDevModel>, key: string): ModelsDevModel | undefined {
  if (models[key]) return models[key];
  const want = normalize(key);
  return Object.entries(models).find(([k]) => normalize(k) === want)?.[1];
}

/**
 * Flat lookup in models.json (keyed "provider/model-id"): match by model name
 * (the last path segment), ignoring the provider prefix.
 */
function findInFlat(flat: Record<string, ModelsDevModel>, id: string): ModelsDevModel | undefined {
  const want = normalize(modelKey(id));
  return Object.entries(flat).find(
    ([k]) => normalize(k.split("/").pop() ?? k) === want,
  )?.[1];
}

const normalize = (s: string) => s.toLowerCase().replace(/[\s\-/.]/g, "");
const isPositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

async function readState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
    return {
      modelsFetchedAt: typeof parsed?.modelsFetchedAt === "number" ? parsed.modelsFetchedAt : null,
      modelsExpireAt: typeof parsed?.modelsExpireAt === "number" ? parsed.modelsExpireAt : null,
      models: Array.isArray(parsed?.models) ? (parsed.models as ProviderModelConfig[]) : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function writeState(next: State): Promise<void> {
  try {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(next, null, 2));
  } catch {
    // best‑effort
  }
}

function formatName(id: string): string {
  const model = id.includes('/') ? id.split('/').pop()! : id;
  return model.replace(/-/g, " ").trim();
}

// ─── Types ──────────────────────────────────────────────────────────

interface State {
  modelsFetchedAt: number | null;
  modelsExpireAt: number | null;
  models: ProviderModelConfig[] | null;
}

interface OpenAiModel {
  id: string;
}

// models.dev types (https://models.dev/api.json, https://models.dev/models.json)
type ModelsDevData = {
  providers: Record<string, ModelsDevProvider> | null;
  flat: Record<string, ModelsDevModel> | null;
};

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

interface ModelsDevModel {
  reasoning?: boolean;
  limit?: { context?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  modalities?: { input?: string[] };
}
