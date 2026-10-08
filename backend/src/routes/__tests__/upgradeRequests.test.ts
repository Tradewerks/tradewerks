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
const notify = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => []));
const notifyOne = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => null));
vi.mock("../../controllers/notificationsController.js", async (orig) => ({
	...(await orig<
		typeof import("../../controllers/notificationsController.js")
	>()),
	notifyDispatchers: notify,
	createDispatcherNotification: notifyOne,
}));
vi.mock("../../services/socketService.js", () => ({
	emitToOrg: vi.fn(),
	getSocket: vi.fn(),
}));
vi.mock("../../platform/rateLimit.js", () => ({
	platformAuthLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
	upgradeRequestLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
const ents = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock("../../services/entitlementService.js", async (orig) => ({
	...(await orig<typeof import("../../services/entitlementService.js")>()),
	getEntitlements: vi.fn(async () => ents.value),
}));

import { DISPATCHER_NOTIFICATION_PERMISSIONS } from "../../controllers/notificationsController.js";
import { ErrorCodes } from "../../types/responses.js";
import { db } from "../../db.js";
import { notifyRequestResolved } from "../../platform/requestNotice.js";
import orgEntitlementsRouter from "../orgEntitlements.js";
import { callRoute } from "./harness.js";
import platformRouter from "../platform/index.js";
import { signStaffToken } from "../../platform/staffToken.js";
import { setStaffActive } from "../../platform/verifyStaffToken.js";
import { emitToOrg } from "../../services/socketService.js";
const mockDb = db as any;

beforeEach(() => {
	vi.clearAllMocks();
	ents.value = {
		planKey: "starter",
		planVersion: 1,
		trialActive: false,
		modules: {
			quickbooks: "not_in_plan",
			ai_assistant: "on",
			quotes: "off_by_org",
		},
		limits: {},
	};
});

describe("upgrade request plumbing", () => {
	it("registers the resolved notification and the request error codes", () => {
		expect(
			DISPATCHER_NOTIFICATION_PERMISSIONS.upgrade_request_resolved,
		).toBe("manage_organization");
		expect(ErrorCodes.REQUEST_OPEN).toBe("REQUEST_OPEN");
		expect(ErrorCodes.REQUEST_CLOSED).toBe("REQUEST_CLOSED");
	});
});

describe("requester notice", () => {
	const requester = (over: Record<string, unknown> = {}) => ({
		id: "d-1",
		role: "dispatcher",
		muted_notification_types: [],
		organization_role: { permissions: ["manage_organization"] },
		...over,
	});
	beforeEach(() => {
		mockDb.upgrade_request.findUnique.mockResolvedValue({
			requested_by_id: "d-1",
		});
	});

	it("notifies the requester only", async () => {
		mockDb.dispatcher.findFirst.mockResolvedValue(requester());
		await notifyRequestResolved(
			"org-1",
			"req-1",
			"declined",
			"Not this quarter",
		);
		expect(notifyOne).toHaveBeenCalledWith(
			{
				dispatcherId: "d-1",
				type: "upgrade_request_resolved",
				title: "Your subscription request was declined",
				body: "Not this quarter",
				actionUrl: "/dispatch/admin?tab=entitlements",
			},
			"org-1",
		);
		expect(notify).not.toHaveBeenCalled();
	});

	it("respects the requester's mute", async () => {
		mockDb.dispatcher.findFirst.mockResolvedValue(
			requester({
				muted_notification_types: ["upgrade_request_resolved"],
			}),
		);
		await notifyRequestResolved("org-1", "req-1", "approved", "Done");
		expect(notifyOne).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("falls back to all admins when the requester is gone or lost the permission", async () => {
		mockDb.dispatcher.findFirst.mockResolvedValue(null);
		await notifyRequestResolved("org-1", "req-1", "approved", "Done");
		mockDb.dispatcher.findFirst.mockResolvedValue(
			requester({ organization_role: { permissions: [] } }),
		);
		await notifyRequestResolved("org-1", "req-1", "approved", "Done");
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[0][0]).toMatchObject({
			type: "upgrade_request_resolved",
			title: "Your subscription request was approved",
		});
	});

	it("never throws", async () => {
		mockDb.upgrade_request.findUnique.mockRejectedValue(
			new Error("db down"),
		);
		await expect(
			notifyRequestResolved("org-1", "req-1", "approved", "Done"),
		).resolves.toBeUndefined();
	});
});

const admin = {
	uid: "d-1",
	role: "admin",
	organization_id: "org-1",
	email: "a@t.test",
	permissions: null,
};
const viewer = {
	uid: "d-2",
	role: "dispatcher",
	organization_id: "org-1",
	email: "v@t.test",
	permissions: ["view_jobs"],
};
const file = (body: unknown, user: Record<string, unknown> = admin) =>
	callRoute(orgEntitlementsRouter, "post", "/upgrade-requests", {
		user,
		body,
	});

describe("customer: file a request", () => {
	beforeEach(() => {
		mockDb.org_entitlement.findUnique.mockResolvedValue({
			plan_version: { plan_key: "starter" },
		});
		mockDb.plan.findUnique.mockImplementation(
			async ({ where }: any) =>
				({
					pro: {
						key: "pro",
						label: "Pro",
						assignable: true,
						archived_at: null,
					},
					starter: {
						key: "starter",
						label: "Starter",
						assignable: true,
						archived_at: null,
					},
					old: {
						key: "old",
						label: "Old",
						assignable: true,
						archived_at: new Date(),
					},
					legacy: {
						key: "legacy",
						label: "Legacy",
						assignable: false,
						archived_at: null,
					},
				})[where.key as string] ?? null,
		);
		mockDb.plan.findMany.mockResolvedValue([{ key: "pro", label: "Pro" }]);
		mockDb.dispatcher.findFirst.mockResolvedValue({ name: "Dana Admin" });
		mockDb.upgrade_request.create.mockImplementation(
			async ({ data }: any) => ({
				id: "req-1",
				status: "open",
				resolution_note: null,
				resolved_at: null,
				created_at: new Date("2026-10-07T00:00:00Z"),
				...data,
			}),
		);
		mockDb.log.create.mockResolvedValue({});
	});

	it("files a tier + locked feature request with a history row", async () => {
		const r = await file({
			planKey: "pro",
			modules: ["quickbooks", "quickbooks"],
			note: "Growing",
		});
		expect(r.status).toBe(201);
		expect(
			mockDb.upgrade_request.create.mock.calls[0][0].data,
		).toMatchObject({
			organization_id: "org-1",
			requested_by_id: "d-1",
			requested_by_name: "Dana Admin",
			requested_plan_key: "pro",
			requested_modules: ["quickbooks"],
			note: "Growing",
		});
		expect(mockDb.log.create.mock.calls[0][0].data).toMatchObject({
			entity_type: "upgrade_request",
			event_type: "upgrade_request.created",
			actor_type: "dispatcher",
		});
		expect(r.body.data).toMatchObject({
			requested_plan_label: "Pro",
			status: "open",
		});
	});

	it("refuses the current, archived, non-assignable and unknown tiers", async () => {
		for (const planKey of ["starter", "old", "legacy", "ghost"])
			await expect(file({ planKey })).rejects.toMatchObject({
				statusCode: 400,
			});
	});

	it("only allows locked paid features", async () => {
		for (const m of ["ai_assistant", "quotes", "inventory", "nope"])
			await expect(file({ modules: [m] })).rejects.toMatchObject({
				statusCode: 400,
			});
	});

	it("requires a note when nothing is picked", async () => {
		await expect(file({})).rejects.toMatchObject({ statusCode: 400 });
		await expect(file({ note: "  " })).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(
			(await file({ note: "Need 3 more technician seats" })).status,
		).toBe(201);
	});

	it("maps the one-open-request index to 409 REQUEST_OPEN", async () => {
		mockDb.upgrade_request.create.mockRejectedValue(
			Object.assign(new Error("u"), { code: "P2002" }),
		);
		await expect(file({ planKey: "pro" })).rejects.toMatchObject({
			statusCode: 409,
			code: "REQUEST_OPEN",
		});
	});

	it("needs manage_organization", async () => {
		const r = await file({ planKey: "pro" }, viewer).catch((e) => e);
		expect(r.status ?? r.statusCode).toBe(403);
		expect(mockDb.upgrade_request.create).not.toHaveBeenCalled();
	});
});

describe("customer: list, withdraw, tiers", () => {
	it("lists the org's requests with labels, newest first", async () => {
		mockDb.upgrade_request.findMany.mockResolvedValue([
			{
				id: "r1",
				organization_id: "org-1",
				requested_by_id: "d-1",
				requested_by_name: "Dana",
				requested_plan_key: "pro",
				requested_modules: ["quickbooks"],
				note: null,
				status: "declined",
				resolution_note: "Not now",
				resolved_by_id: "s-1",
				resolved_at: new Date(),
				created_at: new Date(),
			},
		]);
		mockDb.plan.findMany.mockResolvedValue([{ key: "pro", label: "Pro" }]);
		const r = await callRoute(
			orgEntitlementsRouter,
			"get",
			"/upgrade-requests",
			{ user: admin },
		);
		expect(mockDb.upgrade_request.findMany.mock.calls[0][0]).toMatchObject({
			where: { organization_id: "org-1" },
			orderBy: { created_at: "desc" },
			take: 20,
		});
		expect(r.body.data[0]).toMatchObject({
			requested_plan_label: "Pro",
			requested_modules: [
				{ key: "quickbooks", label: expect.any(String) },
			],
		});
		expect(r.body.data[0]).not.toHaveProperty("resolved_by_id");
	});

	it("withdraws only an open request of the caller's org", async () => {
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 1 });
		mockDb.log.create.mockResolvedValue({});
		mockDb.dispatcher.findFirst.mockResolvedValue({ name: "Dana Admin" });
		const withdraw = () =>
			callRoute(
				orgEntitlementsRouter,
				"post",
				"/upgrade-requests/:id/withdraw",
				{ user: admin, params: { id: "r1" } },
			);
		expect((await withdraw()).status).toBe(200);
		expect(
			mockDb.upgrade_request.updateMany.mock.calls[0][0],
		).toMatchObject({
			where: { id: "r1", organization_id: "org-1", status: "open" },
			data: { status: "withdrawn" },
		});
		expect(mockDb.log.create.mock.calls[0][0].data.event_type).toBe(
			"upgrade_request.withdrawn",
		);
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 0 });
		await expect(withdraw()).rejects.toMatchObject({
			statusCode: 409,
			code: "REQUEST_CLOSED",
		});
	});

	it("lists requestable tiers without the current one, plan-gated features only", async () => {
		mockDb.org_entitlement.findUnique.mockResolvedValue({
			plan_version: { plan_key: "starter" },
		});
		mockDb.plan.findMany.mockResolvedValue([
			{
				key: "pro",
				label: "Pro",
				versions: [{ modules: ["quickbooks", "quotes"] }],
			},
		]);
		const r = await callRoute(orgEntitlementsRouter, "get", "/tiers", {
			user: admin,
		});
		expect(mockDb.plan.findMany.mock.calls[0][0].where).toEqual({
			assignable: true,
			archived_at: null,
			key: { not: "starter" },
		});
		expect(r.body.data).toEqual([
			{
				key: "pro",
				label: "Pro",
				modules: [{ key: "quickbooks", label: expect.any(String) }],
			},
		]);
	});
});

