import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type PresetConfigValue = string | { prompt: string; description?: string };
type PresetMap = Record<string, { prompt: string; description?: string }>;

type ActiveCosplay = {
	active: true;
	name: string;
	prompt: string;
	source: "preset" | "custom";
};

type InactiveCosplay = { active: false };
type CosplayState = ActiveCosplay | InactiveCosplay;

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getConfigPaths(cwd: string) {
	return {
		globalPath: join(getAgentDir(), "cosplay.json"),
		projectPath: join(cwd, ".pi", "cosplay.json"),
	};
}

function getSessionScope(): string {
	const raw = process.env.PI_SESSION_ID || process.env.PI_SESSION_SCOPE || `pid-${process.pid}`;
	return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || `pid-${process.pid}`;
}

function getStatePaths(cwd: string) {
	const piDir = join(cwd, ".pi");
	return {
		projectPath: join(piDir, "cosplay-state.json"),
		sessionPath: join(piDir, "sessions", getSessionScope(), "cosplay-state.json"),
	};
}

function normalizePresets(value: unknown): PresetMap {
	if (!value || typeof value !== "object") return {};

	const source = "presets" in (value as Record<string, unknown>) ? (value as { presets?: unknown }).presets : value;
	if (!source || typeof source !== "object") return {};

	const result: PresetMap = {};
	for (const [name, preset] of Object.entries(source as Record<string, PresetConfigValue>)) {
		if (typeof preset === "string" && preset.trim()) {
			result[name] = { prompt: preset.trim() };
			continue;
		}

		if (
			preset &&
			typeof preset === "object" &&
			"prompt" in preset &&
			typeof preset.prompt === "string" &&
			preset.prompt.trim()
		) {
			result[name] = {
				prompt: preset.prompt.trim(),
				description: typeof preset.description === "string" ? preset.description : undefined,
			};
		}
	}

	return result;
}

function loadJsonFile(path: string): unknown {
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8"));
}

function loadPresets(cwd: string): PresetMap {
	const { globalPath, projectPath } = getConfigPaths(cwd);

	let globalPresets: PresetMap = {};
	let projectPresets: PresetMap = {};

	try {
		globalPresets = normalizePresets(loadJsonFile(globalPath));
	} catch (error) {
		console.error(`Failed to parse cosplay config: ${globalPath}`, error);
	}

	try {
		projectPresets = normalizePresets(loadJsonFile(projectPath));
	} catch (error) {
		console.error(`Failed to parse cosplay config: ${projectPath}`, error);
	}

	return { ...globalPresets, ...projectPresets };
}

