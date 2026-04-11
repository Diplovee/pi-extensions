/**
 * Working UI Extension
 *
 * Customizes the built-in loading text shown while the agent is running.
 *
 * Commands:
 * - /working show
 * - /working set <text>
 * - /working reset
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const CONFIG_DIR = ".pi";
const CONFIG_PATH = "extensions/working-ui.json";
const DEFAULT_MESSAGE = "Working...";
type WorkingMode = "funny" | "clean" | "serious" | "chaos";
const FUNNY_MESSAGES = [
	"Negotiating with the semicolons",
	"Convincing the bugs to leave quietly",
	"Moving bits into better neighborhoods",
	"Politely refactoring the chaos",
	"Summoning a suspicious amount of clarity",
	"Teaching the code some manners",
	"Bribing the compiler with valid syntax",
	"Untangling one bad idea at a time",
	"Doing crimes against boilerplate",
	"Staring aggressively at the root cause",
	"Making the stack trace less dramatic",
	"Rearranging the spaghetti into lasagna",
	"Trying not to wake the legacy code",
	"Applying tactical duct tape",
	"Translating vibes into implementation",
	"Turning TODOs into consequences",
	"Lowering the entropy slightly",
	"Compressing confusion into structure",
	"Pretending this was the plan all along",
	"Searching for the least cursed fix",
	"Coaxing the tests into cooperation",
	"Renaming variables for emotional support",
	"Walking carefully around the side effects",
	"Refactoring with suspicious confidence",
	"Turning edge cases into regular cases",
	"Persuading the app to behave normally",
	"Untying knots in the control flow",
	"Upgrading the mess to a system",
	"Checking whether the bug was lying",
	"Replacing panic with structure",
	"Reducing the number of mysteries",
	"Pulling meaning out of log noise",
	"Trying the boring fix first",
	"Making the weird part less weird",
	"Shuffling complexity into smaller boxes",
	"Calming down an overexcited codepath",
	"Repairing the timeline one bug at a time",
	"Finding out who invited this regression",
	"Taking the scenic route to correctness",
	"Turning a hotfix into an actual fix",
	"Interrogating the assumptions",
	"Making the failure mode more educational",
	"Teaching the app to stop freelancing",
	"Debugging with determined skepticism",
	"Reducing accidental creativity",
	"Trying to keep the abstraction honest",
	"Opening the box marked 'should work'",
	"Searching for the sharp edges",
	"Converting friction into momentum",
	"Stabilizing the vibes",
];
const CLEAN_MESSAGES = [
	"Working",
	"Processing",
	"Applying changes",
	"Reading project state",
	"Updating context",
	"Preparing result",
	"Checking files",
	"Running task",
];
const SERIOUS_MESSAGES = [
	"Analyzing current state",
	"Evaluating implementation path",
	"Applying requested changes",
	"Reviewing dependencies",
	"Updating tracked state",
	"Validating assumptions",
	"Preparing execution result",
	"Inspecting relevant context",
];
const CHAOS_MESSAGES = [
	"Shaking the error tree",
	"Interpreting hostile telemetry",
	"Arguing with invisible state",
	"Opening another forbidden box",
	"Speedrunning consequences",
	"Inviting order into the disaster",
	"Escorting entropy off the premises",
	"Fixing the fix for the fix",
	"Juggling root causes",
	"Pulling a cleaner timeline out of the rubble",
];
const FRAME_SETS = [
	[".", "..", "...", "...."],
	["[   ]", "[=  ]", "[== ]", "[===]"],
	["<   ", "<<  ", "<<< ", "<<<<"],
	["·  ", "·· ", "···", " ··"],
	["(    )", "(=   )", "(==  )", "(=== )", "(====)"],
	["|", "/", "-", "\\"],
	["[>   ]", "[>>  ]", "[ >>>]", "[  >>]", "[   >]"],
	[".  ", ".. ", "...", " .."],
	["{    }", "{ .  }", "{ .. }", "{ ...}", "{..  }"],
	["<-   ", "<--  ", "<--- ", "<----"],
	["[●   ]", "[●●  ]", "[●●● ]", "[ ●●●]"],
	["^    ", "^^   ", "^^^  ", " ^^^ "],
];

interface WorkingConfig {
	message?: string;
	mode?: WorkingMode;
}

type WorkingSelection =
	| { kind: "mode"; mode: WorkingMode }
	| { kind: "reset" }
	| { kind: "custom" }
	| null;

function getConfigPath(cwd: string): string {
	const dir = join(cwd, CONFIG_DIR, "extensions");
	mkdirSync(dir, { recursive: true });
	return join(dir, "working-ui.json");
}

function loadConfig(cwd: string): WorkingConfig {
	const path = getConfigPath(cwd);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as WorkingConfig;
	} catch {
		return {};
	}
}

function saveConfig(cwd: string, config: WorkingConfig): void {
	writeFileSync(getConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export default function workingUI(pi: ExtensionAPI) {
	let message = DEFAULT_MESSAGE;
	let mode: WorkingMode = "funny";
	let activeMessage = DEFAULT_MESSAGE;
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let frames = FRAME_SETS[0];

	const getPool = (): string[] => {
		switch (mode) {
			case "clean":
				return CLEAN_MESSAGES;
			case "serious":
				return SERIOUS_MESSAGES;
			case "chaos":
				return CHAOS_MESSAGES;
			case "funny":
			default:
				return FUNNY_MESSAGES;
		}
	};

	const previewMessage = (previewMode: WorkingMode, previewMessageOverride?: string): string => {
		if (previewMessageOverride && previewMessageOverride !== DEFAULT_MESSAGE) {
			return previewMessageOverride;
		}
		const pool =
			previewMode === "clean"
				? CLEAN_MESSAGES
				: previewMode === "serious"
					? SERIOUS_MESSAGES
					: previewMode === "chaos"
						? CHAOS_MESSAGES
						: FUNNY_MESSAGES;
		return pool[0] || DEFAULT_MESSAGE;
	};

	const showWorkingDialog = async (ctx: ExtensionContext): Promise<WorkingSelection> => {
		const items = [
			{ id: "funny", label: "Funny mode", hint: "1", kind: "mode" as const },
			{ id: "clean", label: "Clean mode", hint: "2", kind: "mode" as const },
			{ id: "serious", label: "Serious mode", hint: "3", kind: "mode" as const },
			{ id: "chaos", label: "Chaos mode", hint: "4", kind: "mode" as const },
			{ id: "custom", label: "Custom label...", hint: "C", kind: "custom" as const },
			{ id: "reset", label: "Reset to random", hint: "R", kind: "reset" as const },
		];

		return await ctx.ui.custom<WorkingSelection>((tui, theme, _kb, done) => {
			let index = 0;
			let cached: string[] | undefined;

			const refresh = () => {
				cached = undefined;
				tui.requestRender();
			};

			const current = () => items[index];

			const resolvePreview = () => {
				const item = current();
				if (item.kind === "mode") {
					return {
						title: item.label,
						message: previewMessage(item.id as WorkingMode, message),
						frame: FRAME_SETS[(index + 1) % FRAME_SETS.length][1] || "...",
					};
				}
				if (item.kind === "custom") {
					return {
						title: "Custom label",
						message: message === DEFAULT_MESSAGE ? "Your own loading text" : message,
						frame: FRAME_SETS[0][2] || "...",
					};
				}
				return {
					title: "Random funny mode",
					message: previewMessage("funny"),
					frame: FRAME_SETS[3][2] || "...",
				};
			};

			const finishSelection = () => {
				const item = current();
				if (item.kind === "mode") {
					done({ kind: "mode", mode: item.id as WorkingMode });
					return;
				}
				if (item.kind === "custom") {
					done({ kind: "custom" });
					return;
				}
				done({ kind: "reset" });
			};

			return {
				handleInput(data: string) {
					if (matchesKey(data, Key.up)) {
						index = (index - 1 + items.length) % items.length;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						index = (index + 1) % items.length;
						refresh();
						return;
					}
					if (data === "1") {
						index = 0;
						finishSelection();
						return;
					}
					if (data === "2") {
						index = 1;
						finishSelection();
						return;
					}
					if (data === "3") {
						index = 2;
						finishSelection();
						return;
					}
					if (data === "4") {
						index = 3;
						finishSelection();
						return;
					}
					if (data.toLowerCase() === "c") {
						index = 4;
						finishSelection();
						return;
					}
					if (data.toLowerCase() === "r") {
						index = 5;
						finishSelection();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						finishSelection();
						return;
					}
					if (matchesKey(data, Key.escape)) {
						done(null);
					}
				},
				invalidate() {
					cached = undefined;
				},
				render(width: number): string[] {
					if (cached) return cached;

					const lines: string[] = [];
					const inner = Math.max(40, width - 4);
					const leftWidth = Math.max(18, Math.floor(inner * 0.42));
					const rightWidth = Math.max(18, inner - leftWidth - 3);
					const preview = resolvePreview();

					const top = `┌${"─".repeat(inner)}┐`;
					const mid = `├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`;
					const bot = `└${"─".repeat(inner)}┘`;
					lines.push(theme.fg("accent", top));
					lines.push(
						theme.fg("accent", "│ ") +
							truncateToWidth(theme.bold("Working UI"), inner - 2, "") +
							" ".repeat(Math.max(0, inner - 2 - visibleWidth(theme.bold("Working UI")))) +
							theme.fg("accent", " │"),
					);
					lines.push(theme.fg("accent", mid));

					const rowCount = Math.max(items.length + 2, 8);
					for (let row = 0; row < rowCount; row++) {
						let left = "";
						let right = "";
						if (row < items.length) {
							const item = items[row];
							const selected = row === index;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							left = `${prefix}${item.hint} ${item.label}`;
						} else if (row === items.length) {
							left = theme.fg("dim", "Enter apply");
						} else if (row === items.length + 1) {
							left = theme.fg("dim", "Esc cancel");
						}

						if (row === 0) right = theme.fg("accent", preview.title);
						if (row === 2) right = `${preview.message}`;
						if (row === 4) right = `${preview.message} ${preview.frame}`;
						if (row === 6) right = theme.fg("dim", "1-4 modes, C custom, R reset");

						const leftCell = truncateToWidth(left, leftWidth, "");
						const rightCell = truncateToWidth(right, rightWidth, "");
						const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftCell)));
						const rightPad = " ".repeat(Math.max(0, rightWidth - visibleWidth(rightCell)));
						lines.push(
							theme.fg("accent", "│") +
								leftCell +
								leftPad +
								theme.fg("accent", "│") +
								rightCell +
								rightPad +
								theme.fg("accent", "│"),
						);
					}

					lines.push(theme.fg("accent", bot));
					cached = lines;
					return lines;
				},
			};
		}, { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: 16 } });
	};

	const apply = (ctx: ExtensionContext, text?: string) => {
		const next = text ?? activeMessage;
		ctx.ui.setWorkingMessage(next === DEFAULT_MESSAGE ? undefined : next);
	};

	const stop = (ctx: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		activeMessage = message;
		apply(ctx);
	};

	const start = (ctx: ExtensionContext) => {
		stop(ctx);
		const pool = getPool();
		activeMessage = message === DEFAULT_MESSAGE ? pool[Math.floor(Math.random() * pool.length)] : message;
		frames = FRAME_SETS[Math.floor(Math.random() * FRAME_SETS.length)];
		timer = setInterval(() => {
			const suffix = frames[frameIndex % frames.length];
			apply(ctx, `${activeMessage} ${suffix}`);
			frameIndex++;
		}, 140);
	};

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		message = config.message?.trim() || DEFAULT_MESSAGE;
		mode = config.mode || "funny";
		activeMessage = message;
		apply(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stop(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});

	pi.registerCommand("working", {
		description: "Customize the loading text. Usage: /working [show|set <text>|mode <funny|clean|serious|chaos>|reset]",
		getArgumentCompletions: (prefix) => {
			const options = ["show", "set", "mode", "reset"].filter((value) => value.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				const selected = await showWorkingDialog(ctx);
				if (!selected) return;
				if (selected.kind === "mode") {
					mode = selected.mode;
					saveConfig(ctx.cwd, { message: message === DEFAULT_MESSAGE ? undefined : message, mode });
					ctx.ui.notify(`Working mode set to: ${mode}`, "info");
					return;
				}
				if (selected.kind === "reset") {
					message = DEFAULT_MESSAGE;
					mode = "funny";
					saveConfig(ctx.cwd, { mode });
					activeMessage = message;
					apply(ctx);
					ctx.ui.notify(`Working label reset to: ${DEFAULT_MESSAGE}\nMode: ${mode}`, "info");
					return;
				}
				if (selected.kind === "custom") {
					const next = await ctx.ui.input("Working label", "Enter a custom loading label");
					const value = next?.trim();
					if (!value) return;
					message = value;
					saveConfig(ctx.cwd, { message, mode });
					activeMessage = message;
					apply(ctx);
					ctx.ui.notify(`Working label set to: ${message}`, "info");
					return;
				}
				return;
			}

			if (trimmed === "show") {
				ctx.ui.notify(`Working label: ${message}\nMode: ${mode}`, "info");
				return;
			}

			if (trimmed === "reset") {
				message = DEFAULT_MESSAGE;
				mode = "funny";
				saveConfig(ctx.cwd, { mode });
				activeMessage = message;
				apply(ctx);
				ctx.ui.notify(`Working label reset to: ${DEFAULT_MESSAGE}\nMode: ${mode}`, "info");
				return;
			}

			if (trimmed.startsWith("mode ")) {
				const nextMode = trimmed.slice(5).trim() as WorkingMode;
				if (!["funny", "clean", "serious", "chaos"].includes(nextMode)) {
					ctx.ui.notify("Usage: /working mode <funny|clean|serious|chaos>", "warning");
					return;
				}
				mode = nextMode;
				saveConfig(ctx.cwd, { message: message === DEFAULT_MESSAGE ? undefined : message, mode });
				ctx.ui.notify(`Working mode set to: ${mode}`, "info");
				return;
			}

			if (trimmed.startsWith("set ")) {
				const next = trimmed.slice(4).trim();
				if (!next) {
					ctx.ui.notify("Usage: /working set <text>", "warning");
					return;
				}
				message = next;
				saveConfig(ctx.cwd, { message, mode });
				activeMessage = message;
				apply(ctx);
				ctx.ui.notify(`Working label set to: ${message}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /working [show|set <text>|mode <funny|clean|serious|chaos>|reset]", "warning");
		},
	});
}
