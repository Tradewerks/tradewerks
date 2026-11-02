import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

vi.hoisted(() => {
	process.env.PLATFORM_JWT_SECRET = "p".repeat(40);
	process.env.JWT_ACCESS_SECRET = "a".repeat(40);
	process.env.OTP_SECRET = "o".repeat(40);
	process.env.PLATFORM_SETUP_CODE = "setup-code-123";
	process.env.MFA_ENCRYPTION_KEY = "0".repeat(64);
	process.env.EMAIL_DISABLED = "true";
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../platform/rateLimit.js", () => ({
	platformAuthLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
const notify = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => []));
const notifyOne = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => null));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: notify,
	createDispatcherNotification: notifyOne,
}));
vi.mock("../../services/socketService.js", () => ({
	emitToOrg: vi.fn(),
	getSocket: vi.fn(),
}));
vi.mock("../../services/emailService.js", async (orig) => ({
	...(await orig<typeof import("../../services/emailService.js")>()),
	sendStaffInviteEmail: vi.fn(async () => {}),
	sendOrgAdminInviteEmail: vi.fn(async () => {}),
	sendStaffSecurityNotice: vi.fn(async () => {}),
	sendStaffEnrollEmail: vi.fn(async () => {}),
}));

import platformRouter from "../platform/index.js";
import { callRoute, leaves } from "./harness.js";
import { db } from "../../db.js";
import { resetMfa } from "../../controllers/mfaController.js";
import {
	signStaffPending,
	signStaffToken,
	verifyStaffPending,
} from "../../platform/staffToken.js";
import {
	applyStaffChange,
	applyStaffChanges,
	NotOnVersionError,
	previewStaffChange,
	previewStaffChanges,
	type StaffChange,
} from "../../services/entitlementService.js";
import { MODULES } from "../../lib/entitlements/registry.js";
import {
	sendOrgAdminInviteEmail,
	sendStaffEnrollEmail,
	sendStaffSecurityNotice,
} from "../../services/emailService.js";
import { hashInviteToken } from "../../lib/inviteToken.js";

const mockDb = db as any;
const staffAuth = (id = "s-1") => {
	mockDb.platform_staff.findFirst.mockResolvedValue({ id });
	return {
		authorization: `Bearer ${signStaffToken({ id, email: `${id}@t.test`, name: id })}`,
	};
};

// Stands in for the revocation query: an active member whose sessions were revoked at `at`.
const staffRevokedAt = (at: Date) =>
	mockDb.platform_staff.findFirst.mockImplementation(async ({ where }: any) => {
		const issuedAt: Date = where.OR[1].sessions_valid_after.lte;
		return where.status === "active" && at <= issuedAt ? { id: where.id } : null;
	});

beforeEach(() => vi.clearAllMocks());

const routeTable = (r: unknown) =>
	(
		r as {
			stack: {
				route?: { path: string; methods: Record<string, boolean> };
			}[];
		}
	).stack
		.filter((l) => l.route)
		.map(
			(l) =>
				`${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`,
		);

describe("route table", () => {
	it("keeps every back-office route on the top-level router", () => {
		expect(routeTable(platformRouter)).toEqual([
			"GET /setup",
			"POST /setup",
			"POST /auth/login",
			"POST /auth/mfa",
			"POST /auth/mfa/enroll/link",
			"POST /auth/mfa/enroll/start",
			"POST /auth/mfa/enroll",
			"POST /invites/preview",
			"POST /invites/accept",
			"GET /staff",
			"GET /staff/activity",
			"POST /staff",
			"POST /staff/:id/resend-invite",
			"PATCH /staff/:id",
			"POST /staff/:id/reset-mfa",
			"GET /orgs",
			"POST /orgs",
			"POST /orgs/:id/admin-invite/resend",
			"GET /orgs/:id",
			"POST /orgs/:id/preview",
			"POST /orgs/:id/changes/preview",
			"POST /orgs/:id/changes",
			"PATCH /orgs/:id/plan",
			"PATCH /orgs/:id/trial",
			"PATCH /orgs/:id/modules",
			"PATCH /orgs/:id/limits",
			"GET /orgs/:id/history",
			"GET /plans",
			"GET /plans/catalog",
			"POST /plans",
			"PATCH /plans/:key",
			"POST /plans/:key/versions",
			"GET /plans/:key/history",
			"GET /plans/:key/move-orgs/preview",
			"POST /plans/:key/move-orgs",
			"GET /upgrade-requests",
			"GET /upgrade-requests/open-count",
			"PATCH /upgrade-requests/:id",
		]);
	});
});

describe("POST /platform/auth/login", () => {
	it("returns a generic 401 for an unknown email", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue(null);
		await expect(
			callRoute(platformRouter, "post", "/auth/login", {
				body: { email: "x@t.test", password: "whatever-long-1" },
			}),
		).rejects.toMatchObject({
			statusCode: 401,
			message: "Invalid email or password",
		});
	});

	it("returns the same 401 for a disabled account with the right password", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "disabled",
			password: await bcrypt.hash("right-password-1", 4),
			failed_attempts: 0,
			locked_until: null,
		});
		await expect(
			callRoute(platformRouter, "post", "/auth/login", {
				body: { email: "x@t.test", password: "right-password-1" },
			}),
		).rejects.toMatchObject({
			statusCode: 401,
			message: "Invalid email or password",
		});
	});

	it("a locked account with the right password gets the same generic 401", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "active",
			password: await bcrypt.hash("right-password-1", 4),
			failed_attempts: 0,
			locked_until: new Date(Date.now() + 60_000),
		});
		await expect(
			callRoute(platformRouter, "post", "/auth/login", {
				body: { email: "x@t.test", password: "right-password-1" },
			}),
		).rejects.toMatchObject({
			statusCode: 401,
			message: "Invalid email or password",
		});
		expect(mockDb.mfa_credential.findUnique).not.toHaveBeenCalled();
	});

	it("locks after the fifth wrong password", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "active",
			password: await bcrypt.hash("right-password-1", 4),
			failed_attempts: 4,
			locked_until: null,
		});
		mockDb.platform_staff.update
			.mockResolvedValueOnce({ failed_attempts: 5 })
			.mockResolvedValueOnce({});
		await expect(
			callRoute(platformRouter, "post", "/auth/login", {
				body: { email: "x@t.test", password: "wrong-password-1" },
			}),
		).rejects.toMatchObject({ statusCode: 401 });
		expect(
			mockDb.platform_staff.update.mock.calls[1][0].data,
		).toMatchObject({
			failed_attempts: 0,
			locked_until: expect.any(Date),
		});
		expect(mockDb.log.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				event_type: "platform_staff.locked",
				entity_id: "s-1",
				changes: { factor: { old: null, new: "password" } },
			}),
		});
	});

	it("emails a staff member without enabled MFA a setup link instead of a setup token", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "active",
			password: await bcrypt.hash("right-password-1", 4),
			failed_attempts: 0,
			locked_until: null,
		});
		mockDb.platform_staff.update.mockResolvedValue({});
		mockDb.mfa_credential.findUnique.mockResolvedValue(null);
		const r = await callRoute(platformRouter, "post", "/auth/login", {
			body: { email: "X@T.test", password: "right-password-1" },
		});
		expect(r.status).toBe(200);
		expect(r.body.data).toEqual({ stage: "enroll_email" });
		const saved = mockDb.platform_staff.update.mock.calls.at(-1)[0];
		expect(saved).toMatchObject({
			where: { id: "s-1" },
			data: { enroll_token_hash: expect.any(String), enroll_expires_at: expect.any(Date) },
		});
		const url = vi.mocked(sendStaffEnrollEmail).mock.calls[0][2];
		const token = new URL(url).searchParams.get("token")!;
		expect(new URL(url).pathname).toBe("/platform/enroll");
		expect(hashInviteToken(token)).toBe(saved.data.enroll_token_hash);
		expect(mockDb.platform_staff.findUnique.mock.calls[0][0].where).toEqual(
			{ email: "x@t.test" },
		);
		expect(mockDb.mfa_credential.findUnique).toHaveBeenCalledWith({
			where: { user_id_role: { user_id: "s-1", role: "platform_staff" } },
		});
	});
});

