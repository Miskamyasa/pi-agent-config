import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionMessageEntry,
  getAgentDir,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import {
  CONFIG_FILENAME,
  type EffectiveConfig,
  loadEffectiveConfig,
  type ModelReference,
  readConfig,
  type SlyeConfig,
  writeConfigAtomically,
} from "./config.ts";
import { completeModel, lowestSupportedThinkingLevel, type ThinkingLevel } from "./model-completion.ts";
import { formatModelCandidate, pickModel, selectModelCandidates } from "./model-picker.ts";
import { completeRewrite, type RewriteOutcome } from "./model-rewrite.ts";
import { prepareRewriteRequest } from "./rewrite.ts";

const USAGE = "Usage: /slye model|on|off";
const MODEL_SCOPE_ALL = "All projects";
const MODEL_SCOPE_PROJECT = "This project only";
const REWRITE_ENTRY_TYPE = "slye.rewrite";
const REWRITE_HEADING = "🤌 Speak like you eat:";

type SlyePaths = {
  global: string;
  project: string;
};

type PiModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;
type UsableModel = { model: PiModel; thinkingLevel: ThinkingLevel };
type AgentMessage = AgentEndEvent["messages"][number];
type RewriteEntryData = { display: string };

export default function speakLikeYouEat(pi: ExtensionAPI): void {
  let hasShownStartupWarning = false;
  let hasShownProcessingWarning = false;
  const processedTargetEntryIds = new Set<string>();

  pi.registerEntryRenderer<RewriteEntryData>(REWRITE_ENTRY_TYPE, (entry, _options, theme) => {
    const data = parseRewriteEntryData(entry.data);
    if (data === undefined) {
      return undefined;
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.bold(REWRITE_HEADING), 0, 0));
    box.addChild(new Markdown(data.display, 0, 1, getMarkdownTheme()));
    return box;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }

    const effectiveConfig = await loadConfig(ctx);
    if (effectiveConfig.kind === "unconfigured") {
      notifyStartupWarning(ctx, "SLYE is not configured. Run /slye model.");
      return;
    }
    if (effectiveConfig.kind === "invalid") {
      notifyStartupWarning(ctx, `SLYE configuration is invalid at ${effectiveConfig.path}. Fix it or run /slye model.`);
      return;
    }
    if (!effectiveConfig.config.enabled) {
      return;
    }
    if (resolveUsableModel(ctx, effectiveConfig.config.model) === undefined) {
      notifyStartupWarning(ctx, "SLYE's selected model is unavailable. Run /slye model.");
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }

    try {
      await runRewrite(ctx, event.messages, { force: false });
    } catch {
      notifyProcessingWarning(ctx);
    }
  });

  pi.registerCommand("slye", {
    description: "Configure Speak like you eat",
    getArgumentCompletions: (prefix) => {
      const commands = ["model", "on", "off"];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length === 0 ? null : matches.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        return;
      }

      const command = args.trim();
      if (command === "model") {
        await chooseAndSaveModel(ctx);
        return;
      }
      if (command === "off") {
        await turnOff(ctx);
        return;
      }
      if (command === "on") {
        await turnOn(ctx);
        return;
      }
      if (command === "") {
        await runManualRewrite(ctx);
        return;
      }

      ctx.ui.notify(USAGE, "info");
    },
  });

  function notifyStartupWarning(ctx: ExtensionContext, message: string): void {
    if (hasShownStartupWarning) {
      return;
    }

    hasShownStartupWarning = true;
    ctx.ui.notify(message, "warning");
  }

  function notifyProcessingWarning(ctx: ExtensionContext): void {
    if (hasShownProcessingWarning) {
      return;
    }

    hasShownProcessingWarning = true;
    ctx.ui.notify("SLYE could not create a rewrite.", "warning");
  }

  async function runRewrite(
    ctx: ExtensionContext,
    messages: readonly AgentMessage[],
    options: { force: boolean },
  ): Promise<"rewrote" | "noop"> {
    const effectiveConfig = await loadConfig(ctx);
    if (effectiveConfig.kind !== "valid" || (!effectiveConfig.config.enabled && !options.force)) {
      return "noop";
    }

    const model = resolveUsableModel(ctx, effectiveConfig.config.model);
    if (model === undefined) {
      return "noop";
    }

    const prepared = prepareRewriteRequest(messages, ctx.sessionManager.getBranch());
    if (prepared === undefined) {
      return "noop";
    }
    if (!options.force && processedTargetEntryIds.has(prepared.entryId)) {
      return "noop";
    }
    processedTargetEntryIds.add(prepared.entryId);

    ctx.ui.setWorkingMessage("Rewriting AI-speak…");
    let outcome: RewriteOutcome;
    try {
      outcome = await completeRewrite(prepared.request, ctx.signal, (request, options) =>
        completeModel(ctx.modelRegistry, model.model, request, options),
      );
    } finally {
      ctx.ui.setWorkingMessage();
    }

    if (outcome.kind === "cancelled") {
      return "noop";
    }
    if (outcome.kind === "failed") {
      notifyProcessingWarning(ctx);
      return "noop";
    }

    pi.appendEntry<RewriteEntryData>(REWRITE_ENTRY_TYPE, { display: outcome.display });
    return "rewrote";
  }

  async function runManualRewrite(ctx: ExtensionCommandContext): Promise<void> {
    const last = findLastAssistantMessage(ctx.sessionManager.getBranch());
    if (last === undefined) {
      ctx.ui.notify("No assistant message to rewrite.", "warning");
      return;
    }

    try {
      const result = await runRewrite(ctx, [last.message], { force: true });
      if (result === "noop") {
        ctx.ui.notify("Nothing to rewrite. The last message is not eligible or SLYE is not enabled.", "warning");
      }
    } catch {
      notifyProcessingWarning(ctx);
    }
  }
}

