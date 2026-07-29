export interface ElapsedTimerState {
	readonly active: boolean;
	readonly startedAtMs: number | null;
	readonly elapsedMs: number;
}

export function createElapsedTimer(): ElapsedTimerState {
	return { active: false, startedAtMs: null, elapsedMs: 0 };
}

export function startElapsedTimer(state: ElapsedTimerState, nowMs: number): ElapsedTimerState {
	if (state.active) return state;
	return { active: true, startedAtMs: nowMs, elapsedMs: 0 };
}

export function stopElapsedTimer(state: ElapsedTimerState, nowMs: number): ElapsedTimerState {
	if (!state.active || state.startedAtMs === null) return state;
	return { active: false, startedAtMs: null, elapsedMs: Math.max(0, nowMs - state.startedAtMs) };
}

export function getElapsedMs(state: ElapsedTimerState, nowMs: number): number {
	if (!state.active || state.startedAtMs === null) return state.elapsedMs;
	return Math.max(0, nowMs - state.startedAtMs);
}

export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	return `${totalMinutes}:${seconds.toString().padStart(2, "0")}`;
}
