import type { Usage } from "@earendil-works/pi-ai";

type UnknownRecord = Record<string, unknown>;

export interface ChildResultWithUsage {
	usage?: unknown;
}

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNonNegative = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Convert all completed child-result usage into Pi's standard Usage shape.
 *
 * Subagent details historically store cost as one exact scalar, so component
 * costs remain zero in that case while cost.total preserves the billed total.
 * Standard nested Usage objects are accepted too, including their cost split.
 */
export function aggregateChildResultUsage(results: readonly ChildResultWithUsage[]): Usage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cacheWrite1h = 0;
	let hasCacheWrite1h = false;
	let reasoning = 0;
	let hasReasoning = false;
	let costInput = 0;
	let costOutput = 0;
	let costCacheRead = 0;
	let costCacheWrite = 0;
	let costTotal = 0;

	for (const result of results) {
		if (!isRecord(result.usage)) continue;
		const child = result.usage;
		input += finiteNonNegative(child.input);
		output += finiteNonNegative(child.output);
		cacheRead += finiteNonNegative(child.cacheRead);
		cacheWrite += finiteNonNegative(child.cacheWrite);

		if (typeof child.cacheWrite1h === "number" && Number.isFinite(child.cacheWrite1h) && child.cacheWrite1h >= 0) {
			hasCacheWrite1h = true;
			cacheWrite1h += child.cacheWrite1h;
		}
		if (typeof child.reasoning === "number" && Number.isFinite(child.reasoning) && child.reasoning >= 0) {
			hasReasoning = true;
			reasoning += child.reasoning;
		}

		if (isRecord(child.cost)) {
			const cost = child.cost;
			const childCostInput = finiteNonNegative(cost.input);
			const childCostOutput = finiteNonNegative(cost.output);
			const childCostCacheRead = finiteNonNegative(cost.cacheRead);
			const childCostCacheWrite = finiteNonNegative(cost.cacheWrite);
			costInput += childCostInput;
			costOutput += childCostOutput;
			costCacheRead += childCostCacheRead;
			costCacheWrite += childCostCacheWrite;
			const reportedTotal = finiteNonNegative(cost.total);
			costTotal +=
				reportedTotal > 0
					? reportedTotal
					: childCostInput + childCostOutput + childCostCacheRead + childCostCacheWrite;
		} else {
			costTotal += finiteNonNegative(child.cost);
		}
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(hasCacheWrite1h ? { cacheWrite1h } : {}),
		...(hasReasoning ? { reasoning } : {}),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			total: costTotal,
		},
	};
}
