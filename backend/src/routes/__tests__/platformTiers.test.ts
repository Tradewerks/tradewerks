import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
	process.env.PLATFORM_JWT_SECRET = "p".repeat(40);
	process.env.JWT_ACCESS_SECRET = "a".repeat(40);
	process.env.OTP_SECRET = "o".repeat(40);
	process.env.MFA_ENCRYPTION_KEY = "0".repeat(64);
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../platform/rateLimit.js", () => ({
	platformAuthLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
	upgradeRequestLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: vi.fn(async () => []),
	createDispatcherNotification: vi.fn(async () => null),
}));
vi.mock("../../services/socketService.js", () => ({
	emitToOrg: vi.fn(),
	getSocket: vi.fn(),
}));
vi.mock("../../services/emailService.js", async (orig) => ({
	...(await orig<typeof import("../../services/emailService.js")>()),
	sendStaffInviteEmail: vi.fn(async () => {}),
	sendStaffSecurityNotice: vi.fn(async () => {}),
}));
vi.mock("../../lib/entitlements/quota.js", async (orig) => ({
	...(await orig<typeof import("../../lib/entitlements/quota.js")>()),
	getUsageSummary: vi.fn(async () => ({
		period_start: "2026-10-01",
		meters: {},
	})),
}));

import platformRouter from "../platform/index.js";
import { callRoute } from "./harness.js";
import { db } from "../../db.js";
import { signStaffToken } from "../../platform/staffToken.js";
import { setStaffActive } from "../../platform/verifyStaffToken.js";

const mockDb = db as any;
const staffAuth = (id = "s-1") => {
	setStaffActive(id, true);
	return {
		authorization: `Bearer ${signStaffToken({ id, email: `${id}@t.test`, name: id })}`,
	};
};
const LIMITS = {
	dispatchers: 10,
	technicians: 25,
	ai_calls_month: 500,
	tax_lookups_month: null,
	receipt_scans_month: null,
};
const plan = (over: Record<string, unknown> = {}) => ({
	key: "pro",
	label: "Pro",
	assignable: true,
	archived_at: null,
	is_signup_default: false,
	...over,
});
const call = (
	method: string,
	path: string,
	opts: Record<string, unknown> = {},
) => callRoute(platformRouter, method, path, { headers: staffAuth(), ...opts });

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.log.create.mockResolvedValue({});
	mockDb.$executeRaw.mockResolvedValue(1);
});

describe("tier list", () => {
	it("counts orgs and trial orgs per version", async () => {
		mockDb.plan.findMany.mockResolvedValue([
			{
				...plan(),
				versions: [
					{
						id: "v2",
						version: 2,
						modules: [],
						limits: LIMITS,
						note: "n",
						created_at: new Date(),
					},
				],
			},
		]);
		mockDb.org_entitlement.groupBy
			.mockResolvedValueOnce([
				{ plan_version_id: "v2", _count: { _all: 3 } },
			])
			.mockResolvedValueOnce([
				{ trial_plan_version_id: "v2", _count: { _all: 1 } },
			]);
		const r = await call("get", "/plans");
		expect(r.body.data[0].versions[0]).toMatchObject({
			org_count: 3,
			trial_org_count: 1,
		});
	});
});

