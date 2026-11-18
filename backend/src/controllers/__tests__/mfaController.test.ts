import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});
vi.mock("../../services/totpService.js", () => ({
	generateSecret: vi.fn(),
	buildOtpAuthUri: vi.fn(),
	generateRecoveryCodes: vi.fn(),
	KEY: "k",
}));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(async () => true) } }));
vi.mock("../authenticationController.js", () => ({ issueAuthTokens: vi.fn() }));
vi.mock("../../services/jwtService.js", () => ({
	generateRefreshToken: vi.fn(async () => "new-rt"),
	setRefreshToken: vi.fn(),
	verifyPendingToken: vi.fn(),
}));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../../services/appLogger.js", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { db } from "../../db.js";
import { setupTotp, disableTotp } from "../mfaController.js";
import type { FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("setupTotp", () => {
	it("refuses to replace an enabled authenticator", async () => {
		fake.mfa_credential.findUnique.mockResolvedValue({ enabled: true });

		await expect(setupTotp("u1", "dispatcher")).rejects.toMatchObject({ statusCode: 400 });
		expect(fake.mfa_credential.upsert).not.toHaveBeenCalled();
	});
});

describe("disableTotp", () => {
	it("revokes only this user's refresh tokens and returns a new one", async () => {
		fake.dispatcher.findUnique.mockResolvedValue({ id: "u1", email: "a@b.co", organization_id: "org1", password: "h" });
		fake.mfa_credential.findUnique.mockResolvedValue({ id: "c1", locked_until: null });

		const result = await disableTotp("u1", "dispatcher", "pw");

		expect(fake.jwt_refresh_token.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
		expect(result).toEqual({ data: { refreshToken: "new-rt" } });
	});
});
