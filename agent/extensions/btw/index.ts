import * as fs from "node:fs";
import { join } from "node:path";

import { contentText, type Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	copyToClipboard,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ResourceLoader,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/**
 * pi-btw-cc — Claude Code-style /btw side questions.
 *
 * `/btw <question>` asks a side question in a floating top-center overlay
 * while the main agent keeps running. The side agent is a real in-memory
 * pi sub-session seeded with the main session's messages, restricted to
 * read-only tools (read/grep/find/ls). Nothing is ever written back to the
 * main conversation; the side thread lives only in this extension instance.
 */

const BTW_SYSTEM_PROMPT = [
	"You are a temporary, read-only side agent answering one quick question for the user.",
	"The main agent continues its work uninterrupted; you share its conversation as background context only.",
	"You have read-only tools (read, grep, find, ls) so you may inspect the repository to answer accurately.",
	"Never claim to have modified anything, and never promise to take any action later.",
	"Answer directly and concisely.",
].join(" ");

const MAX_HISTORY_EXCHANGES = 20;

const BTW_CONFIG_FILENAME = "btw.json";
const BTW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

interface BtwConfigFile {
	model?: unknown;
	thinking?: unknown;
}

/** Model pinned for the side agent via ~/.pi/agent/btw.json. */
type BtwModelResolution =
	| { configured: false }
	| { configured: true; model: Model<any>; thinking?: BtwThinkingLevel };

/**
 * Read the side-agent model config from ~/.pi/agent/btw.json.
 * A missing file or empty `model` means "follow the main session". Anything that
 * looks like a broken config throws so it gets reported, never silently ignored.
 */
function readBtwModelResolution(ctx: ExtensionCommandContext): BtwModelResolution {
	const configPath = join(getAgentDir(), BTW_CONFIG_FILENAME);
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configured: false };
		throw new Error(`btw: cannot read ${configPath}: ${errorMessage(error)}`);
	}
	let config: BtwConfigFile;
	try {
		config = JSON.parse(raw) as BtwConfigFile;
	} catch (error) {
		throw new Error(`btw: invalid JSON in ${configPath}: ${errorMessage(error)}`);
	}
	if (typeof config !== "object" || config === null) {
		throw new Error(`btw: ${configPath} must contain a JSON object`);
	}
	if (typeof config.model !== "string" || config.model.length === 0) return { configured: false };
	let thinking: BtwThinkingLevel | undefined;
	if (config.thinking !== undefined) {
		if (
			typeof config.thinking !== "string" ||
			!BTW_THINKING_LEVELS.includes(config.thinking as BtwThinkingLevel)
		) {
			throw new Error(`btw: invalid "thinking" in ${configPath}: expected one of ${BTW_THINKING_LEVELS.join(", ")}`);
		}
		thinking = config.thinking as BtwThinkingLevel;
	}
	const registry = ctx.modelRegistry;
	const reference = config.model;
	let model: Model<any> | undefined;
	if (reference.includes("/")) {
		const slash = reference.indexOf("/");
		model = registry.find(reference.slice(0, slash), reference.slice(slash + 1));
	} else {
		const matches = registry.getAll().filter((candidate) => candidate.id === reference);
		if (matches.length > 1) {
			throw new Error(`btw: ambiguous model id "${reference}" in ${configPath}, use provider/modelId`);
		}
		model = matches[0];
	}
	if (!model) throw new Error(`btw: unknown model "${reference}" in ${configPath}`);
	if (!registry.hasConfiguredAuth(model)) {
		throw new Error(`btw: no API key for ${model.provider}/${model.id}`);
	}
	return { configured: true, model, thinking };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface BtwExchange {
	question: string;
	answer: string;
	aborted?: boolean;
	error?: string;
}

interface BtwActive {
	question: string;
	answer: string;
	toolName: string | null;
}

/** The single source for "which exchange is on screen": live answer, or a history entry. */
interface BtwSelection {
	question: string;
	answer: string;
	label: string;
	error?: string;
}

interface OverlayRuntime {
	handle?: OverlayHandleLike;
	refresh?: () => void;
	setStatus?: (status: string) => void;
	finish?: () => void;
	closed?: boolean;
	close: () => void;
}

interface OverlayHandleLike {
	focus(): void;
	unfocus(): void;
	hide(): void;
}