const staffAuth = () => {
	setStaffActive("s-1", true);
	return {
		authorization: `Bearer ${signStaffToken({ id: "s-1", email: "s@t.test", name: "Ops" })}`,
	};
};
const openRow = {
	id: "r1",
	organization_id: "org-1",
	requested_by_id: "d-1",
	requested_by_name: "Dana",
	requested_plan_key: "pro",
	requested_modules: ["quickbooks"],
	note: null,
	status: "open",
	resolution_note: null,
	resolved_at: null,
	created_at: new Date("2026-10-07T00:00:00Z"),
};
const patchRequest = (body: unknown) =>
	callRoute(platformRouter, "patch", "/upgrade-requests/:id", {
		headers: staffAuth(),
		params: { id: "r1" },
		body,
	});

describe("staff: inbox", () => {
	it("lists open first, filters by org, includes org names", async () => {
		mockDb.upgrade_request.count.mockResolvedValue(1);
		mockDb.upgrade_request.findMany.mockResolvedValue([
			{ ...openRow, organization: { name: "Acme" } },
		]);
		mockDb.plan.findMany.mockResolvedValue([{ key: "pro", label: "Pro" }]);
		const r = await callRoute(platformRouter, "get", "/upgrade-requests", {
			headers: staffAuth(),
			query: { status: "open", orgId: "org-1" },
		});
		expect(mockDb.upgrade_request.findMany.mock.calls[0][0].where).toEqual({
			status: "open",
			organization_id: "org-1",
		});
		expect(r.body.data.rows[0]).toMatchObject({
			org_name: "Acme",
			requested_plan_label: "Pro",
		});
		expect(r.body.data.rows[0].organization).toBeUndefined();
	});

	it("counts open requests", async () => {
		mockDb.upgrade_request.count.mockResolvedValue(3);
		const r = await callRoute(
			platformRouter,
			"get",
			"/upgrade-requests/open-count",
			{ headers: staffAuth() },
		);
		expect(r.body.data).toEqual({ count: 3 });
		expect(mockDb.upgrade_request.count.mock.calls[0][0]).toEqual({
			where: { status: "open" },
		});
	});
});

