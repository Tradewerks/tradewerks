import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { currentTotpStep, totpCodeAt } from "./fixtures/totpCode.js";

// Real Postgres for the race the fake DB cannot show. CI sets QUOTA_TEST_DATABASE_URL after
// `prisma migrate deploy`. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
	process.env.MFA_ENCRYPTION_KEY = "0".repeat(64);
});

describe.runIf(DB_URL)("TOTP replay guard against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let acceptTotp: typeof import("../mfaCode.js").acceptTotp;
	let cred: { id: string; secret: string };
	let code: string;

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		({ acceptTotp } = await import("../mfaCode.js"));
		const totp = await import("../totpService.js");
		const { encryptSecret } = await import("../crypto.js");
		const plain = totp.generateSecret();
		code = totpCodeAt(plain, currentTotpStep());
		cred = await db.mfa_credential.create({
			data: {
				user_id: "pg-replay-user",
				role: "admin",
				secret: encryptSecret(plain, totp.KEY),
				enabled: true,
			},
			select: { id: true, secret: true },
		});
	});

	afterAll(async () => {
		await db.mfa_credential.deleteMany({ where: { user_id: "pg-replay-user" } });
	});

	it("lets exactly one of two parallel requests with the same code through", async () => {
		const results = await Promise.all([acceptTotp(cred, code), acceptTotp(cred, code)]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await acceptTotp(cred, code)).toBe(false);
	});
});
