import { describe, expect, test } from "bun:test";
import {
	accumulateAllEntryUsage,
	accumulateTaskUsage,
	entriesAddedSince,
	formatCompactCost,
	formatTaskSummaryCompact,
	formatTaskUsageBreakdown,
	formatTokenCount,
	type TaskSummaryData,
} from "./task-summary";

const usage = (
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	total: number,
	reasoning = 0,
) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	reasoning,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: {
		input: total / 4,
		output: total / 4,
		cacheRead: total / 4,
		cacheWrite: total / 4,
		total,
	},
});

const childUsage = (
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cost: number,
) => ({ input, output, cacheRead, cacheWrite, cost, contextTokens: 0, turns: 1 });

describe("task and footer session usage", () => {
	test("sums assistant, nested tool, compaction, and branch-summary usage once", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai-codex",
					model: "gpt-lead",
					usage: usage(100, 20, 40, 5, 0.1, 12),
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "other-nested-tool",
					usage: usage(10, 4, 3, 2, 0.02, 1),
					details: { usage: usage(999, 999, 999, 999, 99) },
				},
			},
			{
				type: "compaction",
				usage: usage(30, 8, 6, 1, 0.03, 2),
				retainedTail: [{ role: "assistant", usage: usage(999, 999, 999, 999, 99) }],
			},
			{ type: "branch_summary", usage: usage(20, 5, 4, 0, 0.01) },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: {
						results: [{ model: "legacy/details-only", usage: childUsage(9, 3, 2, 1, 0.07) }],
					},
				},
			},
			{ type: "custom", customType: "task-summary", data: { usage: usage(999, 999, 999, 999, 99) } },
			{ type: "custom_message", details: { usage: usage(999, 999, 999, 999, 99) } },
		];

		// The themed footer uses the same resolver as task summaries, including
		// historical details-only subagent records.
		const footerTotal = accumulateAllEntryUsage(entries);
		expect(footerTotal.cost.total).toBeCloseTo(0.23);
		expect(footerTotal.input).toBe(169);

		const total = accumulateTaskUsage(entries);
		expect({ ...total, cost: undefined, breakdown: undefined }).toEqual({
			input: 169,
			output: 40,
			cacheRead: 55,
			cacheWrite: 9,
			reasoning: 15,
			totalTokens: 273,
			cost: undefined,
			usageRecords: 5,
			breakdown: undefined,
		});
		expect(total.cost.total).toBeCloseTo(0.23);
		expect(total.breakdown.map((item) => item.label)).toEqual([
			"openai-codex/gpt-lead",
			"legacy/details-only",
			"Nested tools",
			"Compaction/branch summaries",
		]);
		expect(total.breakdown.reduce((sum, item) => sum + item.cost.total, 0)).toBeCloseTo(total.cost.total);
	});

	test("resolves details-only legacy single and parallel child usage", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "gau_subagent",
					details: {
						mode: "single",
						results: [{ model: "legacy-model", usage: childUsage(11, 2, 3, 1, 0.123456) }],
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: {
						mode: "parallel",
						results: [
							{ model: "openai-codex/gpt-worker", usage: usage(20, 4, 5, 2, 0.2, 3) },
							{ model: "deepseek-v4", usage: usage(7, 1, 2, 0, 0.05, 1) },
						],
					},
				},
			},
		];

		const footerTotal = accumulateAllEntryUsage(entries);
		const total = accumulateTaskUsage(entries);
		expect(footerTotal.input).toBe(38);
		expect(footerTotal.output).toBe(7);
		expect(footerTotal.cacheRead).toBe(10);
		expect(footerTotal.cacheWrite).toBe(3);
		expect(footerTotal.reasoning).toBe(4);
		expect(footerTotal.totalTokens).toBe(58);
		expect(footerTotal.cost.total).toBe(0.373456);
		expect(total).toMatchObject(footerTotal);

		const byLabel = new Map(total.breakdown.map((item) => [item.label, item]));
		expect(byLabel.get("unknown-provider/legacy-model")?.cost.total).toBe(0.123456);
		expect(byLabel.get("unknown-provider/legacy-model")?.cost.input).toBe(0);
		expect(byLabel.get("openai-codex/gpt-worker")?.cost.total).toBe(0.2);
		expect(byLabel.get("unknown-provider/deepseek-v4")?.cost.total).toBe(0.05);
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const) {
			expect(total.breakdown.reduce((sum, item) => sum + item[field], 0)).toBe(total[field]);
		}
		expect(total.breakdown.reduce((sum, item) => sum + item.cost.total, 0)).toBe(total.cost.total);
		expect(total.breakdown.reduce((sum, item) => sum + item.cost.input, 0)).toBe(total.cost.input);
	});

	test("attributes parallel subagents to every model without double counting tool usage", () => {
		const nestedUsage = usage(60, 15, 25, 5, 0.444444444);
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai-codex",
					model: "gpt-lead",
					usage: usage(100, 20, 10, 0, 0.2),
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					usage: nestedUsage,
					details: {
						mode: "parallel",
						results: [
							{ model: "opencode/deepseek-free", usage: childUsage(20, 5, 10, 0, 0.111111111) },
							{ model: "openai-codex/gpt-worker", usage: childUsage(30, 7, 10, 3, 0.222222222) },
							{ model: "opencode/deepseek-free", usage: childUsage(10, 3, 5, 2, 0.111111111) },
						],
					},
				},
			},
		];

		const total = accumulateTaskUsage(entries);
		expect(total.input).toBe(160);
		expect(total.output).toBe(35);
		expect(total.cacheRead).toBe(35);
		expect(total.cacheWrite).toBe(5);
		expect(total.totalTokens).toBe(235);
		expect(total.cost.total).toBeCloseTo(0.644444444, 12);

		const byLabel = new Map(total.breakdown.map((item) => [item.label, item]));
		expect(byLabel.get("openai-codex/gpt-lead")?.cost.total).toBeCloseTo(0.2);
		expect(byLabel.get("opencode/deepseek-free")?.input).toBe(30);
		expect(byLabel.get("opencode/deepseek-free")?.cost.total).toBeCloseTo(0.222222222, 12);
		expect(byLabel.get("openai-codex/gpt-worker")?.input).toBe(30);
		expect(byLabel.get("openai-codex/gpt-worker")?.cost.total).toBeCloseTo(0.222222222, 12);

		// Details attribute the already-counted standard tool usage; they never
		// increase the overall total a second time.
		expect(total.breakdown.reduce((sum, item) => sum + item.input, 0)).toBeCloseTo(total.input);
		expect(total.breakdown.reduce((sum, item) => sum + item.cost.total, 0)).toBeCloseTo(total.cost.total, 12);
		expect(total.breakdown.reduce((sum, item) => sum + item.usageRecords, 0)).toBe(total.usageRecords);
	});

	test("does not count details when a top-level usage record exists", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					usage: usage(4, 2, 1, 0, 0.04),
					details: {
						results: [
							{ model: "provider/child-a", usage: usage(400, 200, 100, 50, 40) },
							{ model: "provider/child-b", usage: childUsage(300, 100, 50, 25, 30) },
						],
					},
				},
			},
		];

		const footerTotal = accumulateAllEntryUsage(entries);
		const total = accumulateTaskUsage(entries);
		expect(footerTotal.input).toBe(4);
		expect(footerTotal.output).toBe(2);
		expect(footerTotal.cost.total).toBe(0.04);
		expect(total.input).toBe(4);
		expect(total.output).toBe(2);
		expect(total.cost.total).toBe(0.04);
		expect(total.breakdown.reduce((sum, item) => sum + item.input, 0)).toBe(total.input);
		expect(total.breakdown.reduce((sum, item) => sum + item.cost.total, 0)).toBe(total.cost.total);
	});

	test("ignores details-only results from unrelated tools", () => {
		const total = accumulateAllEntryUsage([
			{
				type: "message",
				message: { role: "toolResult", toolName: "other", details: { results: [{ usage: usage(10, 2, 0, 0, 1) }] } },
			},
		]);
		expect(total.input).toBe(0);
		expect(total.cost.total).toBe(0);
		expect(total.usageRecords).toBe(0);
	});

	test("falls back for missing totals and ignores malformed numeric fields", () => {
		const total = accumulateTaskUsage([
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "test",
					model: "model",
					usage: {
						input: 5,
						output: 2,
						cacheRead: Number.NaN,
						cacheWrite: -1,
						reasoningTokens: 1,
						totalTokens: 0,
						cost: { input: 0.01, output: 0.02, total: 0 },
					},
				},
			},
		]);

		expect(total.totalTokens).toBe(7);
		expect(total.cost.total).toBe(0.03);
		expect(total.cacheRead).toBe(0);
		expect(total.cacheWrite).toBe(0);
		expect(total.reasoning).toBe(1);
	});

	test("selects raw entries appended after the task boundary", () => {
		const entries = [{ id: "old", value: 1 }, { id: "new-1", value: 2 }, { id: "new-2", value: 3 }];
		expect(entriesAddedSince(entries, new Set(["old"]))).toEqual(entries.slice(1));
	});
});

