/**
 * Shared model lookup for a "provider/model" reference.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "./config.ts";

/** Outcome of a model lookup: the model, or the reason it is unusable. */
export type ModelLookup = { model: Model<Api> } | { reason: string };

/**
 * Find a configured model. The reasons are sentence fragments, so callers
 * append them to the provider/model they were given.
 */
export function resolveModel(registry: ModelRegistry, ref: ModelRef): ModelLookup {
  const model = registry.find(ref.provider, ref.id);
  if (!model) return { reason: "is not in the model catalog" };
  if (!registry.hasConfiguredAuth(model)) return { reason: "has no credentials" };
  return { model };
}
