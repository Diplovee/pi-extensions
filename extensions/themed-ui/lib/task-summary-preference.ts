import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const THEMED_UI_CONFIG_PATH = join(homedir(), ".pi", "agent", "themed-ui.json");
export const DEFAULT_TASK_SUMMARY_ENABLED = true;

export type ThemedUiConfig = Record<string, unknown> & {
	taskSummary?: boolean;
};

export type TaskSummaryCommand =
	| { kind: "status" }
	| { kind: "set"; enabled: boolean }
	| { kind: "invalid" };

export function parseThemedUiConfig(raw: string): ThemedUiConfig {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as ThemedUiConfig;
		}
	} catch {
		// Missing and malformed config both safely fall back to defaults.
	}
	return {};
}

export function taskSummaryEnabledFromConfig(config: ThemedUiConfig): boolean {
	return typeof config.taskSummary === "boolean"
		? config.taskSummary
		: DEFAULT_TASK_SUMMARY_ENABLED;
}

export function parseTaskSummaryCommand(args: string, currentlyEnabled: boolean): TaskSummaryCommand {
	switch (args.trim().toLowerCase()) {
		case "":
		case "toggle":
			return { kind: "set", enabled: !currentlyEnabled };
		case "on":
			return { kind: "set", enabled: true };
		case "off":
			return { kind: "set", enabled: false };
		case "status":
			return { kind: "status" };
		default:
			return { kind: "invalid" };
	}
}

export async function loadTaskSummaryPreference(configPath = THEMED_UI_CONFIG_PATH): Promise<boolean> {
	try {
		return taskSummaryEnabledFromConfig(parseThemedUiConfig(await readFile(configPath, "utf8")));
	} catch {
		return DEFAULT_TASK_SUMMARY_ENABLED;
	}
}

export async function saveTaskSummaryPreference(
	enabled: boolean,
	configPath = THEMED_UI_CONFIG_PATH,
): Promise<void> {
	let config: ThemedUiConfig = {};
	try {
		config = parseThemedUiConfig(await readFile(configPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const directory = dirname(configPath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = join(directory, `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`);
	const contents = `${JSON.stringify({ ...config, taskSummary: enabled }, null, 2)}\n`;

	try {
		await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporaryPath, configPath);
	} finally {
		await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