function createBtwResourceLoader(ctx: ExtensionCommandContext): ResourceLoader {
	const promptOptions = ctx.getSystemPromptOptions();
	return new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		// Extensions load so provider extensions (e.g. cpa) re-register inside the
		// sub-session's fresh ModelRuntime. Without this, their models have no auth.
		noPromptTemplates: true,
		noThemes: true,
		// customPrompt is the raw prompt text: the dynamic footer is appended fresh by
		// the sub-session's own buildSystemPrompt, so no string surgery is needed.
		// Context files and skills load from disk like a normal session in this cwd.
		systemPrompt: promptOptions.customPrompt,
		appendSystemPrompt: [
			// Keep the main session's appended prompt so project rules are not silently lost.
			...(promptOptions.appendSystemPrompt ? [promptOptions.appendSystemPrompt] : []),
			BTW_SYSTEM_PROMPT,
		],
	});
}

export default function btw(pi: ExtensionAPI) {
	const exchanges: BtwExchange[] = [];
	let active: BtwActive | null = null;
	// Points at the currently displayed exchange; after every ask it is the newest one.
	let viewIndex = 0;
	let overlayRuntime: OverlayRuntime | null = null;
	let subSession: AgentSession | null = null;
	let subscribed = false;

	function setStatus(status: string): void {
		if (overlayRuntime?.setStatus) overlayRuntime.setStatus(status);
	}

	function refreshOverlay(): void {
		overlayRuntime?.refresh?.();
	}

	function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// Context may be replaced while an async ask is in flight.
		}
	}

	function modelLabel(): string {
		const model = subSession?.model;
		return model ? `${model.provider}/${model.id}` : "";
	}

	function currentSelection(): BtwSelection | null {
		if (active) return { question: active.question, answer: active.answer, label: "answering…" };
		const exchange = exchanges[viewIndex];
		if (!exchange) return null;
		const suffix = exchange.aborted ? " (aborted)" : exchange.error ? " (error)" : "";
		return {
			question: exchange.question,
			answer: exchange.answer,
			error: exchange.error,
			label: `${viewIndex + 1}/${exchanges.length}${suffix}`,
		};
	}

	function capHistory(): void {
		while (exchanges.length > MAX_HISTORY_EXCHANGES) {
			exchanges.shift();
			viewIndex = Math.max(0, viewIndex - 1);
		}
	}

	async function ensureBtwSession(
		ctx: ExtensionCommandContext,
		resolution: BtwModelResolution,
	): Promise<AgentSession | null> {
		if (subSession) return subSession;
		const model = resolution.configured ? resolution.model : ctx.model;
		if (!model) {
			notify(ctx, "No active model for /btw (pin one via ~/.pi/agent/btw.json)", "error");
			return null;
		}
		const resourceLoader = createBtwResourceLoader(ctx);
		await resourceLoader.reload();
		// Seed the journal, not agent state: createAgentSession restores messages from a
		// non-empty session manager itself, and compaction rebuilds re-read the journal —
		// a state-only seed would be silently dropped on the first compaction.
		// convertToLlm projects AgentMessage[] (incl. compaction/branch summaries) onto
		// the plain message roles appendMessage accepts.
		const sessionManager = SessionManager.inMemory(ctx.cwd);
		const seed = convertToLlm(
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
		for (const message of seed) sessionManager.appendMessage(message);
		const { session } = await createAgentSession({
			model,
			thinkingLevel: resolution.configured ? (resolution.thinking ?? pi.getThinkingLevel()) : pi.getThinkingLevel(),
			tools: ["read", "grep", "find", "ls"],
			sessionManager,
			resourceLoader,
			// In-memory settings: the sub-session's setModel/setThinkingLevel used to leak
			// into the user's global settings.json through the file-backed default.
			settingsManager: SettingsManager.inMemory(),
		});
		subSession = session;
		return session;
	}

	function handleSessionEvent(event: AgentSessionEvent): void {
		if (!active) return;
		if (event.type === "message_update" && event.message.role === "assistant") {
			active.answer = contentText(event.message.content).trim();
			refreshOverlay();
		} else if (event.type === "tool_execution_start") {
			active.toolName = event.toolName;
			refreshOverlay();
		} else if (event.type === "tool_execution_end") {
			active.toolName = null;
			refreshOverlay();
		}
	}

	function finishExchange(exchange: BtwExchange, status: string): void {
		exchanges.push(exchange);
		active = null;
		viewIndex = exchanges.length - 1;
		capHistory();
		setStatus(status);
		refreshOverlay();
	}

	async function ask(ctx: ExtensionCommandContext, question: string): Promise<void> {
		if (active) {
			setStatus("Still answering — press Esc to abort first.");
			return;
		}
		// Re-read on every ask so edits to btw.json apply without a restart.
		let resolution: BtwModelResolution;
		try {
			resolution = readBtwModelResolution(ctx);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}
		const session = await ensureBtwSession(ctx, resolution);
		if (!session) return;

		if (!subscribed) {
			session.subscribe(handleSessionEvent);
			subscribed = true;
		}

		// A pinned model is never re-synced to the main session's; unpinned follows it.
		try {
			const target = resolution.configured ? resolution.model : ctx.model;
			if (target && (session.model?.provider !== target.provider || session.model?.id !== target.id)) {
				await session.setModel(target);
			}
			session.setThinkingLevel(
				resolution.configured && resolution.thinking ? resolution.thinking : pi.getThinkingLevel(),
			);
		} catch {
			// Keep whatever the sub-session already uses.
		}

		active = { question, answer: "", toolName: null };
		refreshOverlay();
		setStatus("streaming…");

		try {
			await session.prompt(question, { source: "extension" });
		} catch (error) {
			finishExchange(
				{ question, answer: active.answer, error: error instanceof Error ? error.message : String(error) },
				"error",
			);
			return;
		}

		const response = [...session.messages].reverse().find((message) => message.role === "assistant");
		if (response?.stopReason === "aborted") {
			finishExchange({ question, answer: contentText(response.content).trim(), aborted: true }, "aborted");
		} else if (response && response.stopReason !== "error") {
			finishExchange({ question, answer: contentText(response.content).trim() || "(no answer)" }, "");
		} else {
			finishExchange(
				{
					question,
					answer: active.answer,
					error: response?.errorMessage ?? "The side agent returned an error.",
				},
				"error",
			);
		}
	}

	async function abortActive(): Promise<void> {
		if (!active || !subSession) return;
		try {
			await subSession.abort();
		} catch {
			// Abort races are fine; the prompt() call resolves with stopReason "aborted".
		}
	}

	function closeOverlay(): void {
		overlayRuntime?.close();
	}

	async function copyCurrentAnswer(ctx: ExtensionCommandContext): Promise<void> {
		const answer = currentSelection()?.answer;
		if (!answer) {
			setStatus("Nothing to copy yet.");
			return;
		}
		try {
			await copyToClipboard(answer);
			setStatus("Copied markdown answer to clipboard.");
		} catch (error) {
			notify(ctx, `Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	function ensureOverlay(ctx: ExtensionCommandContext): void {
		if (overlayRuntime?.handle) {
			overlayRuntime.handle.focus();
			refreshOverlay();
			return;
		}
		const runtime: OverlayRuntime = {
			close: () => {
				if (runtime.closed) return;
				runtime.closed = true;
				runtime.handle?.hide();
				if (overlayRuntime === runtime) overlayRuntime = null;
				runtime.finish?.();
			},
		};
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					runtime.finish = () => done();

					const overlay = new BtwOverlayComponent(tui, theme, {
						readExchanges: () => exchanges,
						readActive: () => active,
						readViewIndex: () => viewIndex,
						readCurrent: () => currentSelection(),
						readModelLabel: () => modelLabel(),
						setViewIndex: (index) => {
							viewIndex = index;
						},
						onSubmit: (value) => {
							void ask(ctx, value.trim());
						},
						onDismiss: () => {
							if (active) {
								void abortActive();
								return;
							}
							closeOverlay();
						},
						onCopy: () => {
							void copyCurrentAnswer(ctx);
						},
						onUnfocus: () => {
							overlayRuntime?.handle?.unfocus();
							refreshOverlay();
						},
					});

					runtime.refresh = () => overlay.refresh();
					runtime.setStatus = (status: string) => {
						overlay.setStatus(status);
					};

					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "78%",
						minWidth: 64,
						maxHeight: "78%",
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
						nonCapturing: true,
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) runtime.close();
					},
				},
			)
			.catch((error: unknown) => {
				if (overlayRuntime === runtime) overlayRuntime = null;
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			});
	}

	// Toggle focus between the overlay and the main editor while the overlay stays visible.
	for (const shortcut of ["alt+/", "ctrl+alt+w"]) {
		pi.registerShortcut(shortcut as never, {
			description: "Focus the /btw overlay",
			handler: () => {
				if (!overlayRuntime?.handle) return;
				overlayRuntime.handle.focus();
				refreshOverlay();
			},
		});
	}

	pi.registerCommand("btw", {
		description: "Ask a quick side question in an overlay without interrupting the main conversation",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive TUI mode", "error");
				return;
			}
			const question = args.trim();
			if (!question) {
				// No question: just open the overlay on the latest history entry.
				ensureOverlay(ctx);
				refreshOverlay();
				return;
			}
			ensureOverlay(ctx);
			await ask(ctx, question);
		},
	});
}

const BTW_FOCUS_KEYS = [Key.alt(Key.slash), Key.ctrlAlt("w")] as const;

function matchesBtwFocusKey(data: string): boolean {
	return BTW_FOCUS_KEYS.some((key) => matchesKey(data, key));
}

interface BtwOverlayCallbacks {
	readExchanges: () => BtwExchange[];
	readActive: () => BtwActive | null;
	readViewIndex: () => number;
	readCurrent: () => BtwSelection | null;
	readModelLabel: () => string;
	setViewIndex: (index: number) => void;
	onSubmit: (value: string) => void;
	onDismiss: () => void;
	onCopy: () => void;
	onUnfocus: () => void;
}

const CHROME_LINES = 6; // top border, title, rule, status, hints, bottom border (input rows add to this)
const MIN_CONTENT_LINES = 4;

class BtwOverlayComponent implements Component, Focusable {
	private readonly input: Editor;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly callbacks: BtwOverlayCallbacks;
	private status = "";
	private scrollOffset = 0;
	private followBottom = true;
	focused = false;

	constructor(tui: TUI, theme: Theme, callbacks: BtwOverlayCallbacks) {
		this.tui = tui;
		this.theme = theme;
		this.callbacks = callbacks;
		const editorTheme: EditorTheme = {
			// Blank rules: the overlay frame borders the input, the editor must not draw its own.
			borderColor: () => "",
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		this.input = new Editor(tui, editorTheme, { paddingX: 0 });
		this.input.onSubmit = (value) => {
			// Keep the draft when the ask is rejected (still answering); the parent shows a hint.
			if (!this.callbacks.readActive()) this.input.setText("");
			this.followBottom = true;
			this.callbacks.onSubmit(value);
		};
	}

	setStatus(status: string): void {
		this.status = status;
		this.tui.requestRender();
	}

	refresh(): void {
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesBtwFocusKey(data)) {
			this.callbacks.onUnfocus();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onDismiss();
			return;
		}
		const inputEmpty = this.input.getText().length === 0;
		if (inputEmpty) {
			if (matchesKey(data, Key.left)) {
				const index = this.callbacks.readViewIndex();
				if (!this.callbacks.readActive() && index > 0) {
					this.callbacks.setViewIndex(index - 1);
					this.followBottom = false;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.right)) {
				const exchanges = this.callbacks.readExchanges();
				const index = this.callbacks.readViewIndex();
				if (!this.callbacks.readActive() && index < exchanges.length - 1) {
					this.callbacks.setViewIndex(index + 1);
					this.tui.requestRender();
				}
				return;
			}
			if (data === "c" || data === "C") {
				this.callbacks.onCopy();
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.followBottom = false;
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.scrollOffset += 1;
				this.tui.requestRender();
				return;
			}
		}
		this.input.handleInput(data);
	}

	/** Clamp the scroll state against the current content; returns the visible offset. */
	private clampScroll(contentHeight: number, maxRows: number): number {
		if (contentHeight <= maxRows) {
			this.scrollOffset = 0;
			return 0;
		}
		const maxOffset = contentHeight - maxRows;
		if (this.followBottom) this.scrollOffset = maxOffset;
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		if (this.scrollOffset >= maxOffset) this.followBottom = true;
		return this.scrollOffset;
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("border", `├${"─".repeat(Math.max(1, innerWidth))}┤`);
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	/** Render the editor inside the overlay frame; wraps to as many rows as the text needs. */
	private inputFrameLines(innerWidth: number): string[] {
		const previousFocused = this.input.focused;
		// Render the embedded editor unfocused: a visible cursor marker skews the framed rows.
		this.input.focused = false;
		let rendered: string[];
		try {
			rendered = this.input.render(Math.max(1, innerWidth));
		} finally {
			this.input.focused = previousFocused;
		}
		if (rendered.length > 1 && rendered[0].trim() === "" && rendered[rendered.length - 1].trim() === "") {
			// borderColor blanks the editor's top/bottom rules; drop the two empty rows.
			rendered = rendered.slice(1, -1);
		}
		if (rendered.length === 0) rendered = [""];
		return rendered.map((line) => this.frameLine(line, innerWidth));
	}

	render(width: number): string[] {
		const dim = (color: ThemeColor, text: string) => this.theme.fg(color, text);
		const dialogWidth = Math.max(40, width);
		const innerWidth = Math.max(20, dialogWidth - 2);
		const exchanges = this.callbacks.readExchanges();
		const active = this.callbacks.readActive();
		const view = this.callbacks.readCurrent();

		const contentLines: string[] = [];

		// Dimmed one-liners for the other exchanges (Claude Code-style history list).
		for (let i = 0; i < exchanges.length; i++) {
			if (i === this.callbacks.readViewIndex() && !active) continue;
			const oneLiner = truncateToWidth(exchanges[i].question, innerWidth - 4, "…");
			contentLines.push(dim("dim", `  ${i + 1}. ${oneLiner}`));
		}

		if (view) {
			if (contentLines.length > 0) contentLines.push("");
			contentLines.push(dim("accent", `You: ${truncateToWidth(view.question, innerWidth - 5, "…")}`));
			if (view.error) {
				contentLines.push(dim("warning", `⚠ ${view.error}`));
			}
			const answerLines = view.answer
				// Rebuilt per render so markdown styling always follows the live theme.
				? new Markdown(view.answer, 0, 0, getMarkdownTheme()).render(Math.max(1, innerWidth - 2))
				: [dim("dim", active ? "…" : "(empty)")];
			contentLines.push(...answerLines);
		} else if (exchanges.length === 0) {
			contentLines.push(dim("dim", "No side questions yet."));
		}

		const editorLines = this.inputFrameLines(innerWidth);
		const maxRows = Math.max(
			MIN_CONTENT_LINES,
			Math.floor((process.stdout.rows ?? 30) * 0.78) - (CHROME_LINES + editorLines.length),
		);
		const scrollOffset = this.clampScroll(contentLines.length, maxRows);
		const hiddenAbove = contentLines.length > maxRows ? scrollOffset : 0;
		const visible = contentLines.slice(scrollOffset, scrollOffset + maxRows);

		const statusText =
			this.status ||
			(active ? `streaming…${active.toolName ? ` · ${active.toolName}` : ""}` : view ? view.label : "ready");
		const modelText = (() => {
			const label = this.callbacks.readModelLabel();
			return label ? ` · ${label}` : "";
		})();
		const viewLabel = active ? "" : ` · ${exchanges.length} in memory`;
		const scrollHint = hiddenAbove ? ` · ↑${hiddenAbove} above · ↑↓ scroll` : "";

		const lines: string[] = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(dim("accent", `btw · side question${modelText}${viewLabel}`), innerWidth),
			this.ruleLine(innerWidth),
			...visible.map((line) => this.frameLine(line, innerWidth)),
			this.ruleLine(innerWidth),
			this.frameLine(dim("warning", statusText), innerWidth),
			...editorLines,
			this.frameLine(
				dim(
					"dim",
					`enter ask · c copy · ←→ history · alt+/ main editor${scrollHint} · esc ${active ? "abort" : "close"}`,
				),
				innerWidth,
			),
			this.borderLine(innerWidth, "bottom"),
		];
		return lines.map((line) =>
			visibleWidth(line) > dialogWidth ? truncateToWidth(line, dialogWidth, "") : line,
		);
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