async function chooseAndSaveModel(ctx: ExtensionCommandContext): Promise<void> {
  const scopedCandidates = selectModelCandidates(
    ctx.scopedModels.map(({ model }) => model),
    (model) => ctx.modelRegistry.hasConfiguredAuth(model),
  );
  const allCandidates = selectModelCandidates(ctx.modelRegistry.getAvailable(), (model) =>
    ctx.modelRegistry.hasConfiguredAuth(model),
  );
  if (scopedCandidates.length === 0 && allCandidates.length === 0) {
    ctx.ui.notify("No authenticated models are available for SLYE.", "warning");
    return;
  }

  const selected = await pickModel(ctx, scopedCandidates, allCandidates);
  if (selected === undefined) {
    return;
  }

  const projectTrusted = ctx.isProjectTrusted();
  const scopes = projectTrusted ? [MODEL_SCOPE_ALL, MODEL_SCOPE_PROJECT] : [MODEL_SCOPE_ALL];
  const selectedScope = await ctx.ui.select("Save SLYE model for", scopes);
  if (selectedScope === undefined) {
    return;
  }

  const config: SlyeConfig = {
    enabled: true,
    model: { provider: selected.provider, id: selected.id },
  };
  const paths = getConfigPaths(ctx);

  if (selectedScope === MODEL_SCOPE_PROJECT) {
    await saveEnabledConfig(ctx, paths.project, config.model, MODEL_SCOPE_PROJECT, selected.thinkingLevel);
    return;
  }

  if (selectedScope === MODEL_SCOPE_ALL) {
    await saveGlobalConfig(ctx, paths, projectTrusted, config, formatModelCandidate(selected));
  }
}

async function saveGlobalConfig(
  ctx: ExtensionCommandContext,
  paths: SlyePaths,
  projectTrusted: boolean,
  config: SlyeConfig,
  label: string,
): Promise<void> {
  let removeProjectConfig = false;
  if (projectTrusted) {
    const projectConfig = await readConfig(paths.project);
    if (projectConfig.kind !== "missing") {
      const confirmed = await ctx.ui.confirm(
        "Project SLYE configuration",
        "The project file takes precedence over and blocks the global setting in this project. Remove it and use the global setting?",
      );
      if (!confirmed) {
        return;
      }
      removeProjectConfig = true;
    }
  }

  try {
    await writeConfigAtomically(paths.global, config);
  } catch {
    ctx.ui.notify("Could not save SLYE configuration.", "warning");
    return;
  }

  if (removeProjectConfig) {
    try {
      await rm(paths.project);
    } catch {
      ctx.ui.notify(
        "Global SLYE configuration was saved, but the project file could not be removed. The project file still takes precedence in this project.",
        "warning",
      );
      return;
    }
  }

  ctx.ui.notify(`SLYE enabled with ${label} for All projects.`, "info");
}

