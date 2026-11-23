import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { leaves } from "../../routes/__tests__/harness.js";

const h = vi.hoisted(() => ({
	logActivity: vi.fn(async () => {}),
	notifyDispatchers: vi.fn(async () => {}),
}));

vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
	generateQuoteNumber: vi.fn(),
}));
vi.mock("../logger.js", () => ({
	logActivity: h.logActivity,
	buildChanges: vi.fn(() => ({})),
}));
vi.mock("../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: h.notifyDispatchers,
}));
vi.mock("../wasabiService.js", () => ({
	signImageUrl: vi.fn(async (u: string | null | undefined, ttl?: number) =>
		u ? `${u}?X-Amz-Expires=${ttl}&X-Amz-Signature=sig` : null,
	),
}));
vi.mock("../../lib/pdf/pdfService.js", () => ({
	generateQuotePdf: vi.fn(),
	generateInvoicePdf: vi.fn(),
}));

import { db } from "../../db.js";
import { respondToQuote } from "../../controllers/quotesController.js";
import { buildPublicView } from "../publicViews.js";
import { signImageUrl } from "../wasabiService.js";
import { log } from "../appLogger.js";
import type { ResolvedLink } from "../../lib/publicLink.js";

type Row = Record<string, any>;
const quotes: Record<string, Row> = {};
const fdb = db as any;

const leafValue = (where: unknown, key: string) =>
	leaves(where).find((l) => key in l)?.[key];

const requests: Record<string, Row> = {};

// Evaluates the where tree a scoped query carries (AND/OR, in/notIn/gt, null,
// the `request` relation), so a test fails if the org scope, the status guard,
// the expiry guard or the request guard goes missing from the real query.
function matches(row: Row, where: unknown): boolean {
	if (!where || typeof where !== "object") return true;
	return Object.entries(where as Row).every(([k, v]) => {
		if (k === "AND") return (v as unknown[]).every((w) => matches(row, w));
		if (k === "OR") return (v as unknown[]).some((w) => matches(row, w));
		const val = k === "request" ? requests[row.request_id] : row[k];
		if (v === null) return val == null;
		if (v instanceof Date) return val?.getTime() === v.getTime();
		if (typeof v === "object") {
			if (k === "request") return val ? matches(val, v) : false;
			const o = v as Row;
			if ("in" in o) return o.in.includes(val);
			if ("notIn" in o) return !o.notIn.includes(val);
			if ("gt" in o) return val != null && val > o.gt;
			throw new Error(`fake db: unsupported filter ${k}`);
		}
		return val === v;
	});
}

const aQuote = (over: Row = {}): Row => ({
	id: "q1",
	organization_id: "org-A",
	quote_number: "Q-1001",
	title: "Furnace replacement",
	description: "internal scope notes",
	status: "Sent",
	subtotal: "1000.00",
	discount_amount: "50.00",
	tax_amount: "76.00",
	total: "1026.00",
	valid_until: new Date("2026-12-31T00:00:00Z"),
	expires_at: null,
	created_by_dispatcher_id: "disp-1",
	tax_snapshot: { resolution: "secret" },
	request_id: "r1",
	notes: [{ content: "INTERNAL: margin is thin" }],
	line_items: [
		{
			id: "li-1",
			name: "Furnace",
			description: "96% AFUE",
			quantity: "1.00",
			unit_price: "1000.00",
			total: "1000.00",
			cost: "600.00",
			tax_group_id: "tg-1",
			inventory_item_id: "inv-1",
		},
	],
	...over,
});

const LINK: ResolvedLink = {
	id: "l1",
	organization_id: "org-A",
	purpose: "quote",
	entity_id: "q1",
	contact_id: "c1",
};

