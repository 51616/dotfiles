// @lat: [[command-palette#Prompt-template instant insertion]]

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SlashCommandInfo, Theme } from "@mariozechner/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@mariozechner/pi-tui";
import {
	buildPromptTemplateInsertionText,
	getFallbackCurrentLineText,
	hasPromptTemplatePlaceholders,
	loadPromptTemplateBody,
	parsePromptTemplateArgs,
	substitutePromptTemplateArgs,
} from "./lib/prompt-templates.ts";

type PaletteCommandSource = "builtin" | SlashCommandInfo["source"];

type PaletteCommand = {
	name: string;
	description?: string;
	source: PaletteCommandSource;
	scope?: string;
	path?: string;
};

type BuiltinCommand = {
	name: string;
	description: string;
};

type PaletteAction = "execute" | "insert";

type PaletteSelection = {
	command: PaletteCommand;
	action: PaletteAction;
};

type EditorLike = {
	getCursor(): { line: number; col: number };
	getLines(): string[];
};

type AutocompleteEditorLike = EditorLike & {
	handleInput(data: string): void;
	isShowingAutocomplete(): boolean;
	cancelAutocomplete?: () => void;
};

const PALETTE_COMMAND = "palette";
const PALETTE_SHORTCUT = Key.ctrlShift("p");
const PALETTE_FALLBACK_SHORTCUT = Key.ctrlAlt("p");
const MAX_VISIBLE_COMMANDS = 8;
const COMMAND_LIST_VIEWPORT_ROWS = MAX_VISIBLE_COMMANDS + 1;
const MIN_DESCRIPTION_WIDTH = 16;
const MAX_FRAME_WIDTH = 116;
const GROUP_ORDER: Record<PaletteCommandSource, number> = {
	builtin: 0,
	prompt: 1,
	extension: 2,
	skill: 3,
};

const BUILTIN_COMMANDS: BuiltinCommand[] = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit pi" },
];

function comparePaletteCommands(left: PaletteCommand, right: PaletteCommand): number {
	const groupDiff = GROUP_ORDER[left.source] - GROUP_ORDER[right.source];
	if (groupDiff !== 0) {
		return groupDiff;
	}
	return left.name.localeCompare(right.name);
}

export function comparePaletteCommandsForDisplay(left: PaletteCommand, right: PaletteCommand): number {
	const executableDiff = Number(isDirectlyExecutable(right)) - Number(isDirectlyExecutable(left));
	if (executableDiff !== 0) {
		return executableDiff;
	}
	return comparePaletteCommands(left, right);
}

function normalizeCommandDescription(description?: string): string {
	return description ? description.replace(/\s+/g, " ").trim() : "";
}

function getSearchText(command: PaletteCommand): string {
	return [
		command.name,
		normalizeCommandDescription(command.description),
		getSourceBadge(command),
		isDirectlyExecutable(command) ? "executable" : "insert",
		command.scope,
		command.path,
	]
		.filter(Boolean)
		.join(" ");
}

function getSourceBadge(command: PaletteCommand): string {
	return command.source === "builtin" ? "core" : command.source;
}

function isPromptCommand(command: PaletteCommand): command is PaletteCommand & { source: "prompt"; path: string } {
	return command.source === "prompt" && typeof command.path === "string" && command.path.length > 0;
}

function isEditorLike(value: unknown): value is EditorLike {
	return !!value && typeof value === "object" && typeof (value as Partial<EditorLike>).getCursor === "function" && typeof (value as Partial<EditorLike>).getLines === "function";
}

export function isAutocompleteEditorLike(value: unknown): value is AutocompleteEditorLike {
	return (
		isEditorLike(value) &&
		typeof (value as Partial<AutocompleteEditorLike>).handleInput === "function" &&
		typeof (value as Partial<AutocompleteEditorLike>).isShowingAutocomplete === "function"
	);
}