describe("POST /platform/auth/mfa/enroll/link", () => {
	const token = "t".repeat(43);
	const live = (over: Record<string, unknown> = {}) => ({
		id: "s-1",
		status: "active",
		enroll_expires_at: new Date(Date.now() + 60_000),
		...over,
	});
	const exchange = () =>
		callRoute(platformRouter, "post", "/auth/mfa/enroll/link", { body: { token } });

	it("trades a live link for a setup token once, clearing it with a conditional claim", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue(live());
		mockDb.platform_staff.updateMany.mockResolvedValue({ count: 1 });
		const r = await exchange();
		expect(mockDb.platform_staff.findUnique.mock.calls[0][0].where).toEqual({
			enroll_token_hash: hashInviteToken(token),
		});
		expect(mockDb.platform_staff.updateMany).toHaveBeenCalledWith({
			where: { id: "s-1", enroll_token_hash: hashInviteToken(token), status: "active" },
			data: { enroll_token_hash: null, enroll_expires_at: null },
		});
		expect(verifyStaffPending(r.body.data.pendingToken, "enroll").sid).toBe("s-1");
	});

	it("refuses a link opened twice in parallel", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue(live());
		mockDb.platform_staff.updateMany.mockResolvedValue({ count: 0 });
		await expect(exchange()).rejects.toMatchObject({ statusCode: 404 });
	});

	it.each([
		["expired", live({ enroll_expires_at: new Date(Date.now() - 1) })],
		["disabled", live({ status: "disabled" })],
		["unknown", null],
	])("refuses a %s link", async (_l, row) => {
		mockDb.platform_staff.findUnique.mockResolvedValue(row);
		await expect(exchange()).rejects.toMatchObject({ statusCode: 404 });
		expect(mockDb.platform_staff.updateMany).not.toHaveBeenCalled();
	});
});

describe("lockout does not reveal real accounts", () => {
	it("a locked account with a wrong password gets the generic 401", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "active",
			password: await bcrypt.hash("right-password-1", 4),
			failed_attempts: 0,
			locked_until: new Date(Date.now() + 60_000),
		});
		await expect(
			callRoute(platformRouter, "post", "/auth/login", {
				body: { email: "x@t.test", password: "wrong-password-1" },
			}),
		).rejects.toMatchObject({
			statusCode: 401,
			message: "Invalid email or password",
		});
	});
});

describe("MFA lockout", () => {
	it("counts wrong codes atomically and locks on the fifth", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "active",
		});
		mockDb.mfa_credential.findUnique.mockResolvedValue({
			id: "c-1",
			enabled: true,
			secret: "x",
			failed_attempts: 0,
			locked_until: null,
		});
		mockDb.mfa_recovery_code.findFirst.mockResolvedValue(null);
		mockDb.mfa_credential.update
			.mockResolvedValueOnce({ failed_attempts: 5 })
			.mockResolvedValueOnce({});
		await expect(
			callRoute(platformRouter, "post", "/auth/mfa", {
				headers: {
					authorization: `Bearer ${signStaffPending("s-1", "mfa")}`,
				},
				body: { recoveryCode: "wrongcode1" },
			}),
		).rejects.toMatchObject({ statusCode: 401, message: "Invalid code" });
		expect(mockDb.mfa_credential.update.mock.calls[0][0].data).toEqual({
			failed_attempts: { increment: 1 },
		});
		expect(
			mockDb.mfa_credential.update.mock.calls[1][0].data,
		).toMatchObject({
			failed_attempts: 0,
			locked_until: expect.any(Date),
		});
		expect(mockDb.log.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				event_type: "platform_staff.locked",
				entity_id: "s-1",
				changes: { factor: { old: null, new: "mfa" } },
			}),
		});
	});
});

describe("POST /platform/auth/mfa", () => {
	it("rejects a wrong-stage pending token", async () => {
		await expect(
			callRoute(platformRouter, "post", "/auth/mfa", {
				headers: {
					authorization: `Bearer ${signStaffPending("s-1", "enroll")}`,
				},
				body: { code: "123456" },
			}),
		).rejects.toMatchObject({ statusCode: 401 });
	});

	it("spends a recovery code with a conditional claim", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "active",
		});
		mockDb.mfa_credential.findUnique.mockResolvedValue({
			id: "c-1",
			enabled: true,
			secret: "x",
			failed_attempts: 0,
			locked_until: null,
		});
		mockDb.mfa_recovery_code.findFirst.mockResolvedValue({ id: "r-1" });
		mockDb.mfa_recovery_code.updateMany.mockResolvedValueOnce({ count: 1 });
		mockDb.mfa_credential.update.mockResolvedValue({});
		mockDb.platform_staff.update.mockResolvedValue({});
		const r = await callRoute(platformRouter, "post", "/auth/mfa", {
			headers: {
				authorization: `Bearer ${signStaffPending("s-1", "mfa")}`,
			},
			body: { recoveryCode: "abcd1234" },
		});
		expect(r.body.data.token).toEqual(expect.any(String));
		expect(mockDb.mfa_recovery_code.updateMany).toHaveBeenCalledWith({
			where: { id: "r-1", used_at: null },
			data: { used_at: expect.any(Date) },
		});
	});

	it("refuses when the code was spent by a parallel login", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-1",
			email: "x@t.test",
			name: "X",
			status: "active",
		});
		mockDb.mfa_credential.findUnique.mockResolvedValue({
			id: "c-1",
			enabled: true,
			secret: "x",
			failed_attempts: 0,
			locked_until: null,
		});
		mockDb.mfa_recovery_code.findFirst.mockResolvedValue({ id: "r-1" });
		mockDb.mfa_recovery_code.updateMany.mockResolvedValueOnce({ count: 0 });
		mockDb.mfa_credential.update.mockResolvedValue({});
		await expect(
			callRoute(platformRouter, "post", "/auth/mfa", {
				headers: {
					authorization: `Bearer ${signStaffPending("s-1", "mfa")}`,
				},
				body: { recoveryCode: "abcd1234" },
			}),
		).rejects.toMatchObject({ statusCode: 401, message: "Invalid code" });
	});
});

describe("staff routes need a staff token", () => {
	it("401s a customer token on /platform/orgs", async () => {
		const customer = jwt.sign(
			{ uid: "u", role: "admin" },
			process.env.JWT_ACCESS_SECRET!,
		);
		const r = await callRoute(platformRouter, "get", "/orgs", {
			headers: { authorization: `Bearer ${customer}` },
		});
		expect(r.status).toBe(401);
	});
});

describe("back office not configured", () => {
	it("answers 503 on every /platform route when the secret is missing", async () => {
		const keep = process.env.PLATFORM_JWT_SECRET;
		delete process.env.PLATFORM_JWT_SECRET;
		try {
			const r = await callRoute(platformRouter, "get", "/setup");
			expect(r.status).toBe(503);
			expect(r.body.error.message).toBe("Back office is not configured");
		} finally {
			process.env.PLATFORM_JWT_SECRET = keep;
		}
	});
});