describe("staff: decline", () => {
	beforeEach(() => {
		mockDb.upgrade_request.findUnique.mockResolvedValue(openRow);
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 1 });
		mockDb.log.create.mockResolvedValue({});
		mockDb.dispatcher.findFirst.mockResolvedValue({
			id: "d-1",
			role: "admin",
			muted_notification_types: [],
			organization_role: null,
		});
	});

	it("needs a note", async () => {
		await expect(
			patchRequest({ status: "declined", note: " " }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("closes an open request, logs it, notifies the requester and refreshes the rail", async () => {
		await patchRequest({ status: "declined", note: "Not this quarter" });
		expect(
			mockDb.upgrade_request.updateMany.mock.calls[0][0],
		).toMatchObject({
			where: { id: "r1", status: "open" },
			data: {
				status: "declined",
				resolved_by_id: "s-1",
				resolution_note: "Not this quarter",
			},
		});
		expect(mockDb.log.create.mock.calls[0][0].data).toMatchObject({
			organization_id: "org-1",
			event_type: "upgrade_request.declined",
			actor_type: "platform_staff",
		});
		expect(notifyOne).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Your subscription request was declined",
			}),
			"org-1",
		);
		expect(emitToOrg).toHaveBeenCalledWith(
			"org-1",
			"entitlements:changed",
			{},
		);
	});

	it("409 when someone closed it first", async () => {
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			patchRequest({ status: "declined", note: "Late" }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "REQUEST_CLOSED",
		});
		expect(notifyOne).not.toHaveBeenCalled();
	});
});

