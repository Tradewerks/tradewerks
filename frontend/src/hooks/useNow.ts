import { useEffect, useState } from "react";

/** Epoch ms, refreshed every `intervalMs` while `enabled`. Keep callers small: each tick re-renders. */
export function useNow(intervalMs: number, enabled = true): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs, enabled]);

	return now;
}
