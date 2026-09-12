/**
 * btw Extension
 * Local patched copy of L2ncE/pi-btw.
 *
 * Ask a quick side question in an overlay without interrupting the main
 * conversation.
 */
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
// Each session owns a live side agent; keep only a few so the seeded main
// conversation is not copied into memory without bound.
const MAX_SIDE_SESSIONS = 10;

const BTW_CONFIG_FILENAME = "config.json";
const BTW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

interface BtwConfigFile {
	model?: unknown;
	thinking?: unknown;
}

/** Model pinned for the side agent via ~/.pi/agent/extensions/btw/config.json. */
type BtwModelResolution =
	| { configured: false }
	| { configured: true; model: Model<any>; thinking?: BtwThinkingLevel };

/**
 * Read the side-agent model config from ~/.pi/agent/extensions/btw/config.json.
 * A missing file or empty `model` means "follow the main session". Anything that
 * looks like a broken config throws so it gets reported, never silently ignored.
 */
function readBtwModelResolution(ctx: ExtensionCommandContext): BtwModelResolution {
	const configPath = join(getAgentDir(), "extensions", "btw", BTW_CONFIG_FILENAME);
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

interface BtwSession {
	subSession: AgentSession | null;
	subscribed: boolean;
	exchanges: BtwExchange[];
	// Points at the currently displayed exchange; after every ask it is the newest one.
	viewIndex: number;
	active: BtwActive | null;
}

function createBtwSession(): BtwSession {
	return { subSession: null, subscribed: false, exchanges: [], viewIndex: 0, active: null };
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
	// Each session keeps its own side agent and its own Q&A thread. The popup
	// shows one session at a time; `n` starts a new one.
	const sessions: BtwSession[] = [createBtwSession()];
	let sessionIndex = 0;
	let overlayRuntime: OverlayRuntime | null = null;

	function currentSession(): BtwSession {
		return sessions[sessionIndex];
	}

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
		const model = currentSession().subSession?.model;
		return model ? `${model.provider}/${model.id}` : "";
	}

	function sessionLabel(): string {
		return `${sessionIndex + 1}/${sessions.length}`;
	}

	function currentSelection(): BtwSelection | null {
		const session = currentSession();
		if (session.active) {
			return { question: session.active.question, answer: session.active.answer, label: "answering…" };
		}
		const exchange = session.exchanges[session.viewIndex];
		if (!exchange) return null;
		const suffix = exchange.aborted ? " (aborted)" : exchange.error ? " (error)" : "";
		return {
			question: exchange.question,
			answer: exchange.answer,
			error: exchange.error,
			label: `${session.viewIndex + 1}/${session.exchanges.length}${suffix}`,
		};
	}

	function capHistory(session: BtwSession): void {
		while (session.exchanges.length > MAX_HISTORY_EXCHANGES) {
			session.exchanges.shift();
			session.viewIndex = Math.max(0, session.viewIndex - 1);
		}
	}

	async function ensureBtwSession(
		session: BtwSession,
		ctx: ExtensionCommandContext,
		resolution: BtwModelResolution,
	): Promise<AgentSession | null> {
		if (session.subSession) return session.subSession;
		const model = resolution.configured ? resolution.model : ctx.model;
		if (!model) {
			notify(ctx, "No active model for /btw (pin one via ~/.pi/agent/extensions/btw/config.json)", "error");
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
		const { session: agentSession } = await createAgentSession({
			model,
			thinkingLevel: resolution.configured ? (resolution.thinking ?? pi.getThinkingLevel()) : pi.getThinkingLevel(),
			tools: ["read", "grep", "find", "ls"],
			sessionManager,
			resourceLoader,
			// In-memory settings: the sub-session's setModel/setThinkingLevel used to leak
			// into the user's global settings.json through the file-backed default.
			settingsManager: SettingsManager.inMemory(),
		});
		session.subSession = agentSession;
		return agentSession;
	}

	function handleSessionEvent(session: BtwSession, event: AgentSessionEvent): void {
		if (!session.active) return;
		if (event.type === "message_update" && event.message.role === "assistant") {
			session.active.answer = contentText(event.message.content).trim();
		} else if (event.type === "tool_execution_start") {
			session.active.toolName = event.toolName;
		} else if (event.type === "tool_execution_end") {
			session.active.toolName = null;
		} else {
			return;
		}
		if (session === currentSession()) refreshOverlay();
	}

	function finishExchange(session: BtwSession, exchange: BtwExchange, status: string): void {
		session.exchanges.push(exchange);
		session.active = null;
		session.viewIndex = session.exchanges.length - 1;
		capHistory(session);
		if (session === currentSession()) {
			setStatus(status);
			refreshOverlay();
		}
	}

	async function ask(ctx: ExtensionCommandContext, question: string): Promise<void> {
		const session = currentSession();
		if (session.active) {
			setStatus("Still answering — press Esc to abort first.");
			return;
		}
		// Re-read on every ask so edits to the config apply without a restart.
		let resolution: BtwModelResolution;
		try {
			resolution = readBtwModelResolution(ctx);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}
		const agent = await ensureBtwSession(session, ctx, resolution);
		if (!agent) return;

		if (!session.subscribed) {
			agent.subscribe((event) => handleSessionEvent(session, event));
			session.subscribed = true;
		}

		// A pinned model is never re-synced to the main session's; unpinned follows it.
		try {
			const target = resolution.configured ? resolution.model : ctx.model;
			if (target && (agent.model?.provider !== target.provider || agent.model?.id !== target.id)) {
				await agent.setModel(target);
			}
			agent.setThinkingLevel(
				resolution.configured && resolution.thinking ? resolution.thinking : pi.getThinkingLevel(),
			);
		} catch {
			// Keep whatever the sub-session already uses.
		}

		session.active = { question, answer: "", toolName: null };
		if (session === currentSession()) {
			refreshOverlay();
			setStatus("streaming…");
		}

		try {
			await agent.prompt(question, { source: "extension" });
		} catch (error) {
			finishExchange(session, { question, answer: session.active?.answer ?? "", error: errorMessage(error) }, "error");
			return;
		}

		const response = [...agent.messages].reverse().find((message) => message.role === "assistant");
		if (response?.stopReason === "aborted") {
			finishExchange(session, { question, answer: contentText(response.content).trim(), aborted: true }, "aborted");
		} else if (response && response.stopReason !== "error") {
			finishExchange(session, { question, answer: contentText(response.content).trim() || "(no answer)" }, "");
		} else {
			finishExchange(
				session,
				{
					question,
					answer: session.active?.answer ?? "",
					error: response?.errorMessage ?? "The side agent returned an error.",
				},
				"error",
			);
		}
	}

	async function abortActive(): Promise<void> {
		const session = currentSession();
		if (!session.active || !session.subSession) return;
		try {
			await session.subSession.abort();
		} catch {
			// Abort races are fine; the prompt() call resolves with stopReason "aborted".
		}
	}

	/** Drop a session's side agent; only the oldest session is evicted this way. */
	function disposeSession(session: BtwSession): void {
		if (session.active) void session.subSession?.abort().catch(() => {});
		session.subSession?.dispose();
		session.subSession = null;
		session.subscribed = false;
		session.active = null;
	}

	/** Start a fresh side session seeded from the main session on its first ask. */
	function newSession(): void {
		if (sessions.length >= MAX_SIDE_SESSIONS) {
			const oldest = sessions.shift();
			if (oldest) disposeSession(oldest);
			sessionIndex = Math.max(0, sessionIndex - 1);
		}
		sessions.push(createBtwSession());
		sessionIndex = sessions.length - 1;
		setStatus("New side session — ask a question.");
		refreshOverlay();
	}

	function selectSession(delta: number): void {
		const next = sessionIndex + delta;
		if (next < 0 || next >= sessions.length) return;
		sessionIndex = next;
		setStatus("");
		refreshOverlay();
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
						readExchanges: () => currentSession().exchanges,
						readActive: () => currentSession().active,
						readViewIndex: () => currentSession().viewIndex,
						readCurrent: () => currentSelection(),
						readModelLabel: () => modelLabel(),
						readSessionLabel: () => sessionLabel(),
						setViewIndex: (index) => {
							currentSession().viewIndex = index;
						},
						onSubmit: (value) => {
							void ask(ctx, value.trim());
						},
						onDismiss: () => {
							if (currentSession().active) {
								void abortActive();
								return;
							}
							closeOverlay();
						},
						onCopy: () => {
							void copyCurrentAnswer(ctx);
						},
						onNewSession: () => {
							newSession();
						},
						onSelectSession: (delta) => {
							selectSession(delta);
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
	readSessionLabel: () => string;
	setViewIndex: (index: number) => void;
	onSubmit: (value: string) => void;
	onDismiss: () => void;
	onCopy: () => void;
	onNewSession: () => void;
	onSelectSession: (delta: number) => void;
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
		if (matchesKey(data, Key.alt("left"))) {
			this.callbacks.onSelectSession(-1);
			return;
		}
		if (matchesKey(data, Key.alt("right"))) {
			this.callbacks.onSelectSession(1);
			return;
		}
		const inputEmpty = this.input.getText().length === 0;
		if (inputEmpty) {
			if (data === "n" || data === "N") {
				this.callbacks.onNewSession();
				return;
			}
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
		const sessionText = ` · session ${this.callbacks.readSessionLabel()}`;
		const modelText = (() => {
			const label = this.callbacks.readModelLabel();
			return label ? ` · ${label}` : "";
		})();
		const viewLabel = active ? "" : ` · ${exchanges.length} in memory`;
		const scrollHint = hiddenAbove ? ` · ↑${hiddenAbove} above · ↑↓ scroll` : "";

		const lines: string[] = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(dim("accent", `btw · side question${sessionText}${modelText}${viewLabel}`), innerWidth),
			this.ruleLine(innerWidth),
			...visible.map((line) => this.frameLine(line, innerWidth)),
			this.ruleLine(innerWidth),
			this.frameLine(dim("warning", statusText), innerWidth),
			...editorLines,
			this.frameLine(
				dim(
					"dim",
					`enter ask · n new · c copy · ←→ history · alt+←→ session · alt+/ editor${scrollHint} · esc ${active ? "abort" : "close"}`,
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