describe("create tier", () => {
	it("rejects a bad key", async () => {
		await expect(
			call("post", "/plans", {
				body: {
					key: "Pro Plus",
					label: "Pro Plus",
					modules: [],
					limits: LIMITS,
					note: "New tier",
				},
			}),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("creates the tier, v1 and a history row", async () => {
		mockDb.plan.findUnique.mockResolvedValue(null);
		mockDb.plan.create.mockResolvedValue(
			plan({ key: "plus", label: "Plus" }),
		);
		mockDb.plan_version.create.mockResolvedValue({ id: "v1", version: 1 });
		const r = await call("post", "/plans", {
			body: {
				key: "plus",
				label: "Plus",
				modules: ["quickbooks"],
				limits: LIMITS,
				note: "Mid tier",
			},
		});
		expect(r.status).toBe(201);
		expect(mockDb.plan_version.create.mock.calls[0][0].data).toMatchObject({
			plan_key: "plus",
			version: 1,
			modules: ["quickbooks"],
			created_by_id: "s-1",
		});
		expect(mockDb.log.create.mock.calls[0][0].data).toMatchObject({
			entity_type: "plan",
			entity_id: "plus",
			organization_id: null,
			event_type: "plan.created",
			reason: "Mid tier",
		});
	});

	it("409 on an existing key", async () => {
		mockDb.plan.findUnique.mockResolvedValue(plan({ key: "plus" }));
		await expect(
			call("post", "/plans", {
				body: {
					key: "plus",
					label: "Plus",
					modules: [],
					limits: LIMITS,
					note: "Dup",
				},
			}),
		).rejects.toMatchObject({ statusCode: 409 });
	});
});

describe("new version", () => {
	const latest = {
		id: "v2",
		version: 2,
		modules: ["quickbooks"],
		limits: LIMITS,
	};
	const post = (body: unknown) =>
		call("post", "/plans/:key/versions", { params: { key: "pro" }, body });
	beforeEach(() => {
		mockDb.plan.findUnique.mockResolvedValue({
			...plan(),
			versions: [latest],
		});
	});

	it("refuses contents identical to the latest version", async () => {
		await expect(
			post({ modules: ["quickbooks"], limits: LIMITS, note: "Same" }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("refuses unknown modules, core modules and missing limits", async () => {
		for (const body of [
			{ modules: ["nope"], limits: LIMITS, note: "Bad" },
			{ modules: ["core"], limits: LIMITS, note: "Bad" },
			{ modules: [], limits: { dispatchers: 1 }, note: "Bad" },
		])
			await expect(post(body)).rejects.toMatchObject({ statusCode: 400 });
	});

	it("locks, writes version N+1 and logs it", async () => {
		mockDb.plan_version.create.mockResolvedValue({ id: "v3", version: 3 });
		const r = await post({
			modules: ["quickbooks", "ai_assistant"],
			limits: LIMITS,
			note: "Add AI",
		});
		expect(r.status).toBe(201);
		expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
		expect(mockDb.plan_version.create.mock.calls[0][0].data).toMatchObject({
			plan_key: "pro",
			version: 3,
			modules: ["ai_assistant", "quickbooks"],
			note: "Add AI",
		});
		expect(mockDb.log.create.mock.calls[0][0].data).toMatchObject({
			event_type: "plan.version_created",
			reason: "Add AI",
		});
	});

	it("refuses archived tiers", async () => {
		mockDb.plan.findUnique.mockResolvedValue({
			...plan({ archived_at: new Date() }),
			versions: [latest],
		});
		await expect(
			post({ modules: [], limits: LIMITS, note: "Change" }),
		).rejects.toMatchObject({ statusCode: 400 });
	});
});

describe("patch tier", () => {
	const patch = (body: Record<string, unknown>) =>
		call("patch", "/plans/:key", {
			params: { key: "pro" },
			body: { reason: "Ops change", ...body },
		});

	it("refuses archive while orgs use the tier as base or trial", async () => {
		mockDb.plan.findUnique.mockResolvedValue(plan());
		mockDb.org_entitlement.count.mockResolvedValue(2);
		await expect(patch({ archived: true })).rejects.toMatchObject({
			statusCode: 400,
			message: expect.stringContaining(
				"2 organizations still use this tier",
			),
		});
		expect(mockDb.org_entitlement.count.mock.calls[0][0].where.OR).toEqual([
			{ plan_version: { plan_key: "pro" } },
			{ trial_plan_version: { plan_key: "pro" } },
		]);
	});

	it("uses the singular verb for one org in use", async () => {
		mockDb.plan.findUnique.mockResolvedValue(plan());
		mockDb.org_entitlement.count.mockResolvedValue(1);
		await expect(patch({ archived: true })).rejects.toMatchObject({
			message: expect.stringContaining(
				"1 organization still uses this tier",
			),
		});
	});

	it("refuses archiving a default tier", async () => {
		mockDb.plan.findUnique.mockResolvedValue(
			plan({ is_signup_default: true }),
		);
		await expect(patch({ archived: true })).rejects.toMatchObject({
			statusCode: 400,
		});
	});

	it("archives an unused tier", async () => {
		mockDb.plan.findUnique.mockResolvedValue(plan());
		mockDb.org_entitlement.count.mockResolvedValue(0);
		mockDb.plan.update.mockResolvedValue(plan({ archived_at: new Date() }));
		await patch({ archived: true });
		expect(
			mockDb.plan.update.mock.calls[0][0].data.archived_at,
		).toBeInstanceOf(Date);
		expect(mockDb.log.create.mock.calls[0][0].data.event_type).toBe(
			"plan.updated",
		);
	});

	it("moves the signup default: clears the old holder in the same transaction", async () => {
		mockDb.plan.findUnique.mockResolvedValue(plan());
		mockDb.plan.updateMany.mockResolvedValue({ count: 1 });
		mockDb.plan.update.mockResolvedValue(plan({ is_signup_default: true }));
		await patch({ signupDefault: true });
		expect(mockDb.plan.updateMany.mock.calls[0][0]).toEqual({
			where: { is_signup_default: true },
			data: { is_signup_default: false },
		});
		expect(mockDb.plan.update.mock.calls[0][0].data).toEqual({
			is_signup_default: true,
		});
		expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
	});

	it("refuses clearing a default and refuses non-assignable defaults", async () => {
		mockDb.plan.findUnique.mockResolvedValue(
			plan({ is_signup_default: true }),
		);
		await expect(patch({ signupDefault: false })).rejects.toMatchObject({
			statusCode: 400,
		});
		mockDb.plan.findUnique.mockResolvedValue(plan({ assignable: false }));
		await expect(patch({ signupDefault: true })).rejects.toMatchObject({
			statusCode: 400,
		});
	});

	it("maps a concurrent default race (unique violation) to 409", async () => {
		mockDb.plan.findUnique.mockResolvedValue(plan());
		mockDb.plan.updateMany.mockResolvedValue({ count: 0 });
		mockDb.plan.update.mockRejectedValue(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);
		await expect(patch({ signupDefault: true })).rejects.toMatchObject({
			statusCode: 409,
		});
	});

	it("requires exactly one field besides the reason", async () => {
		await expect(
			patch({ label: "Pro", archived: true }),
		).rejects.toMatchObject({ statusCode: 400 });
	});
});

describe("tier history", () => {
	it("reads plan rows for the key with staff names", async () => {
		mockDb.log.findMany.mockResolvedValue([
			{
				id: "l1",
				timestamp: new Date(),
				event_type: "plan.version_created",
				actor_type: "platform_staff",
				actor_id: "s-1",
				actor_name: "TradeWerks support",
				reason: "Add AI",
				changes: {},
			},
		]);
		mockDb.platform_staff.findMany.mockResolvedValue([
			{ id: "s-1", name: "Ops" },
		]);
		const r = await call("get", "/plans/:key/history", {
			params: { key: "pro" },
		});
		expect(mockDb.log.findMany.mock.calls[0][0].where).toEqual({
			entity_type: "plan",
			entity_id: "pro",
		});
		expect(r.body.data[0]).toMatchObject({ staff_name: "Ops" });
		expect(r.body.data[0].actor_id).toBeUndefined();
	});
});

describe("module catalog", () => {
	it("lists non-core modules with label and kind", async () => {
		const r = await call("get", "/plans/catalog");
		expect(r.body.data.length).toBeGreaterThan(0);
		expect(
			r.body.data.every(
				(m: any) => m.kind !== "core" && m.key && m.label,
			),
		).toBe(true);
	});
});

describe("move orgs", () => {
	const versions = [
		{
			id: "v3",
			version: 3,
			plan_key: "pro",
			modules: ["quickbooks"],
			limits: LIMITS,
		},
		{ id: "v2", version: 2, plan_key: "pro", modules: [], limits: LIMITS },
	];
	const ent = (orgId: string, over: Record<string, unknown> = {}) => ({
		organization_id: orgId,
		plan_version_id: "v2",
		plan_version: versions[1],
		trial_plan_version_id: null,
		trial_plan_version: null,
		trial_ends_at: null,
		module_choices: {},
		module_grants: {},
		limit_overrides: {},
		updated_at: new Date("2026-10-07T00:00:00Z"),
		...over,
	});
	const move = (body: Record<string, unknown>) =>
		call("post", "/plans/:key/move-orgs", {
			params: { key: "pro" },
			body: { reason: "Roll out v3", ...body },
		});
	beforeEach(() => {
		mockDb.plan.findUnique.mockResolvedValue({ ...plan(), versions });
		mockDb.plan_version.findUnique.mockImplementation(
			async ({ where }: any) =>
				where.id === "v3" ? { ...versions[0], plan: plan() } : null,
		);
		mockDb.organization.findMany.mockResolvedValue([
			{ id: "o1", name: "Acme" },
			{ id: "o2", name: "Bolt" },
			{ id: "o3", name: "Core" },
			{ id: "o4", name: "Dune" },
		]);
		mockDb.org_entitlement.updateMany.mockResolvedValue({ count: 1 });
	});

	it("rejects moving from the latest version or another tier's version", async () => {
		for (const from of ["v3", "other"])
			await expect(
				move({ fromVersionId: from, orgIds: ["o1"] }),
			).rejects.toMatchObject({ statusCode: 400 });
	});

	it("moves each org separately and reports skipped causes", async () => {
		mockDb.org_entitlement.findUnique.mockImplementation(
			async ({ where }: any) => {
				if (where.organization_id === "o2")
					return ent("o2", {
						plan_version_id: "v3",
						plan_version: versions[0],
					});
				if (where.organization_id === "o3") return null;
				return ent(where.organization_id);
			},
		);
		mockDb.org_entitlement.updateMany.mockImplementation(
			async ({ where }: any) => ({
				count: where.organization_id === "o4" ? 0 : 1,
			}),
		);
		const r = await move({
			fromVersionId: "v2",
			orgIds: ["o1", "o2", "o3", "o4"],
		});
		expect(r.body.data.toVersion).toBe(3);
		expect(r.body.data.moved).toEqual([{ orgId: "o1", name: "Acme" }]);
		expect(r.body.data.skipped).toEqual([
			{ orgId: "o2", name: "Bolt", cause: "not_on_version" },
			{ orgId: "o3", name: "Core", cause: "no_entitlement" },
			{ orgId: "o4", name: "Dune", cause: "conflict" },
		]);
		const rows = mockDb.log.create.mock.calls.map((c: any) => c[0].data);
		const batch = rows.filter(
			(d: any) => d.event_type === "plan.orgs_moved",
		);
		expect(batch).toHaveLength(1);
		expect(batch[0]).toMatchObject({
			entity_type: "plan",
			entity_id: "pro",
			reason: "Roll out v3",
			changes: { from: 2, to: 3, moved: 1, skipped: 3 },
		});
		// o4's updateMany returned 0, so its transaction threw before writing a log row.
		expect(
			rows.filter(
				(d: any) => d.event_type === "org_entitlement.plan_changed",
			),
		).toHaveLength(1);
	});

	it("records an unexpected failure as error and keeps going", async () => {
		mockDb.org_entitlement.findUnique
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(ent("o2"));
		const r = await move({ fromVersionId: "v2", orgIds: ["o1", "o2"] });
		expect(r.body.data.skipped[0]).toMatchObject({
			orgId: "o1",
			cause: "error",
			message: "boom",
		});
		expect(r.body.data.moved).toEqual([{ orgId: "o2", name: "Bolt" }]);
	});

	it("caps a batch at 500 orgs", async () => {
		await expect(
			move({
				fromVersionId: "v2",
				orgIds: Array.from({ length: 501 }, (_, i) => `o${i}`),
			}),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("previews every org on the source version, with trial deferral", async () => {
		const ends = new Date(Date.now() + 5 * 86_400_000);
		mockDb.org_entitlement.findMany.mockResolvedValue([
			{
				organization_id: "o1",
				organization: { name: "Acme" },
				trial_ends_at: null,
				trial_plan_version: null,
			},
			{
				organization_id: "o2",
				organization: { name: "Bolt" },
				trial_ends_at: ends,
				trial_plan_version: { plan: { label: "Enterprise" } },
			},
		]);
		mockDb.org_entitlement.findUnique.mockImplementation(
			async ({ where }: any) => ent(where.organization_id),
		);
		const r = await call("get", "/plans/:key/move-orgs/preview", {
			params: { key: "pro" },
			query: { from: "v2" },
		});
		expect(r.body.data).toMatchObject({
			from: { id: "v2", version: 2 },
			to: { id: "v3", version: 3 },
			truncated: false,
		});
		expect(r.body.data.rows[0]).toMatchObject({
			orgId: "o1",
			name: "Acme",
			trialDefers: null,
		});
		expect(r.body.data.rows[0].diff.gained).toContain("quickbooks");
		expect(r.body.data.rows[1].trialDefers).toEqual({
			tierLabel: "Enterprise",
			endsAt: ends.toISOString(),
		});
	});
});