describe("POST /platform/setup", () => {
	it("refuses a wrong code", async () => {
		await expect(
			callRoute(platformRouter, "post", "/setup", {
				body: {
					code: "nope",
					email: "a@t.test",
					name: "A",
					password: "long-enough-pass",
				},
			}),
		).rejects.toMatchObject({
			statusCode: 403,
			message: "Setup code is incorrect",
		});
	});

	it("refuses once a staff account exists", async () => {
		mockDb.platform_staff.count.mockResolvedValue(1);
		await expect(
			callRoute(platformRouter, "post", "/setup", {
				body: {
					code: "setup-code-123",
					email: "a@t.test",
					name: "A",
					password: "long-enough-pass",
				},
			}),
		).rejects.toMatchObject({
			statusCode: 404,
			message: "Setup is not available",
		});
		expect(mockDb.platform_staff.create).not.toHaveBeenCalled();
	});
});

describe("resetMfa scopes by role", () => {
	it("deletes only the target role's MFA rows", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue({
			organization_id: "org-1",
		});
		mockDb.mfa_credential.deleteMany.mockResolvedValue({ count: 1 });
		mockDb.mfa_recovery_code.deleteMany.mockResolvedValue({ count: 10 });
		await resetMfa("u-1", "dispatcher", "admin-1", "dispatcher");
		// An org admin's MFA rows carry role "admin" (the token role), not "dispatcher".
		const office = {
			user_id: "u-1",
			role: { in: ["admin", "dispatcher"] },
		};
		expect(mockDb.mfa_credential.deleteMany).toHaveBeenCalledWith({
			where: office,
		});
		expect(mockDb.mfa_recovery_code.deleteMany).toHaveBeenCalledWith({
			where: office,
		});
	});

	it("scopes a technician reset to the technician role", async () => {
		mockDb.technician.findUnique.mockResolvedValue({
			organization_id: "org-1",
		});
		mockDb.mfa_credential.deleteMany.mockResolvedValue({ count: 1 });
		mockDb.mfa_recovery_code.deleteMany.mockResolvedValue({ count: 10 });
		await resetMfa("t-1", "technician", "admin-1", "admin");
		const tech = { user_id: "t-1", role: { in: ["technician"] } };
		expect(mockDb.mfa_credential.deleteMany).toHaveBeenCalledWith({
			where: tech,
		});
		expect(mockDb.mfa_recovery_code.deleteMany).toHaveBeenCalledWith({
			where: tech,
		});
	});
});

describe("staff management", () => {
	it("invites with a hashed token and returns the link once", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue(null);
		mockDb.platform_staff.create.mockImplementation(
			async ({ data }: any) => ({
				id: "s-2",
				email: data.email,
				name: data.name,
				status: "invited",
				last_login: null,
				invite_expires_at: data.invite_expires_at,
				created_at: new Date(),
			}),
		);
		const r = await callRoute(platformRouter, "post", "/staff", {
			headers: staffAuth(),
			body: { email: "New@T.test", name: "New" },
		});
		expect(r.status).toBe(201);
		const token = new URL(r.body.data.inviteUrl).searchParams.get("token")!;
		const data = mockDb.platform_staff.create.mock.calls[0][0].data;
		expect(data.email).toBe("new@t.test");
		expect(data.invite_token_hash).not.toBe(token);
		expect(data.invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(data.invite_expires_at.getTime() - Date.now()).toBeGreaterThan(
			47 * 3600_000,
		);
	});

	it("refuses a duplicate email", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({ id: "s-9" });
		await expect(
			callRoute(platformRouter, "post", "/staff", {
				headers: staffAuth(),
				body: { email: "dup@t.test", name: "Dup" },
			}),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("refuses to disable yourself", async () => {
		await expect(
			callRoute(platformRouter, "patch", "/staff/:id", {
				headers: staffAuth("s-1"),
				params: { id: "s-1" },
				body: { status: "disabled" },
			}),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("refuses to disable the last active staff account", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-2",
			status: "active",
		});
		mockDb.platform_staff.count.mockResolvedValue(1);
		await expect(
			callRoute(platformRouter, "patch", "/staff/:id", {
				headers: staffAuth("s-1"),
				params: { id: "s-2" },
				body: { status: "disabled" },
			}),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("refuses to enable a revoked invite that was never accepted", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-2",
			status: "disabled",
			password: null,
		});
		await expect(
			callRoute(platformRouter, "patch", "/staff/:id", {
				headers: staffAuth("s-1"),
				params: { id: "s-2" },
				body: { status: "active" },
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDb.platform_staff.update).not.toHaveBeenCalled();
	});

	it("lists whether each account was ever accepted, without the hash", async () => {
		mockDb.platform_staff.findMany.mockResolvedValue([
			{
				id: "s-1",
				email: "a@t.test",
				name: "A",
				status: "active",
				password: "hash",
				last_login: null,
				invite_expires_at: null,
				created_at: new Date(),
			},
			{
				id: "s-2",
				email: "b@t.test",
				name: "B",
				status: "disabled",
				password: null,
				last_login: null,
				invite_expires_at: null,
				created_at: new Date(),
			},
		]);
		mockDb.mfa_credential.findMany.mockResolvedValue([]);
		const r = await callRoute(platformRouter, "get", "/staff", {
			headers: staffAuth("s-1"),
		});
		expect(r.body.data.map((x: any) => x.accepted)).toEqual([true, false]);
		expect(r.body.data.every((x: any) => !("password" in x))).toBe(true);
	});

	it("refuses to reset your own MFA", async () => {
		await expect(
			callRoute(platformRouter, "post", "/staff/:id/reset-mfa", {
				headers: staffAuth("s-1"),
				params: { id: "s-1" },
			}),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("reset MFA deletes only platform_staff rows", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({ id: "s-2" });
		mockDb.mfa_credential.deleteMany.mockResolvedValue({ count: 1 });
		mockDb.mfa_recovery_code.deleteMany.mockResolvedValue({ count: 10 });
		await callRoute(platformRouter, "post", "/staff/:id/reset-mfa", {
			headers: staffAuth("s-1"),
			params: { id: "s-2" },
		});
		expect(mockDb.mfa_credential.deleteMany).toHaveBeenCalledWith({
			where: { user_id: "s-2", role: "platform_staff" },
		});
		expect(mockDb.mfa_recovery_code.deleteMany).toHaveBeenCalledWith({
			where: { user_id: "s-2", role: "platform_staff" },
		});
	});

	it("a disabled staff member's token stops working", async () => {
		const headers = staffAuth("s-3");
		mockDb.platform_staff.findFirst.mockResolvedValue(null);
		const r = await callRoute(platformRouter, "get", "/staff", { headers });
		expect(r.status).toBe(401);
	});

	it("a token issued before the member's sessions were revoked stops working", async () => {
		const sign = (ageS: number) =>
			jwt.sign(
				{
					kind: "staff",
					sid: "s-4",
					email: "s-4@t.test",
					name: "s-4",
					iat: Math.floor(Date.now() / 1000) - ageS,
				},
				process.env.PLATFORM_JWT_SECRET!,
				{ expiresIn: "8h" },
			);
		staffRevokedAt(new Date(Date.now() - 30_000));
		mockDb.platform_staff.findMany.mockResolvedValue([]);
		mockDb.mfa_credential.findMany.mockResolvedValue([]);
		const old = await callRoute(platformRouter, "get", "/staff", {
			headers: { authorization: `Bearer ${sign(60)}` },
		});
		expect(old.status).toBe(401);
		const fresh = await callRoute(platformRouter, "get", "/staff", {
			headers: { authorization: `Bearer ${sign(0)}` },
		});
		expect(fresh.status).toBe(200);
	});

	it("disabling revokes sessions, and enabling re-reads the account instead of trusting old tokens", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-2",
			status: "active",
			password: "h",
		});
		mockDb.platform_staff.count.mockResolvedValue(2);
		await callRoute(platformRouter, "patch", "/staff/:id", {
			headers: staffAuth("s-1"),
			params: { id: "s-2" },
			body: { status: "disabled" },
		});
		expect(
			mockDb.platform_staff.update.mock.calls[0][0].data,
		).toMatchObject({
			status: "disabled",
			sessions_valid_after: expect.any(Date),
		});

		const before = jwt.sign(
			{
				kind: "staff",
				sid: "s-2",
				email: "s-2@t.test",
				name: "s-2",
				iat: Math.floor(Date.now() / 1000) - 60,
			},
			process.env.PLATFORM_JWT_SECRET!,
			{ expiresIn: "8h" },
		);
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-2",
			status: "disabled",
			password: "h",
		});
		await callRoute(platformRouter, "patch", "/staff/:id", {
			headers: staffAuth("s-1"),
			params: { id: "s-2" },
			body: { status: "active" },
		});
		staffRevokedAt(new Date(Date.now() - 1_000));
		const r = await callRoute(platformRouter, "get", "/staff", {
			headers: { authorization: `Bearer ${before}` },
		});
		expect(r.status).toBe(401);
	});

	it("a staff change fails if its audit row cannot be written", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-2",
			email: "b@t.test",
			name: "B",
			status: "active",
			password: "h",
		});
		mockDb.platform_staff.count.mockResolvedValue(2);
		mockDb.log.create.mockRejectedValueOnce(new Error("log table down"));
		await expect(
			callRoute(platformRouter, "patch", "/staff/:id", {
				headers: staffAuth("s-1"),
				params: { id: "s-2" },
				body: { status: "disabled" },
			}),
		).rejects.toThrow("log table down");
	});

	it("emails a security notice to every active staff member and the affected one", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-2",
			email: "b@t.test",
			name: "B",
			status: "active",
			password: "h",
		});
		mockDb.platform_staff.count.mockResolvedValue(2);
		mockDb.platform_staff.findMany.mockResolvedValue([
			{ email: "a@t.test" },
			{ email: "c@t.test" },
		]);
		mockDb.log.create.mockResolvedValue({});
		await callRoute(platformRouter, "patch", "/staff/:id", {
			headers: staffAuth("s-1"),
			params: { id: "s-2" },
			body: { status: "disabled" },
		});
		expect(sendStaffSecurityNotice).toHaveBeenCalledTimes(1);
		const [to, subject, text] = (sendStaffSecurityNotice as any).mock
			.calls[0];
		expect([...to].sort()).toEqual(["a@t.test", "b@t.test", "c@t.test"]);
		expect(subject).toBe("TradeWerks back office: security change");
		expect(text).toContain("s-1 disabled B's back office account.");
	});

	it("a failed security notice does not undo the change", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({
			id: "s-2",
			email: "b@t.test",
			name: "B",
		});
		mockDb.platform_staff.findMany.mockRejectedValueOnce(
			new Error("smtp lookup failed"),
		);
		mockDb.log.create.mockResolvedValue({});
		const r = await callRoute(
			platformRouter,
			"post",
			"/staff/:id/reset-mfa",
			{
				headers: staffAuth("s-1"),
				params: { id: "s-2" },
			},
		);
		expect(r.status).toBe(200);
	});

	it("lists staff activity newest first, naming the affected member", async () => {
		mockDb.log.findMany.mockResolvedValue([
			{
				id: "l-2",
				timestamp: new Date("2026-10-07T12:00:00Z"),
				event_type: "platform_staff.disabled",
				actor_type: "platform_staff",
				actor_name: "Ops",
				entity_id: "s-2",
				changes: null,
			},
			{
				id: "l-1",
				timestamp: new Date("2026-10-07T11:00:00Z"),
				event_type: "platform_staff.locked",
				actor_type: "system",
				actor_name: "Lockout",
				entity_id: "s-9",
				changes: { factor: { old: null, new: "password" } },
			},
		]);
		mockDb.platform_staff.findMany.mockResolvedValue([
			{ id: "s-2", name: "B" },
		]);
		const r = await callRoute(platformRouter, "get", "/staff/activity", {
			headers: staffAuth("s-1"),
		});
		expect(mockDb.log.findMany.mock.calls[0][0]).toMatchObject({
			where: { entity_type: "platform_staff", organization_id: null },
			orderBy: { timestamp: "desc" },
			take: 100,
		});
		expect(r.body.data.map((x: any) => [x.id, x.target_name])).toEqual([
			["l-2", "B"],
			["l-1", null],
		]);
	});

	it("resetting MFA revokes the member's sessions", async () => {
		mockDb.platform_staff.findUnique.mockResolvedValue({ id: "s-2" });
		await callRoute(platformRouter, "post", "/staff/:id/reset-mfa", {
			headers: staffAuth("s-1"),
			params: { id: "s-2" },
		});
		expect(mockDb.platform_staff.update).toHaveBeenCalledWith({
			where: { id: "s-2" },
			data: {
				sessions_valid_after: expect.any(Date),
				enroll_token_hash: null,
				enroll_expires_at: null,
			},
		});
	});
});

