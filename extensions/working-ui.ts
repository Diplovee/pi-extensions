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
			if (!trimmed || trimmed === "show") {
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
