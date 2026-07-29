import { describe, expect, test } from "bun:test";
import {
	createElapsedTimer,
	formatElapsed,
	getElapsedMs,
	startElapsedTimer,
	stopElapsedTimer,
} from "./elapsed-timer";

describe("elapsed timer", () => {
	test("starts at zero and preserves the settled duration", () => {
		let state = createElapsedTimer();
		expect(state).toEqual({ active: false, startedAtMs: null, elapsedMs: 0 });
		expect(getElapsedMs(state, 5_000)).toBe(0);

		state = startElapsedTimer(state, 5_000);
		expect(getElapsedMs(state, 8_250)).toBe(3_250);

		state = stopElapsedTimer(state, 9_500);
		expect(state.active).toBe(false);
		expect(getElapsedMs(state, 20_000)).toBe(4_500);
	});

	test("does not reset while active and resets on the next task", () => {
		const active = startElapsedTimer(createElapsedTimer(), 1_000);
		expect(startElapsedTimer(active, 8_000)).toBe(active);
		expect(getElapsedMs(active, 9_000)).toBe(8_000);

		const settled = stopElapsedTimer(active, 10_000);
		const nextTask = startElapsedTimer(settled, 20_000);
		expect(getElapsedMs(nextTask, 20_000)).toBe(0);
	});

	test("formats minute and hour durations", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(65_999)).toBe("1:05");
		expect(formatElapsed(3_599_999)).toBe("59:59");
		expect(formatElapsed(3_600_000)).toBe("1:00:00");
		expect(formatElapsed(45_296_000)).toBe("12:34:56");
	});
});