const WHO = { name: "Jane Customer", ip: "203.0.113.9", userAgent: "UA/1" };

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(quotes)) delete quotes[k];
	for (const k of Object.keys(requests)) delete requests[k];
	quotes.q1 = aQuote();
	requests.r1 = { id: "r1", organization_id: "org-A", status: "Quoted" };
	fdb.quote.findFirst.mockImplementation(async ({ where }: Row) => {
		const row = quotes[leafValue(where, "id") as string];
		return row && matches(row, where)
			? { ...row, request: requests[row.request_id] ?? null }
			: null;
	});
	fdb.quote.updateMany.mockImplementation(async ({ where, data }: Row) => {
		const row = quotes[leafValue(where, "id") as string];
		if (!row || !matches(row, where)) return { count: 0 };
		Object.assign(row, data);
		return { count: 1 };
	});
	fdb.request.updateMany.mockImplementation(async ({ where, data }: Row) => {
		const row = requests[leafValue(where, "id") as string];
		if (!row || !matches(row, where)) return { count: 0 };
		Object.assign(row, data);
		return { count: 1 };
	});
	fdb.organization.findUnique.mockResolvedValue({
		timezone: "America/Chicago",
	});
	fdb.job_note_photo.findMany.mockResolvedValue([]);
});

describe("quote view", () => {
	it("a quote link returns no id, cost, margin, internal note or dispatcher fields", async () => {
		const view = (await buildPublicView(LINK)) as Row;
		expect(Object.keys(view).sort()).toEqual([
			"approved_at",
			"approved_by_name",
			"can_respond",
			"discount_amount",
			"line_items",
			"number",
			"status",
			"subtotal",
			"superseded",
			"tax_amount",
			"title",
			"total",
			"valid_until",
		]);
		expect(Object.keys(view.line_items[0]).sort()).toEqual([
			"description",
			"name",
			"quantity",
			"total",
			"unit_price",
		]);
		const json = JSON.stringify(view);
		for (const leak of [
			"q1",
			"li-1",
			"org-A",
			"disp-1",
			"600",
			"INTERNAL",
			"secret",
			"internal scope notes",
			"inv-1",
			"tg-1",
		])
			expect(json).not.toContain(leak);
		expect(view).toMatchObject({
			number: "Q-1001",
			subtotal: 1000,
			discount_amount: 50,
			total: 1026,
			valid_until: "2026-12-31T00:00:00.000Z",
			can_respond: true,
			superseded: false,
		});
	});

	it("an approved quote shows the customer's typed name and date, never a staff approver's name", async () => {
		const at = new Date("2026-11-17T15:00:00Z");
		quotes.q1 = aQuote({
			status: "Approved",
			approved_at: at,
			approved_by_name: "Jane Customer",
			approved_via: "customer_link",
		});
		expect(await buildPublicView(LINK)).toMatchObject({
			approved_by_name: "Jane Customer",
			approved_at: "2026-11-17T15:00:00.000Z",
		});
		quotes.q1 = aQuote({
			status: "Approved",
			approved_at: at,
			approved_by_name: "Dana Dispatcher",
			approved_via: "staff",
		});
		const staff = (await buildPublicView(LINK)) as Row;
		expect(staff.approved_by_name).toBeNull();
		expect(JSON.stringify(staff)).not.toContain("Dana");
	});

	it("resolving a Sent quote marks it Viewed once", async () => {
		const opened = { ...WHO, markViewed: true };
		const first = (await buildPublicView(LINK, opened)) as Row;
		expect(first.status).toBe("Viewed");
		expect(quotes.q1.viewed_at).toBeInstanceOf(Date);
		const stamped = quotes.q1.viewed_at;
		await buildPublicView(LINK, opened);
		expect(quotes.q1.viewed_at).toBe(stamped);
		const viewedLogs = (h.logActivity.mock.calls as any[]).filter(
			([p]: any[]) => p.changes?.status?.new === "Viewed",
		);
		expect(viewedLogs).toHaveLength(1);
		expect(viewedLogs[0][0]).toMatchObject({
			actor_type: "customer",
			ip_address: "203.0.113.9",
			user_agent: "UA/1",
		});
	});
});

describe("viewed stamping and drafts", () => {
	it("opening a link does not mark the quote Viewed unless the page asks", async () => {
		const view = (await buildPublicView(LINK, WHO)) as Row;
		expect(view.status).toBe("Sent");
		expect(quotes.q1.viewed_at).toBeUndefined();
		expect(h.logActivity).not.toHaveBeenCalled();
	});

	it("a draft quote or invoice resolves nothing even when a link exists", async () => {
		quotes.q1 = aQuote({ status: "Draft" });
		expect(
			await buildPublicView(LINK, { ...WHO, markViewed: true }),
		).toBeNull();
		fdb.invoice.findFirst.mockResolvedValue({
			invoice_number: "INV-1",
			status: "Draft",
			total: 1,
			amount_paid: 0,
			balance_due: 1,
			issue_date: null,
			due_date: null,
			line_items: [],
		});
		fdb.invoice.updateMany.mockResolvedValue({ count: 0 });
		expect(
			await buildPublicView({ ...LINK, purpose: "invoice" }),
		).toBeNull();
	});
});