describe("task summary formatting", () => {
	test("formats compact token and cost values", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1_234)).toBe("1.23k");
		expect(formatTokenCount(12_345)).toBe("12.3k");
		expect(formatTokenCount(1_250_000)).toBe("1.25M");
		expect(formatCompactCost(0)).toBe("$0");
		expect(formatCompactCost(0.123456)).toBe("$0.1235");
	});

	test("formats the default one-line summary", () => {
		const data: TaskSummaryData = {
			version: 1,
			elapsedMs: 65_000,
			usage: {
				input: 12_345,
				output: 1_234,
				cacheRead: 45_678,
				cacheWrite: 200,
				reasoning: 800,
				totalTokens: 59_457,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123456 },
				usageRecords: 3,
				breakdown: [],
			},
		};

		expect(formatTaskSummaryCompact(data)).toBe(
			"◷ 1:05  ↑12.3k  ↓1.23k  cache 45.7k/200  Σ59.5k  $0.1235",
		);
	});

	test("formats per-model usage and cost", () => {
		const total = accumulateTaskUsage([
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "provider",
					model: "model",
					usage: usage(1_200, 300, 400, 0, 0.125),
				},
			},
		]);
		expect(formatTaskUsageBreakdown(total.breakdown[0])).toBe(
			"provider/model: ↑1.2k ↓300 cache 400/0 Σ1.9k $0.125000",
		);
	});
});
