// backend/src/services/tax/taxMetrics.ts
import { db } from "../../db.js";
import { OPEN } from "../../lib/statusTransitions.js";
import { log } from "../appLogger.js";
import {
	taxDocumentsNeedsReview,
	taxProviderCalls,
	taxProviderLatency,
	taxResolutionCacheHits,
} from "../metricsService.js";

export type ProviderCallStatus = "ok" | "ambiguous" | "failed";

export interface TaxMetrics {
	providerCall(status: ProviderCallStatus, seconds: number): void;
	cacheHit(): void;
}

export const otelTaxMetrics: TaxMetrics = {
	providerCall(status, seconds) {
		taxProviderCalls.add(1, { status });
		taxProviderLatency.record(seconds, { status });
	},
	cacheHit() {
		taxResolutionCacheHits.add(1);
	},
};

type CountDb = Pick<typeof db, "quote" | "job" | "invoice">;

/** Unlocked documents only: a sent document's review is history, not a queue. */
export async function countDraftsNeedingReview(client: CountDb = db) {
	const [quote, job, invoice] = await Promise.all([
		client.quote.count({ where: { tax_needs_review: true, status: "Draft" } }),
		client.job.count({ where: { tax_needs_review: true, status: OPEN } }),
		client.invoice.count({ where: { tax_needs_review: true, status: "Draft" } }),
	]);
	return { quote, job, invoice };
}

let gaugeRegistered = false;

/** Runs three counts per scrape (60 s); cross-org on purpose, so the base client. */
export function registerTaxReviewGauge(): void {
	if (gaugeRegistered) return;
	gaugeRegistered = true;
	taxDocumentsNeedsReview.addCallback(async (result) => {
		try {
			const counts = await countDraftsNeedingReview();
			for (const [document_type, n] of Object.entries(counts)) {
				result.observe(n, { document_type });
			}
		} catch (err) {
			log.warn({ err }, "tax needs-review gauge query failed");
		}
	});
}
