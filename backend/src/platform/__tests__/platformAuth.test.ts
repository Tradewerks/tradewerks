import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";

// Real Postgres for the race tests; token tests need no DB.
// CI sets QUOTA_TEST_DATABASE_URL after `prisma migrate deploy`. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
	process.env.PLATFORM_JWT_SECRET = "p".repeat(40);
	process.env.JWT_ACCESS_SECRET = "a".repeat(40);
	process.env.OTP_SECRET = "o".repeat(40);
	process.env.MFA_ENCRYPTION_KEY ??= "0".repeat(64);
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});

import {
	platformProxyWarning,
	platformSecret,
	signStaffToken,
	trustProxySetting,
	signStaffPending,
	verifyStaffClaims,
	verifyStaffPending,
} from "../staffToken.js";
import { verifyToken as verifyCustomerToken } from "../../services/jwtService.js";

const staff = { id: "s-1", email: "ops@tradewerks.test", name: "Ops" };

describe("staff tokens", () => {
	it("round-trips a staff token", () => {
		const c = verifyStaffClaims(signStaffToken(staff));
		expect(c).toMatchObject({
			kind: "staff",
			sid: "s-1",
			email: staff.email,
		});
	});

	it("customer verifyToken rejects a staff token", () => {
		expect(() => verifyCustomerToken(signStaffToken(staff))).toThrow();
	});

	it("customer verifyToken rejects a staff-kind token even if signed with the customer secret", () => {
		const forged = jwt.sign(
			{ kind: "staff", uid: "x", role: "admin" },
			process.env.JWT_ACCESS_SECRET!,
		);
		expect(() => verifyCustomerToken(forged)).toThrow();
	});

	it("staff verification rejects a customer token", () => {
		const customer = jwt.sign(
			{ uid: "u", role: "dispatcher" },
			process.env.JWT_ACCESS_SECRET!,
		);
		expect(() => verifyStaffClaims(customer)).toThrow();
	});

	it("staff verification rejects a pending token and vice versa", () => {
		expect(() =>
			verifyStaffClaims(signStaffPending("s-1", "mfa")),
		).toThrow();
		expect(() =>
			verifyStaffPending(signStaffToken(staff), "mfa"),
		).toThrow();
	});

	it("a pending token is bound to its stage", () => {
		expect(() =>
			verifyStaffPending(signStaffPending("s-1", "enroll"), "mfa"),
		).toThrow();
		expect(
			verifyStaffPending(signStaffPending("s-1", "mfa"), "mfa").sid,
		).toBe("s-1");
	});

	it("platformSecret refuses a secret shared with the customer side, or too short", () => {
		const keep = process.env.PLATFORM_JWT_SECRET;
		process.env.PLATFORM_JWT_SECRET = process.env.JWT_ACCESS_SECRET;
		expect(platformSecret()).toBeNull();
		process.env.PLATFORM_JWT_SECRET = "short";
		expect(platformSecret()).toBeNull();
		process.env.PLATFORM_JWT_SECRET = keep;
		expect(platformSecret()).toBe(keep);
	});
});

describe("proxy configuration", () => {
	it("parses TRUST_PROXY into an Express trust proxy value", () => {
		expect(trustProxySetting(undefined)).toBeUndefined();
		expect(trustProxySetting("")).toBeUndefined();
		expect(trustProxySetting("1")).toBe(1);
		expect(trustProxySetting("true")).toBe(true);
		expect(trustProxySetting("false")).toBe(false);
		expect(trustProxySetting("10.0.0.0/8, loopback")).toBe(
			"10.0.0.0/8, loopback",
		);
	});

	it("warns when an IP allow-list is set without TRUST_PROXY", () => {
		expect(
			platformProxyWarning({ PLATFORM_ALLOWED_IPS: "1.2.3.4" }),
		).toMatch(/TRUST_PROXY/);
		expect(
			platformProxyWarning({
				PLATFORM_ALLOWED_IPS: "1.2.3.4",
				TRUST_PROXY: "1",
			}),
		).toBeNull();
		expect(platformProxyWarning({})).toBeNull();
	});
});

describe.runIf(DB_URL)(
	"platform setup and tier defaults against Postgres",
	() => {
		let db: typeof import("../../db.js").db;
		let setupFirstStaff: typeof import("../authService.js").setupFirstStaff;

		beforeAll(async () => {
			process.env.PLATFORM_SETUP_CODE = "race-code-123";
			({ db } = await import("../../db.js"));
			({ setupFirstStaff } = await import("../authService.js"));
			await db.platform_staff.deleteMany({});
		});
		afterAll(async () => {
			await db.platform_staff.deleteMany({});
			await db.plan.deleteMany({
				where: { key: { in: ["t-a", "t-b"] } },
			});
		});

		it("simultaneous setups create exactly one account", async () => {
			const attempt = (i: number) =>
				setupFirstStaff({
					code: "race-code-123",
					email: `first${i}@t.test`,
					name: `First ${i}`,
					password: "long-enough-pass",
				});
			const results = await Promise.allSettled([
				attempt(1),
				attempt(2),
				attempt(3),
			]);
			expect(
				results.filter((r) => r.status === "fulfilled"),
			).toHaveLength(1);
			expect(await db.platform_staff.count()).toBe(1);
			const rejected = results.filter(
				(r) => r.status === "rejected",
			) as PromiseRejectedResult[];
			for (const r of rejected)
				expect(r.reason.message).toBe("Setup is not available");
		});

		it("only one tier can be signup default and one trial default", async () => {
			await db.plan.updateMany({
				data: { is_signup_default: false, is_trial_default: false },
			});
			await db.plan.createMany({
				data: [
					{ key: "t-a", label: "A", is_signup_default: true },
					{ key: "t-b", label: "B" },
				],
			});
			await expect(
				db.plan.update({
					where: { key: "t-b" },
					data: { is_signup_default: true },
				}),
			).rejects.toThrow();
			await db.plan.update({
				where: { key: "t-b" },
				data: { is_trial_default: true },
			});
			await expect(
				db.plan.update({
					where: { key: "t-a" },
					data: { is_trial_default: true },
				}),
			).rejects.toThrow();
		});
	},
);