describe("respondToQuote", () => {
	it("approve stores the typed name, ip and user agent and notifies dispatchers with quote_accepted", async () => {
		const r = await respondToQuote("org-A", "q1", {
			action: "approve",
			name: "  Jane Customer ",
			ip: WHO.ip,
			userAgent: WHO.userAgent,
			linkId: "l1",
			contactId: "c1",
		});
		expect(r).toEqual({ status: "Approved" });
		expect(quotes.q1).toMatchObject({
			status: "Approved",
			approved_by_name: "Jane Customer",
			approved_via: "customer_link",
		});
		expect(quotes.q1.approved_at).toBeInstanceOf(Date);
		expect(h.logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				entity_type: "quote",
				entity_id: "q1",
				actor_type: "customer",
				actor_name: "Jane Customer",
				ip_address: "203.0.113.9",
				user_agent: "UA/1",
				changes: expect.objectContaining({
					approved_total: { old: null, new: 1026 },
					_public_link_id: { old: null, new: "l1" },
					_contact_id: { old: null, new: "c1" },
				}),
			}),
		);
		expect(requests.r1.status).toBe("QuoteApproved");
		expect(h.notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(h.notifyDispatchers.mock.calls[0][0]).toMatchObject({
			type: "quote_accepted",
		});
		expect(h.notifyDispatchers.mock.calls[0][1]).toBe("org-A");
	});

	it("approve on a Revised quote returns superseded: true, can_respond: false and changes nothing", async () => {
		quotes.q1 = aQuote({ status: "Revised" });
		const before = { ...quotes.q1 };
		const r = await respondToQuote("org-A", "q1", {
			action: "approve",
			name: WHO.name,
		});
		expect(r).toEqual({ status: "Revised" });
		expect(quotes.q1).toEqual(before);
		const view = (await buildPublicView(LINK)) as Row;
		expect(view).toMatchObject({ superseded: true, can_respond: false });
		expect(fdb.request.updateMany).not.toHaveBeenCalled();
		expect(h.notifyDispatchers).not.toHaveBeenCalled();
		expect(h.logActivity).not.toHaveBeenCalled();
	});

	it("approve on an Expired, Cancelled, Rejected or already Approved quote changes nothing", async () => {
		for (const status of ["Expired", "Cancelled", "Rejected", "Approved"]) {
			quotes.q1 = aQuote({ status, approved_by_name: null });
			const before = { ...quotes.q1 };
			const r = await respondToQuote("org-A", "q1", {
				action: "approve",
				name: WHO.name,
			});
			expect(r).toEqual({ status });
			expect(quotes.q1).toEqual(before);
			const view = (await buildPublicView(LINK)) as Row;
			expect(view.can_respond).toBe(false);
		}
		// A quote past its expiry date that the sweep hasn't flipped yet.
		quotes.q1 = aQuote({ expires_at: new Date(Date.now() - 1000) });
		const view = (await buildPublicView(LINK)) as Row;
		expect(view.can_respond).toBe(false);
		expect(fdb.request.updateMany).not.toHaveBeenCalled();
		expect(h.notifyDispatchers).not.toHaveBeenCalled();
	});

	it("approve on a Sent sibling of a converted or cancelled request leaves the request unchanged", async () => {
		for (const status of ["ConvertedToJob", "Cancelled"]) {
			vi.clearAllMocks();
			quotes.q1 = aQuote();
			requests.r1.status = status;
			const r = await respondToQuote("org-A", "q1", {
				action: "approve",
				name: WHO.name,
			});
			expect(r).toEqual({ status: "Sent" });
			expect(quotes.q1.status).toBe("Sent");
			expect(requests.r1.status).toBe(status);
			const view = (await buildPublicView(LINK)) as Row;
			expect(view.can_respond).toBe(false);
			expect(h.notifyDispatchers).not.toHaveBeenCalled();
			expect(h.logActivity).not.toHaveBeenCalled();
		}
	});

	it("a request still New or Reviewing, or already QuoteRejected, moves with the decision", async () => {
		for (const [from, action, to] of [
			["New", "approve", "QuoteApproved"],
			["Reviewing", "decline", "QuoteRejected"],
			["QuoteRejected", "approve", "QuoteApproved"],
			["QuoteApproved", "decline", "QuoteRejected"],
		] as const) {
			quotes.q1 = aQuote();
			requests.r1.status = from;
			await respondToQuote("org-A", "q1", { action, name: WHO.name });
			expect(requests.r1.status).toBe(to);
		}
	});

	it("approve after the quote's expires_at changes nothing", async () => {
		quotes.q1 = aQuote({ expires_at: new Date(Date.now() - 1000) });
		const r = await respondToQuote("org-A", "q1", {
			action: "approve",
			name: WHO.name,
		});
		expect(r).toEqual({ status: "Sent" });
		expect(quotes.q1.approved_by_name).toBeUndefined();
		expect(requests.r1.status).toBe("Quoted");
		expect(h.notifyDispatchers).not.toHaveBeenCalled();
		// A future expiry still allows it.
		quotes.q1 = aQuote({ expires_at: new Date(Date.now() + 60_000) });
		expect(
			await respondToQuote("org-A", "q1", {
				action: "approve",
				name: WHO.name,
			}),
		).toEqual({ status: "Approved" });
	});

	it('decline without a reason is accepted and stores "Declined online"', async () => {
		const r = await respondToQuote("org-A", "q1", {
			action: "decline",
			name: WHO.name,
		});
		expect(r).toEqual({ status: "Rejected" });
		expect(quotes.q1.rejection_reason).toBe("Declined online");
		expect(quotes.q1.rejected_at).toBeInstanceOf(Date);
		expect(quotes.q1.approved_by_name).toBeUndefined();
		expect(requests.r1.status).toBe("QuoteRejected");
		expect(h.notifyDispatchers.mock.calls[0][0]).toMatchObject({
			type: "quote_declined",
		});
	});
});

