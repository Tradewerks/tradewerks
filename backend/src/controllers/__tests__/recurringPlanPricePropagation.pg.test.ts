import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the unit test mocks the tx, so only this shows the eligibility
// SQL (status, start time, invoice state, org, consumed lines) behaves.
// Scratch DB only, via QUOTA_TEST_DATABASE_URL.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(() => Promise.resolve()),
}));

describe.runIf(DB_URL)("template price propagation against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let update: typeof import("../recurringPlansController.js").updateRecurringPlanLineItems;
	const orgIds: string[] = [];
	const FUTURE = new Date(Date.now() + 7 * 86400000);

	async function seedOrg(label: string) {
		const org = await db.organization.create({ data: { name: `PG propagation ${label}` } });
		orgIds.push(org.id);
		const client = await db.client.create({
			data: { organization_id: org.id, name: label, address: "1 Main", coords: {} },
		});
		const plan = await db.recurring_plan.create({
			data: {
				organization_id: org.id,
				client_id: client.id,
				name: label,
				description: "d",
				address: "1 Main",
				starts_at: new Date("2027-01-01T00:00:00Z"),
			},
		});
		const job = await db.job.create({
			data: {
				organization_id: org.id,
				client_id: client.id,
				recurring_plan_id: plan.id,
				job_number: `PGP-${label}-${Date.now()}`,
				name: label,
				description: "d",
				address: "1 Main",
				coords: {},
			},
		});
		return { orgId: org.id, clientId: client.id, planId: plan.id, jobId: job.id };
	}

	type Seed = Awaited<ReturnType<typeof seedOrg>>;

	async function seedVisit(
		s: Seed,
		opts: { status?: "Scheduled" | "InProgress"; jobId?: string; planId?: string } = {},
	) {
		const visit = await db.job_visit.create({
			data: {
				job_id: opts.jobId ?? s.jobId,
				status: opts.status ?? "Scheduled",
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: FUTURE,
				scheduled_end_at: new Date(FUTURE.getTime() + 3600000),
			},
		});
		await db.recurring_occurrence.create({
			data: {
				recurring_plan_id: opts.planId ?? s.planId,
				job_visit_id: visit.id,
				status: "generated",
				occurrence_start_at: FUTURE,
				occurrence_end_at: FUTURE,
				original_start_at: FUTURE,
			},
		});
		await db.job_visit_line_item.create({
			data: {
				visit_id: visit.id,
				name: "Old",
				quantity: 1,
				unit_price: 10,
				total: 10,
				source: "recurring_plan",
			},
		});
		return visit.id;
	}

	async function invoiceVisit(s: Seed, visitId: string, status: "Draft" | "Void") {
		const inv = await db.invoice.create({
			data: {
				organization_id: s.orgId,
				client_id: s.clientId,
				invoice_number: `INV-${visitId.slice(0, 8)}-${status}`,
				status,
			},
		});
		await db.invoice_visit.create({
			data: { invoice_id: inv.id, visit_id: visitId, billed_amount: 10 },
		});
	}

	const names = async (visitId: string) =>
		(await db.job_visit_line_item.findMany({ where: { visit_id: visitId } })).map((l) => l.name);

	const run = (s: Seed) =>
		update(
			s.jobId,
			{
				line_items: [{ name: "New", quantity: 2, unit_price: 25 }],
				apply_to_scheduled_visits: true,
			},
			s.orgId,
		);

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		({ updateRecurringPlanLineItems: update } = await import("../recurringPlansController.js"));
	});

	afterAll(async () => {
		if (!orgIds.length) return;
		const mine = { organization_id: { in: orgIds } };
		await db.invoice.deleteMany({ where: mine });
		await db.log.deleteMany({ where: mine });
		await db.job.deleteMany({ where: mine });
		await db.recurring_plan.deleteMany({ where: mine });
		await db.client.deleteMany({ where: mine });
		await db.organization.deleteMany({ where: { id: { in: orgIds } } });
	});

	it("reprices a future Scheduled visit", async () => {
		const s = await seedOrg("ok");
		const v = await seedVisit(s);
		const r = await run(s);
		expect(r.err).toBe("");
		expect(r.item).toMatchObject({ updated_visits: 1 });
		expect(await names(v)).toEqual(["New"]);
	});

	it("an InProgress visit is not touched", async () => {
		const s = await seedOrg("inprog");
		const v = await seedVisit(s, { status: "InProgress" });
		const r = await run(s);
		expect(r.item).toMatchObject({ updated_visits: 0 });
		expect(await names(v)).toEqual(["Old"]);
	});

	it("a visit on a Draft invoice is not touched", async () => {
		const s = await seedOrg("draft");
		const v = await seedVisit(s);
		await invoiceVisit(s, v, "Draft");
		await run(s);
		expect(await names(v)).toEqual(["Old"]);
	});

	it("a visit on a Void-only invoice is repriced", async () => {
		const s = await seedOrg("void");
		const v = await seedVisit(s);
		await invoiceVisit(s, v, "Void");
		await run(s);
		expect(await names(v)).toEqual(["New"]);
	});

	it("a foreign-org visit id is not touched", async () => {
		const a = await seedOrg("fa");
		const b = await seedOrg("fb");
		// Plan A's occurrence points at a visit under org B's job.
		const v = await seedVisit(b, { planId: a.planId });
		const r = await run(a);
		expect(r.item).toMatchObject({ updated_visits: 0 });
		expect(await names(v)).toEqual(["Old"]);
	});

	it("a visit with a used plan line is skipped whole", async () => {
		const s = await seedOrg("used");
		const v = await seedVisit(s);
		await db.job_visit_line_item.updateMany({
			where: { visit_id: v },
			data: { fulfillment_status: "used" },
		});
		const r = await run(s);
		expect(r.item).toMatchObject({ updated_visits: 0, skipped_visits: 1 });
		expect(await names(v)).toEqual(["Old"]);
	});
});
