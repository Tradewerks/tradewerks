import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { DAY_MS } from "../../lib/dayRange.js";

// Real Postgres for races the fake DB cannot show. CI sets QUOTA_TEST_DATABASE_URL after
// `prisma migrate deploy`. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
	process.env.PLATFORM_JWT_SECRET = "p".repeat(40);
	process.env.JWT_ACCESS_SECRET = "a".repeat(40);
	process.env.OTP_SECRET = "o".repeat(40);
	process.env.MFA_ENCRYPTION_KEY = "0".repeat(64);
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../services/socketService.js", () => ({
	emitToOrg: vi.fn(),
	getSocket: vi.fn(),
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: vi.fn(async () => []),
	createDispatcherNotification: vi.fn(async () => null),
}));

const LIMITS = {
	dispatchers: 3,
	technicians: 5,
	ai_calls_month: 0,
	tax_lookups_month: 0,
	receipt_scans_month: 0,
};
const actor = { id: "pg-staff", name: "PG" };
const KEYS = ["pg_a", "pg_b"];

describe.runIf(DB_URL)("build plan 3b against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let svc: typeof import("../upgradeRequestService.js");
	let tiers: typeof import("../tiersService.js");
	let ent: typeof import("../../services/entitlementService.js");
	let orgId = "";
	let signupDefault: string | null = null;

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		svc = await import("../upgradeRequestService.js");
		tiers = await import("../tiersService.js");
		ent = await import("../../services/entitlementService.js");
		signupDefault =
			(await db.plan.findFirst({ where: { is_signup_default: true } }))
				?.key ?? null;
		await db.plan.createMany({
			data: [
				{ key: "pg_a", label: "PG A" },
				{ key: "pg_b", label: "PG B" },
			],
		});
		await db.plan_version.createMany({
			data: [
				{
					id: "pg_a_1",
					plan_key: "pg_a",
					version: 1,
					modules: [],
					limits: LIMITS,
				},
				{
					id: "pg_b_1",
					plan_key: "pg_b",
					version: 1,
					modules: ["quickbooks"],
					limits: LIMITS,
				},
			],
		});
		orgId = (await db.organization.create({ data: { name: "pg-3b" } })).id;
		await db.org_entitlement.create({
			data: {
				organization_id: orgId,
				plan_version_id: "pg_a_1",
				plan_source: "operator",
			},
		});
	});

	afterAll(async () => {
		await db.log.deleteMany({
			where: {
				OR: [
					{ organization_id: orgId },
					{ entity_type: "plan", entity_id: { in: KEYS } },
				],
			},
		});
		await db.upgrade_request.deleteMany({
			where: { organization_id: orgId },
		});
		await db.org_entitlement.deleteMany({
			where: { organization_id: orgId },
		});
		await db.organization.deleteMany({ where: { id: orgId } });
		await db.plan.updateMany({
			where: { key: { in: KEYS } },
			data: { is_signup_default: false },
		});
		if (signupDefault)
			await db.plan.update({
				where: { key: signupDefault },
				data: { is_signup_default: true },
			});
		await db.plan_version.deleteMany({ where: { plan_key: { in: KEYS } } });
		await db.plan.deleteMany({ where: { key: { in: KEYS } } });
	});

	it("two simultaneous requests leave exactly one open", async () => {
		const by = { id: "d-pg", name: "PG" };
		const results = await Promise.allSettled([
			svc.fileRequest(orgId, by, { planKey: "pg_b" }),
			svc.fileRequest(orgId, by, { planKey: "pg_b" }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find(
			(r) => r.status === "rejected",
		) as PromiseRejectedResult;
		expect(rejected.reason).toMatchObject({
			statusCode: 409,
			code: "REQUEST_OPEN",
		});
		expect(
			await db.upgrade_request.count({
				where: { organization_id: orgId, status: "open" },
			}),
		).toBe(1);
	});

	it("an approving apply on a closed request rolls the change back", async () => {
		const open = await db.upgrade_request.findFirstOrThrow({
			where: { organization_id: orgId, status: "open" },
		});
		await db.upgrade_request.update({
			where: { id: open.id },
			data: { status: "withdrawn" },
		});
		await expect(
			ent.applyStaffChange(
				orgId,
				{ kind: "plan", planVersionId: "pg_b_1" },
				actor,
				"Approve",
				{ upgradeRequestId: open.id },
			),
		).rejects.toMatchObject({ statusCode: 409 });
		const row = await db.org_entitlement.findUniqueOrThrow({
			where: { organization_id: orgId },
		});
		expect(row.plan_version_id).toBe("pg_a_1");
	});

	it("two simultaneous default changes leave exactly one signup default", async () => {
		await Promise.allSettled([
			tiers.patchTier(actor, "pg_a", { signupDefault: true }, "Race"),
			tiers.patchTier(actor, "pg_b", { signupDefault: true }, "Race"),
		]);
		expect(
			await db.plan.count({ where: { is_signup_default: true } }),
		).toBe(1);
	});

	it("two simultaneous new versions get consecutive numbers", async () => {
		const made = await Promise.all([
			tiers.createVersion(actor, "pg_a", {
				modules: ["quickbooks"],
				limits: LIMITS,
				note: "Race one",
			}),
			tiers.createVersion(actor, "pg_a", {
				modules: ["ai_assistant"],
				limits: LIMITS,
				note: "Race two",
			}),
		]);
		expect(made.map((v) => v.version).sort()).toEqual([2, 3]);
	});
});

describe.runIf(DB_URL)("org admin invite against Postgres", () => {
	it("two parallel accepts of one token apply once", async () => {
		const { db } = await import("../../db.js");
		const inv = await import("../../services/orgAdminInvite.js");
		const org = await db.organization.create({
			data: { name: "PG invite org", email: "pg-inv@t.test" },
		});
		const { token, hash, expires } = inv.newOrgInvite();
		await db.dispatcher.create({
			data: {
				organization_id: org.id,
				name: "PG",
				email: `pg-inv-${Date.now()}@t.test`,
				password: "x",
				title: "Administrator",
				description: "",
				role: "admin",
				invite_token_hash: hash,
				invite_expires_at: expires,
			},
		});
		const results = await Promise.allSettled([
			inv.acceptOrgInvite(token, "Sup3r$ecret1"),
			inv.acceptOrgInvite(token, "Sup3r$ecret2"),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		await db.dispatcher.deleteMany({ where: { organization_id: org.id } });
		await db.organization.delete({ where: { id: org.id } });
	});
});

describe.runIf(DB_URL)("trial warning claim against Postgres", () => {
	it("two parallel runs warn an org once", async () => {
		const { db } = await import("../../db.js");
		const sched = await import("../../services/trialScheduler.js");
		const { notifyDispatchers } = await import("../../controllers/notificationsController.js");
		const org = await db.organization.create({
			data: { name: "PG trial org", email: "pg-trial@t.test" },
		});
		const legacy = await db.plan_version.findFirstOrThrow({ where: { plan_key: "legacy" } });
		await db.org_entitlement.create({
			data: {
				organization_id: org.id,
				plan_version_id: legacy.id,
				plan_source: "operator",
				trial_plan_version_id: legacy.id,
				trial_ends_at: new Date(Date.now() + 2 * DAY_MS),
			},
		});
		(notifyDispatchers as any).mockClear();
		await Promise.all([sched.runTrialWarnings(), sched.runTrialWarnings()]);
		const forOrg = (notifyDispatchers as any).mock.calls.filter(
			(c: unknown[]) => c[1] === org.id,
		);
		expect(forOrg).toHaveLength(1);
		await db.org_entitlement.delete({ where: { organization_id: org.id } });
		await db.organization.delete({ where: { id: org.id } });
	});
});