describe("visit view", () => {
	const NOW = new Date("2026-11-18T14:30:00Z");
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	const visit = (status: string) => ({
		id: "v1",
		status,
		scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
		scheduled_end_at: new Date("2026-11-18T16:00:00Z"),
		arrival_constraint: "between",
		arrival_time: null,
		arrival_window_start: "08:00",
		arrival_window_end: "10:00",
		job: { name: "Tune-up", address: "1 Main St" },
		visit_techs: [
			{
				tech_id: "t1",
				tech_status: "EnRoute",
				tech: { name: "Ann Lee", title: "Lead" },
			},
		],
		arrivals: [
			{
				tech_id: "t1",
				basis: "traffic",
				eta_at: new Date("2026-11-18T15:05:00Z"),
				computed_at: new Date("2026-11-18T14:25:00Z"),
				lat: 41.1,
				lng: -87.2,
			},
		],
		drives: [],
	});
	const VISIT_LINK: ResolvedLink = {
		...LINK,
		purpose: "visit",
		entity_id: "v1",
	};

	it("a visit link returns eta while Driving and null after arrive", async () => {
		fdb.job_visit.findFirst.mockResolvedValue(visit("Driving"));
		const driving = (await buildPublicView(VISIT_LINK)) as Row;
		expect(driving).toEqual({
			date: "Wednesday, November 18",
			window: "between 8:00 AM and 10:00 AM",
			address: "1 Main St",
			status_label: "On the way",
			phase: "driving",
			tech_first_names: ["Ann"],
			eta: "9:05 AM",
			tech_photo_url: null,
			summary: null,
			photos: [],
		});
		expect(JSON.stringify(driving)).not.toMatch(/41\.1|87\.2/);
		expect(fdb.job_visit.findFirst).toHaveBeenCalledTimes(1);

		fdb.job_visit.findFirst.mockResolvedValue(visit("OnSite"));
		const arrived = (await buildPublicView(VISIT_LINK)) as Row;
		expect(arrived.eta).toBeNull();
		expect(arrived.status_label).toBe("Arrived");
		expect(arrived.phase).toBe("arrived");

		fdb.job_visit.findFirst.mockResolvedValue(visit("Completed"));
		expect(((await buildPublicView(VISIT_LINK)) as Row).phase).toBe("done");
		fdb.job_visit.findFirst.mockResolvedValue(visit("Scheduled"));
		expect(((await buildPublicView(VISIT_LINK)) as Row).phase).toBe(
			"scheduled",
		);
		fdb.job_visit.findFirst.mockResolvedValue(visit("Delayed"));
		expect(((await buildPublicView(VISIT_LINK)) as Row).phase).toBe(
			"other",
		);
	});
});

