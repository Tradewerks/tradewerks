import { useState, useRef, useEffect, useCallback } from "react";

// ============================================================================
// RATE % INPUT HELPERS
// rate in DB is 0-1; we show/edit as 0-100
// ============================================================================

/** Convert a 0-1 rate to display percent string. Uses 4-decimal precision for edit fields. */
export function rateToPercent(rate: number): string {
	return (rate * 100).toFixed(4).replace(/\.?0+$/, "");
}

export function percentToRate(pct: string): number {
	const n = parseFloat(pct);
	if (isNaN(n)) return 0;
	return Math.min(100, Math.max(0, n)) / 100;
}

// ============================================================================
// INLINE FEEDBACK
// ============================================================================

interface FeedbackState {
	type: "success" | "error";
	message: string;
}

export function useFeedback() {
	const [feedback, setFeedback] = useState<FeedbackState | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => { if (timerRef.current) clearTimeout(timerRef.current); };
	}, []);

	const showFeedback = useCallback((type: "success" | "error", message: string) => {
		if (timerRef.current) clearTimeout(timerRef.current);
		setFeedback({ type, message });
		timerRef.current = setTimeout(() => setFeedback(null), 3000);
	}, []);

	return { feedback, showFeedback };
}

