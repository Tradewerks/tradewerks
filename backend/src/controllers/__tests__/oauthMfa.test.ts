import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../services/oauthService.js", () => ({
	authenticateUser: vi.fn(),
	getClient: vi.fn(async () => ({ name: "Zapier" })),
	isRedirectUriAllowed: vi.fn(() => true),
	issueAuthCode: vi.fn(async () => "auth-code-123"),
	exchangeAuthorizationCode: vi.fn(),
	rotateRefreshToken: vi.fn(),
	verifyClient: vi.fn(),
	OAuthError: class extends Error {},
	OAuthErrorCodes: {},
}));
vi.mock("../../services/mfaService.js", () => ({ mfaChallengeFor: vi.fn() }));
vi.mock("../mfaController.js", () => ({ checkMfaCode: vi.fn() }));
vi.mock("../../services/jwtService.js", () => ({
	generatePendingToken: vi.fn(() => "pending-tok"),
	verifyPendingToken: vi.fn(),
}));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../../services/appLogger.js", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { authenticateUser, issueAuthCode } from "../../services/oauthService.js";
import { mfaChallengeFor } from "../../services/mfaService.js";
import { checkMfaCode } from "../mfaController.js";
import { generatePendingToken, verifyPendingToken } from "../../services/jwtService.js";
import { postAuthorizeDecision } from "../oauthController.js";

const PT = { userId: "u1", role: "dispatcher", organization_id: "org1", stage: "pending_oauth_totp" as const };
const CODE_STEP = { email: "", password: "", mfa_token: "pending-tok" };

const USER = { userId: "u1", role: "dispatcher", organizationId: "org1" };

function call(body: Record<string, string> = {}) {
	const req = {
		body: {
			email: "a@b.co",
			password: "pw",
			action: "allow",
			client_id: "zapier",
			redirect_uri: "https://cb.test/return",
			state: "s1",
			...body,
		},
		headers: {},
		ip: "127.0.0.1",
	} as unknown as Request;
	const res = {
		send: vi.fn(),
		redirect: vi.fn(),
		status: vi.fn(),
	};
	res.status.mockReturnValue(res);
	return { req, res: res as unknown as Response & typeof res };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authenticateUser).mockResolvedValue(USER);
});

describe("OAuth consent MFA", () => {
	it("user with TOTP gets the code step, no auth code issued", async () => {
		vi.mocked(mfaChallengeFor).mockResolvedValue("totp");
		const { req, res } = call();
		await postAuthorizeDecision(req, res);

		expect(issueAuthCode).not.toHaveBeenCalled();
		expect(res.redirect).not.toHaveBeenCalled();
		expect(generatePendingToken).toHaveBeenCalledWith(
			expect.objectContaining({ id: "u1" }),
			"dispatcher",
			"pending_oauth_totp",
		);
		const html = res.send.mock.calls[0][0] as string;
		expect(html).toContain('name="code"');
		expect(html).toContain('name="mfa_token" value="pending-tok"');
		expect(html).not.toContain('name="password"');
		expect(html).toContain('value="deny" formnovalidate');
	});

	it("deny on the sign-in page works with empty email/password", async () => {
		const { req, res } = call({ email: "", password: "", action: "deny" });
		await postAuthorizeDecision(req, res);

		expect(authenticateUser).not.toHaveBeenCalled();
		expect(res.redirect).toHaveBeenCalledWith("https://cb.test/return?error=access_denied&state=s1");
	});

	it("org requires MFA but user not enrolled → refused, no auth code", async () => {
		vi.mocked(mfaChallengeFor).mockResolvedValue("enroll");
		const { req, res } = call();
		await postAuthorizeDecision(req, res);

		expect(issueAuthCode).not.toHaveBeenCalled();
		expect(res.redirect).not.toHaveBeenCalled();
		expect(res.send.mock.calls[0][0]).toContain("requires MFA");
	});

	it("no MFA → redirects with auth code", async () => {
		vi.mocked(mfaChallengeFor).mockResolvedValue(null);
		const { req, res } = call();
		await postAuthorizeDecision(req, res);

		expect(issueAuthCode).toHaveBeenCalledOnce();
		expect(res.redirect).toHaveBeenCalledWith("https://cb.test/return?code=auth-code-123&state=s1");
	});

	it("bad password (incl. deactivated) → no MFA lookup, no auth code", async () => {
		vi.mocked(authenticateUser).mockResolvedValue(null);
		const { req, res } = call();
		await postAuthorizeDecision(req, res);

		expect(mfaChallengeFor).not.toHaveBeenCalled();
		expect(issueAuthCode).not.toHaveBeenCalled();
		const html = res.send.mock.calls[0][0] as string;
		expect(html).toContain("Invalid credentials");
		expect(html).toContain('name="password"');
		expect(html).not.toContain('name="code"');
	});

});

