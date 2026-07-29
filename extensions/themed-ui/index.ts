import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	createElapsedTimer,
	formatElapsed,
	startElapsedTimer,
	stopElapsedTimer,
} from "./lib/elapsed-timer";
import { installEditor } from "./lib/editor-view";
import { installFooter } from "./lib/footer-view";
import { installHeader } from "./lib/header-view";
import { chooseMascot, CURATED_MASCOTS, getMascotValue, randomMascotName } from "./lib/mascots";
import { chooseTheme } from "./lib/theme-picker";
import { CURATED_THEMES } from "./lib/shared";
import {
	loadTaskSummaryPreference,
	parseTaskSummaryCommand,
	saveTaskSummaryPreference,
} from "./lib/task-summary-preference";
import {
	accumulateTaskUsage,
	entriesAddedSince,
	formatCompactCost,
	formatExactNumber,
	formatTaskUsageBreakdown,
	formatTokenCount,
	type TaskSummaryData,
} from "./lib/task-summary";

const TASK_SUMMARY_ENTRY_TYPE = "themed-ui-task-summary";

export default function (pi: ExtensionAPI) {
	let modelName = "no-model";
	let previousThemeName: string | undefined;
	let customHeaderEnabled = true;
	let mascotName = randomMascotName();
	let previousMascotName: string | undefined;
	let elapsedTimer = createElapsedTimer();
	let taskStartEntryIds: ReadonlySet<string> | undefined;
	let taskSummaryEnabled = true;
	let timerInterval: ReturnType<typeof setInterval> | undefined;
	let requestEditorRender: (() => void) | undefined;

	const stopTimerUpdates = () => {
		if (!timerInterval) return;
		clearInterval(timerInterval);
		timerInterval = undefined;
	};

	const startTimerUpdates = () => {
		if (timerInterval) return;
		timerInterval = setInterval(() => requestEditorRender?.(), 1000);
	};

	const installChrome = (ctx: ExtensionContext) => {
		installHeader(ctx, { enabled: customHeaderEnabled, modelName });
		installEditor(
			ctx,
			() => modelName,
			() => pi.getThinkingLevel(),
			() => getMascotValue(mascotName) ?? "🤖",
			() => elapsedTimer,
			(requestRender) => {
				requestEditorRender = requestRender;
			},
		);
		installFooter(ctx);
	};

	const switchTheme = (ctx: ExtensionContext, themeName: string) => {
		const current = ctx.ui.theme.name;
		const result = ctx.ui.setTheme(themeName);
		if (!result.success) {
			ctx.ui.notify(result.error ?? `Failed to switch to ${themeName}`, "error");
			return false;
		}
		if (current && current !== themeName) previousThemeName = current;
		installChrome(ctx);
		ctx.ui.notify(`Theme: ${themeName}`, "success");
		return true;
	};

	pi.registerEntryRenderer<TaskSummaryData>(TASK_SUMMARY_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data || data.version !== 1 || !data.usage) return undefined;

		const { usage } = data;
		const separator = theme.fg("dim", "  ");
		const breakdown = usage.breakdown ?? [];
		const modelCount = breakdown.filter((item) => item.category === "model").length;
		let text = [
			theme.fg("accent", `◷ ${formatElapsed(data.elapsedMs)}`),
			theme.fg("muted", `↑${formatTokenCount(usage.input)}`),
			theme.fg("muted", `↓${formatTokenCount(usage.output)}`),
			theme.fg("dim", `cache ${formatTokenCount(usage.cacheRead)}/${formatTokenCount(usage.cacheWrite)}`),
			theme.fg("muted", `Σ${formatTokenCount(usage.totalTokens)}`),
			theme.fg("success", formatCompactCost(usage.cost.total)),
			...(modelCount > 1 ? [theme.fg("dim", `${modelCount} models`)] : []),
		].join(separator);

		if (expanded) {
			text += `\n${theme.fg(
				"dim",
				`input ${formatExactNumber(usage.input)} · output ${formatExactNumber(usage.output)} · reasoning ${formatExactNumber(usage.reasoning)}`,
			)}`;
			text += `\n${theme.fg(
				"dim",
				`cache read ${formatExactNumber(usage.cacheRead)} · cache write ${formatExactNumber(usage.cacheWrite)} · total ${formatExactNumber(usage.totalTokens)}`,
			)}`;
			const costComponents = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
			const costDetail =
				usage.cost.total > 0 && costComponents === 0
					? `cost $${usage.cost.total.toFixed(6)} (component split unavailable)`
					: `cost $${usage.cost.total.toFixed(6)} (input $${usage.cost.input.toFixed(6)} · output $${usage.cost.output.toFixed(6)} · cache read/write $${usage.cost.cacheRead.toFixed(6)}/$${usage.cost.cacheWrite.toFixed(6)})`;
			text += `\n${theme.fg("dim", costDetail)}`;
			if (breakdown.length > 0) {
				text += `\n${theme.fg("muted", "Usage by model/source:")}`;
				for (const item of breakdown) text += `\n${theme.fg("dim", `  ${formatTaskUsageBreakdown(item)}`)}`;
			}
			text += `\n${theme.fg(
				"dim",
				`${formatExactNumber(usage.usageRecords)} usage record${usage.usageRecords === 1 ? "" : "s"}`,
			)}`;
		}

		return new Text(text, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		stopTimerUpdates();
		elapsedTimer = createElapsedTimer();
		taskStartEntryIds = undefined;
		taskSummaryEnabled = await loadTaskSummaryPreference();
		requestEditorRender = undefined;
		if (!ctx.hasUI) return;
		modelName = ctx.model?.id ?? "no-model";
		installChrome(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const nextTimer = startElapsedTimer(elapsedTimer, Date.now());
		if (nextTimer === elapsedTimer) return;
		elapsedTimer = nextTimer;
		taskStartEntryIds = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
		startTimerUpdates();
		requestEditorRender?.();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const wasActive = elapsedTimer.active;
		const idsPresentAtStart = taskStartEntryIds;
		elapsedTimer = stopElapsedTimer(elapsedTimer, Date.now());
		taskStartEntryIds = undefined;
		stopTimerUpdates();
		if (ctx.hasUI) requestEditorRender?.();

		if (!wasActive || !idsPresentAtStart || !taskSummaryEnabled || ctx.mode !== "tui") return;
		const taskEntries = entriesAddedSince(ctx.sessionManager.getEntries(), idsPresentAtStart);
		pi.appendEntry<TaskSummaryData>(TASK_SUMMARY_ENTRY_TYPE, {
			version: 1,
			elapsedMs: elapsedTimer.elapsedMs,
			usage: accumulateTaskUsage(taskEntries),
		});
	});

	pi.on("session_shutdown", async () => {
		stopTimerUpdates();
		taskStartEntryIds = undefined;
		requestEditorRender = undefined;
	});

	pi.on("model_select", async (event, ctx) => {
		if (!ctx.hasUI) return;
		modelName = event.model.id;
		installChrome(ctx);
	});

	pi.registerCommand("pi-task-summary", {
		description: "Toggle or configure post-task usage summaries",
		handler: async (args, ctx) => {
			const command = parseTaskSummaryCommand(args, taskSummaryEnabled);
			if (command.kind === "invalid") {
				ctx.ui.notify("Usage: /pi-task-summary [on|off|toggle|status]", "warning");
				return;
			}
			if (command.kind === "status") {
				ctx.ui.notify(`Task summaries are ${taskSummaryEnabled ? "ON" : "OFF"}.`, "info");
				return;
			}

			try {
				await saveTaskSummaryPreference(command.enabled);
				taskSummaryEnabled = command.enabled;
				ctx.ui.notify(
					command.enabled
						? "Task summaries turned ON."
						: "Task summaries turned OFF. Existing persisted summaries are unchanged.",
					command.enabled ? "success" : "info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Could not save the task-summary preference: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("pi-theme", {
		description: "Choose or set a pi theme",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const name = args.trim();
			if (name) return void switchTheme(ctx, name);
			const picked = await chooseTheme(ctx);
			if (picked) switchTheme(ctx, picked);
		},
	});

	pi.registerCommand("pi-theme-next", {
		description: "Cycle to the next curated pi theme",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const current = ctx.ui.theme.name;
			const names = CURATED_THEMES.filter((name) => ctx.ui.getTheme(name));
			if (names.length === 0) return;
			const index = current ? names.indexOf(current as (typeof CURATED_THEMES)[number]) : -1;
			switchTheme(ctx, names[(index + 1 + names.length) % names.length]!);
		},
	});

	pi.registerCommand("pi-theme-prev", {
		description: "Cycle to the previous curated pi theme",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const current = ctx.ui.theme.name;
			const names = CURATED_THEMES.filter((name) => ctx.ui.getTheme(name));
			if (names.length === 0) return;
			const index = current ? names.indexOf(current as (typeof CURATED_THEMES)[number]) : 0;
			switchTheme(ctx, names[(index - 1 + names.length) % names.length]!);
		},
	});

	pi.registerCommand("pi-theme-back", {
		description: "Switch back to the previous theme",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!previousThemeName) return void ctx.ui.notify("No previous theme recorded yet", "warning");
			switchTheme(ctx, previousThemeName);
		},
	});

	const switchMascot = (ctx: ExtensionContext, nextMascotName: string) => {
		const value = getMascotValue(nextMascotName);
		if (!value) return void ctx.ui.notify(`Unknown mascot: ${nextMascotName}`, "error");
		if (mascotName !== nextMascotName) previousMascotName = mascotName;
		mascotName = nextMascotName;
		installChrome(ctx);
		ctx.ui.notify(`Mascot: ${nextMascotName} ${value}`, "success");
	};

	pi.registerCommand("pi-mascot", {
		description: "Choose or set the input mascot",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const name = args.trim();
			if (name === "random") return void switchMascot(ctx, randomMascotName());
			if (name) return void switchMascot(ctx, name);
			const picked = await chooseMascot(ctx, mascotName);
			if (picked) switchMascot(ctx, picked);
		},
	});

	pi.registerCommand("pi-mascot-next", {
		description: "Cycle to the next mascot",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const names = CURATED_MASCOTS.map((m) => m.name);
			const index = names.indexOf(mascotName as (typeof names)[number]);
			switchMascot(ctx, names[(index + 1 + names.length) % names.length]!);
		},
	});

	pi.registerCommand("pi-mascot-prev", {
		description: "Cycle to the previous mascot",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const names = CURATED_MASCOTS.map((m) => m.name);
			const index = names.indexOf(mascotName as (typeof names)[number]);
			switchMascot(ctx, names[(index - 1 + names.length) % names.length]!);
		},
	});

	pi.registerCommand("pi-mascot-back", {
		description: "Switch back to the previous mascot",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!previousMascotName) return void ctx.ui.notify("No previous mascot recorded yet", "warning");
			switchMascot(ctx, previousMascotName);
		},
	});

	pi.registerCommand("pi-header-default", {
		description: "Restore pi's built-in header",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			customHeaderEnabled = false;
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});

	pi.registerCommand("pi-header-theme", {
		description: "Restore the custom themed header",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			customHeaderEnabled = true;
			installHeader(ctx, { enabled: true, modelName });
			ctx.ui.notify("Custom themed header restored", "success");
		},
	});
}
