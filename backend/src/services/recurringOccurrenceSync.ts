import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Keeps a recurring occurrence in step with the visit generated from it.
 * Runs inside the visit's status transaction, after the visit row lock and
 * before the job lock, so the order stays plan -> visit -> occurrence -> job.
 * Terminal statuses are mirrored; leaving one (restore/reopen, `from` given) undoes it.
 */
export async function syncOccurrenceForVisit(
	visitId: string,
	to: "Completed" | "Cancelled" | string,
	tx: Prisma.TransactionClient,
	from?: string,
): Promise<void> {
	const wasTerminal = from === "Completed" || from === "Cancelled";
	if (wasTerminal && to !== "Completed" && to !== "Cancelled") {
		// Restore or reopen: the visit is live again, so is its occurrence.
		await tx.recurring_occurrence.updateMany({
			where: {
				job_visit_id: visitId,
				status: { in: ["completed", "cancelled"] },
			},
			data: {
				status: "generated",
				completed_at: null,
				skip_reason: null,
			},
		});
	} else if (to === "Completed") {
		await tx.recurring_occurrence.updateMany({
			// A visit completed after a cancel + restore must not stay "cancelled".
			where: {
				job_visit_id: visitId,
				status: { in: ["generated", "cancelled"] },
			},
			data: { status: "completed", completed_at: new Date() },
		});
	} else if (to === "Cancelled") {
		await tx.recurring_occurrence.updateMany({
			where: {
				job_visit_id: visitId,
				status: { in: ["generated", "completed"] },
			},
			data: { status: "cancelled", skip_reason: "Visit cancelled" },
		});
	}
}
