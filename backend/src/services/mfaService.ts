import { db } from "../db.js";
import { getEntitlements } from "./entitlementService.js";

export async function getMfaEnabledUserIds(userIds: string[]): Promise<Set<string>> {
	if (userIds.length === 0) return new Set();
	const rows = await db.mfa_credential.findMany({
		where: { user_id: { in: userIds }, enabled: true },
		select: { user_id: true },
	});
	return new Set(rows.map((r) => r.user_id));
}

export async function isMfaEnabled(userId: string): Promise<boolean> {
	const cred = await db.mfa_credential.findFirst({
		where: { user_id: userId, enabled: true },
		select: { id: true },
	});
	return !!cred;
}

export async function mfaChallengeFor(userId: string, role: string, orgId: string | null): Promise<"totp" | "enroll" | null> {
	// enrolled authenticator
	const mfa_cred = await db.mfa_credential.findFirst({
		where: {
			user_id: userId,
			role: role,
			enabled: true
		},
		select: { id: true }
	});
	if (mfa_cred) return "totp";

	// org enforced mfa & user not enrolled
	if (!orgId) return null;
	const org = await db.organization.findUnique({
		where: { id: orgId },
		select: { mfa_required: true },
	});
	if (!org?.mfa_required) return null;

	// enforced MFA needs security+; a failed lookup keeps enforcing
	const securityPlusOff = await getEntitlements(orgId)
		.then((e)=> e.modules.security_plus !== "on")
		.catch(() => false);
	return securityPlusOff ? null : "enroll";
}
