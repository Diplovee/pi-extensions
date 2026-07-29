import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadTaskSummaryPreference,
	parseTaskSummaryCommand,
	parseThemedUiConfig,
	saveTaskSummaryPreference,
	taskSummaryEnabledFromConfig,
} from "./task-summary-preference";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("task summary preference parsing", () => {
	test("defaults on for missing, malformed, and invalid values", () => {
		expect(taskSummaryEnabledFromConfig(parseThemedUiConfig("{}"))).toBe(true);
		expect(taskSummaryEnabledFromConfig(parseThemedUiConfig("not json"))).toBe(true);
		expect(taskSummaryEnabledFromConfig(parseThemedUiConfig("[]"))).toBe(true);
		expect(taskSummaryEnabledFromConfig(parseThemedUiConfig('{"taskSummary":"off"}'))).toBe(true);
	});

	test("accepts explicit boolean values", () => {
		expect(taskSummaryEnabledFromConfig(parseThemedUiConfig('{"taskSummary":false}'))).toBe(false);
		expect(taskSummaryEnabledFromConfig(parseThemedUiConfig('{"taskSummary":true}'))).toBe(true);
	});

	test("parses command aliases", () => {
		expect(parseTaskSummaryCommand("", true)).toEqual({ kind: "set", enabled: false });
		expect(parseTaskSummaryCommand(" toggle ", false)).toEqual({ kind: "set", enabled: true });
		expect(parseTaskSummaryCommand("ON", false)).toEqual({ kind: "set", enabled: true });
		expect(parseTaskSummaryCommand("off", true)).toEqual({ kind: "set", enabled: false });
		expect(parseTaskSummaryCommand("status", true)).toEqual({ kind: "status" });
		expect(parseTaskSummaryCommand("maybe", true)).toEqual({ kind: "invalid" });
	});
});

describe("task summary preference persistence", () => {
	test("writes atomically and preserves unknown config fields", async () => {
		const directory = await mkdtemp(join(tmpdir(), "themed-ui-test-"));
		temporaryDirectories.push(directory);
		const configPath = join(directory, "nested", "themed-ui.json");

		await saveTaskSummaryPreference(false, configPath);
		expect(await loadTaskSummaryPreference(configPath)).toBe(false);

		const firstConfig = JSON.parse(await readFile(configPath, "utf8"));
		firstConfig.futureSetting = { enabled: "later" };
		await Bun.write(configPath, `${JSON.stringify(firstConfig)}\n`);

		await saveTaskSummaryPreference(true, configPath);
		expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
			taskSummary: true,
			futureSetting: { enabled: "later" },
		});
	});

	test("loads missing and malformed files safely", async () => {
		const directory = await mkdtemp(join(tmpdir(), "themed-ui-test-"));
		temporaryDirectories.push(directory);
		const configPath = join(directory, "themed-ui.json");

		expect(await loadTaskSummaryPreference(configPath)).toBe(true);
		await Bun.write(configPath, "broken json");
		expect(await loadTaskSummaryPreference(configPath)).toBe(true);
	});
});
