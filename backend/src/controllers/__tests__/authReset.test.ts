import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

// jwtService reads its secrets at import time — set them before anything loads.
vi.hoisted(() => {
	process.env.JWT_ACCESS_SECRET = "test-access-secret";
	process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
	process.env.OTP_SECRET = "test-otp-secret";
});

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});

vi.mock("bcryptjs", () => ({
	default: {
		hash: vi.fn(async (pw: string) => `hashed(${pw})`),
		compare: vi.fn(async (pw: string, hash: string) => hash === `hashed(${pw})`),
	},
}));

vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn(async () => undefined) }));

vi.mock("../../services/emailService.js", () => ({
	sendEmail: vi.fn(),
	sendOTPEmail: vi.fn(),
	sendPasswordResetEmail: vi.fn(),
}));

vi.mock("../../services/otpServce.js", () => ({
	createOTP: vi.fn(),
	OTP_DISABLED: true,
	verifyOTP: vi.fn(),
}));

import { db } from "../../db.js";
import { login, resetPassword, requestPasswordReset } from "../authenticationController.js";
import { refreshAccessToken } from "../../services/jwtService.js";
import { sendPasswordResetEmail } from "../../services/emailService.js";
import { logActivity } from "../../services/logger.js";
import type { FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;
const future = () => new Date(Date.now() + 60 * 60 * 1000);
const past = () => new Date(Date.now() - 60 * 1000);

beforeEach(() => {
	vi.clearAllMocks();
	fake.dispatcher.findFirst.mockResolvedValue(null);
	fake.technician.findFirst.mockResolvedValue(null);
	fake.dispatcher.update.mockResolvedValue({});
	fake.technician.update.mockResolvedValue({});
});

describe("resetPassword — role is derived from the token's owner row (review B1 / S1)", () => {
	it("ignores role:'admin' from the body when the token belongs to a plain dispatcher", async () => {
		fake.dispatcher.findFirst.mockResolvedValue({
			id: "disp-1",
			organization_id: "org-1",
			role: "dispatcher",
			password_reset_token_expires_at: future(),
		});

		const result = await resetPassword("tok", "new-password-123", "admin");

		expect(result).toEqual({ err: "", userId: "disp-1", role: "dispatcher" });
		expect(fake.dispatcher.update).toHaveBeenCalledWith({
			where: { password_reset_token: "tok" },
			data: { password: "hashed(new-password-123)", password_reset_token: null, password_reset_token_expires_at: null },
		});
		expect(fake.technician.update).not.toHaveBeenCalled();
		// lookup asks only for what it needs — never the hash or the token itself
		const select = fake.dispatcher.findFirst.mock.calls[0][0].select;
		expect(select).toEqual({ id: true, organization_id: true, password_reset_token_expires_at: true, role: true });
	});

	it("returns 'admin' only when the owning dispatcher row is an admin", async () => {
		fake.dispatcher.findFirst.mockResolvedValue({
			id: "disp-9",
			organization_id: "org-1",
			role: "admin",
			password_reset_token_expires_at: future(),
		});
		const result = await resetPassword("tok", "new-password-123", "dispatcher");
		expect(result.role).toBe("admin");
	});

	it("finds a technician's token even when the body claims a dispatcher role, and reports 'technician'", async () => {
		fake.technician.findFirst.mockResolvedValue({
			id: "tech-1",
			organization_id: "org-1",
			password_reset_token_expires_at: future(),
		});
		const result = await resetPassword("tok", "new-password-123", "admin");
		expect(result).toEqual({ err: "", userId: "tech-1", role: "technician" });
		expect(fake.technician.update).toHaveBeenCalledOnce();
		expect(fake.dispatcher.update).not.toHaveBeenCalled();
		expect(vi.mocked(logActivity).mock.calls[0][0]).toMatchObject({
			event_type: "auth.password_reset",
			actor_type: "technician",
			changes: { password: { old: "[hashed]", new: "[hashed]" } },
		});
	});

	it("checks the hinted table first but falls through to the other", async () => {
		fake.dispatcher.findFirst.mockResolvedValue({
			id: "disp-1",
			organization_id: "org-1",
			role: "dispatcher",
			password_reset_token_expires_at: future(),
		});
		await resetPassword("tok", "new-password-123", "technician");
		expect(fake.technician.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
			fake.dispatcher.findFirst.mock.invocationCallOrder[0],
		);
	});

	it("rejects expired or unknown tokens without touching the password", async () => {
		fake.dispatcher.findFirst.mockResolvedValue({
			id: "disp-1",
			organization_id: "org-1",
			role: "dispatcher",
			password_reset_token_expires_at: past(),
		});
		expect(await resetPassword("tok", "new-password-123", "dispatcher")).toEqual({ err: "Invalid or expired token" });

		fake.dispatcher.findFirst.mockResolvedValue(null);
		expect(await resetPassword("nope", "new-password-123", "dispatcher")).toEqual({ err: "Invalid or expired token" });
		expect(fake.dispatcher.update).not.toHaveBeenCalled();
	});

	it.each([
		["too short", "short"],
		["too long", "x".repeat(129)],
		["missing", undefined],
		["not a string", 12345678],
	])("validates newPassword (%s) before any lookup", async (_label, pw) => {
		const result = await resetPassword("tok", pw, "dispatcher");
		expect(result.err).toMatch(/^Validation failed/);
		expect(fake.dispatcher.findFirst).not.toHaveBeenCalled();
		expect(fake.technician.findFirst).not.toHaveBeenCalled();
	});

	it("requires a token", async () => {
		const result = await resetPassword("", "new-password-123", "dispatcher");
		expect(result.err).toMatch(/^Validation failed/);
	});
});

describe("requestPasswordReset — no live token survives a failed email (review B1 extra)", () => {
	it("clears the token when the email send fails", async () => {
		fake.dispatcher.findUnique.mockResolvedValue({ id: "disp-1", organization_id: "org-1", email: "d@x.com" });
		vi.mocked(sendPasswordResetEmail).mockResolvedValue({ success: false } as never);

		const result = await requestPasswordReset("d@x.com", "dispatcher");

		expect(result).toEqual({ err: "Error sending password reset email" });
		const updates = fake.dispatcher.update.mock.calls.map((c: [Record<string, any>]) => c[0]);
		expect(updates[0].data.password_reset_token).toEqual(expect.any(String));
		expect(updates[updates.length - 1]).toEqual({
			where: { email: "d@x.com" },
			data: { password_reset_token: null, password_reset_token_expires_at: null },
		});
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("keeps the token and logs when the email is sent", async () => {
		fake.technician.findUnique.mockResolvedValue({ id: "tech-1", organization_id: "org-1", email: "t@x.com" });
		vi.mocked(sendPasswordResetEmail).mockResolvedValue({ success: true } as never);

		const result = await requestPasswordReset("t@x.com", "technician");

		expect(result).toEqual({ err: "" });
		expect(fake.technician.update).toHaveBeenCalledOnce();
		expect(fake.technician.update.mock.calls[0][0].data.password_reset_token).toEqual(expect.any(String));
		expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ event_type: "auth.password_reset_requested" }));
	});
});