export function isDirectlyExecutable(command: PaletteCommand): boolean {
	if (isPromptCommand(command)) {
		return true;
	}
	return ["compact", "name", "new", "quit", "reload", "resume", "session"].includes(command.name);
}

export function getFocusedEditorCurrentLineText(tui: TUI): string | null {
	const focusedComponent = (tui as TUI & { focusedComponent?: unknown }).focusedComponent;
	if (!isEditorLike(focusedComponent)) {
		return null;
	}
	const { line } = focusedComponent.getCursor();
	return focusedComponent.getLines()[line] ?? "";
}

export function dismissFocusedEditorAutocomplete(tui: TUI): void {
	const focusedComponent = (tui as TUI & { focusedComponent?: unknown }).focusedComponent;
	if (!isAutocompleteEditorLike(focusedComponent) || !focusedComponent.isShowingAutocomplete()) {
		return;
	}
	if (typeof focusedComponent.cancelAutocomplete === "function") {
		focusedComponent.cancelAutocomplete();
		return;
	}
	focusedComponent.handleInput("\x1b");
}

function styleCommandName(theme: Theme, command: PaletteCommand, text: string, selected: boolean): string {
	if (isDirectlyExecutable(command)) {
		return theme.fg("success", theme.bold(text));
	}
	return selected ? theme.fg("text", text) : theme.fg("muted", text);
}

function getInitialQuery(editorText: string): string {
	const trimmed = editorText.trim();
	if (!trimmed.startsWith("/") || trimmed.includes("\n")) {
		return "";
	}
	const commandText = trimmed.slice(1);
	const spaceIndex = commandText.indexOf(" ");
	return (spaceIndex === -1 ? commandText : commandText.slice(0, spaceIndex)).trim();
}

export function shouldConfirmReplacement(editorText: string): boolean {
	const trimmed = editorText.trim();
	return trimmed.length > 0 && !trimmed.startsWith("/");
}

export function buildPaletteCommands(commands: SlashCommandInfo[]): PaletteCommand[] {
	const seen = new Set<string>();
	const builtins: PaletteCommand[] = [];
	for (const command of BUILTIN_COMMANDS) {
		seen.add(command.name);
		builtins.push({
			name: command.name,
			description: command.description,
			source: "builtin",
		});
	}

	const dynamic = commands
		.filter((command) => !seen.has(command.name))
		.map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
			scope: command.sourceInfo.scope,
			path: command.sourceInfo.path,
		} satisfies PaletteCommand));

	return [...builtins, ...dynamic].sort(comparePaletteCommands);
}