describe("visit photos", () => {
	const RAW = "https://s3.us-east-1.wasabisys.com/bucket/job-notes-photos/";
	// Evaluates the scoped where (AND + nested relation filters) so a test fails
	// if the share flag, the visit filter or the org scope goes missing.
	const hit = (row: Row, where: unknown): boolean =>
		Object.entries((where ?? {}) as Row).every(([k, v]) => {
			if (k === "AND") return (v as unknown[]).every((w) => hit(row, w));
			if (v && typeof v === "object" && !(v instanceof Date))
				return row[k] ? hit(row[k], v) : false;
			return row[k] === v;
		});
	const photo = (name: string, visitId: string, shared: boolean): Row => ({
		id: `p-${name}`,
		photo_url: `${RAW}${name}.jpg`,
		photo_label: "After",
		photo_name: name,
		share_with_customer: shared,
		note: {
			id: "n1",
			visit_id: visitId,
			job_id: "j1",
			organization_id: "org-A",
		},
	});
	let rows: Row[] = [];

	beforeEach(() => {
		rows = [];
		fdb.job_note_photo.findMany.mockImplementation(async (args: Row) =>
			rows
				.filter((r) => hit(r, args.where))
				.map((r) => ({
					photo_url: r.photo_url,
					photo_label: r.photo_label,
					photo_name: r.photo_name,
				})),
		);
		fdb.job_visit.findFirst.mockResolvedValue({
			id: "v1",
			status: "Completed",
			name: "Furnace tune-up",
			description: "Replaced filter",
			scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
			scheduled_end_at: new Date("2026-11-18T16:00:00Z"),
			arrival_constraint: "anytime",
			arrival_time: null,
			arrival_window_start: null,
			arrival_window_end: null,
			job: { name: "Tune-up", address: "1 Main St" },
			visit_techs: [
				{
					tech_id: "t1",
					tech_status: "Completed",
					tech: {
						name: "Ann Lee",
						title: "Lead",
						photo_url: `${RAW}../technicians/ann.jpg`,
					},
				},
			],
			arrivals: [],
			drives: [],
		});
	});
	const VISIT_LINK: ResolvedLink = {
		...LINK,
		purpose: "visit",
		entity_id: "v1",
	};

	it("unshared photos are never in the public payload", async () => {
		rows = [photo("shared", "v1", true), photo("private", "v1", false)];
		const view = (await buildPublicView(VISIT_LINK)) as Row;
		expect(view.photos.map((p: Row) => p.name)).toEqual(["shared"]);
		expect(JSON.stringify(view)).not.toContain("private");
		expect(view.summary).toEqual({
			name: "Furnace tune-up",
			description: "Replaced filter",
		});
	});

	it("a photo on a note of another visit of the same job is not included", async () => {
		rows = [photo("mine", "v1", true), photo("sibling", "v2", true)];
		const view = (await buildPublicView(VISIT_LINK)) as Row;
		expect(view.photos.map((p: Row) => p.name)).toEqual(["mine"]);
	});

	it("a photo that fails to sign is dropped with a log line; the page still builds", async () => {
		rows = [photo("bad", "v1", true), photo("good", "v1", true)];
		vi.mocked(signImageUrl).mockRejectedValueOnce(new Error("sign failed"));
		const view = (await buildPublicView(VISIT_LINK)) as Row;
		expect(view.photos.map((p: Row) => p.name)).toEqual(["good"]);
		expect(log.warn).toHaveBeenCalled();
		expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(
			"wasabisys",
		);
	});

	it("a signing failure logs the error name and a redacted message, never the raw error", async () => {
		rows = [photo("bad", "v1", true)];
		const err = Object.assign(
			new Error(
				"Access denied for https://s3.wasabisys.com/bucket/a.jpg?X-Amz-Credential=AKIAABCDEFGHIJKLMNOP key=AKIAABCDEFGHIJKLMNOP",
			),
			{ name: "AccessDenied", $metadata: { secret: "s3cr3t" } },
		);
		vi.mocked(signImageUrl).mockRejectedValueOnce(err);
		await buildPublicView(VISIT_LINK);
		const [fields] = vi.mocked(log.warn).mock.calls.at(-1)!;
		expect(fields).not.toHaveProperty("err");
		expect(fields).toMatchObject({ errName: "AccessDenied" });
		const logged = JSON.stringify(vi.mocked(log.warn).mock.calls);
		expect(logged).toContain("Access denied for");
		expect(logged).not.toContain("wasabisys");
		expect(logged).not.toContain("AKIAABCDEFGHIJKLMNOP");
		expect(logged).not.toContain("s3cr3t");
	});

	it("a tech photo that fails to sign is left out", async () => {
		vi.mocked(signImageUrl).mockImplementation(async (u) => {
			if (u?.includes("technicians")) throw new Error("sign failed");
			return u ? `${u}?sig` : null;
		});
		try {
			const view = (await buildPublicView(VISIT_LINK)) as Row;
			expect(view.tech_photo_url).toBeNull();
		} finally {
			vi.mocked(signImageUrl).mockImplementation(
				async (u: string | null | undefined, ttl?: number) =>
					u ? `${u}?X-Amz-Expires=${ttl}&X-Amz-Signature=sig` : null,
			);
		}
	});

	it("photo URLs in the payload are signed and not the raw bucket URL", async () => {
		rows = [photo("coil", "v1", true)];
		const view = (await buildPublicView(VISIT_LINK)) as Row;
		expect(view.photos).toEqual([
			{
				url: `${RAW}coil.jpg?X-Amz-Expires=3600&X-Amz-Signature=sig`,
				label: "After",
				name: "coil",
			},
		]);
		expect(view.tech_photo_url).toBe(
			`${RAW}../technicians/ann.jpg?X-Amz-Expires=3600&X-Amz-Signature=sig`,
		);
		// No unsigned copy of either URL, and no photo or note ids.
		const json = JSON.stringify(view);
		expect(json.split(`${RAW}coil.jpg`).length - 1).toBe(1);
		expect(json).not.toMatch(/"(id|note_id|photo_url)"/);
		expect(json).not.toContain("p-coil");
	});
});

