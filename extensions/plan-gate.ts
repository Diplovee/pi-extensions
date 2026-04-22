/**
 * Plan Gate Extension
 *
 * Keeps the agent in planning mode until the user explicitly approves coding.
 *
 * Commands:
 * - /plan show
 * - /plan start [objective]
 * - /plan hold
 * - /plan go
 * - /plan ok
 * - /plan reset
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const CONFIG_DIR = ".pi";
const STATE_PATH = "plan-gate.json";
const SESSION_DIR = "sessions";

interface PlanGateState {
	version: 1;
	planningMode: boolean;
	objective?: string;
	approvedAt?: string;
	lastUpdatedAt?: string;
}

interface PlanGateToolResult {
	action: string;
	ok: boolean;
	message: string;
	planningMode: boolean;
	objective?: string;
	approvedAt?: string;
}

const PlanGateParams = Type.Object({
	action: StringEnum(["status", "start", "hold", "go", "ok", "reset", "objective"] as const),
	objective: Type.Optional(Type.String({ description: "Planning objective text" })),
});

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function getSessionScope(): string {
	const raw = process.env.PI_SESSION_ID || process.env.PI_SESSION_SCOPE || `pid-${process.pid}`;
	return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || `pid-${process.pid}`;
}

function getPaths(cwd: string) {
	const piDir = join(cwd, CONFIG_DIR);
	const sessionDir = join(piDir, SESSION_DIR, getSessionScope());
	return {
		sessionDir,
		stateFile: join(sessionDir, STATE_PATH),
		legacyStateFile: join(piDir, STATE_PATH),
	};
}

function createState(): PlanGateState {
	return {
		version: 1,
		planningMode: false,
	};
}

function loadState(cwd: string): PlanGateState {
	const { stateFile, legacyStateFile, sessionDir } = getPaths(cwd);
	ensureDir(sessionDir);
	const file = existsSync(stateFile) ? stateFile : legacyStateFile;
	if (!existsSync(file)) return createState();
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PlanGateState>;
		return {
			version: 1,
			planningMode: parsed.planningMode ?? false,
			objective: parsed.objective,
			approvedAt: parsed.approvedAt,
			lastUpdatedAt: parsed.lastUpdatedAt,
		};
	} catch {
		return createState();
	}
}

function saveState(cwd: string, state: PlanGateState): void {
	const { stateFile, sessionDir } = getPaths(cwd);
	ensureDir(sessionDir);
	state.lastUpdatedAt = new Date().toISOString();
	writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function buildPlanningInstructions(state: PlanGateState): string {
	return [
		"You are in PLANNING MODE. Do not implement or modify files yet.",
		"You must only analyze, ask clarifying questions, and propose/iterate plans.",
		"Do not use edit or write tools. Avoid making any code changes.",
		"At the end of each response, ask for approval with: 'Say /plan go when you want me to start coding.'",
		state.objective ? `Current planning objective: ${state.objective}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

export default function planGateExtension(pi: ExtensionAPI) {
	let state: PlanGateState = createState();

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"plan-gate",
			state.planningMode ? ctx.ui.theme.fg("warning", "plan:hold") : ctx.ui.theme.fg("success", "plan:go"),
		);
		ctx.ui.setWidget(
			"plan-gate",
			state.planningMode
				? [
					ctx.ui.theme.fg("warning", "Plan Mode: ON (coding blocked)"),
					ctx.ui.theme.fg("muted", state.objective ? `objective: ${state.objective}` : "objective: none"),
					ctx.ui.theme.fg("dim", "Use /plan go when ready to code."),
				]
				: undefined,
			{ placement: "belowEditor" },
		);
	};

	const persist = (cwd: string) => {
		saveState(cwd, state);
		pi.appendEntry("plan-gate", state);
	};

	const buildToolDetails = (action: string, ok: boolean, message: string): PlanGateToolResult => ({
		action,
		ok,
		message,
		planningMode: state.planningMode,
		objective: state.objective,
		approvedAt: state.approvedAt,
	});

	pi.on("session_start", async (_event, ctx) => {
		state = loadState(ctx.cwd);
		refresh(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.planningMode) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanningInstructions(state)}`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!state.planningMode) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "Plan mode is active. Coding is blocked until user approval. Use /plan go to enable coding.",
			};
		}
	});

	pi.registerTool({
		name: "plan_gate",
		label: "Plan Gate",
		description: "Keep the session in planning mode until the user explicitly approves coding.",
		parameters: PlanGateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			const objective = params.objective?.trim();

			if (action === "status") {
				const message = `Plan mode is ${state.planningMode ? "ON (coding blocked)" : "OFF (coding allowed)"}. Objective: ${state.objective ?? "none"}.`;
				return {
					content: [{ type: "text", text: message }],
					details: buildToolDetails(action, true, message),
				};
			}

			if (action === "start" || action === "hold") {
				state.planningMode = true;
				if (objective) state.objective = objective;
				state.approvedAt = undefined;
				persist(ctx.cwd);
				refresh(ctx);
				const message = state.objective
					? `Plan mode enabled. Objective: ${state.objective}`
					: "Plan mode enabled. Coding is blocked until /plan go or plan_gate go.";
				return {
					content: [{ type: "text", text: message }],
					details: buildToolDetails(action, true, message),
				};
			}

			if (action === "objective") {
				if (!objective) {
					const message = "Missing objective. Provide objective text with action=objective.";
					return {
						content: [{ type: "text", text: message }],
						details: buildToolDetails(action, false, message),
					};
				}
				state.objective = objective;
				persist(ctx.cwd);
				refresh(ctx);
				const message = `Plan objective updated: ${objective}`;
				return {
					content: [{ type: "text", text: message }],
					details: buildToolDetails(action, true, message),
				};
			}

			if (action === "go" || action === "ok") {
				state.planningMode = false;
				state.approvedAt = new Date().toISOString();
				persist(ctx.cwd);
				refresh(ctx);
				const message = "Plan approved. Coding is now allowed.";
				return {
					content: [{ type: "text", text: message }],
					details: buildToolDetails(action, true, message),
				};
			}

			state = createState();
			persist(ctx.cwd);
			refresh(ctx);
			const message = "Plan state reset.";
			return {
				content: [{ type: "text", text: message }],
				details: buildToolDetails(action, true, message),
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("plan_gate ")) +
					theme.fg("muted", args.action) +
					(args.objective ? ` ${theme.fg("dim", `\"${args.objective}\"`)}` : ""),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as PlanGateToolResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const prefix = details.ok ? theme.fg("success", "✓ ") : theme.fg("warning", "! ");
			if (!expanded) return new Text(prefix + theme.fg("muted", details.message), 0, 0);
			const extra = [
				`planningMode: ${details.planningMode}`,
				`objective: ${details.objective ?? "none"}`,
				details.approvedAt ? `approvedAt: ${details.approvedAt}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
			return new Text(prefix + details.message + `\n\n${extra}`, 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "Plan gate: /plan [show|start [objective]|hold|go|ok|reset]",
		getArgumentCompletions: (prefix) => {
			const options = ["show", "start", "hold", "go", "ok", "reset"].filter((v) => v.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [cmdRaw, ...rest] = raw.split(/\s+/);
			const cmd = (cmdRaw || "show").toLowerCase();
			const objective = rest.join(" ").trim();

			if (cmd === "show") {
				ctx.ui.notify(
					[
						`Plan mode: ${state.planningMode ? "ON (coding blocked)" : "OFF (coding allowed)"}`,
						`Objective: ${state.objective || "none"}`,
						`Approved at: ${state.approvedAt || "never"}`,
					].join("\n"),
					"info",
				);
				refresh(ctx);
				return;
			}

			if (cmd === "start" || cmd === "hold") {
				state.planningMode = true;
				if (objective) state.objective = objective;
				state.approvedAt = undefined;
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(
					state.objective
						? `Plan mode enabled. Objective: ${state.objective}`
						: "Plan mode enabled. We will plan until you approve coding with /plan go.",
					"info",
				);
				return;
			}

			if (cmd === "go" || cmd === "ok") {
				state.planningMode = false;
				state.approvedAt = new Date().toISOString();
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify("Plan approved. Coding is now allowed.", "success");
				return;
			}

			if (cmd === "reset") {
				state = createState();
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify("Plan state reset.", "info");
				return;
			}

			ctx.ui.notify("Usage: /plan [show|start [objective]|hold|go|ok|reset]", "warning");
		},
	});
}
