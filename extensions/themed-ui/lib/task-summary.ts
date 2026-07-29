import { formatElapsed } from "./elapsed-timer";

export interface TaskUsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface TaskUsageValues {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	cost: TaskUsageCost;
	usageRecords: number;
}

export interface TaskUsageBreakdown extends TaskUsageValues {
	label: string;
	category: "model" | "nested" | "summary";
}

export interface TaskUsage extends TaskUsageValues {
	breakdown: TaskUsageBreakdown[];
}

export interface TaskSummaryData {
	version: 1;
	elapsedMs: number;
	usage: TaskUsage;
}

type UnknownRecord = Record<string, unknown>;
type BreakdownCategory = TaskUsageBreakdown["category"];

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNonNegative = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const optionalFiniteNonNegative = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function createTaskUsageValues(): TaskUsageValues {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		usageRecords: 0,
	};
}

export function createTaskUsage(): TaskUsage {
	return { ...createTaskUsageValues(), breakdown: [] };
}

function normalizedUsage(usage: UnknownRecord): TaskUsageValues {
	const input = finiteNonNegative(usage.input);
	const output = finiteNonNegative(usage.output);
	const cacheRead = finiteNonNegative(usage.cacheRead);
	const cacheWrite = finiteNonNegative(usage.cacheWrite);
	const cost = isRecord(usage.cost) ? usage.cost : undefined;
	const costInput = finiteNonNegative(cost?.input);
	const costOutput = finiteNonNegative(cost?.output);
	const costCacheRead = finiteNonNegative(cost?.cacheRead);
	const costCacheWrite = finiteNonNegative(cost?.cacheWrite);
	const calculatedTokens = input + output + cacheRead + cacheWrite;
	const reportedTokens = optionalFiniteNonNegative(usage.totalTokens);
	const calculatedCost = costInput + costOutput + costCacheRead + costCacheWrite;
	const reportedCost = cost
		? optionalFiniteNonNegative(cost.total)
		: optionalFiniteNonNegative(usage.cost);

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: optionalFiniteNonNegative(usage.reasoning) ?? finiteNonNegative(usage.reasoningTokens),
		totalTokens: reportedTokens !== undefined && reportedTokens > 0 ? reportedTokens : calculatedTokens,
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			total: reportedCost !== undefined && reportedCost > 0 ? reportedCost : calculatedCost,
		},
		usageRecords: 1,
	};
}

function addValues(total: TaskUsageValues, values: TaskUsageValues): void {
	total.input += values.input;
	total.output += values.output;
	total.cacheRead += values.cacheRead;
	total.cacheWrite += values.cacheWrite;
	total.reasoning += values.reasoning;
	total.totalTokens += values.totalTokens;
	total.cost.input += values.cost.input;
	total.cost.output += values.cost.output;
	total.cost.cacheRead += values.cost.cacheRead;
	total.cost.cacheWrite += values.cost.cacheWrite;
	total.cost.total += values.cost.total;
	total.usageRecords += values.usageRecords;
}

interface ResolvedEntryUsage {
	values: TaskUsageValues;
	/** Child records are attribution metadata when top-level usage is present. */
	results: UnknownRecord[];
	fromDetails: boolean;
}

function aggregateResultUsage(results: readonly UnknownRecord[]): TaskUsageValues | undefined {
	const total = createTaskUsageValues();
	for (const result of results) {
		if (isRecord(result.usage)) addValues(total, normalizedUsage(result.usage));
	}
	return total.usageRecords > 0 ? total : undefined;
}

/**
 * Resolve one entry's billed usage. Subagent details are a historical fallback
 * only: a real top-level toolResult usage record always wins and is never
 * combined with its child records.
 */
function resolveEntryUsage(entry: UnknownRecord): ResolvedEntryUsage | undefined {
	if (entry.type === "message" && isRecord(entry.message)) {
		const message = entry.message;
		const role = message.role;
		if (role !== "assistant" && role !== "toolResult") return undefined;

		const results = subagentResults(message);
		if (isRecord(message.usage)) {
			return { values: normalizedUsage(message.usage), results, fromDetails: false };
		}
		if (role !== "toolResult" || results.length === 0) return undefined;
		const values = aggregateResultUsage(results);
		return values ? { values, results, fromDetails: true } : undefined;
	}

	if ((entry.type === "compaction" || entry.type === "branch_summary") && isRecord(entry.usage)) {
		return { values: normalizedUsage(entry.usage), results: [], fromDetails: false };
	}

	return undefined;
}

function modelLabel(message: UnknownRecord): string {
	const provider = typeof message.provider === "string" && message.provider ? message.provider : "unknown-provider";
	const modelValue = message.responseModel ?? message.model;
	const model = typeof modelValue === "string" && modelValue ? modelValue : "unknown-model";
	return `${provider}/${model}`;
}

function subagentResults(message: UnknownRecord): UnknownRecord[] {
	if (message.role !== "toolResult") return [];
	if (message.toolName !== "subagent" && message.toolName !== "gau_subagent") return [];
	if (!isRecord(message.details) || !Array.isArray(message.details.results)) return [];
	return message.details.results.filter(isRecord);
}