export class CommandPaletteOverlay implements Component, Focusable {
	private readonly searchInput = new Input();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly commands: PaletteCommand[];
	private readonly done: (result: PaletteSelection | null) => void;
	private filteredCommands: PaletteCommand[];
	private selectedIndex = 0;
	private readonly initialQuery: string;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(tui: TUI, theme: Theme, commands: PaletteCommand[], initialQuery: string, done: (result: PaletteSelection | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.commands = commands;
		this.done = done;
		this.initialQuery = initialQuery.trim();
		this.filteredCommands = commands;
		this.searchInput.setValue(this.initialQuery);
		this.applyFilter(this.initialQuery);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.moveSelection(-MAX_VISIBLE_COMMANDS);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.moveSelection(MAX_VISIBLE_COMMANDS);
			return;
		}
		if (matchesKey(data, "shift+enter")) {
			const command = this.getSelectedCommand();
			this.done(command ? { command, action: "insert" } : null);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const command = this.getSelectedCommand();
			this.done(command ? { command, action: "execute" } : null);
			return;
		}

		const previousValue = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const nextValue = this.searchInput.getValue();
		if (nextValue !== previousValue) {
			this.applyFilter(nextValue);
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	render(width: number): string[] {
		const frameWidth = Math.max(4, Math.min(MAX_FRAME_WIDTH, width));
		const innerWidth = Math.max(0, frameWidth - 4);
		const lines: string[] = [];

		lines.push(this.borderLine(frameWidth, "top"));
		lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold("⌘ Slash Command Palette")), innerWidth));
		lines.push(
			this.frameLine(
				this.theme.fg(
					"dim",
					`${this.filteredCommands.length}/${this.commands.length} commands • green commands resolve on enter • shift+enter inserts /name`,
				),
				innerWidth,
			),
		);
		lines.push(this.frameLine("", innerWidth));
		lines.push(this.frameLine(this.theme.fg("muted", "Search"), innerWidth));
		for (const inputLine of this.searchInput.render(innerWidth)) {
			lines.push(this.frameLine(inputLine, innerWidth));
		}
		lines.push(this.frameLine("", innerWidth));
		for (const listLine of this.renderCommandList(innerWidth)) {
			lines.push(this.frameLine(listLine, innerWidth));
		}
		lines.push(this.borderLine(frameWidth, "bottom"));
		return lines;
	}

	private moveSelection(delta: number): void {
		if (this.filteredCommands.length === 0) {
			return;
		}
		const nextIndex = Math.max(0, Math.min(this.filteredCommands.length - 1, this.selectedIndex + delta));
		if (nextIndex === this.selectedIndex) {
			return;
		}
		this.selectedIndex = nextIndex;
		this.tui.requestRender();
	}

	private applyFilter(query: string): void {
		this.filteredCommands = query.trim()
			? fuzzyFilter(this.commands, query, (command) => getSearchText(command))
			: [...this.commands].sort(comparePaletteCommandsForDisplay);
		this.selectedIndex = 0;
	}

	private getSelectedCommand(): PaletteCommand | null {
		return this.filteredCommands[this.selectedIndex] ?? null;
	}

	private renderCommandList(innerWidth: number): string[] {
		const lines: string[] = [];
		const visibleRange = this.getVisibleRange();

		if (this.filteredCommands.length === 0) {
			lines.push(this.theme.fg("warning", "No matching commands."));
		} else {
			const nameColumnWidth = Math.min(
				28,
				Math.max(14, ...this.filteredCommands.map((command) => visibleWidth(`/${command.name}`))),
			);
			const badgeColumnWidth = Math.max(6, ...this.filteredCommands.map((command) => visibleWidth(`[${getSourceBadge(command)}]`)));

			for (let index = visibleRange.start; index < visibleRange.end; index += 1) {
				const command = this.filteredCommands[index];
				if (!command) continue;

				const isSelected = index === this.selectedIndex;
				const prefix = isSelected ? "→ " : "  ";
				const name = truncateToWidth(`/${command.name}`, nameColumnWidth, "");
				const namePadding = " ".repeat(Math.max(0, nameColumnWidth - visibleWidth(name)));
				const badgeText = `[${getSourceBadge(command)}]`;
				const badgePadding = " ".repeat(Math.max(0, badgeColumnWidth - visibleWidth(badgeText)));
				const baseWidth = visibleWidth(prefix) + nameColumnWidth + visibleWidth(badgeText) + badgePadding.length + 2;
				const descriptionWidth = Math.max(0, innerWidth - baseWidth);
				const normalizedDescription = normalizeCommandDescription(command.description);
				const descriptionText =
					descriptionWidth >= MIN_DESCRIPTION_WIDTH && normalizedDescription
						? truncateToWidth(normalizedDescription, descriptionWidth, "")
						: "";

				const left = `${prefix}${styleCommandName(this.theme, command, `${name}${namePadding}`, isSelected)}`;
				const badge = this.theme.fg("muted", `${badgeText}${badgePadding}`);
				const description = descriptionText ? ` ${this.theme.fg("dim", descriptionText)}` : "";
				const line = truncateToWidth(`${left} ${badge}${description}`, innerWidth, "", true);
				lines.push(isSelected ? this.theme.bg("selectedBg", line) : line);
			}
		}

		while (lines.length < COMMAND_LIST_VIEWPORT_ROWS - 1) {
			lines.push("");
		}
		lines.push(this.renderCommandListFooter(visibleRange));
		return lines;
	}

	private renderCommandListFooter(visibleRange: { start: number; end: number }): string {
		const total = this.filteredCommands.length;
		if (total === 0) {
			return this.theme.fg("dim", "Showing 0 of 0");
		}

		const visibleCount = visibleRange.end - visibleRange.start;
		const digits = String(total).length;
		const formatCount = (value: number): string => String(value).padStart(digits, " ");
		if (visibleCount <= 0) {
			return this.theme.fg("dim", `Showing ${formatCount(0)} of ${formatCount(total)}`);
		}
		if (visibleCount === total) {
			return this.theme.fg("dim", `Showing ${formatCount(total)} of ${formatCount(total)}`);
		}
		return this.theme.fg("dim", `Showing ${formatCount(visibleRange.start + 1)}-${formatCount(visibleRange.end)} of ${formatCount(total)}`);
	}

	private getVisibleRange(): { start: number; end: number } {
		const total = this.filteredCommands.length;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_COMMANDS / 2), total - MAX_VISIBLE_COMMANDS));
		return {
			start,
			end: Math.min(total, start + MAX_VISIBLE_COMMANDS),
		};
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		return `${this.theme.fg("border", "│ ")}${truncated}${padding}${this.theme.fg("border", " │")}`;
	}

	private borderLine(width: number, position: "top" | "bottom"): string {
		const left = position === "top" ? "╭" : "╰";
		const right = position === "top" ? "╮" : "╯";
		return this.theme.fg("borderAccent", `${left}${"─".repeat(Math.max(1, width - 2))}${right}`);
	}
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return typeof (ctx as Partial<ExtensionCommandContext>).reload === "function";
}

