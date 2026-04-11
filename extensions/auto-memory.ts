/**
 * Auto Memory Extension
 *
 * Keeps a slim, project-local memory file up to date automatically and injects
 * a token-aware memory summary into context before each agent run.
 *
 * Files:
 * - <cwd>/.pi/MEMORY.md                Generated memory visible to the user
 * - <cwd>/.pi/auto-memory.json         Structured memory state
 * - <cwd>/.pi/extensions/auto-memory.json  Persistent on/off config
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /memory on|off|toggle|show|sync|clear
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";

const EXTENSION_ID = "auto-memory";
const CONFIG_DIR = ".pi";
const CONFIG_PATH = "extensions/auto-memory.json";
const MEMORY_PATH = "MEMORY.md";
const STATE_PATH = "auto-memory.json";
const TERSE_CONFIG_PATH = "extensions/terse-mode.json";

const MAX_PREFERENCES = 8;
const MAX_PROJECT_FACTS = 10;
const MAX_DECISIONS = 6;
const MAX_FOCUS_CHARS = 220;
const HIGH_CONTEXT_PERCENT = 70;

interface MemoryItem {
	text: string;
	createdAt: string;
	updatedAt: string;
	mentions: number;
	source: "user" | "assistant";
}

interface AutoMemoryState {
	version: 1;
	enabled: boolean;
	preferences: MemoryItem[];
	projectFacts: MemoryItem[];
	recentDecisions: MemoryItem[];
	currentFocus?: string;
	lastSourceText?: string;
	lastUpdatedAt?: string;
}

interface AutoMemoryConfig {
	enabled?: boolean;
}

interface TerseConfig {
	enabled?: boolean;
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function normalizeForKey(text: string): string {
	return normalizeWhitespace(text).toLowerCase().replace(/[^\w\s/-]+/g, "");
}

function trimSentence(text: string, maxChars: number): string {
	const normalized = normalizeWhitespace(text);
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function getTextFromMessage(message: AgentMessage): string {
	if ("content" in message && typeof message.content === "string") {
		return normalizeWhitespace(message.content);
	}

	if ("content" in message && Array.isArray(message.content)) {
		return normalizeWhitespace(
			message.content
				.filter((item): item is TextContent => item.type === "text")
				.map((item) => item.text)
				.join("\n"),
		);
	}

	if (message.role === "toolResult") {
		return normalizeWhitespace(
			Array.isArray(message.content)
				? message.content.filter((item): item is TextContent => item.type === "text").map((item) => item.text).join("\n")
				: "",
		);
	}

	return "";
}

function getPaths(cwd: string) {
	const piDir = join(cwd, CONFIG_DIR);
	return {
		piDir,
		configFile: join(piDir, CONFIG_PATH),
		stateFile: join(piDir, STATE_PATH),
		memoryFile: join(piDir, MEMORY_PATH),
	};
}

function loadConfig(cwd: string): AutoMemoryConfig {
	const { configFile, piDir } = getPaths(cwd);
	ensureDir(join(piDir, "extensions"));
	if (!existsSync(configFile)) return {};
	try {
		return JSON.parse(readFileSync(configFile, "utf-8")) as AutoMemoryConfig;
	} catch {
		return {};
	}
}

function saveConfig(cwd: string, config: AutoMemoryConfig): void {
	const { configFile, piDir } = getPaths(cwd);
	ensureDir(join(piDir, "extensions"));
	writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function isTerseEnabled(cwd: string): boolean {
	const { piDir } = getPaths(cwd);
	const configFile = join(piDir, TERSE_CONFIG_PATH);
	if (!existsSync(configFile)) return false;
	try {
		return Boolean((JSON.parse(readFileSync(configFile, "utf-8")) as TerseConfig).enabled);
	} catch {
		return false;
	}
}

function createEmptyState(enabled: boolean): AutoMemoryState {
	return {
		version: 1,
		enabled,
		preferences: [],
		projectFacts: [],
		recentDecisions: [],
	};
}

function loadState(cwd: string): AutoMemoryState {
	const config = loadConfig(cwd);
	const { stateFile, piDir } = getPaths(cwd);
	ensureDir(piDir);
	if (!existsSync(stateFile)) {
		return createEmptyState(config.enabled ?? true);
	}
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as Partial<AutoMemoryState>;
		return {
			version: 1,
			enabled: parsed.enabled ?? config.enabled ?? true,
			preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
			projectFacts: Array.isArray(parsed.projectFacts) ? parsed.projectFacts : [],
			recentDecisions: Array.isArray(parsed.recentDecisions) ? parsed.recentDecisions : [],
			currentFocus: parsed.currentFocus,
			lastSourceText: parsed.lastSourceText,
			lastUpdatedAt: parsed.lastUpdatedAt,
		};
	} catch {
		return createEmptyState(config.enabled ?? true);
	}
}

function saveState(cwd: string, state: AutoMemoryState): void {
	const { stateFile, piDir } = getPaths(cwd);
	ensureDir(piDir);
	writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function scoreItem(item: MemoryItem): number {
	const ageMs = Date.now() - new Date(item.updatedAt).getTime();
	const recencyBoost = Math.max(0, 30 - Math.floor(ageMs / (1000 * 60 * 60 * 24)));
	return item.mentions * 5 + recencyBoost;
}

function dedupeAndLimit(items: MemoryItem[], limit: number): MemoryItem[] {
	const map = new Map<string, MemoryItem>();
	for (const item of items) {
		const key = normalizeForKey(item.text);
		if (!key) continue;
		const existing = map.get(key);
		if (!existing) {
			map.set(key, item);
			continue;
		}
		existing.mentions += item.mentions;
		if (new Date(item.updatedAt) > new Date(existing.updatedAt)) {
			existing.updatedAt = item.updatedAt;
			existing.source = item.source;
			existing.text = item.text;
		}
	}

	return Array.from(map.values())
		.sort((a, b) => scoreItem(b) - scoreItem(a))
		.slice(0, limit);
}

function upsertItem(items: MemoryItem[], text: string, source: "user" | "assistant", now: string): MemoryItem[] {
	const normalized = normalizeForKey(text);
	if (!normalized) return items;

	const next = [...items];
	const existing = next.find((item) => normalizeForKey(item.text) === normalized);
	if (existing) {
		existing.updatedAt = now;
		existing.mentions += 1;
		if (text.length < existing.text.length) {
			existing.text = text;
		}
		return next;
	}

	next.push({
		text,
		createdAt: now,
		updatedAt: now,
		mentions: 1,
		source,
	});
	return next;
}

function sentenceCandidates(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => normalizeWhitespace(sentence))
		.filter(Boolean);
}

function extractPreferenceCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (const sentence of sentenceCandidates(text)) {
		if (
			/\b(remember|prefer|please use|always|never|avoid|keep responses|be concise|be brief|use tabs|use spaces)\b/i.test(
				sentence,
			)
		) {
			candidates.push(trimSentence(sentence, 140));
		}
	}
	return candidates;
}

function extractProjectFactCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (const sentence of sentenceCandidates(text)) {
		if (
			/\b(we use|project uses|repo uses|this project uses|our stack|api|database|branch|package manager|typescript|pnpm|npm|yarn|react|next\.js|vite|tailwind)\b/i.test(
				sentence,
			)
		) {
			candidates.push(trimSentence(sentence, 160));
		}
	}
	return candidates;
}

function extractDecisionCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (const sentence of sentenceCandidates(text)) {
		if (/\b(decided|decision|going with|we will|we'll|choose|chosen|ship|use .* instead of)\b/i.test(sentence)) {
			candidates.push(trimSentence(sentence, 160));
		}
	}
	return candidates;
}

function pruneState(state: AutoMemoryState): AutoMemoryState {
	state.preferences = dedupeAndLimit(state.preferences, MAX_PREFERENCES);
	state.projectFacts = dedupeAndLimit(state.projectFacts, MAX_PROJECT_FACTS);
	state.recentDecisions = dedupeAndLimit(state.recentDecisions, MAX_DECISIONS);
	if (state.currentFocus) {
		state.currentFocus = trimSentence(state.currentFocus, MAX_FOCUS_CHARS);
	}
	return state;
}

function renderMemoryMarkdown(state: AutoMemoryState): string {
	const lines: string[] = [];
	lines.push("# PI Memory");
	lines.push("");
	lines.push(`Generated by the \`${EXTENSION_ID}\` extension. Edit the config, not this file.`);
	lines.push("");

	if (state.currentFocus) {
		lines.push("## Current Focus");
		lines.push(`- ${state.currentFocus}`);
		lines.push("");
	}

	if (state.preferences.length > 0) {
		lines.push("## Preferences");
		for (const item of state.preferences) {
			lines.push(`- ${item.text}`);
		}
		lines.push("");
	}

	if (state.projectFacts.length > 0) {
		lines.push("## Project Facts");
		for (const item of state.projectFacts) {
			lines.push(`- ${item.text}`);
		}
		lines.push("");
	}

	if (state.recentDecisions.length > 0) {
		lines.push("## Recent Decisions");
		for (const item of state.recentDecisions) {
			lines.push(`- ${item.text}`);
		}
		lines.push("");
	}

	if (state.lastUpdatedAt) {
		lines.push(`_Last updated: ${new Date(state.lastUpdatedAt).toLocaleString()}_`);
		lines.push("");
	}

	return `${lines.join("\n").trim()}\n`;
}

function saveMemoryFile(cwd: string, state: AutoMemoryState): void {
	const { memoryFile, piDir } = getPaths(cwd);
	ensureDir(piDir);
	writeFileSync(memoryFile, renderMemoryMarkdown(state), "utf-8");
}

function buildMemoryLines(state: AutoMemoryState, theme: Theme, contextPercent: number | null, terse: boolean): string[] {
	const lines: string[] = [];
	const statusColor = state.enabled ? "success" : "warning";
	lines.push(`${theme.fg(statusColor, state.enabled ? (terse ? "Mem: ON" : "Memory: ON") : terse ? "Mem: OFF" : "Memory: OFF")}`);

	const stats = [
		`${state.preferences.length} prefs`,
		`${state.projectFacts.length} facts`,
		`${state.recentDecisions.length} decisions`,
	];
	lines.push(theme.fg("muted", stats.join(" | ")));

	if (state.currentFocus) {
		lines.push(theme.fg("text", `${terse ? "Focus" : "Focus:"} ${trimSentence(state.currentFocus, 80)}`));
	}

	if (contextPercent !== null) {
		const slim = contextPercent >= HIGH_CONTEXT_PERCENT ? (terse ? "slim" : "slim mode") : "normal";
		lines.push(theme.fg("dim", `${terse ? "Ctx" : "Context"}: ${contextPercent}% | ${slim}`));
	}

	return lines;
}

function latestUserText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;
		const text = getTextFromMessage(entry.message);
		if (text) return text;
	}
	return "";
}

function updateStateFromTurn(state: AutoMemoryState, event: { message: AgentMessage }, ctx: ExtensionContext): boolean {
	if (!state.enabled || event.message.role !== "assistant") return false;

	const assistantText = getTextFromMessage(event.message);
	const userText = latestUserText(ctx);
	const sourceText = `${userText}\n${assistantText}`.trim();
	if (!sourceText || sourceText === state.lastSourceText) {
		return false;
	}

	const now = new Date().toISOString();
	const next = { ...state };
	next.currentFocus = userText ? trimSentence(userText, MAX_FOCUS_CHARS) : next.currentFocus;
	next.lastSourceText = sourceText;
	next.lastUpdatedAt = now;

	for (const candidate of extractPreferenceCandidates(userText)) {
		next.preferences = upsertItem(next.preferences, candidate, "user", now);
	}
	for (const candidate of extractProjectFactCandidates(userText)) {
		next.projectFacts = upsertItem(next.projectFacts, candidate, "user", now);
	}
	for (const candidate of extractDecisionCandidates(userText)) {
		next.recentDecisions = upsertItem(next.recentDecisions, candidate, "user", now);
	}
	for (const candidate of extractDecisionCandidates(assistantText)) {
		next.recentDecisions = upsertItem(next.recentDecisions, candidate, "assistant", now);
	}

	pruneState(next);

	const changed = JSON.stringify(next) !== JSON.stringify(state);
	if (!changed) return false;

	Object.assign(state, next);
	return true;
}

export default function autoMemoryExtension(pi: ExtensionAPI) {
	let state: AutoMemoryState | undefined;

	const load = (cwd: string): AutoMemoryState => {
		state = pruneState(loadState(cwd));
		saveState(cwd, state);
		saveMemoryFile(cwd, state);
		return state;
	};

	const persist = (cwd: string): void => {
		if (!state) return;
		pruneState(state);
		saveState(cwd, state);
		saveMemoryFile(cwd, state);
		pi.appendEntry(`${EXTENSION_ID}-state`, {
			enabled: state.enabled,
			lastUpdatedAt: state.lastUpdatedAt,
			preferences: state.preferences.length,
			projectFacts: state.projectFacts.length,
			recentDecisions: state.recentDecisions.length,
		});
	};

	const refreshWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !state) return;
		const percent = ctx.getContextUsage()?.percent ?? null;
		ctx.ui.setWidget("auto-memory", buildMemoryLines(state, ctx.ui.theme, percent, isTerseEnabled(ctx.cwd)), { placement: "belowEditor" });
		ctx.ui.setStatus("auto-memory", ctx.ui.theme.fg(state.enabled ? "success" : "warning", state.enabled ? "mem:on" : "mem:off"));
	};

	pi.on("session_start", async (_event, ctx) => {
		load(ctx.cwd);
		refreshWidget(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!state) {
			load(ctx.cwd);
		}
		if (!state) return;

		if (updateStateFromTurn(state, event, ctx)) {
			persist(ctx.cwd);
		}
		refreshWidget(ctx);
	});

	pi.registerCommand("memory", {
		description: "Manage auto memory: on, off, toggle, show, sync, clear",
		handler: async (args, ctx) => {
			if (!state) {
				load(ctx.cwd);
			}
			if (!state) return;

			const action = normalizeWhitespace(args || "").toLowerCase();
			switch (action) {
				case "on":
					state.enabled = true;
					saveConfig(ctx.cwd, { enabled: true });
					persist(ctx.cwd);
					ctx.ui.notify(isTerseEnabled(ctx.cwd) ? "Memory on" : "Auto memory enabled", "info");
					break;
				case "off":
					state.enabled = false;
					saveConfig(ctx.cwd, { enabled: false });
					persist(ctx.cwd);
					ctx.ui.notify(isTerseEnabled(ctx.cwd) ? "Memory off" : "Auto memory disabled", "info");
					break;
				case "toggle":
					state.enabled = !state.enabled;
					saveConfig(ctx.cwd, { enabled: state.enabled });
					persist(ctx.cwd);
					ctx.ui.notify(isTerseEnabled(ctx.cwd) ? `Memory ${state.enabled ? "on" : "off"}` : `Auto memory ${state.enabled ? "enabled" : "disabled"}`, "info");
					break;
				case "clear":
					state = createEmptyState(state.enabled);
					saveConfig(ctx.cwd, { enabled: state.enabled });
					persist(ctx.cwd);
					ctx.ui.notify(isTerseEnabled(ctx.cwd) ? "Memory cleared" : "Auto memory cleared", "info");
					break;
				case "sync":
					persist(ctx.cwd);
					ctx.ui.notify(isTerseEnabled(ctx.cwd) ? "Memory synced" : "Auto memory synced", "info");
					break;
				case "show":
				case "":
					ctx.ui.notify(
						[
							`Auto memory: ${state.enabled ? "ON" : "OFF"}`,
							`Preferences: ${state.preferences.length}`,
							`Project facts: ${state.projectFacts.length}`,
							`Recent decisions: ${state.recentDecisions.length}`,
							state.currentFocus ? `Focus: ${state.currentFocus}` : undefined,
						]
							.filter(Boolean)
							.join("\n"),
						"info",
					);
					break;
				default:
					ctx.ui.notify("Usage: /memory on|off|toggle|show|sync|clear", "warning");
					break;
			}

			refreshWidget(ctx);
		},
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "toggle", "show", "sync", "clear"].filter((value) => value.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
	});
}
