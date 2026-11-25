/// <reference types="node" />
/**
 * Large-dataset seed for list/board/history query verification. Additive and
 * idempotent; every row is tagged so --purge can remove exactly what it made:
 *   clients/contacts/requests/quotes/jobs/technicians: name or title "SCALE· ..."
 *   invoices: number "SCALE-INV-..."; log rows: user_agent "scale-seed".
 *
 *   npx tsx prisma/seedScale.ts [--org <orgId>] [--purge] [--yes]
 *
 * Point DATABASE_URL at a scratch DB; never run against a DB you cannot rebuild.
 * It prints the target host, database and org first, and refuses any database
 * other than hvac_seedcheck (including the dev DB hvac_db) unless --yes is passed.
 */
import "dotenv/config";
import crypto from "crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/prisma/client.js";

const db = new PrismaClient({
	adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const TAG = "SCALE·";
const LOG_TAG = "scale-seed";
const BATCH = 1000;
const DAY = 86_400_000;

const N = {
	clients: 5000,
	requests: 3000,
	quotes: 6000,
	jobs: 20000,
	visits: 30000,
	invoices: 12000,
	logs: 150000,
	techs: 15,
};

// Deterministic so reruns after a purge reproduce the same shape.
let seed = 0x9e3779b9;
const rnd = () => {
	seed ^= seed << 13;
	seed >>>= 0;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	seed >>>= 0;
	return seed / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const weighted = <T>(xs: readonly (readonly [T, number])[]): T => {
	const total = xs.reduce((s, [, w]) => s + w, 0);
	let r = rnd() * total;
	for (const [v, w] of xs) if ((r -= w) <= 0) return v;
	return xs[xs.length - 1][0];
};
const money = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
const id = () => crypto.randomUUID();
const pad = (n: number, w = 6) => String(n).padStart(w, "0");

const FIRST = ["Alder", "Birch", "Cedar", "Dunn", "Elm", "Fairview", "Grove", "Harbor", "Iron", "Juniper", "Kestrel", "Lakeside", "Maple", "North", "Oak", "Pine", "Quarry", "Ridge", "Summit", "Timber"];
const LAST = ["Plumbing", "Holdings", "Realty", "Dental", "Bakery", "Apartments", "Lofts", "Church", "School", "Clinic", "Storage", "Motors", "Diner", "Offices", "Residence"];
const STREETS = ["Main St", "Oak Ave", "Maple Dr", "Cedar Ln", "Elm St", "Lake Rd", "Hill St", "Park Blvd"];
const WORK = ["Furnace tune-up", "AC no cooling", "Thermostat replace", "Duct inspection", "Condenser swap", "Heat pump install", "Refrigerant leak", "Blower motor", "Mini-split service", "Water heater flush"];

const PRIORITIES = ["Low", "Medium", "High", "Urgent", "Emergency"] as const;
const REQUEST_STATUSES = [
	["New", 25], ["Reviewing", 15], ["Quoted", 15], ["QuoteApproved", 10],
	["QuoteRejected", 5], ["ConvertedToJob", 25], ["Cancelled", 5],
] as const;
const QUOTE_STATUSES = [
	["Draft", 12], ["Issued", 6], ["Sent", 18], ["Viewed", 12], ["Approved", 28],
	["Disputed", 2], ["Rejected", 8], ["Revised", 4], ["Expired", 6], ["Cancelled", 4],
] as const;
const JOB_STATUSES = [
	["Unscheduled", 12], ["Scheduled", 18], ["InProgress", 8], ["Completed", 52], ["Cancelled", 10],
] as const;
const INVOICE_STATUSES = [
	["Draft", 8], ["Issued", 10], ["Sent", 14], ["Viewed", 8], ["PartiallyPaid", 8],
	["Paid", 40], ["Disputed", 2], ["Void", 10],
] as const;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

const chunks = <T>(rows: T[]) => {
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH));
	return out;
};

async function insertAll<T>(label: string, rows: T[], write: (batch: T[]) => Promise<unknown>) {
	const t = Date.now();
	for (const batch of chunks(rows)) await write(batch);
	console.log(`  ${label}: ${rows.length} rows (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

async function purge(orgId: string) {
	const org = { organization_id: orgId };
	const t = Date.now();
	const step = async (label: string, run: () => Promise<{ count: number }>) =>
		console.log(`  ${label}: ${(await run()).count}`);
	console.log(`Purging ${TAG} rows from org ${orgId}`);
	await step("log", () => db.log.deleteMany({ where: { ...org, user_agent: LOG_TAG } }));
	await step("invoice", () =>
		db.invoice.deleteMany({ where: { ...org, invoice_number: { startsWith: "SCALE-INV-" } } }),
	);
	// job_visit and job_visit_technician go with their job (onDelete: Cascade).
	await step("job", () => db.job.deleteMany({ where: { ...org, name: { startsWith: TAG } } }));
	await step("quote", () => db.quote.deleteMany({ where: { ...org, title: { startsWith: TAG } } }));
	await step("request", () => db.request.deleteMany({ where: { ...org, title: { startsWith: TAG } } }));
	// client_contact rows cascade from client/contact.
	await step("client", () => db.client.deleteMany({ where: { ...org, name: { startsWith: TAG } } }));
	await step("contact", () => db.contact.deleteMany({ where: { ...org, name: { startsWith: TAG } } }));
	await step("technician", () => db.technician.deleteMany({ where: { ...org, name: { startsWith: TAG } } }));
	console.log(`Purge done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

// hvac_db is the dev DB (the .env default), so it needs --yes like any other target.
const ALLOWED_DBS = ["hvac_seedcheck"];

// Writes (and --purge deletes) thousands of rows, so show where and stop on a surprise target.
function confirmTarget(org: string) {
	let host = "?";
	let database = "?";
	try {
		const u = new URL(process.env.DATABASE_URL ?? "");
		host = u.host;
		database = decodeURIComponent(u.pathname.replace(/^\//, ""));
	} catch {
		// An unparsable URL falls through to the refusal below.
	}
	console.log(`Target: host=${host} db=${database} org=${org}`);
	if (!ALLOWED_DBS.includes(database) && !flag("--yes")) {
		throw new Error(
			`Refusing to touch database "${database}" (allowed: ${ALLOWED_DBS.join(", ")}). Pass --yes to proceed.`,
		);
	}
}

async function main() {
	// Before any query, so a wrong DATABASE_URL is refused rather than read.
	confirmTarget(opt("--org") ?? "(auto: the org with the most clients)");
	// organization has no created_at, so "the seed's org" is the one holding the most
	// clients (the base seed also makes small secondary orgs).
	const orgId =
		opt("--org") ??
		(
			await db.client.groupBy({
				by: ["organization_id"],
				where: { organization_id: { not: null } },
				_count: { _all: true },
				orderBy: { _count: { organization_id: "desc" } },
				take: 1,
			})
		)[0]?.organization_id ??
		(await db.organization.findFirst({ select: { id: true } }))?.id;
	if (!orgId) throw new Error("No organization found; run the base seed first or pass --org");
	if (!(await db.organization.findUnique({ where: { id: orgId }, select: { id: true } })))
		throw new Error(`Organization ${orgId} not found`);

	console.log(`Org resolved: ${orgId}`);

	if (flag("--purge")) return purge(orgId);

	const existing = await db.client.count({
		where: { organization_id: orgId, name: { startsWith: TAG } },
	});
	if (existing >= N.clients) {
		console.log(`Skip: ${existing} ${TAG} clients already exist in org ${orgId}`);
		return;
	}
	if (existing > 0) {
		throw new Error(`Partial scale data found (${existing} clients). Run with --purge first.`);
	}

	const t0 = Date.now();
	const now = Date.now();
	const org = orgId;
	console.log(`Seeding scale data into org ${org}`);

	// Technicians: top up to 15 active ones; only the ones made here carry the tag.
	const techIds = (
		await db.technician.findMany({
			where: { organization_id: org, deactivated_at: null, deleted_at: null },
			select: { id: true },
		})
	).map((x) => x.id);
	const techRows: Prisma.technicianCreateManyInput[] = [];
	for (let i = techIds.length; i < N.techs; i++) {
		const tid = id();
		techIds.push(tid);
		techRows.push({
			id: tid,
			organization_id: org,
			name: `${TAG} Tech ${pad(i + 1, 2)}`,
			email: `scale-tech-${tid}@scale.invalid`,
			phone: `555-02${pad(i, 2)}`,
			password: "!scale-seed-no-login",
			title: "Technician",
			description: "Scale-seed technician",
			hire_date: new Date(now - int(30, 1500) * DAY),
			status: "Offline",
		});
	}
	await insertAll("technician", techRows, (data) => db.technician.createMany({ data }));

	const dispatcher = await db.dispatcher.findFirst({
		where: { organization_id: org },
		select: { id: true, name: true },
	});

	// Clients + contacts
	const clients: { id: string; name: string; address: string; coords: object; created: number }[] = [];
	const clientRows: Prisma.clientCreateManyInput[] = [];
	const contactRows: Prisma.contactCreateManyInput[] = [];
	const linkRows: Prisma.client_contactCreateManyInput[] = [];
	for (let i = 0; i < N.clients; i++) {
		const cid = id();
		const name = `${TAG} ${pick(FIRST)} ${pick(LAST)} ${pad(i + 1, 5)}`;
		const address = `${int(100, 9999)} ${pick(STREETS)}, Springfield`;
		const coords = { lat: 39.7 + rnd() * 0.3, lon: -89.7 + rnd() * 0.3 };
		const created = now - int(0, 700) * DAY;
		const last = created + Math.floor(rnd() * Math.max(1, now - created));
		clients.push({ id: cid, name, address, coords, created });
		clientRows.push({
			id: cid,
			organization_id: org,
			name,
			address,
			coords,
			is_active: rnd() < 0.9,
			is_tax_exempt: rnd() < 0.05,
			created_at: new Date(created),
			last_activity: new Date(last),
			updated_at: new Date(last),
		});
		const nContacts = rnd() < 0.4 ? 2 : 1;
		for (let c = 0; c < nContacts; c++) {
			const kid = id();
			contactRows.push({
				id: kid,
				organization_id: org,
				name: `${TAG} Contact ${pad(i + 1, 5)}-${c + 1}`,
				email: `scale-c${pad(i + 1, 5)}-${c + 1}@scale.invalid`,
				phone: `555-${pad(i * 2 + c, 7)}`,
				type: "customer",
				is_active: true,
			});
			linkRows.push({ client_id: cid, contact_id: kid, is_primary: c === 0, is_billing: c === 0 });
		}
	}
	await insertAll("client", clientRows, (data) => db.client.createMany({ data }));
	await insertAll("contact", contactRows, (data) => db.contact.createMany({ data }));
	await insertAll("client_contact", linkRows, (data) => db.client_contact.createMany({ data }));

	// Requests
	const requests: { id: string; client: number }[] = [];
	const requestRows: Prisma.requestCreateManyInput[] = [];
	for (let i = 0; i < N.requests; i++) {
		const ci = int(0, N.clients - 1);
		const rid = id();
		const created = now - int(0, 365) * DAY - int(0, DAY / 1000) * 1000;
		const status = weighted(REQUEST_STATUSES);
		requests.push({ id: rid, client: ci });
		requestRows.push({
			id: rid,
			organization_id: org,
			client_id: clients[ci].id,
			title: `${TAG} ${pick(WORK)} request ${pad(i + 1, 5)}`,
			description: "Scale-seed request",
			priority: weighted([["Low", 15], ["Medium", 50], ["High", 20], ["Urgent", 10], ["Emergency", 5]] as const),
			address: clients[ci].address,
			coords: clients[ci].coords,
			status,
			created_at: new Date(created),
			updated_at: new Date(created + int(0, 20) * DAY),
			requires_quote: rnd() < 0.5,
			source: pick(["phone", "email", "web"]),
			created_by_dispatcher_id: dispatcher?.id,
			...(status === "Cancelled" ? { cancelled_at: new Date(created + DAY), cancellation_reason: "Customer withdrew" } : {}),
		});
	}
	await insertAll("request", requestRows, (data) => db.request.createMany({ data }));

	// Quotes. Approved ones may later back a job (quote_id is unique on job).
	const quotes: { id: string; client: number; status: string; subtotal: number; tax: number; total: number }[] = [];
	const quoteRows: Prisma.quoteCreateManyInput[] = [];
	for (let i = 0; i < N.quotes; i++) {
		const ci = int(0, N.clients - 1);
		const qid = id();
		const status = weighted(QUOTE_STATUSES);
		const created = now - int(0, 365) * DAY;
		const subtotal = money(120, 9000);
		const taxRate = 0.0825;
		const tax = Math.round(subtotal * taxRate * 100) / 100;
		const total = Math.round((subtotal + tax) * 100) / 100;
		quotes.push({ id: qid, client: ci, status, subtotal, tax, total });
		quoteRows.push({
			id: qid,
			organization_id: org,
			quote_number: `SCALE-Q-${pad(i + 1)}`,
			client_id: clients[ci].id,
			request_id: i < N.requests && rnd() < 0.5 ? requests[i].id : null,
			title: `${TAG} ${pick(WORK)} quote ${pad(i + 1, 5)}`,
			description: "Scale-seed quote",
			status,
			address: clients[ci].address,
			coords: clients[ci].coords,
			priority: pick(PRIORITIES),
			is_active: status !== "Revised" && status !== "Cancelled",
			subtotal,
			tax_rate: taxRate,
			tax_amount: tax,
			total,
			created_at: new Date(created),
			updated_at: new Date(created + int(0, 10) * DAY),
			issued_at: status === "Draft" ? null : new Date(created + DAY),
			approved_at: status === "Approved" ? new Date(created + 3 * DAY) : null,
			expires_at: new Date(created + int(14, 60) * DAY),
			created_by_dispatcher_id: dispatcher?.id,
		});
	}
	await insertAll("quote", quoteRows, (data) => db.quote.createMany({ data }));

	// Jobs
	const approvedQuotes = quotes.filter((q) => q.status === "Approved");
	const jobs: { id: string; client: number; status: string; created: number }[] = [];
	const jobRows: Prisma.jobCreateManyInput[] = [];
	let nextApproved = 0;
	for (let i = 0; i < N.jobs; i++) {
		const jid = id();
		const status = weighted(JOB_STATUSES);
		const created = now - int(0, 210) * DAY - int(0, 86400) * 1000;
		const quote = nextApproved < approvedQuotes.length && rnd() < 0.4 ? approvedQuotes[nextApproved++] : null;
		const ci = quote ? quote.client : int(0, N.clients - 1);
		const subtotal = quote ? quote.subtotal : money(80, 7000);
		const changed = created + int(0, 14) * DAY;
		jobs.push({ id: jid, client: ci, status, created });
		jobRows.push({
			id: jid,
			organization_id: org,
			job_number: `SCALE-J-${pad(i + 1)}`,
			name: `${TAG} ${pick(WORK)} ${pad(i + 1, 5)}`,
			description: "Scale-seed job",
			priority: weighted([["Low", 15], ["Medium", 50], ["High", 20], ["Urgent", 10], ["Emergency", 5]] as const),
			address: clients[ci].address,
			coords: clients[ci].coords,
			status,
			created_at: new Date(created),
			updated_at: new Date(changed),
			status_changed_at: new Date(changed),
			completed_at: status === "Completed" ? new Date(changed) : null,
			cancelled_at: status === "Cancelled" ? new Date(changed) : null,
			cancellation_reason: status === "Cancelled" ? "Customer cancelled" : null,
			client_id: clients[ci].id,
			request_id: rnd() < 0.15 ? pick(requests).id : null,
			quote_id: quote?.id ?? null,
			subtotal,
			estimated_total: subtotal,
			actual_total: status === "Completed" ? subtotal : null,
		});
	}
	await insertAll("job", jobRows, (data) => db.job.createMany({ data }));

	// Visits over -180..+30 days, 1-2 techs each. Status follows the date so
	// the board shows a believable mix rather than random states.
	const visitRows: Prisma.job_visitCreateManyInput[] = [];
	const visitTechRows: Prisma.job_visit_technicianCreateManyInput[] = [];
	const visits: { id: string; job: number; start: number }[] = [];
	for (let i = 0; i < N.visits; i++) {
		const vid = id();
		const ji = i < N.jobs && rnd() < 0.6 ? i : int(0, N.jobs - 1);
		const day = int(-180, 30);
		const start = now + day * DAY + int(7, 17) * 3_600_000;
		const end = start + int(1, 4) * 3_600_000;
		const jobStatus = jobs[ji].status;
		const status =
			jobStatus === "Cancelled" ? "Cancelled"
			: day < -1 ? weighted([["Completed", 92], ["Cancelled", 8]] as const)
			: day <= 0 ? weighted([["Completed", 30], ["InProgress", 20], ["OnSite", 15], ["Driving", 10], ["Scheduled", 20], ["Paused", 5]] as const)
			: "Scheduled";
		const done = status === "Completed";
		visits.push({ id: vid, job: ji, start });
		visitRows.push({
			id: vid,
			job_id: jobs[ji].id,
			name: `${TAG} visit`,
			arrival_constraint: "anytime",
			finish_constraint: "when_done",
			scheduled_start_at: new Date(start),
			scheduled_end_at: new Date(end),
			actual_start_at: done || status === "InProgress" || status === "OnSite" ? new Date(start + int(0, 20) * 60_000) : null,
			actual_end_at: done ? new Date(end + int(-20, 40) * 60_000) : null,
			status,
			cancellation_reason: status === "Cancelled" ? "Rescheduled" : null,
			subtotal: money(80, 1800),
			created_at: new Date(Math.min(start, now) - int(1, 20) * DAY),
			updated_at: new Date(Math.min(start, now)),
		});
		const lead = pick(techIds);
		const techStatus = done ? "Done" : status === "OnSite" || status === "InProgress" ? "OnSite" : status === "Driving" ? "EnRoute" : "Assigned";
		visitTechRows.push({ visit_id: vid, tech_id: lead, tech_status: techStatus });
		if (rnd() < 0.25) {
			const second = pick(techIds);
			if (second !== lead) visitTechRows.push({ visit_id: vid, tech_id: second, tech_status: techStatus });
		}
	}
	await insertAll("job_visit", visitRows, (data) => db.job_visit.createMany({ data }));
	await insertAll("job_visit_technician", visitTechRows, (data) => db.job_visit_technician.createMany({ data }));

	// Invoices
	const invoiceRows: Prisma.invoiceCreateManyInput[] = [];
	const invoices: { id: string; created: number }[] = [];
	for (let i = 0; i < N.invoices; i++) {
		const iid = id();
		const status = weighted(INVOICE_STATUSES);
		const created = now - int(0, 365) * DAY;
		const subtotal = money(90, 9000);
		const tax = Math.round(subtotal * 0.0825 * 100) / 100;
		const total = Math.round((subtotal + tax) * 100) / 100;
		const paid = status === "Paid" ? total : status === "PartiallyPaid" ? Math.round(total * 0.4 * 100) / 100 : 0;
		const issued = status === "Draft" ? null : new Date(created + DAY);
		invoices.push({ id: iid, created });
		invoiceRows.push({
			id: iid,
			organization_id: org,
			invoice_number: `SCALE-INV-${pad(i + 1)}`,
			client_id: clients[int(0, N.clients - 1)].id,
			status,
			issue_date: issued,
			due_date: issued ? new Date(created + 31 * DAY) : null,
			payment_terms_days: 30,
			issued_at: issued,
			paid_at: status === "Paid" ? new Date(created + int(2, 40) * DAY) : null,
			voided_at: status === "Void" ? new Date(created + 2 * DAY) : null,
			subtotal,
			tax_rate: 0.0825,
			tax_amount: tax,
			total,
			amount_paid: paid,
			balance_due: status === "Void" ? 0 : Math.round((total - paid) * 100) / 100,
			created_at: new Date(created),
			updated_at: new Date(created + int(0, 30) * DAY),
			created_by_dispatcher_id: dispatcher?.id,
		});
	}
	await insertAll("invoice", invoiceRows, (data) => db.invoice.createMany({ data }));

	// Log rows. Parent-entity rows by id; a slice of child *.deleted rows carry the
	// _parent_id breadcrumb that getEntityHistory reads (PARENT_ID_PATH).
	const logRows: Prisma.logCreateManyInput[] = [];
	const actor = { actor_type: "dispatcher", actor_id: dispatcher?.id ?? null, actor_name: dispatcher?.name ?? "Scale Seed" };
	const ENTITY_POOL = [
		["client", clients.map((c) => c.id), 22],
		["job", jobs.map((j) => j.id), 32],
		["quote", quotes.map((q) => q.id), 14],
		["request", requests.map((r) => r.id), 8],
		["invoice", invoices.map((v) => v.id), 14],
		["job_visit", visits.map((v) => v.id), 10],
	] as const;
	const eventsByEntity: Record<string, [string, string][]> = {
		client: [["client.created", "created"], ["client.updated", "updated"], ["client_note.created", "created"]],
		job: [["job.created", "created"], ["job.status_changed", "updated"], ["job.updated", "updated"]],
		quote: [["quote.created", "created"], ["quote.sent", "sent"], ["quote.approved", "updated"]],
		request: [["request.created", "created"], ["request.updated", "updated"]],
		invoice: [["invoice.created", "created"], ["invoice.sent", "sent"], ["invoice.paid", "updated"]],
		job_visit: [["job_visit.created", "created"], ["job_visit.status_changed", "updated"]],
	};
	for (let i = 0; i < N.logs; i++) {
		const [type, ids] = weighted(ENTITY_POOL.map((e) => [e, e[2]] as const));
		const entityId = pick(ids);
		const timestamp = new Date(now - Math.floor(Math.pow(rnd(), 1.5) * 180 * DAY));
		const breadcrumb = type === "job_visit" ? rnd() < 0.3 : false;
		if (breadcrumb) {
			const v = pick(visits);
			logRows.push({
				organization_id: org,
				event_type: "job_visit.deleted",
				action: "deleted",
				entity_type: "job_visit",
				entity_id: id(),
				...actor,
				changes: {
					_parent_type: { old: null, new: "job" },
					_parent_id: { old: null, new: jobs[v.job].id },
				},
				timestamp,
				user_agent: LOG_TAG,
			});
			continue;
		}
		const [event_type, action] = pick(eventsByEntity[type]);
		logRows.push({
			organization_id: org,
			event_type,
			action,
			entity_type: type,
			entity_id: entityId,
			...actor,
			changes: { status: { old: "Draft", new: "Sent" } },
			timestamp,
			user_agent: LOG_TAG,
		});
	}
	await insertAll("log", logRows, (data) => db.log.createMany({ data }));

	console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
