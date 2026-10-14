import { db } from "../db.js";
import { logActivity } from "./logger.js";
import { log } from "./appLogger.js";
import { assertValidQuoteTransition } from "../lib/statusTransitions.js";

/**
 * `expires_at` was stored and never enforced, so `Expired` was a status the
 * reports read but nothing ever wrote. Approved quotes are deliberately
 * excluded: an accepted offer does not lapse on a timer.
 */
const EXPIRABLE_STATUSES = ["Issued", "Sent", "Viewed"] as const;

// A caller with years of quotes and no prior sweep would otherwise load every
// stale row in one tick. The scheduler runs this often enough that a capped
// batch catches up over a few ticks rather than needing its own backfill job.
const BATCH_LIMIT = 500;

export async function expireStaleQuotes(
	now: Date = new Date(),
): Promise<{ expired: number; failed: number }> {
	const stale = await db.quote.findMany({
		where: {
			status: { in: [...EXPIRABLE_STATUSES] },
			expires_at: { lt: now },
		},
		select: {
			id: true,
			status: true,
			organization_id: true,
			quote_number: true,
		},
		take: BATCH_LIMIT,
	});

	let expired = 0;
	let failed = 0;
	for (const quote of stale) {
		try {
			assertValidQuoteTransition(quote.status, "Expired");
			await db.quote.update({
				where: { id: quote.id },
				data: { status: "Expired" },
			});
			await logActivity({
				event_type: "quote.expired",
				action: "updated",
				entity_type: "quote",
				entity_id: quote.id,
				organization_id: quote.organization_id,
				actor_type: "system",
				actor_id: null,
				changes: { status: { old: quote.status, new: "Expired" } },
			});
			expired += 1;
		} catch (err) {
			// One bad row must not abandon the rest of the sweep.
			failed += 1;
			log.error({ err, quoteId: quote.id }, "Failed to expire quote");
		}
	}

	// A permanently failing row is otherwise invisible except by grepping the
	// per-row error above; this is the one line an ops dashboard can alert on.
	if (failed > 0) {
		log.warn({ expired, failed }, "Quote expiry sweep had failures");
	}

	return { expired, failed };
}