describe("visit payload coordinates", () => {
	it("the visit payload never contains coordinates", async () => {
		const keys = (v: unknown): string[] =>
			v && typeof v === "object"
				? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)])
				: [];
		fdb.job_visit.findFirst.mockResolvedValue({
			id: "v1",
			status: "Driving",
			scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
			scheduled_end_at: new Date("2026-11-18T16:00:00Z"),
			arrival_constraint: "between",
			arrival_time: null,
			arrival_window_start: "08:00",
			arrival_window_end: "10:00",
			job: { name: "Tune-up", address: "1 Main St", lat: 1, lng: 2 },
			visit_techs: [
				{
					tech_id: "t1",
					tech_status: "EnRoute",
					tech: { name: "Ann Lee", title: "Lead", lat: 1, lon: 2 },
				},
			],
			arrivals: [
				{
					tech_id: "t1",
					basis: "traffic",
					eta_at: new Date(Date.now() + 3_600_000),
					computed_at: new Date(),
					lat: 41.1,
					lng: -87.2,
					latitude: 41.1,
					longitude: -87.2,
				},
			],
			drives: [],
		});
		const view = await buildPublicView({
			...LINK,
			purpose: "visit",
			entity_id: "v1",
		});
		expect(view).not.toBeNull();
		expect(
			keys(view).filter((k) =>
				/^(lat|lng|lon|latitude|longitude)$/i.test(k),
			),
		).toEqual([]);
		expect(JSON.stringify(view)).not.toMatch(/41\.1|87\.2/);
	});
});

describe("org isolation", () => {
	it("a link for org A never resolves data from org B even if entity_id is edited in the DB to another org's quote", async () => {
		quotes.qB = aQuote({ id: "qB", organization_id: "org-B" });
		const edited = { ...LINK, entity_id: "qB" };
		expect(await buildPublicView(edited, WHO)).toBeNull();
		expect(
			await respondToQuote("org-A", "qB", {
				action: "approve",
				name: WHO.name,
			}),
		).toBeNull();
		expect(quotes.qB.status).toBe("Sent");
		expect(quotes.qB.viewed_at).toBeUndefined();
		expect(h.notifyDispatchers).not.toHaveBeenCalled();
	});
});
