import { useEffect, useState } from "react";
import { localDateKey } from "./scheduleBoardUtils";

/** Local "YYYY-MM-DD" for today; rolls over at local midnight. */
export function useTodayKey(): string {
	const [key, setKey] = useState(() => localDateKey(new Date()));

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const sync = () => setKey(localDateKey(new Date()));
		const schedule = () => {
			clearTimeout(timer);
			const now = new Date();
			// Date arithmetic rather than +24h so DST days land on the real midnight.
			const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
			timer = setTimeout(() => {
				sync();
				schedule();
			}, midnight.getTime() - now.getTime() + 1000);
		};
		// Timers stall while the machine sleeps, so re-check when the tab is shown again.
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			sync();
			schedule();
		};

		schedule();
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);

	return key;
}