const versions: Record<string, any> = {
	pv_pro_1: {
		id: "pv_pro_1",
		plan_key: "pro",
		version: 1,
		modules: ["quickbooks", "ai_assistant"],
		limits: { technicians: 25 },
		plan: { label: "Pro", assignable: true, archived_at: null },
	},
	pv_starter_1: {
		id: "pv_starter_1",
		plan_key: "starter",
		version: 1,
		modules: [],
		limits: { technicians: 5 },
		plan: { label: "Starter", assignable: true, archived_at: null },
	},
	pv_legacy_1: {
		id: "pv_legacy_1",
		plan_key: "legacy",
		version: 1,
		modules: ["quickbooks", "ai_assistant"],
		limits: {},
		plan: { assignable: false, archived_at: null },
	},
};
const entRow = (over: Record<string, unknown> = {}) => ({
	organization_id: "org-1",
	plan_version_id: "pv_pro_1",
	plan_version: versions.pv_pro_1,
	trial_plan_version_id: null,
	trial_plan_version: null,
	trial_ends_at: null,
	module_choices: { quickbooks: true, ai_assistant: true },
	module_grants: {},
	limit_overrides: {},
	updated_at: new Date("2026-10-06T00:00:00Z"),
	...over,
});
const actorS = { id: "s-1", name: "Ops" };
const primeEntitlements = () => {
	mockDb.org_entitlement.findUnique.mockResolvedValue(entRow());
	mockDb.plan_version.findUnique.mockImplementation(
		async ({ where }: any) => versions[where.id] ?? null,
	);
	mockDb.org_entitlement.updateMany.mockResolvedValue({ count: 1 });
	mockDb.log.create.mockResolvedValue({});
};