function derivePersonaName(prompt: string): string {
	const normalized = prompt.replace(/^['"`]|['"`]$/g, "").trim();
	const patterns = [
		/^you(?:'re| are)\s+([^,.!\n]+)/i,
		/^act as\s+([^,.!\n]+)/i,
		/^be\s+([^,.!\n]+)/i,
	];

	const cleanup = (value: string): string => {
		let result = value.trim();
		result = result.replace(/^(an?|the)\s+/i, "");
		result = result.replace(/\s+(an?|the)\s+.+$/i, "");
		result = result.replace(/\s+(engineer|developer|reviewer|designer|assistant|coder|programmer|architect|friend|pirate|mentor|consultant).*$/i, "");
		const words = result.split(/\s+/).filter(Boolean);
		if (words.length === 0) return "custom";
		if (words.length === 1) return words[0];
		const namedLead = words[0];
		if (/^[A-Z][a-zA-Z0-9_-]*$/.test(namedLead)) return namedLead;
		return words.slice(0, 2).join(" ");
	};

	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		if (match?.[1]) {
			return cleanup(match[1]);
		}
	}

	return cleanup(normalized);
}

function statusLabel(state: CosplayState): string | undefined {
	if (!state.active) return undefined;
	const label = state.name;
	return label.length > 18 ? `${label.slice(0, 15)}...` : label;
}

function updateStatus(ctx: ExtensionContext, state: CosplayState) {
	const label = statusLabel(state);
	ctx.ui.setStatus("cosplay", label ? ctx.ui.theme.fg("accent", `cos:${label}`) : undefined);
	ctx.ui.setWidget(
		"cosplay-dashboard",
		label
			? [
				`${ctx.ui.theme.fg("accent", "COSPLAY")} ${ctx.ui.theme.fg("muted", "active:")} ${ctx.ui.theme.bold(ctx.ui.theme.fg("accent", label))}`,
			]
			: undefined,
	);
}

function describeState(state: CosplayState): string {
	if (!state.active) return "Cosplay mode is off.";
	const sourcePart = state.source === "preset" ? "Preset" : "Custom";
	return `${sourcePart}: ${state.name}. Prompt: ${state.prompt}`;
}

function buildCosplayInstructions(personaPrompt: string): string {
	return `
IMPORTANT: COSPLAY MODE IS ACTIVE.

You must fully stay in character according to this persona:
${personaPrompt}

Rules:
- Remain in character in all assistant replies.
- Keep replies concise and context-efficient by default.
- Do not add unnecessary roleplay fluff, monologues, or filler.
- Still complete the user's real task correctly and use tools normally.
- If the task needs more detail, provide it while staying in character.
- Prefer short, direct wording unless the user asks for depth.
`;
}

export default function cosplayExtension(pi: ExtensionAPI) {
	let presets: PresetMap = {};
	let state: CosplayState = { active: false };

	function persistState(nextState: CosplayState, cwd?: string) {
		state = nextState;
		pi.appendEntry("cosplay-state", nextState);
		if (!cwd) return;

		const { projectPath, sessionPath } = getStatePaths(cwd);
		mkdirSync(dirname(projectPath), { recursive: true });
		mkdirSync(dirname(sessionPath), { recursive: true });
		const payload = `${JSON.stringify(nextState, null, 2)}\n`;
		writeFileSync(projectPath, payload, "utf8");
		writeFileSync(sessionPath, payload, "utf8");
	}

	function refreshPresets(cwd: string) {
		presets = loadPresets(cwd);
	}

	function activatePreset(name: string, ctx: ExtensionContext) {
		const preset = presets[name];
		if (!preset) {
			ctx.ui.notify(`Unknown cosplay preset: ${name}`, "warning");
			return;
		}

		persistState(
			{
				active: true,
				name,
				prompt: preset.prompt,
				source: "preset",
			},
			ctx.cwd,
		);
		updateStatus(ctx, state);
		ctx.ui.notify(`Cosplay enabled: ${name}`, "info");
	}

	function activateCustom(prompt: string, ctx: ExtensionContext) {
		persistState(
			{
				active: true,
				name: derivePersonaName(prompt),
				prompt,
				source: "custom",
			},
			ctx.cwd,
		);
		updateStatus(ctx, state);
		ctx.ui.notify("Custom cosplay enabled", "info");
	}

	function clearCosplay(ctx: ExtensionContext) {
		persistState({ active: false }, ctx.cwd);
		updateStatus(ctx, state);
		ctx.ui.notify("Cosplay cleared", "info");
	}

	pi.registerCommand("cos", {
		description: "Enable cosplay mode with a preset or persona prompt",
		getArgumentCompletions: (prefix) => {
			const values = ["list", ...Object.keys(presets)].filter((value) => value.startsWith(prefix));
			return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			refreshPresets(ctx.cwd);
			const input = args.trim();

			if (!input) {
				ctx.ui.notify(describeState(state), "info");
				return;
			}

			if (input === "list") {
				const names = Object.keys(presets).sort();
				if (names.length === 0) {
					const { globalPath, projectPath } = getConfigPaths(ctx.cwd);
					ctx.ui.notify(`No presets found. Add ${globalPath} or ${projectPath}`, "warning");
					return;
				}
				ctx.ui.notify(`Cosplay presets: ${names.join(", ")}`, "info");
				return;
			}

			if (input === "off" || input === "none" || input === "clear") {
				clearCosplay(ctx);
				return;
			}

			if (presets[input]) {
				activatePreset(input, ctx);
				return;
			}

			activateCustom(input, ctx);
		},
	});

	pi.registerCommand("uncos", {
		description: "Disable cosplay mode",
		handler: async (_args, ctx) => {
			clearCosplay(ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n${buildCosplayInstructions(state.prompt)}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshPresets(ctx.cwd);

		const lastStateEntry = ctx.sessionManager
			.getEntries()
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "cosplay-state")
			.pop() as { data?: CosplayState } | undefined;

		if (lastStateEntry?.data) {
			state =
				lastStateEntry.data.active && !lastStateEntry.data.name
					? { ...lastStateEntry.data, name: derivePersonaName(lastStateEntry.data.prompt) }
					: lastStateEntry.data;
		}

		persistState(state, ctx.cwd);
		updateStatus(ctx, state);
	});
}
