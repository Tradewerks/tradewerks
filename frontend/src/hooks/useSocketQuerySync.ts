import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { socket } from "../lib/socket";
import { qk, invalidate } from "../lib/queryKeys";
import { ENTITLEMENTS_STALE_EVENT } from "../lib/permissionAccess";
import { ENTITLEMENTS_QUERY_KEY } from "./useEntitlements";
import { UPGRADE_REQUESTS_QUERY_KEY } from "./useUpgradeRequests";
import { useToastStore } from "../stores/toastStore";
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
	ProjectUpdatedEvent,
	RecordChangedEvent,
	RecordType,
	VisitStatusEvent,
} from "../types/socketEvents";

const TECHNICIANS_KEY = ["technicians"] as const;
// Task 11's dashboard query; invalidating a key nobody reads is a no-op.
const DASHBOARD_TODAY_KEY = ["reports", "dashboard-today"] as const;
const DISPUTE_ACTIVITY = /^(quote|invoice)\.dispute_(opened|resolved)$/;

const invalidateKeys = (qc: QueryClient, keys: readonly (readonly unknown[])[]) => {
	for (const queryKey of keys) qc.invalidateQueries({ queryKey });
};

const recordKeys = (
	keys: { all: readonly unknown[]; detail: (id: string) => readonly unknown[] },
	extra: readonly (readonly unknown[])[] = [],
) =>
	(qc: QueryClient, e: RecordChangedEvent) =>
		invalidateKeys(qc, [keys.all, keys.detail(e.id), ...extra]);

// invalidateQueries refetches only mounted queries by default, so a broad
// prefix costs one request per mounted list, not one per cached key.
export const RECORD_INVALIDATIONS: Record<
	RecordType,
	(qc: QueryClient, e: RecordChangedEvent) => void
> = {
	// ["jobs"] stays in the visit set while the board still reads job lists.
	visit: (qc, e) =>
		invalidateKeys(qc, [
			qk.board.all,
			qk.visits.all,
			qk.jobs.all,
			TECHNICIANS_KEY,
			DASHBOARD_TODAY_KEY,
			...(e.jobId ? [qk.jobs.detail(e.jobId)] : []),
		]),
	job: (qc) => invalidateKeys(qc, [qk.jobs.all, qk.board.all, DASHBOARD_TODAY_KEY]),
	client: recordKeys(qk.clients),
	request: recordKeys(qk.requests, [DASHBOARD_TODAY_KEY]),
	quote: recordKeys(qk.quotes, [DASHBOARD_TODAY_KEY]),
	invoice: recordKeys(qk.invoices),
	recurring_plan: recordKeys(qk.recurringPlans),
};

// Events emitted while disconnected are lost for good; refetch whatever is on screen.
const RECONNECT_KEYS = [
	qk.board.all,
	qk.visits.all,
	qk.jobs.all,
	qk.clients.all,
	qk.requests.all,
	qk.quotes.all,
	qk.invoices.all,
	qk.arrivals.all,
	TECHNICIANS_KEY,
] as const;

