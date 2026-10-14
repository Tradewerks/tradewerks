import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
	process.env.PLATFORM_JWT_SECRET = "p".repeat(40);
	process.env.JWT_ACCESS_SECRET = "a".repeat(40);
	process.env.OTP_SECRET = "o".repeat(40);
	process.env.MFA_ENCRYPTION_KEY = "0".repeat(64);
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../db.js", async () => ({ db: (await import("./harness.js")).createFakeDb() }));
vi.mock("../../platform/rateLimit.js", () => {
	const pass = (_q: unknown, _s: unknown, n: () => void) => n();
	return {
		platformAuthLimiter: pass,
		upgradeRequestLimiter: pass,
		signupLimiter: pass,
		orgInviteLimiter: pass,
	};
});
vi.mock("../../services/emailService.js", async (orig) => ({
	...(await orig<typeof import("../../services/emailService.js")>()),
	sendEmailVerificationEmail: vi.fn(async () => {}),
	sendOrgAdminInviteEmail: vi.fn(async () => {}),
}));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn(async () => {}) }));

import organizationsRouter from "../organizations.js";
import { callRoute } from "./harness.js";
import { db } from "../../db.js";
import { hashInviteToken } from "../../lib/inviteToken.js";
import { resetPassword } from "../../controllers/authenticationController.js";

const mockDb = db as any;
beforeEach(() => vi.clearAllMocks());

describe("GET /organizations/business-types", () => {
	it("lists key and label in display order, without module defaults", async () => {
		const r = await callRoute(organizationsRouter, "get", "/business-types");
		expect(r.status).toBe(200);
		expect(r.body.data[0]).toEqual({ key: "hvac", label: "HVAC" });
		expect(r.body.data.at(-1)).toEqual({ key: "general", label: "Other" });
	});
});

const REGISTER = {
	org_name: "Acme Plumbing",
	admin_name: "Pat",
	admin_email: "Pat@Acme.test",
	admin_password: "Sup3r$ecret",
	business_type: "plumbing",
};

