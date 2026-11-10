import type { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import type { getScopedDb } from "./context.js";
import { recomputeDocumentTotals } from "./recomputeDocumentTotals.js";
import { OPEN } from "./statusTransitions.js";

/**
 * Recompute every open visit of a job, one transaction each. Visits resolve their rate from the
 * job's address, so callers run this after the job's own change has committed. A
 * failing visit is logged and skipped; it never fails the caller.
 */
export async function recomputeOpenVisits(
	sdb: ReturnType<typeof getScopedDb>,
	jobId: string,
	orgId: string,
	reason: string,
): Promise<void> {
	const visits = await sdb.job_visit.findMany({
		where: { job_id: jobId, status: OPEN },
		select: { id: true },
	});
	for (const v of visits) {
		try {
			await sdb.$transaction((tx) =>
				recomputeDocumentTotals("job_visit", v.id, orgId, tx as unknown as Prisma.TransactionClient),
			);
		} catch (err) {
			log.error({ err, orgId, visitId: v.id }, `Visit recompute after ${reason} failed`);
		}
	}
}
