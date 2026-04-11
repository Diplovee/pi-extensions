/**
 * Terse Mode Extension
 *
 * Shared on/off switch for shorter extension UI text and notifications.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const CONFIG_DIR = ".pi";
const CONFIG_PATH = "extensions/terse-mode.json";

interface TerseConfig {
	enabled: boolean;
}

function getConfigPath(cwd: string): string {
	const dir = join(cwd, CONFIG_DIR, "extensions");
	mkdirSync(dir, { recursive: true });
	return join(dir, "terse-mode.json");
}

function loadConfig(cwd: string): TerseConfig {
	const path = getConfigPath(cwd);
	if (!existsSync(path)) return { enabled: false };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TerseConfig>;
		return { enabled: Boolean(parsed.enabled) };
	} catch {
		return { enabled: false };
	}
}

function saveConfig(cwd: string, config: TerseConfig): void {
	writeFileSync(getConfigPath(cwd), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export default function terseMode(pi: ExtensionAPI) {
	let enabled = false;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("terse-mode", ctx.ui.theme.fg(enabled ? "success" : "dim", enabled ? "terse:on" : "terse:off"));
	};

	pi.on("session_start", async (_event, ctx) => {
		enabled = loadConfig(ctx.cwd).enabled;
		refresh(ctx);
	});

	pi.registerCommand("terse", {
		description: "Toggle terse extension text. Usage: /terse [show|on|off|toggle]",
		getArgumentCompletions: (prefix) => {
			const options = ["show", "on", "off", "toggle"].filter((value) => value.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "show";
			if (action === "show") {
				enabled = loadConfig(ctx.cwd).enabled;
				refresh(ctx);
				ctx.ui.notify(`Terse mode: ${enabled ? "ON" : "OFF"}`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				enabled = action === "on";
				saveConfig(ctx.cwd, { enabled });
				refresh(ctx);
				ctx.ui.notify(`Terse mode ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (action === "toggle") {
				enabled = !loadConfig(ctx.cwd).enabled;
				saveConfig(ctx.cwd, { enabled });
				refresh(ctx);
				ctx.ui.notify(`Terse mode ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /terse [show|on|off|toggle]", "warning");
		},
	});
}
