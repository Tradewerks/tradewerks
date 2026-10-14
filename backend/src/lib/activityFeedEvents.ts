/**
 * Log event types the activity feed shows. One list because two doors read it:
 * logActivity's live socket push and GET /logs/recent's page load. While they
 * were separate copies, an event added to only one either vanished on reload or
 * never arrived live.
 */
export const FEED_EVENT_TYPES = [
	"job.created",
	"job_visit.created",
	"job_visit.updated",
	"job_visit.technicians_assigned",
	"request.created",
	"request.updated",
	"quote.created",
	"quote.updated",
	// A send that never reached the client is the one thing about a quote a
	// dispatcher has to learn without going looking for it.
	"quote.send_failed",
	"quote.dispute_opened",
	"quote.dispute_resolved",
	"invoice.created",
	"invoice.updated",
	"invoice.send_failed",
	"invoice.dispute_opened",
	"invoice.dispute_resolved",
	"invoice_payment.created",
	"recurring_plan.created",
	"recurring_occurrence.generated",
	"technician.updated",
] as const;

export const FEED_EVENT_SET: ReadonlySet<string> = new Set(FEED_EVENT_TYPES);
