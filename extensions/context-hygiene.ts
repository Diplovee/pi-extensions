/**
 * Context Hygiene Extension
 *
 * Keeps sessions lean by watching token pressure and noisy history, then
 * triggering compaction with focused instructions when thresholds are crossed.
 *
 * Commands:
 * - /hygiene show
 * - /hygiene on
 * - /hygiene off
 * - /hygiene toggle
 * - /hygiene compact
 * - /hygiene reset
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const EXTENSION_ID = "context-hygiene";
const CONFIG_DIR = ".pi";
const CONFIG_PATH = "extensions/context-hygiene.json";
const STATE_PATH = "context-hygiene.json";
const TERSE_CONFIG_PATH = "extensions/terse-mode.json";
const DASHBOARD_CONFIG_PATH = "extensions/dashboard-ui.json";

const WARN_PERCENT = 55;
const COMPACT_PERCENT = 72;
const MAX_NOISE_SCORE = 10;
const MIN_TURNS_BETWEEN_COMPACTIONS = 4;

interface HygieneConfig {
	enabled?: boolean;
}

interface HygieneState {
	version: 1;
	enabled: boolean;
	lastNoiseScore: number;
	lastContextPercent: number | null;
	lastCompactTurn?: number;
	lastCompactReason?: string;
	lastCompactAt?: string;
	lastWarningAt?: string;
}

interface TerseConfig {
	enabled?: boolean;
}

interface DashboardConfig {
	enabled?: boolean;
}

interface HygieneToolResult {
	action: string;
	ok: boolean;
	message: string;
	enabled: boolean;
	contextPercent: number | null;
	noiseScore: number;
	lastCompactAt?: string;
	lastCompactReason?: string;
}

const ContextHygieneParams = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("compact")]),
	reason: Type.Optional(Type.String({ description: "Optional reason for manual compaction" })),
});

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function getPaths(cwd: string) {
	const piDir = join(cwd, CONFIG_DIR);
	return {
		piDir,
		configFile: join(piDir, CONFIG_PATH),
		stateFile: join(piDir, STATE_PATH),
	};
}

function loadConfig(cwd: string): HygieneConfig {
	const { configFile, piDir } = getPaths(cwd);
	ensureDir(join(piDir, "extensions"));
	if (!existsSync(configFile)) return {};
	try {
		return JSON.parse(readFileSync(configFile, "utf-8")) as HygieneConfig;
	} catch {
		return {};
	}
}

function saveConfig(cwd: string, config: HygieneConfig): void {
	const { configFile, piDir } = getPaths(cwd);
	ensureDir(join(piDir, "extensions"));
	writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function createState(enabled: boolean): HygieneState {
	return {
		version: 1,
		enabled,
		lastNoiseScore: 0,
		lastContextPercent: null,
	};
}

function loadState(cwd: string): HygieneState {
	const config = loadConfig(cwd);
	const { stateFile, piDir } = getPaths(cwd);
	ensureDir(piDir);
	if (!existsSync(stateFile)) return createState(config.enabled ?? true);
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as Partial<HygieneState>;
		return {
			version: 1,
			enabled: parsed.enabled ?? config.enabled ?? true,
			lastNoiseScore: parsed.lastNoiseScore ?? 0,
			lastContextPercent: parsed.lastContextPercent ?? null,
			lastCompactTurn: parsed.lastCompactTurn,
			lastCompactReason: parsed.lastCompactReason,
			lastCompactAt: parsed.lastCompactAt,
			lastWarningAt: parsed.lastWarningAt,
		};
	} catch {
		return createState(config.enabled ?? true);
	}
}

function saveState(cwd: string, state: HygieneState): void {
	const { stateFile, piDir } = getPaths(cwd);
	ensureDir(piDir);
	writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
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

function isDashboardEnabled(cwd: string): boolean {
	const { piDir } = getPaths(cwd);
	const configFile = join(piDir, DASHBOARD_CONFIG_PATH);
	if (!existsSync(configFile)) return true;
	try {
		return (JSON.parse(readFileSync(configFile, "utf-8")) as DashboardConfig).enabled !== false;
	} catch {
		return true;
	}
}

function getText(message: AgentMessage): string {
	if ("content" in message && typeof message.content === "string") {
		return message.content;
	}
	if ("content" in message && Array.isArray(message.content)) {
		return message.content
			.filter((item): item is TextContent => item.type === "text")
			.map((item) => item.text)
			.join("\n");
	}
	return "";
}

function scoreNoise(ctx: ExtensionContext): number {
	const branch = ctx.sessionManager.getBranch();
	const recentMessages = branch
		.filter((entry) => entry.type === "message")
		.slice(-16)
		.map((entry) => entry.message);

	let score = 0;
	const normalized = recentMessages.map((message) =>
		getText(message)
			.toLowerCase()
			.replace(/\s+/g, " ")
			.trim(),
	);

	const duplicates = new Map<string, number>();
	for (const text of normalized) {
		if (!text) continue;
		duplicates.set(text, (duplicates.get(text) ?? 0) + 1);
	}
	for (const count of duplicates.values()) {
		if (count > 1) score += count - 1;
	}

	const toolResults = recentMessages.filter((message) => message.role === "toolResult").length;
	if (toolResults >= 6) score += 2;
	if (toolResults >= 10) score += 2;

	for (const text of normalized) {
		if (text.length > 1500) score += 1;
		if (/error:|warning:|stack trace|traceback/i.test(text)) score += 1;
		if (/plan:|steps:|todo/i.test(text) && text.length > 600) score += 1;
	}

	return score;
}

function buildCompactInstructions(reason: string): string {
	return [
		"Keep the summary compact and decision-relevant.",
		"Preserve only the current user goal, active constraints, unresolved blockers, and the latest chosen approach.",
		"Remove repeated plans, stale debugging chatter, verbose tool output, and superseded approaches.",
		"Compress completed work into short bullets instead of conversational detail.",
		`Reason for compaction: ${reason}.`,
	].join(" ");
}

function shouldCompact(state: HygieneState, turnIndex: number, contextPercent: number | null, noiseScore: number) {
	if (!state.enabled) return { compact: false, reason: "" };
	if (state.lastCompactTurn !== undefined && turnIndex - state.lastCompactTurn < MIN_TURNS_BETWEEN_COMPACTIONS) {
		return { compact: false, reason: "" };
	}
	if (contextPercent !== null && contextPercent >= COMPACT_PERCENT) {
		return { compact: true, reason: `context usage reached ${contextPercent}%` };
	}
	if (noiseScore >= MAX_NOISE_SCORE && contextPercent !== null && contextPercent >= WARN_PERCENT) {
		return { compact: true, reason: `noise score ${noiseScore} with context at ${contextPercent}%` };
	}
	return { compact: false, reason: "" };
}

export default function contextHygiene(pi: ExtensionAPI) {
	let state: HygieneState = createState(true);

	const load = (cwd: string) => {
		state = loadState(cwd);
	};

	const persist = (cwd: string) => {
		saveState(cwd, state);
		pi.appendEntry(`${EXTENSION_ID}-state`, {
			enabled: state.enabled,
			lastNoiseScore: state.lastNoiseScore,
			lastContextPercent: state.lastContextPercent,
			lastCompactAt: state.lastCompactAt,
			lastCompactReason: state.lastCompactReason,
		});
	};

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const terse = isTerseEnabled(ctx.cwd);
		const mode = state.enabled ? "on" : "off";
		const percent = state.lastContextPercent === null ? "?" : `${state.lastContextPercent}%`;
		if (isDashboardEnabled(ctx.cwd)) {
			ctx.ui.setWidget("context-hygiene", undefined);
		} else {
			ctx.ui.setWidget(
				"context-hygiene",
				[
					ctx.ui.theme.fg(state.enabled ? "success" : "warning", terse ? `Hygiene: ${mode.toUpperCase()}` : `Context Hygiene: ${mode.toUpperCase()}`),
					ctx.ui.theme.fg("muted", `${terse ? "ctx" : "context"}: ${percent} | noise: ${state.lastNoiseScore}`),
					ctx.ui.theme.fg("dim", state.lastCompactReason ? `${terse ? "compact" : "last compact"}: ${state.lastCompactReason}` : terse ? "compact: none" : "last compact: none"),
				],
				{ placement: "belowEditor" },
			);
		}
		ctx.ui.setStatus(
			"context-hygiene",
			ctx.ui.theme.fg(state.enabled ? "success" : "warning", state.enabled ? "hygiene:on" : "hygiene:off"),
		);
	};

	const triggerCompact = (ctx: ExtensionContext, reason: string) => {
		state.lastCompactTurn = ctx.sessionManager.getBranch().length;
		state.lastCompactReason = reason;
		state.lastCompactAt = new Date().toISOString();
		persist(ctx.cwd);
		refresh(ctx);
		ctx.compact({
			customInstructions: buildCompactInstructions(reason),
			onComplete: () => {
				if (ctx.hasUI) ctx.ui.notify(isTerseEnabled(ctx.cwd) ? `Compacted: ${reason}` : `Context compacted: ${reason}`, "info");
			},
			onError: (error) => {
				if (ctx.hasUI) ctx.ui.notify(isTerseEnabled(ctx.cwd) ? `Compact failed: ${error.message}` : `Compaction failed: ${error.message}`, "error");
			},
		});
	};

	const buildToolDetails = (action: string, message: string, ok: boolean): HygieneToolResult => ({
		action,
		ok,
		message,
		enabled: state.enabled,
		contextPercent: state.lastContextPercent,
		noiseScore: state.lastNoiseScore,
		lastCompactAt: state.lastCompactAt,
		lastCompactReason: state.lastCompactReason,
	});

	pi.on("session_start", async (event, ctx) => {
		load(ctx.cwd);
		if (event.reason === "new") {
			state = createState(loadConfig(ctx.cwd).enabled ?? state.enabled);
			persist(ctx.cwd);
		}
		refresh(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!state) load(ctx.cwd);
		const percent = ctx.getContextUsage()?.percent ?? null;
		const noise = scoreNoise(ctx);
		state.lastContextPercent = percent;
		state.lastNoiseScore = noise;

		if (state.enabled && percent !== null && percent >= WARN_PERCENT) {
			const now = Date.now();
			const lastWarning = state.lastWarningAt ? new Date(state.lastWarningAt).getTime() : 0;
			if (now - lastWarning > 1000 * 60 * 5 && ctx.hasUI) {
				ctx.ui.notify(isTerseEnabled(ctx.cwd) ? `Ctx ${percent}%, noise ${noise}` : `Context rising: ${percent}% used, noise score ${noise}`, "warning");
				state.lastWarningAt = new Date(now).toISOString();
			}
		}

		const decision = shouldCompact(state, event.turnIndex, percent, noise);
		persist(ctx.cwd);
		refresh(ctx);

		if (decision.compact && ctx.isIdle()) {
			triggerCompact(ctx, decision.reason);
		}
	});

	pi.registerTool({
		name: "context_hygiene",
		label: "Context Hygiene",
		description:
			"Inspect remaining context headroom and compact noisy history when needed. Use `status` to check pressure, and `compact` when the session has too much stale chatter, duplicate planning, or verbose tool residue.",
		parameters: ContextHygieneParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) load(ctx.cwd);

			const percent = ctx.getContextUsage()?.percent ?? null;
			const noise = scoreNoise(ctx);
			state.lastContextPercent = percent;
			state.lastNoiseScore = noise;
			persist(ctx.cwd);
			refresh(ctx);

			if (params.action === "status") {
				const message = [
					`Context hygiene is ${state.enabled ? "enabled" : "disabled"}.`,
					`Context usage: ${percent === null ? "unknown" : `${percent}%`}.`,
					`Noise score: ${noise}.`,
					state.lastCompactAt ? `Last compact: ${state.lastCompactAt}.` : "Last compact: never.",
					state.lastCompactReason ? `Last compact reason: ${state.lastCompactReason}.` : undefined,
				]
					.filter(Boolean)
					.join(" ");

				return {
					content: [{ type: "text", text: message }],
					details: buildToolDetails("status", message, true),
				};
			}

			if (!state.enabled) {
				const message = "Context hygiene is off. Ask the user to enable it with /hygiene on before compacting.";
				return {
					content: [{ type: "text", text: message }],
					details: buildToolDetails("compact", message, false),
				};
			}

			const reason =
				params.reason?.trim() ||
				(percent !== null && percent >= COMPACT_PERCENT
					? `context usage reached ${percent}%`
					: `manual hygiene compaction at noise score ${noise}`);
			triggerCompact(ctx, reason);
			const message = `Triggered hygiene compaction: ${reason}.`;
			return {
				content: [{ type: "text", text: message }],
				details: buildToolDetails("compact", message, true),
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("context_hygiene ")) +
					theme.fg("muted", args.action) +
					(args.reason ? ` ${theme.fg("dim", `"${args.reason}"`)}` : ""),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as HygieneToolResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const prefix = details.ok ? theme.fg("success", "✓ ") : theme.fg("warning", "! ");
			if (!expanded) {
				return new Text(prefix + theme.fg("muted", details.message), 0, 0);
			}

			const extra = [
				`enabled: ${details.enabled}`,
				`context: ${details.contextPercent === null ? "unknown" : `${details.contextPercent}%`}`,
				`noise: ${details.noiseScore}`,
				details.lastCompactAt ? `last compact: ${details.lastCompactAt}` : undefined,
				details.lastCompactReason ? `reason: ${details.lastCompactReason}` : undefined,
			]
				.filter(Boolean)
				.join("\n");

			return new Text(prefix + details.message + `\n\n${extra}`, 0, 0);
		},
	});

	pi.registerCommand("hygiene", {
		description: "Manage context hygiene. Usage: /hygiene [show|on|off|toggle|compact|reset]",
		getArgumentCompletions: (prefix) => {
			const options = ["show", "on", "off", "toggle", "compact", "reset"].filter((value) => value.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (!state) load(ctx.cwd);
			const action = args.trim().toLowerCase() || "show";

			if (action === "show") {
				const details = [
					`Context hygiene: ${state.enabled ? "ON" : "OFF"}`,
					`Context usage: ${state.lastContextPercent === null ? "unknown" : `${state.lastContextPercent}%`}`,
					`Noise score: ${state.lastNoiseScore}`,
					`Last compact: ${state.lastCompactAt ?? "never"}`,
					state.lastCompactReason ? `Reason: ${state.lastCompactReason}` : undefined,
				]
					.filter(Boolean)
					.join("\n");
				ctx.ui.notify(details, "info");
				refresh(ctx);
				return;
			}

			if (action === "on" || action === "off") {
				state.enabled = action === "on";
				saveConfig(ctx.cwd, { enabled: state.enabled });
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(isTerseEnabled(ctx.cwd) ? `Hygiene ${state.enabled ? "on" : "off"}` : `Context hygiene ${state.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "toggle") {
				state.enabled = !state.enabled;
				saveConfig(ctx.cwd, { enabled: state.enabled });
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(isTerseEnabled(ctx.cwd) ? `Hygiene ${state.enabled ? "on" : "off"}` : `Context hygiene ${state.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "compact") {
				triggerCompact(ctx, "manual hygiene compaction");
				return;
			}

			if (action === "reset") {
				const enabled = state.enabled;
				state = createState(enabled);
				saveConfig(ctx.cwd, { enabled });
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(isTerseEnabled(ctx.cwd) ? "Hygiene reset" : "Context hygiene state reset", "info");
				return;
			}

			ctx.ui.notify("Usage: /hygiene [show|on|off|toggle|compact|reset]", "warning");
		},
	});
}