async function turnOff(ctx: ExtensionCommandContext): Promise<void> {
  const effectiveConfig = await loadConfig(ctx);
  if (effectiveConfig.kind === "invalid") {
    ctx.ui.notify(`SLYE configuration is invalid at ${effectiveConfig.path}. It was not changed.`, "warning");
    return;
  }
  const path = effectiveConfig.kind === "valid" ? effectiveConfig.path : getConfigPaths(ctx).global;
  const model = effectiveConfig.kind === "valid" ? effectiveConfig.config.model : undefined;
  const config: SlyeConfig = model === undefined ? { enabled: false } : { enabled: false, model };

  try {
    await writeConfigAtomically(path, config);
  } catch {
    ctx.ui.notify("Could not save SLYE configuration.", "warning");
    return;
  }

  ctx.ui.notify("SLYE is off.", "info");
}

async function turnOn(ctx: ExtensionCommandContext): Promise<void> {
  const effectiveConfig = await loadConfig(ctx);
  if (effectiveConfig.kind === "invalid") {
    ctx.ui.notify(`SLYE configuration is invalid at ${effectiveConfig.path}. Repair it or run /slye model.`, "warning");
    return;
  }
  if (effectiveConfig.kind === "valid" && effectiveConfig.config.model !== undefined) {
    const model = effectiveConfig.config.model;
    const usableModel = resolveUsableModel(ctx, model);
    if (usableModel !== undefined) {
      const scope = effectiveConfig.scope === "project" ? MODEL_SCOPE_PROJECT : MODEL_SCOPE_ALL;
      await saveEnabledConfig(ctx, effectiveConfig.path, model, scope, usableModel.thinkingLevel);
      return;
    }
  }

  await chooseAndSaveModel(ctx);
}

async function saveEnabledConfig(
  ctx: ExtensionCommandContext,
  path: string,
  model: ModelReference,
  scope: string,
  thinkingLevel: ThinkingLevel,
): Promise<void> {
  try {
    await writeConfigAtomically(path, { enabled: true, model });
  } catch {
    ctx.ui.notify("Could not save SLYE configuration.", "warning");
    return;
  }

  ctx.ui.notify(`SLYE enabled with ${formatModelCandidate({ ...model, thinkingLevel })} for ${scope}.`, "info");
}

function parseRewriteEntryData(data: unknown): RewriteEntryData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  if (!("display" in data) || typeof data.display !== "string") {
    return undefined;
  }

  return { display: data.display };
}

function findLastAssistantMessage(branch: readonly SessionEntry[]): SessionMessageEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message.role === "assistant") {
      return entry;
    }
  }

  return undefined;
}

async function loadConfig(ctx: ExtensionContext): Promise<EffectiveConfig> {
  const paths = getConfigPaths(ctx);
  return loadEffectiveConfig(paths.global, paths.project, ctx.isProjectTrusted());
}

function getConfigPaths(ctx: ExtensionContext): SlyePaths {
  return {
    global: join(getAgentDir(), CONFIG_FILENAME),
    project: join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILENAME),
  };
}

function resolveUsableModel(ctx: ExtensionContext, reference: ModelReference): UsableModel | undefined {
  const model = ctx.modelRegistry.find(reference.provider, reference.id);
  if (model === undefined) {
    return undefined;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    return undefined;
  }

  const thinkingLevel = lowestSupportedThinkingLevel(model);
  if (thinkingLevel === undefined) {
    return undefined;
  }

  return { model, thinkingLevel };
}