describe("POST /organizations/register", () => {
	beforeEach(() => {
		mockDb.dispatcher.findUnique.mockResolvedValue(null);
		mockDb.plan_version.findFirst.mockResolvedValue({ id: "pv_starter_1" });
		mockDb.organization.create.mockResolvedValue({ id: "org-1", name: "Acme Plumbing" });
		mockDb.org_entitlement.create.mockResolvedValue({});
		mockDb.organization_role.createMany.mockResolvedValue({});
		mockDb.organization_role.create.mockResolvedValue({ id: "role-admin" });
		mockDb.dispatcher.create.mockResolvedValue({ id: "d-1", email: "pat@acme.test" });
	});

	it("puts the org on the latest signup-default version with the type's modules and no trial", async () => {
		const r = await callRoute(organizationsRouter, "post", "/register", { body: REGISTER });
		expect(r.status).toBe(201);
		expect(mockDb.plan_version.findFirst).toHaveBeenCalledWith({
			where: { plan: { is_signup_default: true, archived_at: null } },
			orderBy: { version: "desc" },
			select: { id: true },
		});
		const ent = mockDb.org_entitlement.create.mock.calls[0][0].data;
		expect(ent).toMatchObject({
			organization_id: "org-1",
			plan_version_id: "pv_starter_1",
			plan_source: "signup",
			template_key: "plumbing",
			modules_reviewed_at: null,
		});
		expect(ent.trial_plan_version_id).toBeUndefined();
		expect(ent.module_choices.followups).toBe(true);
		expect(mockDb.dispatcher.create.mock.calls[0][0].data.email).toBe("pat@acme.test");
	});

	it("refuses with 503 SIGNUPS_PAUSED when no tier is the signup default", async () => {
		mockDb.plan_version.findFirst.mockResolvedValue(null);
		await expect(
			callRoute(organizationsRouter, "post", "/register", { body: REGISTER }),
		).rejects.toMatchObject({ statusCode: 503, code: "SIGNUPS_PAUSED" });
		expect(mockDb.organization.create).not.toHaveBeenCalled();
	});

	it("rejects an unknown business type with 400", async () => {
		await expect(
			callRoute(organizationsRouter, "post", "/register", {
				body: { ...REGISTER, business_type: "rocketry" },
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		expect(mockDb.organization.create).not.toHaveBeenCalled();
	});

	it("still answers 409 for an email already in use", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue({ id: "other" });
		const r = await callRoute(organizationsRouter, "post", "/register", { body: REGISTER });
		expect(r.status).toBe(409);
	});

	it("answers 409 for an email a technician uses (login checks technicians first)", async () => {
		mockDb.technician.findFirst.mockResolvedValueOnce({ id: "tech-1" });
		const r = await callRoute(organizationsRouter, "post", "/register", { body: REGISTER });
		expect(r.status).toBe(409);
		expect(mockDb.organization.create).not.toHaveBeenCalled();
	});

	it("answers 409, not a generic failure, when a parallel signup takes the email", async () => {
		mockDb.dispatcher.create.mockRejectedValueOnce(
			Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
		);
		const r = await callRoute(organizationsRouter, "post", "/register", { body: REGISTER });
		expect(r.status).toBe(409);
		expect(r.body.error.code).toBe("CONFLICT");
	});
});

const TOKEN = "t".repeat(43);
const future = () => new Date(Date.now() + 3_600_000);
const pending = (over: Record<string, unknown> = {}) => ({
	id: "d-1",
	email: "pat@acme.test",
	invite_expires_at: future(),
	organization: { name: "Acme" },
	...over,
});
const INVALID = { statusCode: 404, message: "This invite link is invalid or has expired" };

describe("customer admin invite", () => {
	it("preview names the company and email for a live token", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(pending());
		const r = await callRoute(organizationsRouter, "post", "/invites/preview", {
			body: { token: TOKEN },
		});
		expect(r.status).toBe(200);
		expect(r.body.data).toEqual({ company: "Acme", email: "pat@acme.test" });
		expect(mockDb.dispatcher.findUnique.mock.calls[0][0].where).toEqual({
			invite_token_hash: hashInviteToken(TOKEN),
		});
	});

	it("an expired token answers 404 with the generic message", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(
			pending({ invite_expires_at: new Date(Date.now() - 1) }),
		);
		await expect(
			callRoute(organizationsRouter, "post", "/invites/preview", { body: { token: TOKEN } }),
		).rejects.toMatchObject(INVALID);
	});

	it("an unknown token answers the same 404", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(null);
		await expect(
			callRoute(organizationsRouter, "post", "/invites/preview", { body: { token: TOKEN } }),
		).rejects.toMatchObject(INVALID);
	});

	it("accept sets the password, verifies the email and spends the token in one conditional update", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(pending());
		mockDb.dispatcher.updateMany.mockResolvedValue({ count: 1 });
		const r = await callRoute(organizationsRouter, "post", "/invites/accept", {
			body: { token: TOKEN, password: "Sup3r$ecret" },
		});
		expect(r.status).toBe(200);
		expect(r.body.data).toEqual({ email: "pat@acme.test" });
		const arg = mockDb.dispatcher.updateMany.mock.calls[0][0];
		expect(arg.where).toMatchObject({ id: "d-1", invite_token_hash: hashInviteToken(TOKEN) });
		expect(arg.where.invite_expires_at.gt).toBeInstanceOf(Date);
		expect(arg.data).toMatchObject({ invite_token_hash: null, invite_expires_at: null });
		expect(arg.data.email_verified_at).toBeInstanceOf(Date);
		// A null last_login reads as a temporary password and forces a second reset at sign-in.
		expect(arg.data.last_login).toBeInstanceOf(Date);
		expect(arg.data.password).toMatch(/^\$2[aby]\$/);
	});

	it("a token spent in parallel loses with 404", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(pending());
		mockDb.dispatcher.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			callRoute(organizationsRouter, "post", "/invites/accept", {
				body: { token: TOKEN, password: "Sup3r$ecret" },
			}),
		).rejects.toMatchObject(INVALID);
	});

	it("rejects a short password with 400", async () => {
		const r = await callRoute(organizationsRouter, "post", "/invites/accept", {
			body: { token: TOKEN, password: "short" },
		});
		expect(r.status).toBe(400);
	});

	it("a password reset spends a pending admin invite", async () => {
		mockDb.dispatcher.findFirst.mockResolvedValue({
			id: "d-1",
			organization_id: "org-1",
			password_reset_token_expires_at: future(),
			role: "admin",
		});
		mockDb.dispatcher.update.mockResolvedValue({});
		await resetPassword("reset-token-xxxxxxxxxxxx", "Sup3r$ecret", "dispatcher");
		expect(mockDb.dispatcher.update.mock.calls[0][0].data).toMatchObject({
			invite_token_hash: null,
			invite_expires_at: null,
		});
	});
});