function subagentModelLabel(result: UnknownRecord): string {
	const model = typeof result.model === "string" && result.model ? result.model : undefined;
	if (!model) return "unknown-provider/unknown-model";
	// Child results historically carried only model. Keep provider/model values
	// intact, but make an unqualified model's missing provider explicit.
	return model.includes("/") ? model : `unknown-provider/${model}`;
}

function hasValues(values: TaskUsageValues): boolean {
	return (
		values.input > 0 ||
		values.output > 0 ||
		values.cacheRead > 0 ||
		values.cacheWrite > 0 ||
		values.reasoning > 0 ||
		values.totalTokens > 0 ||
		values.usageRecords > 0 ||
		values.cost.total > 0 ||
		values.cost.input > 0 ||
		values.cost.output > 0 ||
		values.cost.cacheRead > 0 ||
		values.cost.cacheWrite > 0
	);
}

function breakdownKey(category: BreakdownCategory, label: string): string {
	return `${category}\u0000${label}`;
}

function ensureBreakdown(
	breakdown: Map<string, TaskUsageBreakdown>,
	category: BreakdownCategory,
	label: string,
): TaskUsageBreakdown {
	const key = breakdownKey(category, label);
	let item = breakdown.get(key);
	if (!item) {
		item = { label, category, ...createTaskUsageValues() };
		breakdown.set(key, item);
	}
	return item;
}

function addBreakdown(
	breakdown: Map<string, TaskUsageBreakdown>,
	category: BreakdownCategory,
	label: string,
	values: TaskUsageValues,
): void {
	addValues(ensureBreakdown(breakdown, category, label), values);
}

const VALUE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** Attribute a standard nested-tool usage record without adding it to the overall total again. */
function attributeSubagentUsage(
	available: TaskUsageValues,
	results: readonly UnknownRecord[],
	breakdown: Map<string, TaskUsageBreakdown>,
): void {
	const candidates = results.map((result) => ({
		label: subagentModelLabel(result),
		values: isRecord(result.usage) ? normalizedUsage(result.usage) : createTaskUsageValues(),
	}));
	if (candidates.length === 0) {
		addBreakdown(breakdown, "nested", "Nested tools", available);
		return;
	}

	const candidateTotal = createTaskUsageValues();
	for (const candidate of candidates) addValues(candidateTotal, candidate.values);
	const allocatedTotal = createTaskUsageValues();
	const lastValueCandidate = (field: (typeof VALUE_FIELDS)[number]): number => {
		for (let i = candidates.length - 1; i >= 0; i--) {
			if (candidates[i]!.values[field] > 0) return i;
		}
		return -1;
	};
	const lastCostCandidate = (field: (typeof COST_FIELDS)[number]): number => {
		for (let i = candidates.length - 1; i >= 0; i--) {
			if (candidates[i]!.values.cost[field] > 0) return i;
		}
		return -1;
	};
	const lastRecordCandidate = (): number => {
		for (let i = candidates.length - 1; i >= 0; i--) {
			if (candidates[i]!.values.usageRecords > 0) return i;
		}
		return -1;
	};

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index]!;
		const adjusted = createTaskUsageValues();
		for (const field of VALUE_FIELDS) {
			const denominator = candidateTotal[field];
			const scaleDown = denominator > 0 && available[field] < denominator;
			adjusted[field] =
				scaleDown && index === lastValueCandidate(field)
					? Math.max(0, available[field] - allocatedTotal[field])
					: denominator > 0
						? candidate.values[field] * Math.min(1, available[field] / denominator)
						: 0;
		}
		for (const field of COST_FIELDS) {
			const denominator = candidateTotal.cost[field];
			const scaleDown = denominator > 0 && available.cost[field] < denominator;
			adjusted.cost[field] =
				scaleDown && index === lastCostCandidate(field)
					? Math.max(0, available.cost[field] - allocatedTotal.cost[field])
					: denominator > 0
						? candidate.values.cost[field] * Math.min(1, available.cost[field] / denominator)
						: 0;
		}
		const recordDenominator = candidateTotal.usageRecords;
		const recordScaleDown = recordDenominator > 0 && available.usageRecords < recordDenominator;
		adjusted.usageRecords =
			recordScaleDown && index === lastRecordCandidate()
				? Math.max(0, available.usageRecords - allocatedTotal.usageRecords)
				: recordDenominator > 0
					? candidate.values.usageRecords * Math.min(1, available.usageRecords / recordDenominator)
					: 0;
		addBreakdown(breakdown, "model", candidate.label, adjusted);
		addValues(allocatedTotal, adjusted);
	}

	const remainder = createTaskUsageValues();
	for (const field of VALUE_FIELDS) remainder[field] = Math.max(0, available[field] - allocatedTotal[field]);
	for (const field of COST_FIELDS) {
		remainder.cost[field] = Math.max(0, available.cost[field] - allocatedTotal.cost[field]);
	}
	remainder.usageRecords = Math.max(0, available.usageRecords - allocatedTotal.usageRecords);
	if (hasValues(remainder)) addBreakdown(breakdown, "nested", "Nested tools (unattributed)", remainder);
}

