import { db } from "../../db.js";
import { log } from "../appLogger.js";
import {
	receiptOcrDuration,
	receiptOcrFieldFlags,
	receiptOcrOldestPendingAge,
	receiptOcrPending,
	receiptOcrReads,
} from "../metricsService.js";
import type { OcrFlagSet } from "./flags.js";
import type { OcrFailureKind } from "./normalize.js";

/**
 * `recovered` is a sweeper re-run that succeeded; `abandoned` is one the sweeper gave up
 * on. `superseded` finished after a newer photo or read took the row, so wrote nothing.
 */
export type OcrReadOutcome =
	| "succeeded"
	| "failed"
	| "skipped"
	| "throttled"
	| "timeout"
	| "unavailable"
	| "recovered"
	| "abandoned"
	| "superseded";

export function outcomeForFailure(kind: OcrFailureKind): OcrReadOutcome {
	return kind === "final" ? "failed" : kind;
}

export const ocrMetrics = {
	read(provider: string, outcome: OcrReadOutcome): void {
		receiptOcrReads.add(1, { provider, outcome });
	},
	duration(provider: string, seconds: number): void {
		receiptOcrDuration.record(seconds, { provider });
	},
	flags(set: OcrFlagSet): void {
		for (const [field, flag] of Object.entries(set.fields)) {
			if (flag) receiptOcrFieldFlags.add(1, { field, kind: flag.kind });
		}
	},
};

type CountDb = Pick<typeof db, "field_purchase">;

export async function pendingReadStats(client: CountDb = db, now = Date.now()) {
	const agg = await client.field_purchase.aggregate({
		where: { ocr_status: "pending" },
		_count: { _all: true },
		_min: { ocr_started_at: true },
	});
	const oldest = agg._min.ocr_started_at;
	return {
		count: agg._count._all,
		oldestAgeSeconds: oldest ? Math.max(0, (now - oldest.getTime()) / 1000) : 0,
	};
}

let gaugesRegistered = false;

/** One query per scrape feeds both gauges; cross-org on purpose, so the base client. */
export function registerOcrPendingGauges(): void {
	if (gaugesRegistered) return;
	gaugesRegistered = true;
	let inFlight: Promise<Awaited<ReturnType<typeof pendingReadStats>> | null> | null = null;
	const stats = () => {
		inFlight ??= pendingReadStats()
			.catch((err) => {
				log.warn({ err }, "receipt OCR pending gauge query failed");
				return null;
			})
			.finally(() => setTimeout(() => (inFlight = null), 1_000));
		return inFlight;
	};
	receiptOcrPending.addCallback(async (result) => {
		const s = await stats();
		if (s) result.observe(s.count);
	});
	receiptOcrOldestPendingAge.addCallback(async (result) => {
		const s = await stats();
		if (s) result.observe(s.oldestAgeSeconds);
	});
}