// Several writes refused in one burst should produce one message.
let lastModuleRefusalToastAt = 0;

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
		// Legacy visit/job events also hit ["jobs"] and the board, so the board stays
		// live even against a backend that does not emit record:changed yet.
		// ["jobs"] also covers the job page's ["jobs", id, "visits"].
		const onJobVisitChanged = (_event: JobVisitUpdatedEvent | VisitStatusEvent) => {
			invalidateKeys(qc, [qk.visits.all, TECHNICIANS_KEY, qk.jobs.all, qk.board.all]);
		};
		const onJobUpdated = (_event: JobUpdatedEvent) => {
			invalidateKeys(qc, [qk.visits.all, qk.jobs.all, qk.board.all]);
		};
		const onJobVisitCreatedOrDeleted = (_event: JobVisitCreatedEvent | JobVisitDeletedEvent) => {
			invalidateKeys(qc, [qk.visits.all, qk.jobs.all, qk.board.all]);
		};
		const onJobNoteCreated = (_event: JobNoteCreatedEvent) => {
			qc.invalidateQueries({ queryKey: qk.visits.all });
		};
		const onRecordChanged = (event: RecordChangedEvent) => {
			RECORD_INVALIDATIONS[event.type]?.(qc, event);
		};
		const onReconnect = () => invalidateKeys(qc, RECONNECT_KEYS);
		// Attach/detach moves a job between projects, so jobs refetch too.
		const onProjectUpdated = (event: ProjectUpdatedEvent) => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			qc.invalidateQueries({ queryKey: ["project", event.projectId] });
			qc.invalidateQueries({ queryKey: ["clientProjects"] });
			qc.invalidateQueries({ queryKey: ["jobs"] });
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
		// The arrival tracker's minute tick, and any visit change that moves a forecast
		const onArrivalsUpdated = () => {
			qc.invalidateQueries({ queryKey: qk.arrivals.all });
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

		const onEntitlementsChanged = () => {
			qc.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY });
			qc.invalidateQueries({ queryKey: UPGRADE_REQUESTS_QUERY_KEY });
		};
		const onModuleRefused = (event: Event) => {
			onEntitlementsChanged();
			const detail = (event as CustomEvent<{ code?: string; method?: string }>).detail;
			if (!detail?.method || detail.method.toLowerCase() === "get") return;
			const now = Date.now();
			if (now - lastModuleRefusalToastAt < 5000) return;
			lastModuleRefusalToastAt = now;
			useToastStore
				.getState()
				.push(
					"warning",
					detail.code === "MODULE_NOT_IN_PLAN"
						? "That isn't part of your subscription. Nothing was changed."
						: "That module is turned off for your organization. Nothing was changed.",
				);
		};

		socket.on("entitlements:changed", onEntitlementsChanged);
		window.addEventListener(ENTITLEMENTS_STALE_EVENT, onModuleRefused);
		socket.on("inventory:updated", onInventoryUpdated);
		socket.on("job_visit:status_changed", onJobVisitChanged);
		socket.on("job_visit:updated", onJobVisitChanged);
		socket.on("job:updated", onJobUpdated);
		socket.on("job_visit:created", onJobVisitCreatedOrDeleted);
		socket.on("job_visit:deleted", onJobVisitCreatedOrDeleted);
		socket.on("job_note:created", onJobNoteCreated);
		socket.on("project:updated", onProjectUpdated);
		socket.on("field_purchase:submitted", onFieldPurchaseChanged);
		socket.on("field_purchase:reviewed", onFieldPurchaseChanged);
		socket.on("field_purchase:preauth_requested", onFieldPurchaseChanged);
		socket.on("field_purchase:preauth_decided", onFieldPurchaseChanged);
		socket.on("field_purchase:ocr", onFieldPurchaseOcr);
		socket.on("field_purchase:grant_requested", onGrantRequested);
		socket.on("activity-event", onActivity);
		socket.on("arrivals:updated", onArrivalsUpdated);
		socket.on("record:changed", onRecordChanged);
		// A manager event: the socket-level "connect" also fires on first connect.
		socket.io.on("reconnect", onReconnect);

		return () => {
			socket.off("entitlements:changed", onEntitlementsChanged);
			window.removeEventListener(ENTITLEMENTS_STALE_EVENT, onModuleRefused);
			socket.off("inventory:updated", onInventoryUpdated);
			socket.off("job_visit:status_changed", onJobVisitChanged);
			socket.off("job_visit:updated", onJobVisitChanged);
			socket.off("job:updated", onJobUpdated);
			socket.off("job_visit:created", onJobVisitCreatedOrDeleted);
			socket.off("job_visit:deleted", onJobVisitCreatedOrDeleted);
			socket.off("job_note:created", onJobNoteCreated);
			socket.off("project:updated", onProjectUpdated);
			socket.off("field_purchase:submitted", onFieldPurchaseChanged);
			socket.off("field_purchase:reviewed", onFieldPurchaseChanged);
			socket.off("field_purchase:preauth_requested", onFieldPurchaseChanged);
			socket.off("field_purchase:preauth_decided", onFieldPurchaseChanged);
			socket.off("field_purchase:ocr", onFieldPurchaseOcr);
			socket.off("field_purchase:grant_requested", onGrantRequested);
			socket.off("activity-event", onActivity);
			socket.off("arrivals:updated", onArrivalsUpdated);
			socket.off("record:changed", onRecordChanged);
			socket.io.off("reconnect", onReconnect);
		};
	}, [qc]);
}
