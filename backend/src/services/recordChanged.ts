import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { emitToOrg } from "./socketService.js";
import { PARENT_ID_PATH } from "../controllers/logsController.js";

export type RecordType =
	| "visit"
	| "job"
	| "client"
	| "request"
	| "quote"
	| "invoice"
	| "recurring_plan";

export const ENTITY_TO_RECORD: Partial<Record<string, RecordType>> = {
	job_visit: "visit",
	job: "job",
	job_line_item: "job",
	job_note: "job",
	client: "client",
	contact: "client",
	request: "request",
	request_note: "request",
	quote: "quote",
	quote_line_item: "quote",
	quote_note: "quote",
	invoice: "invoice",
	invoice_payment: "invoice",
	invoice_note: "invoice",
	payment: "invoice",
	recurring_plan: "recurring_plan",
	recurring_plan_note: "recurring_plan",
	recurring_occurrence: "recurring_plan",
};

// Entity types whose own id IS the record id. Everything else in
// ENTITY_TO_RECORD is a child row and must emit its parent's id.
const SELF_ENTITIES = new Set([
	"job_visit",
	"job",
	"client",
	"request",
	"quote",
	"invoice",
	"recurring_plan",
]);

const OUTSIDE_REQUEST_DELAY_MS = 300;

type Payload = { type: RecordType; id: string; jobId?: string };
type Pending = Payload & { orgId: string };
type ChangeBuffer = {
	events: Map<string, Pending>;
	closed: boolean;
	failed: boolean;
};

const newBuffer = (): ChangeBuffer => ({
	events: new Map(),
	closed: false,
	failed: false,
});

const als = new AsyncLocalStorage<ChangeBuffer>();

let deferred = new Map<string, Pending>();
let deferredTimer: ReturnType<typeof setTimeout> | null = null;

const enqueue = (events: Map<string, Pending>, event: Pending) => {
	const key = `${event.type}:${event.id}`;
	const prev = events.get(key);
	events.set(key, { ...event, jobId: event.jobId ?? prev?.jobId });
};

const flush = (events: Map<string, Pending>) => {
	for (const { orgId, type, id, jobId } of events.values()) {
		const payload: Payload = jobId ? { type, id, jobId } : { type, id };
		try {
			emitToOrg(orgId, "record:changed", payload);
		} catch {
			// Socket layer down or uninitialized: the write already committed.
		}
	}
	events.clear();
};

const flushDeferred = () => {
	deferredTimer = null;
	const events = deferred;
	deferred = new Map();
	flush(events);
};

const defer = (event: Pending) => {
	enqueue(deferred, event);
	if (!deferredTimer) {
		deferredTimer = setTimeout(flushDeferred, OUTSIDE_REQUEST_DELAY_MS);
		deferredTimer.unref();
	}
};

export function recordChanged(
	orgId: string,
	type: RecordType,
	id: string,
	jobId?: string,
): void {
	const event: Pending = { orgId, type, id, jobId };
	const buffer = als.getStore();
	if (buffer && !buffer.closed) {
		enqueue(buffer.events, event);
		return;
	}
	// Late fire-and-forget work of a failed request belongs to a write that
	// did not land; after a successful one it did, so take the timed path.
	if (buffer?.failed) return;
	defer(event);
}

// Status < 400 is the commit signal: handlers answer 4xx/5xx after a rolled
// back transaction, and listeners must not refetch for a write that never
// landed.
// On client abort Node fires `close` without `finish` while the handler may
// still be running and may yet commit. Its outcome is unknowable, so hand the
// events to the timed path: a spurious ids-only refetch beats a missed one.
export const changeBufferMiddleware: RequestHandler = (_req, res, next) => {
	const buffer = newBuffer();
	const settle = () => {
		if (buffer.closed) return;
		buffer.closed = true;
		if (!res.writableEnded) {
			for (const event of buffer.events.values()) defer(event);
			buffer.events.clear();
		} else if (res.statusCode >= 400) {
			buffer.failed = true;
			buffer.events.clear();
		} else {
			flush(buffer.events);
		}
	};
	als.run(buffer, () => {
		res.on("finish", settle);
		res.on("close", settle);
		next();
	});
};

export async function runWithChangeBuffer<T>(fn: () => Promise<T>): Promise<T> {
	const buffer = newBuffer();
	try {
		const result = await als.run(buffer, fn);
		buffer.closed = true;
		flush(buffer.events);
		return result;
	} catch (err) {
		buffer.closed = true;
		buffer.failed = true;
		buffer.events.clear();
		throw err;
	}
}

const breadcrumb = (changes: unknown, key: "_parent_id" | "_parent_type") => {
	const path =
		key === "_parent_id" ? PARENT_ID_PATH : ["_parent_type", "new"];
	let node: unknown = changes;
	for (const step of path) {
		if (!node || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[step];
	}
	return typeof node === "string" && node ? node : undefined;
};

// Rows logged against a record that did not change it. customerComms'
// failureReport stamps every message outcome with its target's entity type,
// so without this each sent visit notice would refetch every board.
export const NON_MUTATING_EVENT_PREFIXES = ["customer_message."] as const;

export function recordChangedFromLog(entry: {
	event_type: string;
	organization_id?: string | null;
	entity_type: string;
	entity_id: string;
	changes?: unknown;
}): void {
	const orgId = entry.organization_id;
	const type = ENTITY_TO_RECORD[entry.entity_type];
	if (!orgId || !type) return;
	if (
		NON_MUTATING_EVENT_PREFIXES.some((p) => entry.event_type.startsWith(p))
	) {
		return;
	}

	if (entry.entity_type === "job_visit") {
		const jobId =
			breadcrumb(entry.changes, "_parent_type") === "job"
				? breadcrumb(entry.changes, "_parent_id")
				: undefined;
		recordChanged(orgId, type, entry.entity_id, jobId);
		return;
	}
	if (SELF_ENTITIES.has(entry.entity_type)) {
		recordChanged(orgId, type, entry.entity_id);
		return;
	}
	const parentType = breadcrumb(entry.changes, "_parent_type");
	const parentId = breadcrumb(entry.changes, "_parent_id");
	if (!parentId || (parentType && parentType !== type)) return;
	recordChanged(orgId, type, parentId);
}