describe("OAuth consent code step", () => {
	beforeEach(() => {
		vi.mocked(verifyPendingToken).mockReturnValue(PT);
	});

	it("correct TOTP code → redirects with auth code for the token's user", async () => {
		vi.mocked(checkMfaCode).mockResolvedValue("ok");
		const { req, res } = call({ ...CODE_STEP, code: "123456" });
		await postAuthorizeDecision(req, res);

		expect(authenticateUser).not.toHaveBeenCalled();
		expect(checkMfaCode).toHaveBeenCalledWith("u1", "dispatcher", "123456", undefined);
		expect(issueAuthCode).toHaveBeenCalledWith(
			expect.objectContaining({ user: { userId: "u1", role: "dispatcher", organizationId: "org1" } }),
		);
		expect(res.redirect).toHaveBeenCalledWith("https://cb.test/return?code=auth-code-123&state=s1");
	});

	it("backup code is passed as backupCode, not code", async () => {
		vi.mocked(checkMfaCode).mockResolvedValue("ok");
		const { req, res } = call({ ...CODE_STEP, code: "a1b2c3d4" });
		await postAuthorizeDecision(req, res);

		expect(checkMfaCode).toHaveBeenCalledWith("u1", "dispatcher", undefined, "a1b2c3d4");
	});

	it("wrong code → code page again with same token, no auth code", async () => {
		vi.mocked(checkMfaCode).mockResolvedValue("invalid");
		const { req, res } = call({ ...CODE_STEP, code: "000000" });
		await postAuthorizeDecision(req, res);

		expect(issueAuthCode).not.toHaveBeenCalled();
		const html = res.send.mock.calls[0][0] as string;
		expect(html).toContain("Invalid code");
		expect(html).toContain('name="mfa_token" value="pending-tok"');
	});

	it("locked → too many attempts, no auth code", async () => {
		vi.mocked(checkMfaCode).mockResolvedValue("locked");
		const { req, res } = call({ ...CODE_STEP, code: "123456" });
		await postAuthorizeDecision(req, res);

		expect(issueAuthCode).not.toHaveBeenCalled();
		expect(res.send.mock.calls[0][0]).toContain("Too many attempts");
	});

	it("expired / tampered token → back to sign in, no auth code", async () => {
		vi.mocked(verifyPendingToken).mockImplementation(() => {
			throw new Error("jwt expired");
		});
		const { req, res } = call({ ...CODE_STEP, code: "123456" });
		await postAuthorizeDecision(req, res);

		expect(checkMfaCode).not.toHaveBeenCalled();
		expect(issueAuthCode).not.toHaveBeenCalled();
		expect(res.send.mock.calls[0][0]).toContain("Session expired");
	});

	it("login pending_totp token is rejected on the consent page", async () => {
		vi.mocked(verifyPendingToken).mockReturnValue({ ...PT, stage: "pending_totp" });
		const { req, res } = call({ ...CODE_STEP, code: "123456" });
		await postAuthorizeDecision(req, res);

		expect(checkMfaCode).not.toHaveBeenCalled();
		expect(issueAuthCode).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("deny on the code page works without email/password", async () => {
		const { req, res } = call({ ...CODE_STEP, action: "deny" });
		await postAuthorizeDecision(req, res);

		expect(res.redirect).toHaveBeenCalledWith("https://cb.test/return?error=access_denied&state=s1");
	});
});
