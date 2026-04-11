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
					const memory = readJson<{
						enabled?: boolean;
						preferences?: unknown[];
						projectFacts?: unknown[];
						recentDecisions?: unknown[];
						currentFocus?: string;
					}>(join(ctx.cwd, ".pi", "auto-memory.json"));
					const hygiene = readJson<{
						enabled?: boolean;
						lastContextPercent?: number | null;
						lastNoiseScore?: number;
						lastCompactReason?: string;
					}>(join(ctx.cwd, ".pi", "context-hygiene.json"));
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

					const currentPhase =
						phase?.phases?.find((item) => item.id === phase.currentPhaseId) ?? phase?.phases?.[0];
					const doneTodos = currentPhase?.todos?.filter((todo) => todo.done).length ?? 0;
					const totalTodos = currentPhase?.todos?.length ?? 0;

					const inner = Math.max(20, width - 4);
					const leftWidth = Math.max(10, Math.floor(inner * 0.52));
					const rightWidth = Math.max(10, inner - leftWidth - 3);

					const left: string[] = [
						theme.fg("accent", "Memory"),
						`${memory?.enabled === false ? "off" : "on"} | ${memory?.preferences?.length ?? 0} prefs | ${memory?.projectFacts?.length ?? 0} facts | ${memory?.recentDecisions?.length ?? 0} decisions`,
						memory?.currentFocus ? `focus: ${memory.currentFocus}` : "focus: none",
						"",
						theme.fg("accent", "Hygiene"),
						`${hygiene?.enabled === false ? "off" : "on"} | ctx ${hygiene?.lastContextPercent ?? "?"}% | noise ${hygiene?.lastNoiseScore ?? 0}`,
						hygiene?.lastCompactReason ? `compact: ${hygiene.lastCompactReason}` : "compact: none",
					];

					const right: string[] = [
						theme.fg("accent", "Phase"),
						currentPhase ? `${currentPhase.name}` : "none",
						currentPhase
							? `${doneTodos}/${totalTodos} todos | ${currentPhase.status}`
							: "0/0 todos | none",
						currentPhase
							? `tests ${currentPhase.testStatus} | review ${currentPhase.reviewStatus}`
							: "tests ? | review ?",
					];

					const rows = Math.max(left.length, right.length);
					const lines: string[] = [];
					lines.push(theme.fg("borderMuted", `┌${"─".repeat(inner)}┐`));
					lines.push(
						theme.fg("borderMuted", "│ ") +
							shortLine(theme.fg("accent", "PI Dashboard"), theme.fg("dim", enabled ? "active" : "off"), inner) +
							theme.fg("borderMuted", " │"),
					);
					lines.push(theme.fg("borderMuted", `├${"─".repeat(inner)}┤`));

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

					lines.push(theme.fg("borderMuted", `└${"─".repeat(inner)}┘`));
					return lines;
				},
			};
		});

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

					const statuses = footerData.getExtensionStatuses();
					const leftStatuses = ["auto-memory", "context-hygiene", "terse-mode"]
						.map((key) => statuses.get(key))
						.filter(Boolean)
						.join(" ");
					const rightStatuses = ["phase-tracker", "dashboard-ui"]
						.map((key) => statuses.get(key))
						.filter(Boolean)
						.join(" ");

					const top = shortLine(theme.fg("dim", cwd), theme.fg("dim", ctx.model?.id || "no-model"), width);
					const mid = shortLine(
						theme.fg("dim", `↑${input} ↓${output} $${cost.toFixed(3)}`),
						theme.fg("dim", rightStatuses),
						width,
					);
					const bottom = shortLine(theme.fg("accent", leftStatuses), theme.fg("accent", rightStatuses), width);
					return [top, mid, bottom];
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
