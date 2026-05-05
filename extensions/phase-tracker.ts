/**
 * Phase Tracker Extension
 *
 * Tracks work in phases with explicit todos, testing, and a required user
 * review gate before a phase can complete.
 *
 * User command:
 * - /phases show
 * - /phases approve [notes]
 * - /phases reject [notes]
 * - /phases reset
 *
 * Agent tool:
 * - phase_tracker
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const EXTENSION_ID = "phase-tracker";
const CONFIG_DIR = ".pi";
const STATE_PATH = "phase-tracker.json";
const TERSE_CONFIG_PATH = "extensions/terse-mode.json";
const DASHBOARD_CONFIG_PATH = "extensions/dashboard-ui.json";

type PhaseStatus = "not_started" | "in_progress" | "awaiting_review" | "done";
type TestStatus = "unknown" | "pass" | "fail";
type ReviewStatus = "not_requested" | "requested" | "approved" | "changes_requested";

interface TodoItem {
	id: number;
	text: string;
	done: boolean;
}

interface Phase {
	id: number;
	name: string;
	goal: string;
	status: PhaseStatus;
	todos: TodoItem[];
	testStatus: TestStatus;
	reviewStatus: ReviewStatus;
	testNotes?: string;
	reviewNotes?: string;
	errorCount: number;
}

interface TrackerState {
	version: 1;
	planTitle?: string;
	phases: Phase[];
	currentPhaseId?: number;
	nextPhaseId: number;
	nextTodoId: number;
	lastUpdatedAt?: string;
}

interface TrackerToolResult {
	action: string;
	ok: boolean;
	message: string;
	state: TrackerState;
}

interface TerseConfig {
	enabled?: boolean;
}

interface DashboardConfig {
	enabled?: boolean;
}

const PhaseTrackerParams = Type.Object({
	action: StringEnum([
		"create_plan",
		"add_phase",
		"add_todo",
		"start_phase",
		"complete_todo",
		"log_test",
		"request_review",
		"log_error",
		"next_phase",
		"list",
	] as const),
	title: Type.Optional(Type.String({ description: "Plan title for create_plan" })),
	phaseName: Type.Optional(Type.String({ description: "Name of the phase" })),
	goal: Type.Optional(Type.String({ description: "Goal of the phase" })),
	phaseId: Type.Optional(Type.Number({ description: "Phase ID to operate on" })),
	todoText: Type.Optional(Type.String({ description: "Todo text" })),
	todoId: Type.Optional(Type.Number({ description: "Todo ID to complete" })),
	testOutcome: Type.Optional(
		StringEnum(["pass", "fail"] as const, { description: "Whether tests passed or failed" }),
	),
	notes: Type.Optional(Type.String({ description: "Test/review/error notes" })),
	error: Type.Optional(Type.String({ description: "Error description when logging a regression" })),
	phases: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				goal: Type.String(),
				todos: Type.Optional(Type.Array(Type.String())),
			}),
		),
	),
});

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function getStatePath(cwd: string): string {
	const piDir = join(cwd, CONFIG_DIR);
	ensureDir(piDir);
	return join(piDir, STATE_PATH);
}

function createEmptyState(): TrackerState {
	return {
		version: 1,
		phases: [],
		nextPhaseId: 1,
		nextTodoId: 1,
	};
}

function loadState(cwd: string): TrackerState {
	const statePath = getStatePath(cwd);
	if (!existsSync(statePath)) {
		return createEmptyState();
	}
	try {
		const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<TrackerState>;
		return {
			version: 1,
			planTitle: parsed.planTitle,
			phases: Array.isArray(parsed.phases) ? parsed.phases : [],
			currentPhaseId: parsed.currentPhaseId,
			nextPhaseId: parsed.nextPhaseId ?? 1,
			nextTodoId: parsed.nextTodoId ?? 1,
			lastUpdatedAt: parsed.lastUpdatedAt,
		};
	} catch {
		return createEmptyState();
	}
}

function saveState(cwd: string, state: TrackerState): void {
	const statePath = getStatePath(cwd);
	state.lastUpdatedAt = new Date().toISOString();
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function isTerseEnabled(cwd: string): boolean {
	const configFile = join(cwd, CONFIG_DIR, TERSE_CONFIG_PATH);
	if (!existsSync(configFile)) return false;
	try {
		return Boolean((JSON.parse(readFileSync(configFile, "utf-8")) as TerseConfig).enabled);
	} catch {
		return false;
	}
}

function isDashboardEnabled(cwd: string): boolean {
	const configFile = join(cwd, CONFIG_DIR, DASHBOARD_CONFIG_PATH);
	if (!existsSync(configFile)) return true;
	try {
		return (JSON.parse(readFileSync(configFile, "utf-8")) as DashboardConfig).enabled !== false;
	} catch {
		return true;
	}
}

function cloneState(state: TrackerState): TrackerState {
	return JSON.parse(JSON.stringify(state)) as TrackerState;
}

function getPhase(state: TrackerState, phaseId?: number): Phase | undefined {
	if (phaseId !== undefined) {
		return state.phases.find((phase) => phase.id === phaseId);
	}
	if (state.currentPhaseId !== undefined) {
		return state.phases.find((phase) => phase.id === state.currentPhaseId);
	}
	return undefined;
}

function summarizePhase(phase: Phase): string {
	const completed = phase.todos.filter((todo) => todo.done).length;
	return `#${phase.id} ${phase.name} [${phase.status}] ${completed}/${phase.todos.length} todos, tests:${phase.testStatus}, review:${phase.reviewStatus}, errors:${phase.errorCount}`;
}

function renderStateText(state: TrackerState): string {
	if (state.phases.length === 0) {
		return "No phases defined yet.";
	}
	const lines: string[] = [];
	if (state.planTitle) {
		lines.push(`Plan: ${state.planTitle}`);
	}
	for (const phase of state.phases) {
		lines.push(summarizePhase(phase));
		for (const todo of phase.todos) {
			lines.push(`  ${todo.done ? "[x]" : "[ ]"} #${todo.id} ${todo.text}`);
		}
		if (phase.testNotes) lines.push(`  test notes: ${phase.testNotes}`);
		if (phase.reviewNotes) lines.push(`  review notes: ${phase.reviewNotes}`);
	}
	return lines.join("\n");
}

function widgetLines(state: TrackerState, theme: Theme, terse: boolean): string[] {
	const lines: string[] = [];
	const phase = getPhase(state);
	lines.push(theme.fg("accent", terse ? "Phases" : "Phase Tracker"));
	if (!phase) {
		lines.push(theme.fg("dim", terse ? "No phase" : "No active phase"));
		if (state.phases.length > 0) {
			lines.push(theme.fg("muted", terse ? `${state.phases.length} ready` : `${state.phases.length} phase(s) ready`));
		}
		return lines;
	}

	const done = phase.todos.filter((todo) => todo.done).length;
	lines.push(theme.fg("text", `${phase.name}  (${done}/${phase.todos.length} todos)`));

	let gate = terse ? "work" : "working";
	if (phase.reviewStatus === "requested") gate = terse ? "review" : "waiting for your review";
	if (phase.reviewStatus === "approved" && phase.status === "done") gate = "approved";
	if (phase.reviewStatus === "changes_requested" || phase.testStatus === "fail") gate = terse ? "fix+test" : "fix and retest";
	lines.push(theme.fg("muted", `gate: ${gate}`));
	lines.push(theme.fg("dim", `tests: ${phase.testStatus} | review: ${phase.reviewStatus} | errors: ${phase.errorCount}`));
	return lines;
}

function setCurrentPhase(state: TrackerState, phase: Phase): void {
	state.currentPhaseId = phase.id;
	for (const other of state.phases) {
		if (other.id !== phase.id && other.status === "in_progress") {
			other.status = "not_started";
		}
	}
	if (phase.status === "not_started") {
		phase.status = "in_progress";
	}
}

function canCompletePhase(phase: Phase): { ok: boolean; reason?: string } {
	if (phase.todos.some((todo) => !todo.done)) {
		return { ok: false, reason: "There are unfinished todos in the current phase." };
	}
	if (phase.testStatus !== "pass") {
		return { ok: false, reason: "Tests have not passed for the current phase." };
	}
	if (phase.reviewStatus !== "approved") {
		return { ok: false, reason: "User review has not approved this phase yet." };
	}
	return { ok: true };
}

function appendPhase(state: TrackerState, name: string, goal: string, todos: string[] = []): Phase {
	const phase: Phase = {
		id: state.nextPhaseId++,
		name,
		goal,
		status: "not_started",
		todos: todos.map((text) => ({ id: state.nextTodoId++, text, done: false })),
		testStatus: "unknown",
		reviewStatus: "not_requested",
		errorCount: 0,
	};
	state.phases.push(phase);
	if (state.currentPhaseId === undefined) {
		setCurrentPhase(state, phase);
	}
	return phase;
}

function ok(action: string, state: TrackerState, message: string): { content: { type: "text"; text: string }[]; details: TrackerToolResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { action, ok: true, message, state: cloneState(state) },
	};
}

function fail(action: string, state: TrackerState, message: string): { content: { type: "text"; text: string }[]; details: TrackerToolResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { action, ok: false, message, state: cloneState(state) },
	};
}

export default function phaseTracker(pi: ExtensionAPI) {
	let state: TrackerState = createEmptyState();

	const load = (cwd: string) => {
		state = loadState(cwd);
	};

	const persist = (cwd: string) => {
		saveState(cwd, state);
		pi.appendEntry(`${EXTENSION_ID}-state`, {
			currentPhaseId: state.currentPhaseId,
			phaseCount: state.phases.length,
			lastUpdatedAt: state.lastUpdatedAt,
		});
	};

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("phase-tracker", undefined);
		const phase = getPhase(state);
		ctx.ui.setStatus(
			"phase-tracker",
			phase ? ctx.ui.theme.fg("accent", `phase:${phase.id}:${phase.status}`) : ctx.ui.theme.fg("dim", "phase:none"),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		load(ctx.cwd);
		refresh(ctx);
	});

	pi.registerTool({
		name: "phase_tracker",
		label: "Phase Tracker",
		description:
			"Track work by phases with todos, test results, error/retest loops, and a required user review gate before moving to the next phase. Use list to inspect current state instead of relying on prompt context.",
		parameters: PhaseTrackerParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) load(ctx.cwd);

			switch (params.action) {
				case "create_plan": {
					state = createEmptyState();
					state.planTitle = params.title?.trim() || "Implementation Plan";
					for (const entry of params.phases ?? []) {
						appendPhase(state, entry.name, entry.goal, entry.todos ?? []);
					}
					persist(ctx.cwd);
					refresh(ctx);
					return ok("create_plan", state, `Created plan "${state.planTitle}" with ${state.phases.length} phase(s).`);
				}

				case "add_phase": {
					if (!params.phaseName || !params.goal) {
						return fail("add_phase", state, "phaseName and goal are required.");
					}
					const phase = appendPhase(state, params.phaseName.trim(), params.goal.trim());
					persist(ctx.cwd);
					refresh(ctx);
					return ok("add_phase", state, `Added phase ${summarizePhase(phase)}.`);
				}

				case "add_todo": {
					const phase = getPhase(state, params.phaseId);
					if (!phase || !params.todoText) {
						return fail("add_todo", state, "A target phase and todoText are required.");
					}
					phase.todos.push({ id: state.nextTodoId++, text: params.todoText.trim(), done: false });
					if (phase.status === "done") phase.status = "in_progress";
					persist(ctx.cwd);
					refresh(ctx);
					return ok("add_todo", state, `Added todo to phase #${phase.id}.`);
				}

				case "start_phase": {
					const phase = getPhase(state, params.phaseId) ?? state.phases.find((entry) => entry.status !== "done");
					if (!phase) {
						return fail("start_phase", state, "No phase available to start.");
					}
					setCurrentPhase(state, phase);
					phase.reviewStatus = phase.reviewStatus === "approved" ? "approved" : "not_requested";
					persist(ctx.cwd);
					refresh(ctx);
					return ok("start_phase", state, `Started phase ${summarizePhase(phase)}.`);
				}

				case "complete_todo": {
					const phase = getPhase(state, params.phaseId);
					if (!phase || params.todoId === undefined) {
						return fail("complete_todo", state, "A target phase and todoId are required.");
					}
					const todo = phase.todos.find((entry) => entry.id === params.todoId);
					if (!todo) {
						return fail("complete_todo", state, `Todo #${params.todoId} not found.`);
					}
					todo.done = true;
					if (phase.status === "not_started") phase.status = "in_progress";
					persist(ctx.cwd);
					refresh(ctx);
					return ok("complete_todo", state, `Completed todo #${todo.id} in phase #${phase.id}.`);
				}

				case "log_test": {
					const phase = getPhase(state, params.phaseId);
					if (!phase || !params.testOutcome) {
						return fail("log_test", state, "A target phase and testOutcome are required.");
					}
					phase.testStatus = params.testOutcome;
					phase.testNotes = params.notes?.trim();
					if (params.testOutcome === "fail") {
						phase.status = "in_progress";
						phase.reviewStatus = "not_requested";
					}
					persist(ctx.cwd);
					refresh(ctx);
					return ok("log_test", state, `Logged test result "${params.testOutcome}" for phase #${phase.id}.`);
				}

				case "request_review": {
					const phase = getPhase(state, params.phaseId);
					if (!phase) {
						return fail("request_review", state, "No target phase found.");
					}
					if (phase.todos.some((todo) => !todo.done)) {
						return fail("request_review", state, "Cannot request review while there are unfinished todos.");
					}
					if (phase.testStatus !== "pass") {
						return fail("request_review", state, "Cannot request review until tests pass.");
					}
					phase.reviewStatus = "requested";
					phase.reviewNotes = params.notes?.trim();
					phase.status = "awaiting_review";
					persist(ctx.cwd);
					refresh(ctx);
					return ok("request_review", state, `Phase #${phase.id} is now awaiting user review.`);
				}

				case "log_error": {
					const phase = getPhase(state, params.phaseId);
					if (!phase || !params.error) {
						return fail("log_error", state, "A target phase and error text are required.");
					}
					phase.errorCount += 1;
					phase.status = "in_progress";
					phase.testStatus = "fail";
					phase.reviewStatus = "changes_requested";
					phase.reviewNotes = [params.error.trim(), params.notes?.trim()].filter(Boolean).join(" | ");
					setCurrentPhase(state, phase);
					persist(ctx.cwd);
					refresh(ctx);
					return ok("log_error", state, `Logged regression for phase #${phase.id}; it remains active for fixes and retesting.`);
				}

				case "next_phase": {
					const phase = getPhase(state);
					if (!phase) {
						return fail("next_phase", state, "No active phase.");
					}
					const completion = canCompletePhase(phase);
					if (!completion.ok) {
						return fail("next_phase", state, completion.reason || "Current phase is not ready to complete.");
					}
					phase.status = "done";
					const next = state.phases.find((entry) => entry.id > phase.id && entry.status !== "done");
					if (next) {
						setCurrentPhase(state, next);
						persist(ctx.cwd);
						refresh(ctx);
						return ok("next_phase", state, `Completed phase #${phase.id}; moved to phase #${next.id}.`);
					}
					state.currentPhaseId = undefined;
					persist(ctx.cwd);
					refresh(ctx);
					return ok("next_phase", state, `Completed final phase #${phase.id}.`);
				}

				case "list":
					return ok("list", state, renderStateText(state));
			}

			return fail(params.action, state, `Unknown action: ${params.action}`);
		},

		renderCall(args, theme) {
			let line = theme.fg("toolTitle", theme.bold("phase_tracker ")) + theme.fg("muted", args.action);
			if (args.phaseId !== undefined) line += ` ${theme.fg("accent", `#${args.phaseId}`)}`;
			if (args.phaseName) line += ` ${theme.fg("dim", `"${args.phaseName}"`)}`;
			return new Text(line, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TrackerToolResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (!details.ok) {
				return new Text(theme.fg("error", details.message), 0, 0);
			}

			if (!expanded) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", details.message), 0, 0);
			}

			return new Text(theme.fg("success", "✓ ") + details.message + `\n\n${renderStateText(details.state)}`, 0, 0);
		},
	});

	pi.registerCommand("phases", {
		description: "Show or review tracked phases. Usage: /phases [show|approve|reject|reset] [notes]",
		getArgumentCompletions: (prefix) => {
			const options = ["show", "approve", "reject", "reset"].filter((value) => value.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (!state) load(ctx.cwd);
			const [rawAction, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const action = rawAction || "show";
			const notes = rest.join(" ").trim();
			const phase = getPhase(state);

			if (action === "show") {
				ctx.ui.notify(renderStateText(state), "info");
				refresh(ctx);
				return;
			}

			if (action === "reset") {
				state = createEmptyState();
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(isTerseEnabled(ctx.cwd) ? "Phases reset" : "Phase tracker reset", "info");
				return;
			}

			if (!phase) {
				ctx.ui.notify("No active phase to review", "warning");
				return;
			}

			if (action === "approve") {
				phase.reviewStatus = "approved";
				phase.reviewNotes = notes || "User approved phase review.";
				if (phase.testStatus === "pass" && phase.todos.every((todo) => todo.done)) {
					phase.status = "done";
				}
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(
					isTerseEnabled(ctx.cwd)
						? `Phase #${phase.id} approved.`
						: `Approved phase #${phase.id}. The agent can move on with phase_tracker next_phase.`,
					"info",
				);
				return;
			}

			if (action === "reject") {
				phase.reviewStatus = "changes_requested";
				phase.reviewNotes = notes || "User requested changes.";
				phase.status = "in_progress";
				phase.testStatus = "fail";
				phase.errorCount += 1;
				setCurrentPhase(state, phase);
				persist(ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(
					isTerseEnabled(ctx.cwd)
						? `Phase #${phase.id} rejected.`
						: `Rejected phase #${phase.id}. It stays open for fixes and retesting.`,
					"warning",
				);
				return;
			}

			ctx.ui.notify("Usage: /phases [show|approve|reject|reset] [notes]", "warning");
		},
	});
}