describe("staff: approve when already in effect", () => {
	beforeEach(() => {
		mockDb.upgrade_request.findUnique.mockResolvedValue(openRow);
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 1 });
		mockDb.log.create.mockResolvedValue({});
		mockDb.org_entitlement.findUnique.mockResolvedValue({
			plan_version: { plan_key: "pro" },
		});
	});

	it("refuses while a requested part is not in effect", async () => {
		await expect(
			patchRequest({ status: "approved", note: "Done" }),
		).rejects.toMatchObject({
			statusCode: 400,
			message: "Apply the requested change first",
		});
	});

	it("409 REQUEST_CLOSED when the request was already closed", async () => {
		mockDb.upgrade_request.findUnique.mockResolvedValue({ ...openRow, status: "declined" });
		await expect(patchRequest({ status: "approved", note: "Done" })).rejects.toMatchObject({
			statusCode: 409,
			code: "REQUEST_CLOSED",
		});
	});

	it("closes as approved when the tier and features are already on", async () => {
		ents.value.modules.quickbooks = "on";
		await patchRequest({
			status: "approved",
			note: "A colleague applied it",
		});
		expect(
			mockDb.upgrade_request.updateMany.mock.calls[0][0].data,
		).toMatchObject({ status: "approved" });
		expect(mockDb.log.create.mock.calls[0][0].data.event_type).toBe(
			"upgrade_request.approved",
		);
	});
});