async function runBuiltinPaletteCommand(name: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<boolean> {
	switch (name) {
		case "reload": {
			if (!isCommandContext(ctx)) return false;
			await ctx.reload();
			return true;
		}
		case "new": {
			if (!isCommandContext(ctx)) return false;
			const result = await ctx.newSession();
			if (result.cancelled) {
				ctx.ui.notify("Cancelled.", "info");
			}
			return true;
		}
		case "compact": {
			await new Promise<void>((resolve, reject) => {
				ctx.compact({
					onComplete: () => resolve(),
					onError: reject,
				});
			});
			ctx.ui.notify("Context compacted.", "info");
			return true;
		}
		case "resume": {
			if (!isCommandContext(ctx)) return false;
			const cwd = ctx.sessionManager.getCwd();
			const sessionDir = ctx.sessionManager.getSessionDir();
			const sessions = await SessionManager.list(cwd, sessionDir);
			sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
			const options = sessions.slice(0, 30).map((session) => {
				const nameLabel = (session.name || "").trim();
				const label = nameLabel || session.firstMessage;
				return `${label}  (${session.path})`;
			});
			if (options.length === 0) {
				ctx.ui.notify("No resumable sessions found.", "info");
				return true;
			}
			const picked = await ctx.ui.select("Resume session", options);
			if (!picked) {
				return true;
			}
			const match = /\(([^)]+)\)$/.exec(picked);
			const sessionPath = (match?.[1] || "").trim();
			if (!sessionPath) {
				ctx.ui.notify("Failed to parse selected session.", "warning");
				return true;
			}
			const result = await ctx.switchSession(sessionPath);
			if (result.cancelled) {
				ctx.ui.notify("Cancelled.", "info");
			}
			return true;
		}
		case "quit":
			ctx.shutdown();
			return true;
		case "session": {
			const sessionFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";
			const sessionName = ctx.sessionManager.getSessionName() ?? "";
			ctx.ui.notify(
				[`session: ${sessionName || "(unnamed)"}`, `file: ${sessionFile}`, `cwd: ${ctx.sessionManager.getCwd()}`].join("\n"),
				"info",
			);
			return true;
		}
		case "name": {
			const nextName = await ctx.ui.input("Session name", "Enter a new session name");
			if (typeof nextName !== "string") {
				return true;
			}
			pi.setSessionName(nextName.trim());
			ctx.ui.notify(nextName.trim() ? `Session renamed to ${nextName.trim()}` : "Session name cleared", "info");
			return true;
		}
		default:
			return false;
	}
}

