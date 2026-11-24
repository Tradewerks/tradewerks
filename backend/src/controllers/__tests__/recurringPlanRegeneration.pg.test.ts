import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: duplicate slots, legacy repair and lock order only show up
// against the real unique key and real row locks. Scratch DB only, via
// QUOTA_TEST_DATABASE_URL.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
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
// The post-save top-up runs detached; these tests drive generation directly.
vi.mock("../../services/recurringPlanScheduler.js", () => ({
	topUpPlan: vi.fn(async () => ({ generated: 0, visitsCreated: 0 })),
}));

const TZ = "America/Chicago";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(DB_URL)("recurring plan regeneration against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let ctl: typeof import("../recurringPlansController.js");
	let zt: typeof import("../../lib/recurrence/zonedTime.js");
	let createInvoiceRecord: typeof import("../../services/invoiceService.js").createInvoiceRecord;
	const orgIds: string[] = [];
	// First slot three local days out, so every slot is in the future.
	let A: string;

	const at = (date: string, hhmm: string) => zt.zonedWallTimeToUtc(date, hhmm, TZ);

	async function seed(
		label: string,
		rule: {
			arrival_time?: string;
			finish_constraint?: "when_done" | "at";
			finish_time?: string;
		} = {},
	) {
		const org = await db.organization.create({ data: { name: `PG regen ${label}` } });
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
				starts_at: at(A, "12:00"),
				timezone: TZ,
				generation_window_days: 30,
				min_advance_days: 1,
				rules: {
					create: {
						frequency: "daily",
						interval: 7,
						arrival_constraint: "at",
						arrival_time: rule.arrival_time ?? "09:00",
						finish_constraint: rule.finish_constraint ?? "when_done",
						finish_time: rule.finish_time ?? null,
					},
				},
			},
		});
		const job = await db.job.create({
			data: {
				organization_id: org.id,
				client_id: client.id,
				recurring_plan_id: plan.id,
				job_number: `PGR-${label}-${Date.now()}`,
				name: label,
				description: "d",
				address: "1 Main",
				coords: {},
			},
		});
		return { orgId: org.id, clientId: client.id, planId: plan.id, jobId: job.id };
	}
	type Seed = Awaited<ReturnType<typeof seed>>;

	async function attachVisit(s: Seed, occurrenceId: string) {
		const o = await db.recurring_occurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
		const visit = await db.job_visit.create({
			data: {
				job_id: s.jobId,
				status: "Scheduled",
				arrival_constraint: "at",
				finish_constraint: "when_done",
				scheduled_start_at: o.occurrence_start_at,
				scheduled_end_at: o.occurrence_end_at,
			},
		});
		await db.recurring_occurrence.update({
			where: { id: occurrenceId },
			data: { status: "generated", job_visit_id: visit.id },
		});
		return visit.id;
	}

	const rows = (planId: string) =>
		db.recurring_occurrence.findMany({
			where: { recurring_plan_id: planId },
			orderBy: { occurrence_start_at: "asc" },
		});

	const onDate = async (planId: string, date: string) =>
		(await rows(planId)).filter((r) => zt.toLocalDate(r.occurrence_start_at, TZ) === date);

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		ctl = await import("../recurringPlansController.js");
		zt = await import("../../lib/recurrence/zonedTime.js");
		({ createInvoiceRecord } = await import("../../services/invoiceService.js"));
		A = zt.addLocalDays(zt.toLocalDate(new Date(), TZ), 3);
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

	it("future-scope reschedule then regenerate creates no new occurrences", async () => {
		const s = await seed("future");
		const first = await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		expect(first.err).toBe("");
		const before = await rows(s.planId);
		expect(before.length).toBeGreaterThan(1);

		const moved = await ctl.rescheduleOccurrence(
			before[0].id,
			{ new_start_at: at(A, "13:00").toISOString(), scope: "future" },
			s.orgId,
		);
		expect(moved.err).toBe("");

		const again = await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		expect(again.item?.generated).toBe(0);
		expect(await rows(s.planId)).toHaveLength(before.length);
	});

	it("future-scope reschedule reports later visits it kept at their time", async () => {
		const s = await seed("kept");
		await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		const all = await rows(s.planId);
		await attachVisit(s, all[2].id);

		const moved = await ctl.rescheduleOccurrence(
			all[0].id,
			{ new_start_at: at(A, "13:00").toISOString(), scope: "future" },
			s.orgId,
		);
		expect(moved.err).toBe("");
		expect(moved.item).toMatchObject({ kept_visits: 1 });
	});

	it("rule-time edit with a generated row does not duplicate that date", async () => {
		const s = await seed("ruleedit");
		await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		const all = await rows(s.planId);
		await attachVisit(s, all[1].id);
		const keptDate = zt.toLocalDate(all[1].occurrence_start_at, TZ);

		const r = await ctl.updateRecurringPlan(
			s.jobId,
			{
				rule: {
					frequency: "daily",
					interval: 7,
					arrival_constraint: "at",
					arrival_time: "14:00",
					finish_constraint: "when_done",
				},
			},
			s.orgId,
		);
		expect(r.err).toBe("");
		expect(await onDate(s.planId, keptDate)).toHaveLength(1);
		expect(await rows(s.planId)).toHaveLength(all.length);
	});

	async function seedLegacy(s: Seed, status: "planned" | "generated") {
		// A row moved a day past its slot before slots existed; M1 copied the
		// moved start into original_start_at.
		const start = at(zt.addLocalDays(A, 8), "09:00");
		const row = await db.recurring_occurrence.create({
			data: {
				recurring_plan_id: s.planId,
				status: "planned",
				occurrence_start_at: start,
				occurrence_end_at: new Date(start.getTime() + 7_200_000),
				original_start_at: start,
				slot_verified: false,
			},
		});
		if (status === "generated") await attachVisit(s, row.id);
		return row.id;
	}

	it("manual Generate reconciles legacy rows before generating", async () => {
		const s = await seed("legacy-gen");
		const legacyId = await seedLegacy(s, "planned");

		const r = await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		expect(r.err).toBe("");
		expect(await onDate(s.planId, zt.addLocalDays(A, 7))).toHaveLength(0);
		const legacy = await db.recurring_occurrence.findUniqueOrThrow({ where: { id: legacyId } });
		expect(legacy.slot_verified).toBe(true);
		expect(legacy.original_start_at.toISOString()).toBe(
			at(zt.addLocalDays(A, 7), "09:00").toISOString(),
		);
	});

	it("a rule edit reconciles legacy rows against the old rule first", async () => {
		const s = await seed("legacy-edit");
		const legacyId = await seedLegacy(s, "generated");

		const r = await ctl.updateRecurringPlan(
			s.jobId,
			{
				rule: {
					frequency: "daily",
					interval: 7,
					arrival_constraint: "at",
					arrival_time: "10:00",
					finish_constraint: "when_done",
				},
			},
			s.orgId,
		);
		expect(r.err).toBe("");
		expect(await onDate(s.planId, zt.addLocalDays(A, 7))).toHaveLength(0);
		const legacy = await db.recurring_occurrence.findUniqueOrThrow({ where: { id: legacyId } });
		expect(legacy.original_start_at.toISOString()).toBe(
			at(zt.addLocalDays(A, 7), "09:00").toISOString(),
		);
	});

	it("future-scope reschedule computes from the rule committed under the plan lock", async () => {
		const s = await seed("stale-rule", { finish_constraint: "at", finish_time: "11:00" });
		await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		const [first] = await rows(s.planId);

		let pending!: ReturnType<typeof ctl.rescheduleOccurrence>;
		await db.$transaction(
			async (h) => {
				await h.$queryRaw`SELECT id FROM recurring_plan WHERE id = ${s.planId} FOR NO KEY UPDATE`;
				await h.recurring_rule.updateMany({
					where: { recurring_plan_id: s.planId },
					data: { finish_time: "12:00" },
				});
				pending = ctl.rescheduleOccurrence(
					first.id,
					{ new_start_at: at(A, "13:00").toISOString(), scope: "future" },
					s.orgId,
				);
				await sleep(600);
			},
			{ timeout: 20_000 },
		);
		const r = await pending;
		expect(r.err).toBe("");
		const rule = await db.recurring_rule.findFirstOrThrow({
			where: { recurring_plan_id: s.planId },
		});
		expect(rule.arrival_time).toBe("13:00");
		expect(rule.finish_time).toBe("16:00");
	});

	it("a visit generated behind a reschedule takes the rescheduled time", async () => {
		const s = await seed("stale-occ");
		await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		const [first] = await rows(s.planId);
		const moved = at(A, "15:00");

		let pending!: ReturnType<typeof ctl.generateVisitFromOccurrence>;
		await db.$transaction(
			async (h) => {
				await h.$queryRaw`SELECT id FROM recurring_plan WHERE id = ${s.planId} FOR NO KEY UPDATE`;
				await h.recurring_occurrence.update({
					where: { id: first.id },
					data: {
						occurrence_start_at: moved,
						occurrence_end_at: new Date(moved.getTime() + 7_200_000),
					},
				});
				pending = ctl.generateVisitFromOccurrence(first.id, s.orgId);
				await sleep(600);
			},
			{ timeout: 20_000 },
		);
		const r = await pending;
		expect(r.err).toBe("");
		const visit = await db.job_visit.findUniqueOrThrow({ where: { id: r.item!.visit_id } });
		expect(visit.scheduled_start_at.toISOString()).toBe(moved.toISOString());
	});

	it("switching billing_mode from none back on re-enables the existing schedule", async () => {
		const s = await seed("billing");
		await db.recurring_plan.update({
			where: { id: s.planId },
			data: { billing_mode: "none" },
		});
		const stale = new Date(Date.now() - 40 * 86_400_000);
		await db.invoice_schedule.create({
			data: {
				recurring_plan_id: s.planId,
				frequency: "monthly",
				billing_basis: "plan_line_items",
				day_of_month: 1,
				next_invoice_at: stale,
				is_active: false,
			},
		});

		const r = await ctl.updateRecurringPlan(s.jobId, { billing_mode: "subscription" }, s.orgId);
		expect(r.err).toBe("");
		const sched = await db.invoice_schedule.findUniqueOrThrow({
			where: { recurring_plan_id: s.planId },
		});
		expect(sched.is_active).toBe(true);
		expect(sched.next_invoice_at!.getTime()).toBeGreaterThan(Date.now());
	});

	it("invoice creation waits for a visit lock held by template propagation", async () => {
		const s = await seed("inv-lock");
		await ctl.generateOccurrences(s.jobId, {}, s.orgId);
		const [first] = await rows(s.planId);
		const visitId = await attachVisit(s, first.id);

		let pending!: Promise<number>;
		let released = 0;
		await db.$transaction(
			async (h) => {
				await h.$queryRaw`SELECT id FROM job_visit WHERE id = ${visitId} FOR NO KEY UPDATE`;
				pending = createInvoiceRecord(
					{
						client_id: s.clientId,
						line_items: [{ name: "Visit", quantity: 1, unit_price: 10 }],
						visit_billings: [{ visit_id: visitId, billed_amount: 10 }],
					},
					s.orgId,
					null,
				).then(() => Date.now());
				await sleep(600);
				released = Date.now();
			},
			{ timeout: 20_000 },
		);
		expect(await pending).toBeGreaterThanOrEqual(released);
	});
});
