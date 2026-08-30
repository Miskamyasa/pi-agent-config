import type { ExtensionCommandContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  type KeybindingsManager,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { lowestSupportedThinkingLevel, type ThinkingLevel } from "./model-completion.ts";

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;
type PickerScope = "scoped" | "all";

const MAX_VISIBLE_CANDIDATES = 10;

export type ModelCandidate = {
  provider: string;
  id: string;
  name: string;
  thinkingLevel: ThinkingLevel;
};

export function selectModelCandidates(
  models: readonly PiModel[],
  hasConfiguredAuth: (model: PiModel) => boolean,
): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];

  for (const model of models) {
    if (!hasConfiguredAuth(model)) {
      continue;
    }

    const thinkingLevel = lowestSupportedThinkingLevel(model);
    if (thinkingLevel === undefined) {
      continue;
    }

    if (candidates.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      continue;
    }

    const name = typeof model.name === "string" && model.name.trim() !== "" ? model.name : model.id;
    candidates.push({
      provider: model.provider,
      id: model.id,
      name,
      thinkingLevel,
    });
  }

  return candidates.sort(compareCandidates);
}

export function filterModelCandidates(candidates: readonly ModelCandidate[], search: string): ModelCandidate[] {
  return fuzzyFilter([...candidates], search, (candidate) => `${candidate.provider} ${candidate.id} ${candidate.name}`);
}

export async function pickModel(
  ctx: ExtensionCommandContext,
  scopedCandidates: ModelCandidate[],
  allCandidates: ModelCandidate[],
): Promise<ModelCandidate | undefined> {
  const initialScope: PickerScope = scopedCandidates.length > 0 ? "scoped" : "all";

  return ctx.ui.custom<ModelCandidate | undefined>(
    (tui, theme, keybindings, done) =>
      new ModelPicker(tui, theme, keybindings, scopedCandidates, allCandidates, initialScope, done),
  );
}

export function formatModelCandidate(candidate: Pick<ModelCandidate, "provider" | "id" | "thinkingLevel">): string {
  return `${candidate.provider} / ${candidate.id} · thinking: ${candidate.thinkingLevel}`;
}

function compareCandidates(left: ModelCandidate, right: ModelCandidate): number {
  if (left.provider !== right.provider) {
    return left.provider < right.provider ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

class ModelPicker extends Container implements Focusable {
  private readonly input = new Input();
  private readonly candidatesByScope: Record<PickerScope, ModelCandidate[]>;
  private readonly onDone: (candidate: ModelCandidate | undefined) => void;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private scope: PickerScope;
  private filteredCandidates: ModelCandidate[] = [];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    scopedCandidates: ModelCandidate[],
    allCandidates: ModelCandidate[],
    initialScope: PickerScope,
    onDone: (candidate: ModelCandidate | undefined) => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.candidatesByScope = { scoped: scopedCandidates, all: allCandidates };
    this.scope = initialScope;
    this.onDone = onDone;
    this.updateCandidates();
    this.updateContent();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onDone(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.toggleScope();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selectedCandidate = this.filteredCandidates[this.selectedIndex];
      if (selectedCandidate !== undefined) {
        this.onDone(selectedCandidate);
      }
      return;
    }

    this.input.handleInput(data);
    this.updateCandidates();
    this.updateContent();
    this.tui.requestRender();
  }

  private get canSwitchScope(): boolean {
    return this.candidatesByScope.scoped.length > 0;
  }

  private toggleScope(): void {
    if (this.scope === "all" && !this.canSwitchScope) {
      return;
    }

    this.scope = this.scope === "scoped" ? "all" : "scoped";
    this.updateCandidates();
    this.updateContent();
    this.tui.requestRender();
  }

  private moveSelection(change: number): void {
    if (this.filteredCandidates.length === 0) {
      return;
    }

    this.selectedIndex =
      (this.selectedIndex + change + this.filteredCandidates.length) % this.filteredCandidates.length;
    this.updateContent();
    this.tui.requestRender();
  }

  private updateCandidates(): void {
    const selectedCandidate = this.filteredCandidates[this.selectedIndex];
    const candidates = this.candidatesByScope[this.scope];
    const nextCandidates = filterModelCandidates(candidates, this.input.getValue());
    const selectedIndex = selectedCandidate === undefined ? -1 : findCandidateIndex(nextCandidates, selectedCandidate);

    this.filteredCandidates = nextCandidates;
    this.selectedIndex = selectedIndex === -1 ? 0 : selectedIndex;
  }

  private updateContent(): void {
    this.clear();
    this.addChild(new DynamicBorder((text) => this.theme.fg("accent", text)));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Choose a SLYE model")), 1, 0));
    const scopeHint = this.canSwitchScope ? " (Tab to switch)" : "";
    this.addChild(new Text(this.theme.fg("muted", `Scope: ${scopeLabel(this.scope)}${scopeHint}`), 1, 0));
    this.addChild(new Text(this.theme.fg("muted", "Search:"), 1, 0));
    this.addChild(this.input);
    this.addChild(new Spacer());

    const displayedCandidates = visibleCandidates(this.filteredCandidates, this.selectedIndex);
    if (displayedCandidates.length === 0) {
      this.addChild(new Text(this.theme.fg("warning", "No matching authenticated models."), 1, 0));
    } else {
      for (const [index, candidate] of displayedCandidates) {
        const prefix = index === this.selectedIndex ? "> " : "  ";
        const modelName = candidate.name === candidate.id ? "" : ` (${candidate.name})`;
        const text = `${prefix}${formatModelCandidate(candidate)}${modelName}`;
        const styled = index === this.selectedIndex ? this.theme.fg("accent", text) : text;
        this.addChild(new Text(styled, 1, 0));
      }
    }

    this.addChild(new Spacer());
    const footerHint = this.canSwitchScope
      ? "Tab scope · ↑↓ navigate · Enter select · Esc cancel"
      : "↑↓ navigate · Enter select · Esc cancel";
    this.addChild(new Text(this.theme.fg("dim", footerHint), 1, 0));
    this.addChild(new DynamicBorder((text) => this.theme.fg("accent", text)));
  }
}

function findCandidateIndex(candidates: ModelCandidate[], selected: ModelCandidate): number {
  return candidates.findIndex((candidate) => candidate.provider === selected.provider && candidate.id === selected.id);
}

function visibleCandidates(candidates: ModelCandidate[], selectedIndex: number): Array<[number, ModelCandidate]> {
  const start = Math.floor(selectedIndex / MAX_VISIBLE_CANDIDATES) * MAX_VISIBLE_CANDIDATES;
  return candidates.slice(start, start + MAX_VISIBLE_CANDIDATES).map((candidate, index) => [start + index, candidate]);
}

function scopeLabel(scope: PickerScope): string {
  return scope === "scoped" ? "Scoped models" : "All authenticated models";
}