export async function executePaletteCommand(
	command: PaletteCommand,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	currentLineText: string | null,
): Promise<void> {
	if (isPromptCommand(command)) {
		try {
			const body = loadPromptTemplateBody(command.path);
			let argsString = "";
			if (hasPromptTemplatePlaceholders(body)) {
				const input = await ctx.ui.input(
					"Prompt template arguments",
					`Arguments for /${command.name} (quote multi-word values if needed)`,
				);
				if (typeof input !== "string") {
					return;
				}
				argsString = input.trim();
			}
			const content = substitutePromptTemplateArgs(body, parsePromptTemplateArgs(argsString));
			ctx.ui.pasteToEditor(buildPromptTemplateInsertionText(content, currentLineText));
			ctx.ui.notify(`Inserted /${command.name} at cursor.`, "info");
			return;
		} catch {
			ctx.ui.notify(`Failed to load /${command.name}. Inserted the slash command instead.`, "warning");
			ctx.ui.setEditorText(`/${command.name} `);
			return;
		}
	}

	const builtin = BUILTIN_COMMANDS.some((builtinCommand) => builtinCommand.name === command.name);
	if (!builtin) {
		ctx.ui.notify(`Direct execution is only supported for prompt templates and [run] commands. Inserted /${command.name} instead.`, "info");
		ctx.ui.setEditorText(`/${command.name} `);
		return;
	}

	const executed = await runBuiltinPaletteCommand(command.name, ctx, pi);
	if (!executed) {
		ctx.ui.notify(`Direct execution is not implemented for /${command.name}. Inserted it instead.`, "info");
		ctx.ui.setEditorText(`/${command.name} `);
	}
}

async function openCommandPalette(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	const commands = buildPaletteCommands(pi.getCommands());
	const currentEditorText = ctx.ui.getEditorText();
	let currentLineText: string | null = getFallbackCurrentLineText(currentEditorText);
	const selection = await ctx.ui.custom<PaletteSelection | null>(
		(tui, theme, _keybindings, done) => {
			currentLineText = getFocusedEditorCurrentLineText(tui) ?? currentLineText;
			dismissFocusedEditorAutocomplete(tui);
			return new CommandPaletteOverlay(tui, theme, commands, getInitialQuery(currentEditorText), done);
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-center",
				width: "78%",
				minWidth: 64,
				maxHeight: "84%",
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);

	if (!selection) {
		return;
	}

	if (selection.action === "execute") {
		await executePaletteCommand(selection.command, ctx, pi, currentLineText);
		return;
	}

	if (shouldConfirmReplacement(currentEditorText)) {
		const confirmed = await ctx.ui.confirm(
			"Replace current draft?",
			`Insert /${selection.command.name} and discard the current editor text?`,
		);
		if (!confirmed) {
			return;
		}
	}

	ctx.ui.setEditorText(`/${selection.command.name} `);
}

export default function commandPaletteExtension(pi: ExtensionAPI): void {
	pi.registerCommand(PALETTE_COMMAND, {
		description: `Open the slash command palette (${PALETTE_SHORTCUT}; fallback ${PALETTE_FALLBACK_SHORTCUT})`,
		handler: async (_args, ctx) => {
			await openCommandPalette(ctx, pi);
		},
	});

	pi.registerShortcut(PALETTE_SHORTCUT, {
		description: "Open slash command palette",
		handler: async (ctx) => {
			await openCommandPalette(ctx, pi);
		},
	});

	pi.registerShortcut(PALETTE_FALLBACK_SHORTCUT, {
		description: "Open slash command palette (legacy-terminal fallback)",
		handler: async (ctx) => {
			await openCommandPalette(ctx, pi);
		},
	});
}
