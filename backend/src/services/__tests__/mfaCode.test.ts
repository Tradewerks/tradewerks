import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

vi.hoisted(() => {
	process.env.MFA_ENCRYPTION_KEY = "0".repeat(64);
	process.env.OTP_SECRET = "o".repeat(40);
	process.env.JWT_ACCESS_SECRET = "a".repeat(40);
});
vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));
vi.mock("../logger.js", () => ({ logActivity: vi.fn() }));
vi.mock("../../controllers/authenticationController.js", () => ({
	issueAuthTokens: vi.fn(async () => ({ data: { token: "t" } })),
}));

import { db } from "../../db.js";
import { encryptSecret } from "../crypto.js";
import { KEY, generateSecret, matchTotpStep } from "../totpService.js";
import { acceptTotp, spendRecoveryCode } from "../mfaCode.js";
import { currentTotpStep, totpCodeAt } from "./fixtures/totpCode.js";
import { disableTotp, verifyMfa } from "../../controllers/mfaController.js";

const mockDb = db as any;
beforeEach(() => vi.clearAllMocks());

const codeAt = totpCodeAt;
const nowStep = currentTotpStep;
const plain = generateSecret();
const cred = (over: Record<string, unknown> = {}) => ({
	id: "c-1",
	enabled: true,
	secret: encryptSecret(plain, KEY),
	failed_attempts: 0,
	locked_until: null,
	last_used_step: null,
	...over,
});

describe("matchTotpStep", () => {
	it("returns the step of a code inside the window and null outside it", () => {
		const s = nowStep();
		expect(matchTotpStep(plain, codeAt(plain, s))).toBe(s);
		expect(matchTotpStep(plain, codeAt(plain, s - 1))).toBe(s - 1);
		expect(matchTotpStep(plain, codeAt(plain, s - 3))).toBeNull();
		expect(matchTotpStep(plain, "12345")).toBeNull();
	});
});

describe("acceptTotp", () => {
	it("claims the matched step only if it is newer than the last one used", async () => {
		mockDb.mfa_credential.updateMany.mockResolvedValue({ count: 1 });
		const s = nowStep();
		expect(await acceptTotp(cred(), codeAt(plain, s))).toBe(true);
		expect(mockDb.mfa_credential.updateMany).toHaveBeenCalledWith({
			where: {
				id: "c-1",
				OR: [{ last_used_step: null }, { last_used_step: { lt: s } }],
			},
			data: { last_used_step: s },
		});
	});

	it("refuses a replay: the conditional claim matches no row", async () => {
		mockDb.mfa_credential.updateMany.mockResolvedValue({ count: 0 });
		expect(await acceptTotp(cred(), codeAt(plain, nowStep()))).toBe(false);
	});

	it("refuses a wrong code or a non-string without touching the row", async () => {
		expect(await acceptTotp(cred(), "000000x")).toBe(false);
		expect(await acceptTotp(cred(), { $ne: 1 } as unknown as string)).toBe(false);
		expect(mockDb.mfa_credential.updateMany).not.toHaveBeenCalled();
	});
});

describe("spendRecoveryCode", () => {
	it("loses when a parallel request spent the code first", async () => {
		mockDb.mfa_recovery_code.findFirst.mockResolvedValue({ id: "r-1" });
		mockDb.mfa_recovery_code.updateMany.mockResolvedValue({ count: 0 });
		expect(await spendRecoveryCode("u-1", "admin", "abcd1234")).toBe(false);
		expect(mockDb.mfa_recovery_code.updateMany).toHaveBeenCalledWith({
			where: { id: "r-1", used_at: null },
			data: { used_at: expect.any(Date) },
		});
	});

	it("ignores a non-string code", async () => {
		expect(await spendRecoveryCode("u-1", "admin", 7 as unknown as string)).toBe(false);
		expect(mockDb.mfa_recovery_code.findFirst).not.toHaveBeenCalled();
	});
});

const pending = () =>
	jwt.sign(
		{ userId: "u-1", role: "admin", organization_id: "o-1", stage: "pending_totp" },
		process.env.OTP_SECRET!,
	);

describe("customer verifyMfa", () => {
	it("refuses a replayed code and counts it with an atomic increment", async () => {
		mockDb.mfa_credential.findUnique.mockResolvedValue(cred({ last_used_step: nowStep() }));
		mockDb.mfa_credential.updateMany.mockResolvedValue({ count: 0 });
		mockDb.mfa_credential.update.mockResolvedValue({ failed_attempts: 1 });
		const r = await verifyMfa({} as any, pending(), codeAt(plain, nowStep()));
		expect(r).toMatchObject({ error: { message: "Invalid code" } });
		expect(mockDb.mfa_credential.update.mock.calls[0][0].data).toEqual({
			failed_attempts: { increment: 1 },
		});
	});

	it("locks on the fifth wrong code", async () => {
		mockDb.mfa_credential.findUnique.mockResolvedValue(cred({ failed_attempts: 4 }));
		mockDb.mfa_credential.update
			.mockResolvedValueOnce({ failed_attempts: 5 })
			.mockResolvedValueOnce({});
		await verifyMfa({} as any, pending(), "000000");
		expect(mockDb.mfa_credential.update.mock.calls[1][0].data).toMatchObject({
			failed_attempts: 0,
			locked_until: expect.any(Date),
		});
	});

	it("spends a backup code with a conditional claim", async () => {
		mockDb.mfa_credential.findUnique.mockResolvedValue(cred());
		mockDb.mfa_recovery_code.findFirst.mockResolvedValue({ id: "r-1" });
		mockDb.mfa_recovery_code.updateMany.mockResolvedValue({ count: 1 });
		mockDb.mfa_credential.update.mockResolvedValue({});
		const r = await verifyMfa({} as any, pending(), undefined, "abcd1234");
		expect(r).toEqual({ data: { token: "t" } });
		expect(mockDb.mfa_recovery_code.update).not.toHaveBeenCalled();
	});
});

describe("customer disableTotp", () => {
	const user = { id: "u-1", password: "h", organization_id: "o-1" };

	it("refuses while the credential is locked, even with a right code", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(user);
		mockDb.mfa_credential.findUnique.mockResolvedValue(
			cred({ locked_until: new Date(Date.now() + 60_000) }),
		);
		const r = await disableTotp("u-1", "admin", undefined, codeAt(plain, nowStep()));
		expect(r).toMatchObject({ error: { code: "TOO_MANY_REQUESTS" } });
		expect(mockDb.mfa_credential.deleteMany).not.toHaveBeenCalled();
	});

	it("counts a wrong code toward the lock", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(user);
		mockDb.mfa_credential.findUnique.mockResolvedValue(cred());
		mockDb.mfa_credential.update.mockResolvedValue({ failed_attempts: 1 });
		const r = await disableTotp("u-1", "admin", undefined, "000000");
		expect(r).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
		expect(mockDb.mfa_credential.update.mock.calls[0][0].data).toEqual({
			failed_attempts: { increment: 1 },
		});
		expect(mockDb.mfa_credential.deleteMany).not.toHaveBeenCalled();
	});

	it("refuses a replayed code", async () => {
		mockDb.dispatcher.findUnique.mockResolvedValue(user);
		mockDb.mfa_credential.findUnique.mockResolvedValue(cred());
		mockDb.mfa_credential.updateMany.mockResolvedValue({ count: 0 });
		mockDb.mfa_credential.update.mockResolvedValue({ failed_attempts: 1 });
		const r = await disableTotp("u-1", "admin", undefined, codeAt(plain, nowStep()));
		expect(r).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
	});
});