describe("requestPasswordReset — email is lowercased before lookup", () => {
	it("finds a lowercase-stored user when called with a differently-cased email", async () => {
		fake.dispatcher.findUnique.mockResolvedValue({ id: "disp-1", organization_id: "org-1", email: "d@x.com" });
		vi.mocked(sendPasswordResetEmail).mockResolvedValue({ success: true } as never);

		const result = await requestPasswordReset("D@X.com", "dispatcher");

		expect(result).toEqual({ err: "" });
		expect(fake.dispatcher.findUnique).toHaveBeenCalledWith({ where: { email: "d@x.com" } });
		expect(fake.dispatcher.update.mock.calls[0][0].where).toEqual({ email: "d@x.com" });
	});
});

describe("login — opts back into the password hash only for the credential check (review B2)", () => {
	it("passes omit:{password:false} on the lookup and never returns the hash", async () => {
		fake.technician.findUnique.mockResolvedValue(null);
		fake.dispatcher.findUnique.mockResolvedValue({
			id: "disp-1",
			email: "d@x.com",
			organization_id: "org-1",
			role: "dispatcher",
			password: "hashed(pw)",
			last_login: null,
			organization_role_id: null,
		});
		fake.dispatcher.update.mockResolvedValue({});
		fake.organization.findUnique.mockResolvedValue({ timezone: "UTC" });
		fake.jwt_refresh_token.findFirst.mockResolvedValue(null);
		fake.jwt_refresh_token.create.mockResolvedValue({});

		const res = { cookie: vi.fn() } as never;
		const result = await login(res, "d@x.com", "pw");

		expect(fake.technician.findUnique.mock.calls[0][0]).toEqual({ where: { email: "d@x.com" }, omit: { password: false } });
		expect(fake.dispatcher.findUnique.mock.calls[0][0]).toEqual({ where: { email: "d@x.com" }, omit: { password: false } });
		expect(result && "data" in result && result.data).toMatchObject({ user: { uid: "disp-1", role: "dispatcher" } });
		expect(JSON.stringify(result)).not.toContain("hashed(pw)");
	});

	it("rejects a wrong password", async () => {
		fake.technician.findUnique.mockResolvedValue(null);
		fake.dispatcher.findUnique.mockResolvedValue({ id: "disp-1", email: "d@x.com", organization_id: "org-1", role: "dispatcher", password: "hashed(pw)", last_login: new Date() });
		const result = await login({ cookie: vi.fn() } as never, "d@x.com", "wrong");
		expect(result).toMatchObject({ success: false, error: { code: "INVALID_CREDENTIALS" } });
	});
});

