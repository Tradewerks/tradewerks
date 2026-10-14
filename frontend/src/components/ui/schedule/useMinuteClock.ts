import { useEffect, useState } from "react";

/** Epoch ms, refreshed on each wall-clock minute while `enabled`. */
export function useMinuteClock(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!enabled) return;
		let interval: ReturnType<typeof setInterval> | undefined;
		// Align to the minute so the now rule moves when the clock face does.
		const timeout = setTimeout(() => {
			setNow(Date.now());
			interval = setInterval(() => setNow(Date.now()), 60_000);
		}, 60_000 - (Date.now() % 60_000));
		return () => {
			clearTimeout(timeout);
			if (interval) clearInterval(interval);
		};
	}, [enabled]);

	return now;
}
