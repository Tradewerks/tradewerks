import { useEffect, useState } from "react";

// 300ms: short enough to feel live, long enough to avoid a request per keystroke.
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);
	return debounced;
}