describe("refreshAccessToken — role/permissions are re-read from the DB (review B1)", () => {
	const signRefresh = (claims: Record<string, unknown>) =>
		jwt.sign(claims, process.env.JWT_REFRESH_SECRET!, { expiresIn: "7d" });

	it("does not trust an 'admin' claim on the refresh token", async () => {
		const token = signRefresh({ id: "disp-1", email: "old@x.com", role: "admin", organization_id: "org-1" });
		fake.jwt_refresh_token.findFirst.mockResolvedValue({ token });
		fake.dispatcher.findUnique.mockResolvedValue({
			email: "d@x.com",
			organization_id: "org-1",
			organization_role_id: "role-1",
			role: "dispatcher",
		});
		fake.organization.findUnique.mockResolvedValue({ timezone: "America/Chicago" });
		fake.organization_role.findUnique.mockResolvedValue({ permissions: ["view_jobs"] });

		const result = await refreshAccessToken(token);
		expect(typeof result).toBe("string");
		const claims = jwt.verify(result as string, process.env.JWT_ACCESS_SECRET!) as Record<string, unknown>;
		expect(claims.role).toBe("dispatcher");
		expect(claims.permissions).toEqual(["view_jobs"]);
		expect(claims.email).toBe("d@x.com");
		expect(claims.organization_timezone).toBe("America/Chicago");
	});

	it("mints admin permissions only when the row says admin", async () => {
		const token = signRefresh({ id: "disp-1", email: "d@x.com", role: "dispatcher", organization_id: "org-1" });
		fake.jwt_refresh_token.findFirst.mockResolvedValue({ token });
		fake.dispatcher.findUnique.mockResolvedValue({ email: "d@x.com", organization_id: null, organization_role_id: null, role: "admin" });
		const result = await refreshAccessToken(token);
		const claims = jwt.verify(result as string, process.env.JWT_ACCESS_SECRET!) as { role: string; permissions: string[] };
		expect(claims.role).toBe("admin");
		expect(claims.permissions).toContain("manage_roles");
	});

	it("uses the technician table for technician refresh tokens", async () => {
		const token = signRefresh({ id: "tech-1", email: "t@x.com", role: "technician", organization_id: "org-1" });
		fake.jwt_refresh_token.findFirst.mockResolvedValue({ token });
		fake.technician.findUnique.mockResolvedValue({ email: "t@x.com", organization_id: "org-1", organization_role_id: null });
		fake.organization.findUnique.mockResolvedValue({ timezone: "UTC" });
		const result = await refreshAccessToken(token);
		const claims = jwt.verify(result as string, process.env.JWT_ACCESS_SECRET!) as { role: string; permissions: string[] };
		expect(claims.role).toBe("technician");
		expect(claims.permissions).toEqual([]);
		expect(fake.dispatcher.findUnique).not.toHaveBeenCalled();
	});

	it("rejects when the user no longer exists", async () => {
		const token = signRefresh({ id: "disp-gone", email: "d@x.com", role: "dispatcher", organization_id: "org-1" });
		fake.jwt_refresh_token.findFirst.mockResolvedValue({ token });
		fake.dispatcher.findUnique.mockResolvedValue(null);
		const result = await refreshAccessToken(token);
		expect(result).toMatchObject({ success: false, error: { code: "INVALID_TOKEN" } });
	});

	it("rejects unknown/expired stored tokens before touching users", async () => {
		const token = signRefresh({ id: "disp-1", email: "d@x.com", role: "dispatcher", organization_id: "org-1" });
		fake.jwt_refresh_token.findFirst.mockResolvedValue(null);
		const result = await refreshAccessToken(token);
		expect(result).toMatchObject({ success: false, error: { code: "INVALID_TOKEN" } });
		expect(fake.dispatcher.findUnique).not.toHaveBeenCalled();
	});
});

