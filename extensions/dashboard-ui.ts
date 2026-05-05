/**
 * Dashboard UI Extension
 *
 * Renders a combined widget and split footer for memory, hygiene, and phase
 * state. When enabled, other extensions can suppress their own widgets.
 *
 * Commands:
 * - /dashboard show
 * - /dashboard on
 * - /dashboard off
 * - /dashboard toggle
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const CONFIG_DIR = ".pi";
const CONFIG_PATH = "extensions/dashboard-ui.json";
const SESSION_DIR = "sessions";

interface DashboardConfig {
	enabled: boolean;
}

function getConfigPath(cwd: string): string {
	const dir = join(cwd, CONFIG_DIR, "extensions");
	mkdirSync(dir, { recursive: true });
	return join(dir, "dashboard-ui.json");
}

function loadConfig(cwd: string): DashboardConfig {
	const path = getConfigPath(cwd);
	if (!existsSync(path)) return { enabled: true };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<DashboardConfig>;
		return { enabled: parsed.enabled !== false };
	} catch {
		return { enabled: true };
	}
}

function saveConfig(cwd: string, config: DashboardConfig): void {
	writeFileSync(getConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function shortLine(left: string, right: string, width: number): string {
	const available = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(available) + right, width);
}

function getSessionScope(): string {
	const raw = process.env.PI_SESSION_ID || process.env.PI_SESSION_SCOPE || `pid-${process.pid}`;
	return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || `pid-${process.pid}`;
}

function readSessionJson<T>(cwd: string, filename: string): T | null {
	const piDir = join(cwd, CONFIG_DIR);
	const sessionFile = join(piDir, SESSION_DIR, getSessionScope(), filename);
	return readJson<T>(sessionFile) ?? readJson<T>(join(piDir, filename));
}

function renderContextBar(
	theme: { fg: (color: string, text: string) => string },
	contextPercent: number | null | undefined,
	barWidth: number,
): string {
	if (contextPercent === null || contextPercent === undefined) {
		return `${theme.fg("borderMuted", "[")}${theme.fg("dim", "?".repeat(barWidth))}${theme.fg("borderMuted", "]")} ${theme.fg("dim", "?%")}`;
	}

	const clamped = Math.max(0, Math.min(100, contextPercent));
	const filled = Math.round((clamped / 100) * barWidth);
	const color = clamped >= 72 ? "error" : clamped >= 55 ? "warning" : "success";
	const fill = filled > 0 ? theme.fg(color, "█".repeat(filled)) : "";
	const empty = filled < barWidth ? theme.fg("muted", "░".repeat(barWidth - filled)) : "";
	return `${theme.fg("borderMuted", "[")}${fill}${empty}${theme.fg("borderMuted", "]")} ${theme.fg("muted", `${Math.round(clamped)}%`)}`;
}

function normalizeLabel(value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	return value.replace(/_/g, " ").trim() || fallback;
}

function kv(theme: { fg: (color: string, text: string) => string }, label: string, value: string, labelWidth = 8): string {
	return `${theme.fg("dim", `${label}:`.padEnd(labelWidth + 1, " "))}${value}`;
}

function hasThemedUiInstalled(): boolean {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return false;
	return existsSync(join(home, ".pi", "agent", "extensions", "themed-ui"));
}

function statusColor(value: string | undefined): string {
	const normalized = (value ?? "").toLowerCase();
	if (normalized.includes("pass") || normalized.includes("done") || normalized.includes("approved")) return "success";
	if (normalized.includes("fail") || normalized.includes("reject") || normalized.includes("error")) return "error";
	if (normalized.includes("review") || normalized.includes("await") || normalized.includes("pending")) return "warning";
	return "muted";
}

export default function dashboardUI(pi: ExtensionAPI) {
	let enabled = true;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		if (!enabled) {
			ctx.ui.setWidget("dashboard-ui", undefined);
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus("dashboard-ui", ctx.ui.theme.fg("dim", "dash:off"));
			return;
		}

		ctx.ui.setStatus("dashboard-ui", ctx.ui.theme.fg("accent", "dash:on"));

		ctx.ui.setWidget("dashboard-ui", (_tui, theme) => {
			return {
				invalidate() {},
				render(width: number): string[] {
					const memory = readSessionJson<{
						enabled?: boolean;
						preferences?: unknown[];
						projectFacts?: unknown[];
						recentDecisions?: unknown[];
						currentFocus?: string;
					}>(ctx.cwd, "auto-memory.json");
					const hygiene = readSessionJson<{
						enabled?: boolean;
						lastContextPercent?: number | null;
						lastNoiseScore?: number;
						lastCompactReason?: string;
					}>(ctx.cwd, "context-hygiene.json");
					const phase = readJson<{
						currentPhaseId?: number;
						phases?: Array<{
							id: number;
							name: string;
							status: string;
							todos: Array<{ done: boolean }>;
							testStatus: string;
							reviewStatus: string;
						}>;
					}>(join(ctx.cwd, ".pi", "phase-tracker.json"));
					const cosplay = readSessionJson<{
						active?: boolean;
						name?: string;
						source?: "preset" | "custom";
					}>(ctx.cwd, "cosplay-state.json");

					const currentPhase =
						phase?.phases?.find((item) => item.id === phase.currentPhaseId) ?? phase?.phases?.[0];
					const doneTodos = currentPhase?.todos?.filter((todo) => todo.done).length ?? 0;
					const totalTodos = currentPhase?.todos?.length ?? 0;

					const inner = Math.max(20, width - 4);
					const twoColumn = inner >= 86;
					const leftWidth = twoColumn ? Math.max(12, Math.floor(inner * 0.52)) : inner;
					const rightWidth = twoColumn ? Math.max(12, inner - leftWidth - 3) : inner;
					const hygieneBarWidth = Math.max(8, Math.min(16, leftWidth - 15));

					const memoryOn = memory?.enabled !== false;
					const memoryCounts = `${memory?.preferences?.length ?? 0}p ${memory?.projectFacts?.length ?? 0}f ${memory?.recentDecisions?.length ?? 0}d`;
					const focusText = memory?.currentFocus
						? truncateToWidth(memory.currentFocus, Math.max(10, leftWidth - 10), "...")
						: theme.fg("muted", "none");

					const hygieneOn = hygiene?.enabled !== false;
					const noiseText = String(hygiene?.lastNoiseScore ?? 0);
					const compactText = hygiene?.lastCompactReason
						? truncateToWidth(hygiene.lastCompactReason, Math.max(10, leftWidth - 10), "...")
						: theme.fg("muted", "none");

					const phaseName = currentPhase ? truncateToWidth(currentPhase.name, Math.max(10, rightWidth - 10), "...") : theme.fg("muted", "none");
					const phaseState = normalizeLabel(currentPhase?.status, "none");
					const testsState = normalizeLabel(currentPhase?.testStatus, "?");
					const reviewState = normalizeLabel(currentPhase?.reviewStatus, "?");
					const cosplayName = cosplay?.active
						? truncateToWidth(cosplay.name || "custom", Math.max(10, rightWidth - 10), "...")
						: theme.fg("muted", "none");
					const cosplayState = cosplay?.active
						? theme.fg("success", cosplay.source || "active")
						: theme.fg("muted", "off");

					const left: string[] = [
						theme.fg("accent", "MEMORY"),
						kv(theme, "status", memoryOn ? theme.fg("success", "on") : theme.fg("warning", "off")),
						kv(theme, "store", theme.fg("muted", memoryCounts)),
						kv(theme, "focus", focusText),
						"",
						theme.fg("accent", "HYGIENE"),
						kv(theme, "status", hygieneOn ? theme.fg("success", "on") : theme.fg("warning", "off")),
						kv(theme, "noise", theme.fg(statusColor(noiseText), noiseText)),
						kv(theme, "ctx", renderContextBar(theme, hygiene?.lastContextPercent, hygieneBarWidth)),
						kv(theme, "compact", compactText),
					];

					const right: string[] = [
						theme.fg("accent", "PHASE"),
						kv(theme, "name", phaseName),
						kv(theme, "todos", `${doneTodos}/${totalTodos}`),
						kv(theme, "state", theme.fg(statusColor(phaseState), phaseState)),
						kv(theme, "tests", theme.fg(statusColor(testsState), testsState)),
						kv(theme, "review", theme.fg(statusColor(reviewState), reviewState)),
						"",
						theme.fg("accent", "COSPLAY"),
						kv(theme, "name", cosplayName),
						kv(theme, "state", cosplayState),
					];

					const lines: string[] = [];
					lines.push(theme.fg("borderMuted", `┌${"─".repeat(inner)}┐`));
					lines.push(
						theme.fg("borderMuted", "│ ") +
							shortLine(theme.fg("accent", "PI Dashboard"), theme.fg("dim", enabled ? "active" : "off"), inner) +
							theme.fg("borderMuted", " │"),
					);
					lines.push(theme.fg("borderMuted", `├${"─".repeat(inner)}┤`));

					if (!twoColumn) {
						const single = [...left, "", theme.fg("borderMuted", "-".repeat(Math.max(8, inner - 2))), "", ...right];
						for (const row of single) {
							const cell = truncateToWidth(row, inner, "");
							const pad = " ".repeat(Math.max(0, inner - visibleWidth(cell)));
							lines.push(theme.fg("borderMuted", "│ ") + cell + pad + theme.fg("borderMuted", " │"));
						}
					} else {
						const rows = Math.max(left.length, right.length);
						for (let i = 0; i < rows; i++) {
							const leftCell = truncateToWidth(left[i] ?? "", leftWidth, "");
							const rightCell = truncateToWidth(right[i] ?? "", rightWidth, "");
							const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftCell)));
							const rightPad = " ".repeat(Math.max(0, rightWidth - visibleWidth(rightCell)));
							lines.push(
								theme.fg("borderMuted", "│ ") +
									leftCell +
									leftPad +
									theme.fg("borderMuted", " │ ") +
									rightCell +
									rightPad +
									theme.fg("borderMuted", " │"),
							);
						}
					}

					lines.push(theme.fg("borderMuted", `└${"─".repeat(inner)}┘`));
					return lines;
				},
			};
		});

		if (hasThemedUiInstalled()) {
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					let cwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
					const branch = footerData.getGitBranch();
					if (branch) cwd += ` (${branch})`;

					const top = shortLine(theme.fg("dim", cwd), theme.fg("dim", ctx.model?.id || "no-model"), width);
					const mid = truncateToWidth(theme.fg("dim", `↑${input} ↓${output} $${cost.toFixed(3)}`), width);
					return [top, mid];
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		enabled = loadConfig(ctx.cwd).enabled;
		refresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.registerCommand("dashboard", {
		description: "Manage dashboard UI. Usage: /dashboard [show|on|off|toggle]",
		getArgumentCompletions: (prefix) => {
			const options = ["show", "on", "off", "toggle"].filter((value) => value.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "show";
			if (action === "show") {
				enabled = loadConfig(ctx.cwd).enabled;
				refresh(ctx);
				ctx.ui.notify(`Dashboard: ${enabled ? "ON" : "OFF"}`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				enabled = action === "on";
				saveConfig(ctx.cwd, { enabled });
				refresh(ctx);
				ctx.ui.notify(`Dashboard ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (action === "toggle") {
				enabled = !loadConfig(ctx.cwd).enabled;
				saveConfig(ctx.cwd, { enabled });
				refresh(ctx);
				ctx.ui.notify(`Dashboard ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /dashboard [show|on|off|toggle]", "warning");
		},
	});
}
