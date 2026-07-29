import { describe, expect, test } from "bun:test";
import { aggregateChildResultUsage } from "./usage";

describe("aggregateChildResultUsage", () => {
	test("aggregates parallel child tokens and preserves exact scalar costs", () => {
		const usage = aggregateChildResultUsage([
			{
				usage: {
					input: 101,
					output: 17,
					cacheRead: 53,
					cacheWrite: 7,
					cost: 0.123456789,
				},
			},
			{
				usage: {
					input: 211,
					output: 29,
					cacheRead: 61,
					cacheWrite: 11,
					cost: 0.987654321,
				},
			},
		]);

		expect(usage).toEqual({
			input: 312,
			output: 46,
			cacheRead: 114,
			cacheWrite: 18,
			totalTokens: 490,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 1.11111111,
			},
		});
	});

	test("accepts standard Usage costs and ignores malformed values", () => {
		const usage = aggregateChildResultUsage([
			{
				usage: {
					input: 10,
					output: 3,
					cacheRead: 4,
					cacheWrite: 2,
					cacheWrite1h: 1,
					reasoning: 2,
					cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
				},
			},
			{ usage: { input: -1, output: Number.NaN, cost: Number.POSITIVE_INFINITY } },
			{},
		]);

		expect(usage).toEqual({
			input: 10,
			output: 3,
			cacheRead: 4,
			cacheWrite: 2,
			cacheWrite1h: 1,
			reasoning: 2,
			totalTokens: 19,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
		});
	});
});