describe("deactivated users (build plan 2)", () => {
	it("login refuses a deactivated dispatcher with the generic message", async () => {
		fake.technician.findUnique.mockResolvedValue(null);
		fake.dispatcher.findUnique.mockResolvedValue({
			id: "disp-1",
			email: "d@x.com",
			organization_id: "org-1",
			role: "dispatcher",
			password: "hashed(pw)",
			last_login: new Date(),
			deactivated_at: new Date(),
		});
		const result = await login({ cookie: vi.fn() } as never, "d@x.com", "pw");
		expect(result).toMatchObject({
			success: false,
			error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
		});
		expect(fake.jwt_refresh_token.create).not.toHaveBeenCalled();
	});

	it("password reset request is a silent no-op for a deactivated user", async () => {
		fake.dispatcher.findUnique.mockResolvedValue({
			id: "disp-1",
			organization_id: "org-1",
			email: "d@x.com",
			deactivated_at: new Date(),
		});
		const result = await requestPasswordReset("d@x.com", "dispatcher");
		expect(result).toEqual({ err: "" });
		expect(fake.dispatcher.update).not.toHaveBeenCalled();
		expect(sendPasswordResetEmail).not.toHaveBeenCalled();
	});
});

describe("isUserActive (build plan 2)", () => {
	it("is false for a deactivated or missing user and caches the answer", async () => {
		const { isUserActive } = await import("../../services/userActiveCache.js");
		fake.technician.findUnique.mockResolvedValueOnce({ deactivated_at: new Date() });
		expect(await isUserActive("tech-x", "technician")).toBe(false);
		expect(await isUserActive("tech-x", "technician")).toBe(false);
		expect(fake.technician.findUnique).toHaveBeenCalledTimes(1);
		fake.dispatcher.findUnique.mockResolvedValueOnce(null);
		expect(await isUserActive("gone", "dispatcher")).toBe(false);
	});

	it("falls back to active when the lookup fails and nothing is cached", async () => {
		const { isUserActive } = await import("../../services/userActiveCache.js");
		fake.dispatcher.findUnique.mockRejectedValueOnce(new Error("db down"));
		expect(await isUserActive("never-seen", "dispatcher")).toBe(true);
	});
});
