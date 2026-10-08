import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { socket } from "../lib/socket";
import { qk, invalidate } from "../lib/queryKeys";
import type {
	FieldPurchaseEvent,
	FieldPurchaseGrantRequestedEvent,
	FieldPurchaseOcrEvent,
	InventoryUpdatedEvent,
	JobUpdatedEvent,
	JobNoteCreatedEvent,
	JobVisitCreatedEvent,
	JobVisitUpdatedEvent,
	JobVisitDeletedEvent,
	VisitStatusEvent,
} from "../types/socketEvents";

const JOB_VISITS_KEY = ["jobVisits"] as const;
const TECHNICIANS_KEY = ["technicians"] as const;
const DISPUTE_ACTIVITY = /^(quote|invoice)\.dispute_(opened|resolved)$/;

// Single canonical event→invalidation map — mounted once in DispatchLayout and
// TechnicianLayout so every socket-driven cache update lives in one place.
export function useSocketQuerySync(): void {
	const qc = useQueryClient();

	useEffect(() => {
		const onInventoryUpdated = (event: InventoryUpdatedEvent) => {
			if (event.itemId) {
				qc.invalidateQueries({ queryKey: qk.inventory.detail(event.itemId) });
				qc.invalidateQueries({ queryKey: qk.inventory.list() });
			} else {
				invalidate.warehouse(qc);
			}
			invalidate.vehicleStock(qc, event.vehicleId);
			qc.invalidateQueries({ queryKey: qk.inventory.provisional });
			// An item-scoped change can add or clear a reconcile row — approving a
			// provisional item, linking a name, receiving against one. The broad
			// branch above already covers this through `inventory.all`; the scoped one
			// left the queue stale for everyone but the dispatcher who acted.
			qc.invalidateQueries({ queryKey: qk.inventory.reconcile() });
		};
		const onJobVisitChanged = (event: JobVisitUpdatedEvent | VisitStatusEvent) => {
			qc.invalidateQueries({ queryKey: JOB_VISITS_KEY });
			qc.invalidateQueries({ queryKey: TECHNICIANS_KEY });
			// The job page reads its visits under ["jobs", id, "visits"], outside the
			// jobVisits prefix. Only status events name the job.
			if ("visit" in event && event.visit?.job?.id) {
				qc.invalidateQueries({ queryKey: ["jobs", event.visit.job.id] });
			}
		};
		const onJobUpdated = (_event: JobUpdatedEvent) => {
			qc.invalidateQueries({ queryKey: JOB_VISITS_KEY });
		};
		const onJobVisitCreatedOrDeleted = (_event: JobVisitCreatedEvent | JobVisitDeletedEvent) => {
			qc.invalidateQueries({ queryKey: JOB_VISITS_KEY });
		};
		const onJobNoteCreated = (_event: JobNoteCreatedEvent) => {
			qc.invalidateQueries({ queryKey: JOB_VISITS_KEY });
		};
		/**
		 * Every field-purchase transition. `fieldPurchases.all` is the prefix for the
		 * queue, the stage counts and the open detail, so one invalidation covers both
		 * audiences.
		 */
		const onFieldPurchaseChanged = (_event: FieldPurchaseEvent) => {
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
		};
		// Extraction runs off the upload request, so nothing else tells the sheet its
		// lines arrived. Scoped to the one row: an org-wide refetch per receipt read
		// is noise on every other screen.
		const onFieldPurchaseOcr = (event: FieldPurchaseOcrEvent) => {
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.detail(event.id) });
			// The reading the purchase did not take. Its own key, so a sheet open on
			// this purchase picks the extraction up the moment it lands rather than
			// on the next thing that happens to refetch the detail.
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.extraction(event.id) });
		};
		const onGrantRequested = (_event: FieldPurchaseGrantRequestedEvent) => {
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.grants });
		};
		// Disputes have no socket event of their own: they ride the activity
		// feed's broadcast, and this hook is mounted on every page while the feed
		// may not be.
		const onActivity = (event: { event_type?: string }) => {
			if (DISPUTE_ACTIVITY.test(event.event_type ?? "")) {
				qc.invalidateQueries({ queryKey: qk.disputes.open });
			}
		};

		socket.on("inventory:updated", onInventoryUpdated);
		socket.on("job_visit:status_changed", onJobVisitChanged);
		socket.on("job_visit:updated", onJobVisitChanged);
		socket.on("job:updated", onJobUpdated);
		socket.on("job_visit:created", onJobVisitCreatedOrDeleted);
		socket.on("job_visit:deleted", onJobVisitCreatedOrDeleted);
		socket.on("job_note:created", onJobNoteCreated);
		socket.on("field_purchase:submitted", onFieldPurchaseChanged);
		socket.on("field_purchase:reviewed", onFieldPurchaseChanged);
		socket.on("field_purchase:preauth_requested", onFieldPurchaseChanged);
		socket.on("field_purchase:preauth_decided", onFieldPurchaseChanged);
		socket.on("field_purchase:ocr", onFieldPurchaseOcr);
		socket.on("field_purchase:grant_requested", onGrantRequested);
		socket.on("activity-event", onActivity);

		return () => {
			socket.off("inventory:updated", onInventoryUpdated);
			socket.off("job_visit:status_changed", onJobVisitChanged);
			socket.off("job_visit:updated", onJobVisitChanged);
			socket.off("job:updated", onJobUpdated);
			socket.off("job_visit:created", onJobVisitCreatedOrDeleted);
			socket.off("job_visit:deleted", onJobVisitCreatedOrDeleted);
			socket.off("job_note:created", onJobNoteCreated);
			socket.off("field_purchase:submitted", onFieldPurchaseChanged);
			socket.off("field_purchase:reviewed", onFieldPurchaseChanged);
			socket.off("field_purchase:preauth_requested", onFieldPurchaseChanged);
			socket.off("field_purchase:preauth_decided", onFieldPurchaseChanged);
			socket.off("field_purchase:ocr", onFieldPurchaseOcr);
			socket.off("field_purchase:grant_requested", onGrantRequested);
			socket.off("activity-event", onActivity);
		};
	}, [qc]);
}
