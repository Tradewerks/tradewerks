import { db } from "../db.js";
import { decryptSecret } from "./crypto.js";
import { hashRecoveryCode, KEY, matchTotpStep } from "./totpService.js";

// Accepts a TOTP code at most once. The step claim is conditional, so a replay of an accepted
// code, or a parallel request carrying the same code, loses.
export async function acceptTotp(
	cred: { id: string; secret: string },
	code: string | undefined,
): Promise<boolean> {
	// Customer routes pass req.body fields through unvalidated.
	if (typeof code !== "string") return false;
	const step = matchTotpStep(decryptSecret(cred.secret, KEY), code);
	if (step === null) return false;
	const { count } = await db.mfa_credential.updateMany({
		where: {
			id: cred.id,
			OR: [{ last_used_step: null }, { last_used_step: { lt: step } }],
		},
		data: { last_used_step: step },
	});
	return count === 1;
}

// Conditional claim: two simultaneous requests cannot both spend one recovery code.
export async function spendRecoveryCode(
	userId: string,
	role: string,
	code: string | undefined,
): Promise<boolean> {
	if (typeof code !== "string" || !code) return false;
	const row = await db.mfa_recovery_code.findFirst({
		where: { user_id: userId, role, code: hashRecoveryCode(code), used_at: null },
		select: { id: true },
	});
	if (!row) return false;
	const { count } = await db.mfa_recovery_code.updateMany({
		where: { id: row.id, used_at: null },
		data: { used_at: new Date() },
	});
	return count === 1;
}