describe("applyStaffChange", () => {
	beforeEach(primeEntitlements);

	it("downgrade: operator source, audited as TradeWerks support, one notification", async () => {
		const after = await applyStaffChange(
			"org-1",
			{ kind: "plan", planVersionId: "pv_starter_1" },
			actorS,
			"Customer asked to downgrade",
		);
		expect(after.modules.quickbooks).toBe("not_in_plan");
		const upd = mockDb.org_entitlement.updateMany.mock.calls[0][0];
		expect(upd.where).toEqual({
			organization_id: "org-1",
			updated_at: new Date("2026-10-06T00:00:00Z"),
		});
		expect(upd.data).toMatchObject({
			plan_version_id: "pv_starter_1",
			plan_source: "operator",
		});
		expect(mockDb.log.create.mock.calls[0][0].data).toMatchObject({
			entity_type: "org_entitlement",
			entity_id: "org-1",
			actor_type: "platform_staff",
			actor_id: "s-1",
			actor_name: "TradeWerks support",
			reason: "Customer asked to downgrade",
			event_type: "org_entitlement.plan_changed",
		});
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatchObject({
			type: "subscription_changed",
		});
		expect((notify.mock.calls[0][0] as { body: string }).body).toContain(
			"Technician seats limit is now 5.",
		);
	});

	it("refuses a grant that changes nothing", async () => {
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "grant", module: "quickbooks", grant: null },
				actorS,
				"No-op",
			),
		).rejects.toMatchObject({
			statusCode: 400,
			message: "Nothing to change",
		});
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("refuses a limit override equal to the current one", async () => {
		mockDb.org_entitlement.findUnique.mockResolvedValue(
			entRow({ limit_overrides: { technicians: 7 } }),
		);
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "limit", key: "technicians", override: 7 },
				actorS,
				"Same",
			),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "limit", key: "dispatchers", override: "tier" },
				actorS,
				"Same",
			),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("move guard: refuses an org no longer on the expected version", async () => {
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "plan", planVersionId: "pv_starter_1" },
				actorS,
				"Move",
				{
					expectedPlanVersionId: "pv_old",
				},
			),
		).rejects.toBeInstanceOf(NotOnVersionError);
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("move guard: the write is conditional on the source version", async () => {
		await applyStaffChange(
			"org-1",
			{ kind: "plan", planVersionId: "pv_starter_1" },
			actorS,
			"Move",
			{
				expectedPlanVersionId: "pv_pro_1",
			},
		);
		expect(
			mockDb.org_entitlement.updateMany.mock.calls[0][0].where,
		).toEqual({
			organization_id: "org-1",
			updated_at: new Date("2026-10-06T00:00:00Z"),
			plan_version_id: "pv_pro_1",
		});
	});

	it("approving apply closes the open request in the same transaction", async () => {
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 1 });
		mockDb.upgrade_request.findUnique.mockResolvedValue({
			requested_by_id: "d-1",
		});
		mockDb.dispatcher.findFirst.mockResolvedValue({
			id: "d-1",
			role: "admin",
			muted_notification_types: [],
			organization_role: null,
		});
		await applyStaffChange(
			"org-1",
			{ kind: "plan", planVersionId: "pv_starter_1" },
			actorS,
			"As asked",
			{
				upgradeRequestId: "req-1",
			},
		);
		expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
		expect(
			mockDb.upgrade_request.updateMany.mock.calls[0][0],
		).toMatchObject({
			where: { id: "req-1", organization_id: "org-1", status: "open" },
			data: {
				status: "approved",
				resolved_by_id: "s-1",
				resolution_note: "As asked",
			},
		});
		const events = mockDb.log.create.mock.calls.map(
			(c: any) => c[0].data.event_type,
		);
		expect(events).toEqual([
			"upgrade_request.approved",
			"org_entitlement.plan_changed",
		]);
		expect(
			mockDb.log.create.mock.calls[1][0].data.changes.upgrade_request_id,
		).toBe("req-1");
		expect(notifyOne).toHaveBeenCalledWith(
			expect.objectContaining({
				dispatcherId: "d-1",
				type: "upgrade_request_resolved",
			}),
			"org-1",
		);
	});

	it("a losing concurrent approve reports REQUEST_CLOSED, not a stale org", async () => {
		mockDb.org_entitlement.updateMany.mockResolvedValue({ count: 0 });
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "plan", planVersionId: "pv_starter_1" },
				actorS,
				"Race",
				{
					upgradeRequestId: "req-1",
				},
			),
		).rejects.toMatchObject({ statusCode: 409, code: "REQUEST_CLOSED" });
	});

	it("approving apply on a closed request fails as a whole with 409", async () => {
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "plan", planVersionId: "pv_starter_1" },
				actorS,
				"Late",
				{
					upgradeRequestId: "req-1",
				},
			),
		).rejects.toMatchObject({ statusCode: 409, code: "REQUEST_CLOSED" });
		expect(notify).not.toHaveBeenCalled();
		expect(notifyOne).not.toHaveBeenCalled();
	});

	it("upgrade sends no notification", async () => {
		mockDb.org_entitlement.findUnique.mockResolvedValue(
			entRow({
				plan_version_id: "pv_starter_1",
				plan_version: versions.pv_starter_1,
			}),
		);
		await applyStaffChange(
			"org-1",
			{ kind: "plan", planVersionId: "pv_pro_1" },
			actorS,
			"Upgrade approved",
		);
		expect(notify).not.toHaveBeenCalled();
	});

	it("refuses a non-assignable tier", async () => {
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "plan", planVersionId: "pv_legacy_1" },
				actorS,
				"Back to legacy",
			),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("loses the optimistic lock with the reload message and no notification", async () => {
		mockDb.org_entitlement.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "limit", key: "technicians", override: 3 },
				actorS,
				"Cap test",
			),
		).rejects.toMatchObject({
			statusCode: 409,
			message:
				"This organization was changed by someone else. Reload and try again.",
		});
		expect(notify).not.toHaveBeenCalled();
	});

	it('limit override "tier" removes the key; null means unlimited', async () => {
		mockDb.org_entitlement.findUnique.mockResolvedValue(
			entRow({ limit_overrides: { technicians: 3, ai_calls_month: 10 } }),
		);
		await applyStaffChange(
			"org-1",
			{ kind: "limit", key: "technicians", override: "tier" },
			actorS,
			"Back to tier",
		);
		expect(
			mockDb.org_entitlement.updateMany.mock.calls[0][0].data
				.limit_overrides,
		).toEqual({ ai_calls_month: 10 });
		mockDb.org_entitlement.updateMany.mockClear();
		await applyStaffChange(
			"org-1",
			{ kind: "limit", key: "ai_calls_month", override: null },
			actorS,
			"Unlimited AI",
		);
		expect(
			mockDb.org_entitlement.updateMany.mock.calls[0][0].data
				.limit_overrides,
		).toEqual({
			technicians: 3,
			ai_calls_month: null,
		});
	});

	it("grant null clears the key; core modules are refused", async () => {
		mockDb.org_entitlement.findUnique.mockResolvedValue(
			entRow({ module_grants: { fleet: "on" } }),
		);
		await applyStaffChange(
			"org-1",
			{ kind: "grant", module: "fleet", grant: null },
			actorS,
			"Remove grant",
		);
		expect(
			mockDb.org_entitlement.updateMany.mock.calls[0][0].data
				.module_grants,
		).toEqual({});
		const core = MODULES.find((m) => m.kind === "core")!;
		await expect(
			applyStaffChange(
				"org-1",
				{ kind: "grant", module: core.key, grant: "off" },
				actorS,
				"Core off",
			),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("trial: ending clears the warn markers; a past end date is refused", async () => {
		await applyStaffChange(
			"org-1",
			{ kind: "trial", trial: null },
			actorS,
			"End trial",
		);
		expect(
			mockDb.org_entitlement.updateMany.mock.calls[0][0].data,
		).toMatchObject({
			trial_plan_version_id: null,
			trial_ends_at: null,
			trial_warned_3d_at: null,
			trial_warned_end_at: null,
		});
		await expect(
			applyStaffChange(
				"org-1",
				{
					kind: "trial",
					trial: {
						planVersionId: "pv_pro_1",
						endsAt: "2020-01-01T00:00:00Z",
					},
				},
				actorS,
				"Bad trial",
			),
		).rejects.toMatchObject({ statusCode: 400 });
	});
});

describe("previewStaffChange", () => {
	beforeEach(primeEntitlements);

	it("lists lost modules and over-cap seats without writing", async () => {
		mockDb.dispatcher.count.mockResolvedValue(2);
		mockDb.technician.count.mockResolvedValue(8);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
		const p = await previewStaffChange("org-1", {
			kind: "plan",
			planVersionId: "pv_starter_1",
		});
		expect(p.diff.lost).toEqual(
			expect.arrayContaining(["quickbooks", "ai_assistant"]),
		);
		expect(p.overCap).toEqual([{ key: "technicians", used: 8, limit: 5 }]);
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("keeps its response shape: no breakdown", async () => {
		mockDb.dispatcher.count.mockResolvedValue(1);
		mockDb.technician.count.mockResolvedValue(1);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
		const p = await previewStaffChange("org-1", {
			kind: "grant",
			module: "quickbooks",
			grant: "off",
		});
		expect(p).not.toHaveProperty("breakdown");
	});
});

describe("previewStaffChanges", () => {
	beforeEach(() => {
		primeEntitlements();
		mockDb.dispatcher.count.mockResolvedValue(1);
		mockDb.technician.count.mockResolvedValue(1);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
	});

	it("folds tier then grants: after and diff are before → final", async () => {
		const p = await previewStaffChanges("org-1", [
			{ kind: "grant", module: "quickbooks", grant: "on" },
			{ kind: "plan", planVersionId: "pv_starter_1" },
		]);
		expect(p.after.modules.quickbooks).toBe("on");
		expect(p.after.modules.ai_assistant).toBe("not_in_plan");
		expect(p.diff.lost).toEqual(["ai_assistant"]);
		expect(p.before.modules.quickbooks).toBe("on");
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("carries the projected breakdown", async () => {
		const p = await previewStaffChanges("org-1", [
			{ kind: "plan", planVersionId: "pv_starter_1" },
			{ kind: "grant", module: "quickbooks", grant: "on" },
		]);
		expect(p.breakdown.baseTier).toEqual({ key: "starter", label: "Starter", version: 1 });
		expect(p.breakdown.trialTier).toBeNull();
		expect(p.breakdown.modules.quickbooks).toEqual({ state: "on", source: "grant_on" });
		expect(p.breakdown.modules.ai_assistant).toMatchObject({ source: "not_in_tier" });
		expect(p.breakdown.limits.technicians).toMatchObject({ tier: 5, effective: 5 });
	});

	it("reports over-cap seats from the final row", async () => {
		mockDb.technician.count.mockResolvedValue(8);
		const p = await previewStaffChanges("org-1", [
			{ kind: "plan", planVersionId: "pv_starter_1" },
		]);
		expect(p.overCap).toEqual([{ key: "technicians", used: 8, limit: 5 }]);
	});

	it.each([
		["an empty list", []],
		[
			"two changes for the same module",
			[
				{ kind: "grant", module: "quickbooks", grant: "off" },
				{ kind: "grant", module: "quickbooks", grant: null },
			],
		],
		[
			"two tier changes",
			[
				{ kind: "plan", planVersionId: "pv_starter_1" },
				{ kind: "plan", planVersionId: "pv_pro_1" },
			],
		],
		[
			"two trial changes",
			[
				{ kind: "trial", trial: null },
				{ kind: "trial", trial: null },
			],
		],
		[
			"two changes for the same limit",
			[
				{ kind: "limit", key: "technicians", override: 3 },
				{ kind: "limit", key: "technicians", override: 4 },
			],
		],
	])("refuses %s with 400", async (_name, changes) => {
		await expect(previewStaffChanges("org-1", changes as never)).rejects.toMatchObject({
			statusCode: 400,
		});
	});

	it("refuses a batch carrying a grant that changes nothing", async () => {
		await expect(
			previewStaffChanges("org-1", [
				{ kind: "plan", planVersionId: "pv_starter_1" },
				{ kind: "grant", module: "quickbooks", grant: null },
			]),
		).rejects.toMatchObject({ statusCode: 400, message: "Nothing to change" });
	});
});

describe("applyStaffChanges", () => {
	beforeEach(primeEntitlements);

	const batch: StaffChange[] = [
		{ kind: "grant", module: "quickbooks", grant: "on" },
		{ kind: "plan", planVersionId: "pv_starter_1" },
		{ kind: "grant", module: "fleet", grant: "off" },
	];

	it("writes once with the merged data, conditional on updated_at", async () => {
		await applyStaffChanges("org-1", batch, actorS, "Downgrade, keep QB");
		expect(mockDb.org_entitlement.updateMany).toHaveBeenCalledTimes(1);
		const upd = mockDb.org_entitlement.updateMany.mock.calls[0][0];
		expect(upd.where).toEqual({
			organization_id: "org-1",
			updated_at: new Date("2026-10-06T00:00:00Z"),
		});
		expect(upd.data).toEqual({
			plan_version_id: "pv_starter_1",
			plan_source: "operator",
			module_grants: { quickbooks: "on", fleet: "off" },
		});
	});

	it("audits one row per change, tier first, all with the same reason", async () => {
		await applyStaffChanges("org-1", batch, actorS, "Downgrade, keep QB");
		const rows = mockDb.log.create.mock.calls.map((c: any) => c[0].data);
		expect(rows.map((r: any) => r.event_type)).toEqual([
			"org_entitlement.plan_changed",
			"org_entitlement.grant_changed",
			"org_entitlement.grant_changed",
		]);
		expect(new Set(rows.map((r: any) => r.reason))).toEqual(new Set(["Downgrade, keep QB"]));
		expect(rows[2].changes.module_grants).toEqual({
			old: { quickbooks: "on" },
			new: { quickbooks: "on", fleet: "off" },
		});
	});

	it("stamps the request id on every audit row and closes the request first", async () => {
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 1 });
		mockDb.upgrade_request.findUnique.mockResolvedValue(null);
		await applyStaffChanges("org-1", batch, actorS, "As asked", {
			upgradeRequestId: "req-1",
		});
		const rows = mockDb.log.create.mock.calls.map((c: any) => c[0].data);
		expect(rows[0].event_type).toBe("upgrade_request.approved");
		expect(rows.slice(1).every((r: any) => r.changes.upgrade_request_id === "req-1")).toBe(
			true,
		);
		expect(rows).toHaveLength(4);
	});

	it("a losing concurrent approve reports REQUEST_CLOSED", async () => {
		mockDb.org_entitlement.updateMany.mockResolvedValue({ count: 0 });
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyStaffChanges("org-1", batch, actorS, "Race", { upgradeRequestId: "req-1" }),
		).rejects.toMatchObject({ statusCode: 409, code: "REQUEST_CLOSED" });
	});

	it("409s on a lost write or a stale page, with no notification", async () => {
		await expect(
			applyStaffChanges("org-1", batch, actorS, "Stale", {
				expectedUpdatedAt: "2026-10-05T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
		mockDb.org_entitlement.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyStaffChanges("org-1", batch, actorS, "Lost"),
		).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
		expect(notify).not.toHaveBeenCalled();
	});

	it("emits once and sends one notification naming every loss", async () => {
		const { emitToOrg } = await import("../../services/socketService.js");
		await applyStaffChanges(
			"org-1",
			[
				{ kind: "plan", planVersionId: "pv_starter_1" },
				{ kind: "grant", module: "fleet", grant: "off" },
			],
			actorS,
			"Downgrade",
		);
		expect(emitToOrg).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		const body = (notify.mock.calls[0][0] as { body: string }).body;
		expect(body).toContain("QuickBooks");
		expect(body).toContain("Technician seats limit is now 5.");
	});

	it("honours expectedPlanVersionId", async () => {
		await expect(
			applyStaffChanges("org-1", batch, actorS, "Move", { expectedPlanVersionId: "pv_old" }),
		).rejects.toBeInstanceOf(NotOnVersionError);
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});
});

describe("organization routes", () => {
	beforeEach(primeEntitlements);

	it("passes upgradeRequestId through the route", async () => {
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 1 });
		mockDb.upgrade_request.findUnique.mockResolvedValue(null);
		const r = await callRoute(platformRouter, "patch", "/orgs/:id/plan", {
			headers: staffAuth(),
			params: { id: "org-1" },
			body: {
				planVersionId: "pv_starter_1",
				reason: "As asked",
				upgradeRequestId: "8f14e45f-ceea-4e7a-9b6f-2f5d6c1b2a10",
			},
		});
		expect(r.status).toBe(200);
		expect(mockDb.upgrade_request.updateMany).toHaveBeenCalledTimes(1);
	});

	it("requires a reason of at least 3 characters", async () => {
		await expect(
			callRoute(platformRouter, "patch", "/orgs/:id/plan", {
				headers: staffAuth(),
				params: { id: "org-1" },
				body: { planVersionId: "pv_starter_1", reason: " " },
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("sets a limit override through the route", async () => {
		const r = await callRoute(platformRouter, "patch", "/orgs/:id/limits", {
			headers: staffAuth(),
			params: { id: "org-1" },
			body: { key: "technicians", override: 7, reason: "Pilot customer" },
		});
		expect(r.status).toBe(200);
		expect(
			mockDb.org_entitlement.updateMany.mock.calls[0][0].data
				.limit_overrides,
		).toEqual({ technicians: 7 });
	});

	it("refuses a save made from a stale page with the reload message", async () => {
		await expect(
			callRoute(platformRouter, "patch", "/orgs/:id/limits", {
				headers: staffAuth(),
				params: { id: "org-1" },
				body: {
					key: "technicians",
					override: 7,
					reason: "Pilot customer",
					expectedUpdatedAt: "2026-10-05T00:00:00.000Z",
				},
			}),
		).rejects.toMatchObject({
			statusCode: 409,
			message:
				"This organization was changed by someone else. Reload and try again.",
		});
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
		const ok = await callRoute(
			platformRouter,
			"patch",
			"/orgs/:id/limits",
			{
				headers: staffAuth(),
				params: { id: "org-1" },
				body: {
					key: "technicians",
					override: 7,
					reason: "Pilot customer",
					expectedUpdatedAt: "2026-10-06T00:00:00.000Z",
				},
			},
		);
		expect(ok.status).toBe(200);
	});

	it("rejects an unknown limit key at the schema", async () => {
		await expect(
			callRoute(platformRouter, "patch", "/orgs/:id/limits", {
				headers: staffAuth(),
				params: { id: "org-1" },
				body: { key: "nope", override: 7, reason: "whatever" },
			}),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	const changesBody = {
		changes: [
			{ kind: "plan", planVersionId: "pv_starter_1" },
			{ kind: "grant", module: "quickbooks", grant: "on" },
		],
	};

	it("batch preview returns the projected breakdown without writing", async () => {
		mockDb.dispatcher.count.mockResolvedValue(1);
		mockDb.technician.count.mockResolvedValue(1);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
		const r = await callRoute(platformRouter, "post", "/orgs/:id/changes/preview", {
			headers: staffAuth(),
			params: { id: "org-1" },
			body: changesBody,
		});
		expect(r.body.data.breakdown.baseTier.key).toBe("starter");
		expect(r.body.data.diff.lost).toEqual(["ai_assistant"]);
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("batch apply saves with the reason, stamp and request id", async () => {
		mockDb.upgrade_request.updateMany.mockResolvedValue({ count: 1 });
		mockDb.upgrade_request.findUnique.mockResolvedValue(null);
		const r = await callRoute(platformRouter, "post", "/orgs/:id/changes", {
			headers: staffAuth(),
			params: { id: "org-1" },
			body: {
				...changesBody,
				reason: "Downgrade, keep QB",
				expectedUpdatedAt: "2026-10-06T00:00:00.000Z",
				upgradeRequestId: "8f14e45f-ceea-4e7a-9b6f-2f5d6c1b2a10",
			},
		});
		expect(r.status).toBe(200);
		expect(r.body.data.modules.quickbooks).toBe("on");
		expect(mockDb.org_entitlement.updateMany).toHaveBeenCalledTimes(1);
		expect(mockDb.upgrade_request.updateMany).toHaveBeenCalledTimes(1);
	});

	it.each([
		["no changes", { changes: [], reason: "Fine reason" }],
		[
			"more than 20 changes",
			{
				changes: Array.from({ length: 21 }, () => ({ kind: "trial", trial: null })),
				reason: "Fine reason",
			},
		],
		["a short reason", { ...changesBody, reason: " a " }],
		["an unknown kind", { changes: [{ kind: "nope" }], reason: "Fine reason" }],
	])("batch apply refuses %s at the schema", async (_n, body) => {
		await expect(
			callRoute(platformRouter, "post", "/orgs/:id/changes", {
				headers: staffAuth(),
				params: { id: "org-1" },
				body,
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("preview takes the change body and does not write", async () => {
		mockDb.dispatcher.count.mockResolvedValue(1);
		mockDb.technician.count.mockResolvedValue(1);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
		const r = await callRoute(platformRouter, "post", "/orgs/:id/preview", {
			headers: staffAuth(),
			params: { id: "org-1" },
			body: {
				change: { kind: "grant", module: "quickbooks", grant: "off" },
			},
		});
		expect(r.body.data.diff.lost).toEqual(["quickbooks"]);
		expect(mockDb.org_entitlement.updateMany).not.toHaveBeenCalled();
	});

	it("org detail carries the module catalog (no core modules)", async () => {
		mockDb.organization.findUnique.mockResolvedValue({
			id: "org-1",
			name: "Acme",
		});
		mockDb.dispatcher.count.mockResolvedValue(1);
		mockDb.technician.count.mockResolvedValue(1);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
		const r = await callRoute(platformRouter, "get", "/orgs/:id", {
			headers: staffAuth(),
			params: { id: "org-1" },
		});
		const catalog = r.body.data.catalog as {
			key: string;
			label: string;
			kind: string;
		}[];
		expect(catalog).toEqual(
			expect.arrayContaining([
				{ key: "quickbooks", label: "QuickBooks", kind: "plan_gated" },
			]),
		);
		expect(catalog.some((m) => m.kind === "core")).toBe(false);
	});

	it("org detail carries a breakdown that explains each module and limit", async () => {
		mockDb.organization.findUnique.mockResolvedValue({
			id: "org-1",
			name: "Acme",
		});
		mockDb.org_entitlement.findUnique.mockResolvedValue({
			plan_version_id: "pv-2",
			plan_source: "operator",
			template_key: "hvac",
			trial_plan_version_id: null,
			trial_ends_at: null,
			module_choices: {},
			module_grants: { quickbooks: "off" },
			limit_overrides: { dispatchers: 8 },
			updated_at: new Date(),
			plan_version: {
				id: "pv-2",
				plan_key: "pro",
				version: 2,
				modules: ["quickbooks"],
				limits: { dispatchers: 5 },
				plan: { key: "pro", label: "Pro" },
			},
			trial_plan_version: null,
		});
		mockDb.dispatcher.count.mockResolvedValue(1);
		mockDb.technician.count.mockResolvedValue(1);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
		const r = await callRoute(platformRouter, "get", "/orgs/:id", {
			headers: staffAuth(),
			params: { id: "org-1" },
		});
		const b = r.body.data.breakdown;
		expect(b.baseTier).toEqual({ key: "pro", label: "Pro", version: 2 });
		expect(b.trialTier).toBeNull();
		expect(b.modules.quickbooks).toEqual({
			state: "not_in_plan",
			source: "grant_off",
		});
		expect(b.limits.dispatchers).toEqual({
			tier: 5,
			override: 8,
			effective: 8,
		});
		expect(r.body.data.resolved).toBeDefined();
	});

	it("org detail breakdown is null when the org has no entitlement row", async () => {
		mockDb.organization.findUnique.mockResolvedValue({
			id: "org-2",
			name: "Bare",
		});
		mockDb.org_entitlement.findUnique.mockResolvedValue(null);
		mockDb.dispatcher.count.mockResolvedValue(0);
		mockDb.technician.count.mockResolvedValue(0);
		mockDb.usage_counter.findMany.mockResolvedValue([]);
		const r = await callRoute(platformRouter, "get", "/orgs/:id", {
			headers: staffAuth(),
			params: { id: "org-2" },
		});
		expect(r.body.data.breakdown).toBeNull();
	});

	it("history names the staff member for TradeWerks rows only", async () => {
		mockDb.log.findMany.mockResolvedValue([
			{
				id: "l1",
				timestamp: new Date(),
				event_type: "org_entitlement.plan_changed",
				actor_type: "platform_staff",
				actor_id: "s-1",
				actor_name: "TradeWerks support",
				reason: "r",
				changes: {},
			},
			{
				id: "l2",
				timestamp: new Date(),
				event_type: "org_entitlement.modules_changed",
				actor_type: "dispatcher",
				actor_id: "d-1",
				actor_name: "Alex",
				reason: null,
				changes: {},
			},
		]);
		mockDb.platform_staff.findMany.mockResolvedValue([
			{ id: "s-1", name: "Ops Person" },
		]);
		const r = await callRoute(platformRouter, "get", "/orgs/:id/history", {
			headers: staffAuth(),
			params: { id: "org-1" },
		});
		expect(r.body.data[0].staff_name).toBe("Ops Person");
		expect(r.body.data[1].staff_name).toBeNull();
		expect(leaves(mockDb.log.findMany.mock.calls[0][0].where)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entity_type: "org_entitlement" }),
			]),
		);
	});
});

describe("staff create organization (build plan 4)", () => {
	const call = (method: string, path: string, opts: Record<string, unknown> = {}) =>
		callRoute(platformRouter, method, path, { headers: staffAuth(), ...opts });
	const BODY = {
		name: "Acme Plumbing",
		admin_name: "Pat",
		admin_email: "Pat@Acme.test",
		business_type: "plumbing",
		plan_key: "pro",
		trial: { plan_key: "enterprise", days: 14 },
	};
	beforeEach(() => {
		mockDb.dispatcher.findUnique.mockResolvedValue(null);
		mockDb.plan_version.findFirst.mockImplementation(async ({ where }: any) =>
			where.plan.key === "pro"
				? { id: "pv_pro_2" }
				: where.plan.key === "enterprise"
					? { id: "pv_ent_1" }
					: null,
		);
		mockDb.organization.create.mockResolvedValue({
			id: "org-new",
			name: "Acme Plumbing",
			timezone: "America/Chicago",
		});
		mockDb.org_entitlement.create.mockResolvedValue({});
		mockDb.organization_role.createMany.mockResolvedValue({});
		mockDb.organization_role.create.mockResolvedValue({ id: "role-admin" });
		mockDb.dispatcher.create.mockResolvedValue({ id: "d-new", email: "pat@acme.test" });
		mockDb.log.create.mockResolvedValue({});
	});

	it("provisions on the chosen tier with a trial, issues an invite and audits it", async () => {
		const r = await call("post", "/orgs", { body: BODY });
		expect(r.status).toBe(201);
		expect(r.body.data.id).toBe("org-new");
		expect(r.body.data.inviteUrl).toMatch(/\/accept-invite\?token=/);
		const ent = mockDb.org_entitlement.create.mock.calls[0][0].data;
		expect(ent).toMatchObject({
			plan_version_id: "pv_pro_2",
			plan_source: "operator",
			template_key: "plumbing",
			trial_plan_version_id: "pv_ent_1",
		});
		const days = (ent.trial_ends_at.getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(13.99);
		const admin = mockDb.dispatcher.create.mock.calls[0][0].data;
		expect(admin.email).toBe("pat@acme.test");
		expect(admin.invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(admin.last_login).toBeNull();
		expect(vi.mocked(sendOrgAdminInviteEmail).mock.calls[0][4]).toBe("America/Chicago");
		expect(mockDb.log.create.mock.calls[0][0].data).toMatchObject({
			organization_id: "org-new",
			entity_type: "org_entitlement",
			entity_id: "org-new",
			event_type: "organization.created",
			actor_type: "platform_staff",
		});
	});

	it("409 when the admin email is in use", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue({ id: "x" });
		await expect(call("post", "/orgs", { body: BODY })).rejects.toMatchObject({
			statusCode: 409,
		});
	});

	it("409 when the admin email belongs to a technician (login would find the technician first)", async () => {
		mockDb.technician.findFirst.mockResolvedValueOnce({ id: "t-1" });
		await expect(call("post", "/orgs", { body: BODY })).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(mockDb.organization.create).not.toHaveBeenCalled();
	});

	it("409, not 500, when a parallel create takes the email first", async () => {
		mockDb.dispatcher.create.mockRejectedValueOnce(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);
		await expect(call("post", "/orgs", { body: BODY })).rejects.toMatchObject({
			statusCode: 409,
		});
	});

	it("400 for a tier that is unknown, archived or not assignable", async () => {
		await expect(
			call("post", "/orgs", { body: { ...BODY, plan_key: "nope" } }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("400 for trial days outside 1–365", async () => {
		for (const days of [0, 366])
			await expect(
				call("post", "/orgs", { body: { ...BODY, trial: { plan_key: "enterprise", days } } }),
			).rejects.toMatchObject({ statusCode: 400 });
	});

	it("resend replaces the token, and refuses when nothing is pending", async () => {
		mockDb.dispatcher.findFirst.mockResolvedValueOnce({
			id: "d-1",
			email: "pat@acme.test",
			organization: { name: "Acme", timezone: "Pacific/Honolulu" },
		});
		mockDb.dispatcher.update.mockResolvedValue({});
		const path = "/orgs/:id/admin-invite/resend";
		const ok = await call("post", path, { params: { id: "org-1" } });
		expect(ok.status).toBe(200);
		// The expiry date in the email is the org's calendar day, not the server's.
		expect(vi.mocked(sendOrgAdminInviteEmail).mock.calls.at(-1)?.[4]).toBe("Pacific/Honolulu");
		expect(ok.body.data.inviteUrl).toMatch(/\/accept-invite\?token=/);
		expect(mockDb.dispatcher.update.mock.calls[0][0].data.invite_token_hash).toMatch(
			/^[0-9a-f]{64}$/,
		);
		mockDb.dispatcher.findFirst.mockResolvedValueOnce(null);
		await expect(call("post", path, { params: { id: "org-1" } })).rejects.toMatchObject({
			statusCode: 409,
		});
	});

	it("the list filter keeps only active trials ending within N days", async () => {
		mockDb.organization.count.mockResolvedValue(0);
		mockDb.organization.findMany.mockResolvedValue([]);
		await call("get", "/orgs", { query: { trial_ending_within_days: "7" } });
		const where = mockDb.organization.findMany.mock.calls[0][0].where;
		expect(where.entitlement.trial_plan_version_id).toEqual({ not: null });
		expect(where.entitlement.trial_ends_at.gt).toBeInstanceOf(Date);
		expect(where.entitlement.trial_ends_at.lte).toBeInstanceOf(Date);
	});

	it("the list filter narrows to one tier, and to one of its versions", async () => {
		mockDb.organization.count.mockResolvedValue(0);
		mockDb.organization.findMany.mockResolvedValue([]);
		await call("get", "/orgs", { query: { tier: "starter" } });
		expect(mockDb.organization.findMany.mock.calls[0][0].where.entitlement).toEqual({
			plan_version: { plan: { key: "starter" } },
		});
		await call("get", "/orgs", {
			query: { tier: "starter", version: "2", trial_ending_within_days: "7" },
		});
		const both = mockDb.organization.findMany.mock.calls[1][0].where.entitlement;
		expect(both.plan_version).toEqual({ plan: { key: "starter" }, version: 2 });
		expect(both.trial_plan_version_id).toEqual({ not: null });
	});
});
