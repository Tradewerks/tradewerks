import type { Prisma } from "../../../generated/prisma/client.js";

/**
 * Sets job.actual_total to the sum of its Completed visits' totals. Takes the
 * caller's tx so the visit write and the rollup commit or fail together.
 */
export async function recomputeJobActualTotal(
	tx: Prisma.TransactionClient,
	jobId: string,
): Promise<number> {
	// Locked before the aggregate, or two visits settling at once each sum
	// without the other and the later write drops one. Callers already hold
	// the visit row, so this keeps the visit -> job order.
	await tx.$queryRaw`SELECT id FROM job WHERE id = ${jobId} FOR NO KEY UPDATE`;
	const agg = await tx.job_visit.aggregate({
		where: { job_id: jobId, status: "Completed" },
		_sum: { total: true },
	});
	const sum = Number(agg._sum.total ?? 0);
	await tx.job.update({ where: { id: jobId }, data: { actual_total: sum } });
	return sum;
}
