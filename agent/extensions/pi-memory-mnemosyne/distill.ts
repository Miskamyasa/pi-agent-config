/**
 * Client-side turn distillation: extract durable facts from a finished turn
 * with a cheap registry model, so the store only ever receives small facts
 * instead of raw transcripts. Mirrors the completion pattern used by the
 * slye extension (registry -> provider -> streamSimple).
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const DISTILL_PROMPT = `You maintain long-term memory for a coding assistant. Extract durable facts from the turn below.

Keep ONLY information that stays true across sessions and is useful later:
- user identity, preferences, and standing workflow rules
- infrastructure facts (servers, domains, topology, credentials placement)
- decisions with lasting effect ("we always/never ...", "X was rejected because ...")

Discard: one-off task state, transient details, code snippets, tool output, anything already obvious from a normal project context. Never invent or guess. If nothing qualifies, return [].

Return ONLY a JSON array of 1-5 short standalone sentences, in the language of the turn. Example:
["User prefers pnpm over npm for all scripts", "Deploy server is example.com behind nginx"]

Turn:
`;

function lowestSupportedThinkingLevel(model: { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> }):
  | (typeof THINKING_LEVELS)[number]
  | undefined {
  if (!model.reasoning) return "off";
  for (const level of THINKING_LEVELS) {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) continue;
    if ((level === "xhigh" || level === "max") && typeof mapped !== "string") continue;
    return level;
  }
  return undefined;
}

/** Best-effort parse: models sometimes wrap the JSON in fences or prose. */
function parseFacts(raw: string): string[] {
  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 5)
      .map((item) => (item.length > 400 ? item.slice(0, 400) + "…" : item));
  } catch {
    return [];
  }
}

export async function distillFacts(
  registry: ModelRegistry,
  modelReference: string,
  transcript: string,
): Promise<string[]> {
  const sep = modelReference.indexOf("/");
  if (sep <= 0 || sep === modelReference.length - 1) {
    throw new Error(`distill model must be "provider/model-id": ${modelReference}`);
  }
  const model = registry.find(modelReference.slice(0, sep), modelReference.slice(sep + 1));
  if (!model) throw new Error(`distill model not found: ${modelReference}`);
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(`distill model has no configured auth: ${modelReference}`);
  }
  const provider = registry.getProvider(model.provider);
  if (!provider) throw new Error(`distill provider unavailable: ${model.provider}`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const effectiveModel = auth.baseUrl === undefined ? model : { ...model, baseUrl: auth.baseUrl };
  const options: Record<string, unknown> = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal: AbortSignal.timeout(45_000),
  };
  const thinkingLevel = lowestSupportedThinkingLevel(model);
  if (thinkingLevel !== undefined && thinkingLevel !== "off") {
    options.reasoning = thinkingLevel;
  }

  const result = await provider.streamSimple(
    effectiveModel,
    { messages: [{ role: "user", content: DISTILL_PROMPT + transcript, timestamp: Date.now() }] },
    options as Parameters<typeof provider.streamSimple>[2],
  ).result();

  const text =
    typeof result.content === "string"
      ? result.content
      : result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return parseFacts(text);
}
