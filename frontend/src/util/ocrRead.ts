import { useEffect, useState } from "react";

/**
 * Mirrors the server's OCR_STALE_MS (provider timeout + 100s). A read still
 * `pending` past this died with its process or failed retryably; the server's
 * sweeper re-runs it, accepts a Try again, and refuses submit until it lands.
 * Kept client-side rather than sent as a flag: the sheet has to flip at the
 * stale moment without a refetch.
 */
export const OCR_STALE_MS = 120_000;

type ReadRow = {
	ocr_status: string | null;
	ocr_started_at?: string | null;
	updated_at?: string | null;
};

/** Rows read before `ocr_started_at` existed fall back to `updated_at`, as the server does. */
function readStart(row: ReadRow): number {
	const at = row.ocr_started_at ?? row.updated_at;
	return at ? new Date(at).getTime() : NaN;
}

export function isOcrReadStalled(row: ReadRow, now = Date.now()): boolean {
	if (row.ocr_status !== "pending") return false;
	const started = readStart(row);
	return Number.isFinite(started) && now - started >= OCR_STALE_MS;
}

/**
 * "reading" | "stalled" | null. Re-renders once at the stale moment, since a
 * stalled row stops changing and nothing else would.
 */
export function useOcrReadState(row: ReadRow): "reading" | "stalled" | null {
	const [, setTick] = useState(0);
	const pending = row.ocr_status === "pending";
	const started = readStart(row);
	useEffect(() => {
		if (!pending || !Number.isFinite(started)) return;
		const wait = started + OCR_STALE_MS - Date.now();
		if (wait <= 0) return;
		const t = setTimeout(() => setTick((n) => n + 1), wait + 50);
		return () => clearTimeout(t);
	}, [pending, started]);
	if (!pending) return null;
	return isOcrReadStalled(row) ? "stalled" : "reading";
}