/** Attribute details-only usage directly to each child model. */
function attributeDetailsOnlyUsage(
	results: readonly UnknownRecord[],
	breakdown: Map<string, TaskUsageBreakdown>,
): void {
	for (const result of results) {
		if (!isRecord(result.usage)) continue;
		addBreakdown(breakdown, "model", subagentModelLabel(result), normalizedUsage(result.usage));
	}
}

/**
 * Sum usage-bearing entries exactly once. For historical subagent tool results
 * without top-level usage, child details provide the fallback billed records.
 * This is shared by task summaries and the themed footer's session totals.
 */
export function accumulateAllEntryUsage(entries: readonly unknown[]): TaskUsageValues {
	const total = createTaskUsageValues();
	for (const unknownEntry of entries) {
		if (!isRecord(unknownEntry)) continue;
		const resolved = resolveEntryUsage(unknownEntry);
		if (resolved) addValues(total, resolved.values);
	}
	return total;
}

/**
 * Build task totals plus model/source attribution. Top-level nested details only
 * divide an already-counted toolResult usage record; details-only records are
 * attributed directly and are already included in the resolved total.
 */
export function accumulateTaskUsage(entries: readonly unknown[]): TaskUsage {
	const total: TaskUsage = { ...accumulateAllEntryUsage(entries), breakdown: [] };
	const breakdown = new Map<string, TaskUsageBreakdown>();

	for (const unknownEntry of entries) {
		if (!isRecord(unknownEntry)) continue;
		const resolved = resolveEntryUsage(unknownEntry);
		if (!resolved) continue;
		const values = resolved.values;

		if (unknownEntry.type === "message" && isRecord(unknownEntry.message)) {
			const message = unknownEntry.message;
			if (message.role === "assistant") {
				addBreakdown(breakdown, "model", modelLabel(message), values);
			} else if (resolved.fromDetails) {
				attributeDetailsOnlyUsage(resolved.results, breakdown);
			} else if (resolved.results.length > 0) {
				attributeSubagentUsage(values, resolved.results, breakdown);
			} else {
				addBreakdown(breakdown, "nested", "Nested tools", values);
			}
		} else {
			addBreakdown(breakdown, "summary", "Compaction/branch summaries", values);
		}
	}

	total.breakdown = Array.from(breakdown.values())
		.filter((item) => item.category === "model" || hasValues(item))
		.sort((a, b) => {
			const categoryOrder = { model: 0, nested: 1, summary: 2 } as const;
			return categoryOrder[a.category] - categoryOrder[b.category] || b.cost.total - a.cost.total || a.label.localeCompare(b.label);
		});
	return total;
}

export function entriesAddedSince<T extends { id: string }>(
	entries: readonly T[],
	idsPresentAtStart: ReadonlySet<string>,
): readonly T[] {
	return entries.filter((entry) => !idsPresentAtStart.has(entry.id));
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatTokenCount(value: number): string {
	const count = Math.max(0, finiteNonNegative(value));
	if (count < 1_000) return NUMBER_FORMAT.format(count);

	const units = ["k", "M", "B", "T"] as const;
	let scaled = count;
	let unitIndex = -1;
	do {
		scaled /= 1_000;
		unitIndex += 1;
	} while (scaled >= 1_000 && unitIndex < units.length - 1);

	const fractionDigits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
	return `${Number(scaled.toFixed(fractionDigits))}${units[unitIndex]}`;
}

export function formatCompactCost(value: number): string {
	const cost = finiteNonNegative(value);
	if (cost === 0) return "$0";
	if (cost < 0.0001) return `$${cost.toFixed(6)}`;
	return `$${cost.toFixed(cost >= 100 ? 2 : 4)}`;
}

export function formatTaskSummaryCompact(data: TaskSummaryData): string {
	const { usage } = data;
	const modelCount = usage.breakdown?.filter((item) => item.category === "model").length ?? 0;
	return [
		`◷ ${formatElapsed(data.elapsedMs)}`,
		`↑${formatTokenCount(usage.input)}`,
		`↓${formatTokenCount(usage.output)}`,
		`cache ${formatTokenCount(usage.cacheRead)}/${formatTokenCount(usage.cacheWrite)}`,
		`Σ${formatTokenCount(usage.totalTokens)}`,
		formatCompactCost(usage.cost.total),
		...(modelCount > 1 ? [`${modelCount} models`] : []),
	].join("  ");
}

export function formatTaskUsageBreakdown(item: TaskUsageBreakdown): string {
	return `${item.label}: ↑${formatTokenCount(item.input)} ↓${formatTokenCount(item.output)} cache ${formatTokenCount(item.cacheRead)}/${formatTokenCount(item.cacheWrite)} Σ${formatTokenCount(item.totalTokens)} $${item.cost.total.toFixed(6)}`;
}

export function formatExactNumber(value: number): string {
	return NUMBER_FORMAT.format(Math.max(0, finiteNonNegative(value)));
}
