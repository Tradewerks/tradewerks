import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "../db.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { logActivity } from "../services/logger.js";
import { hashInviteToken } from "../lib/inviteToken.js";
import {
	KEY,
	buildOtpAuthUri,
	generateRecoveryCodes,
	generateSecret,
	hashRecoveryCode,
	verifyTotp,
} from "../services/totpService.js";
import { decryptSecret, encryptSecret } from "../services/crypto.js";
import {
	signStaffPending,
	signStaffToken,
	verifyStaffPending,
} from "./staffToken.js";
import { setStaffActive } from "./verifyStaffToken.js";

export const STAFF_ROLE = "platform_staff";
export const PASSWORD_SCHEMA = z.string().min(12).max(128);
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const DUMMY_HASH = bcrypt.hashSync("never-a-real-password", 10);

export type StaffSession = {
	token: string;
	staff: { id: string; email: string; name: string };
};

const invalidLogin = () =>
	httpError(401, ErrorCodes.INVALID_CREDENTIALS, "Invalid email or password");
const locked = () =>
	httpError(
		429,
		ErrorCodes.TOO_MANY_REQUESTS,
		"Too many attempts. Try again in 15 minutes.",
	);
const badInvite = () =>
	httpError(
		404,
		ErrorCodes.NOT_FOUND,
		"This invite link is invalid or has expired",
	);
const setupUnavailable = () =>
	httpError(404, ErrorCodes.NOT_FOUND, "Setup is not available");
const signInAgain = () =>
	httpError(401, ErrorCodes.INVALID_TOKEN, "Sign in again");

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) =>
	crypto.timingSafeEqual(digest(a), digest(b));

function pending<T>(fn: () => T): T {
	try {
		return fn();
	} catch {
		throw signInAgain();
	}
}

async function activeStaff(id: string) {
	const s = await db.platform_staff.findUnique({ where: { id } });
	if (!s || s.status !== "active") throw signInAgain();
	return s;
}

const auditLock = (s: { id: string }, factor: "password" | "mfa") =>
	logActivity({
		event_type: "platform_staff.locked",
		action: "updated",
		entity_type: "platform_staff",
		entity_id: s.id,
		organization_id: null,
		actor_type: "system",
		actor_name: "Lockout",
		changes: { factor: { old: null, new: factor } },
	});

async function session(s: {
	id: string;
	email: string;
	name: string;
	sessions_valid_after?: Date | null;
}): Promise<StaffSession> {
	await db.platform_staff.update({
		where: { id: s.id },
		data: { last_login: new Date() },
	});
	setStaffActive(s.id, true, s.sessions_valid_after ?? null);
	await logActivity({
		event_type: "platform_staff.login",
		action: "viewed",
		entity_type: "platform_staff",
		entity_id: s.id,
		organization_id: null,
		actor_type: "platform_staff",
		actor_id: s.id,
		actor_name: s.name,
	});
	return {
		token: signStaffToken(s),
		staff: { id: s.id, email: s.email, name: s.name },
	};
}

export async function getSetupAvailable(): Promise<boolean> {
	if (!process.env.PLATFORM_SETUP_CODE) return false;
	return (await db.platform_staff.count()) === 0;
}

export async function setupFirstStaff(input: {
	code: string;
	email: string;
	name: string;
	password: string;
}): Promise<{ pendingToken: string }> {
	const expected = process.env.PLATFORM_SETUP_CODE;
	if (!expected) throw setupUnavailable();
	if (!safeEqual(input.code, expected))
		throw httpError(403, ErrorCodes.FORBIDDEN, "Setup code is incorrect");
	const password = await bcrypt.hash(input.password, 10);
	const staff = await db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(8, 0)`;
		if ((await tx.platform_staff.count()) > 0) throw setupUnavailable();
		return tx.platform_staff.create({
			data: {
				email: input.email.trim().toLowerCase(),
				name: input.name.trim(),
				password,
				status: "active",
			},
			select: { id: true, name: true },
		});
	});
	await logActivity({
		event_type: "platform_staff.setup",
		action: "created",
		entity_type: "platform_staff",
		entity_id: staff.id,
		organization_id: null,
		actor_type: "platform_staff",
		actor_id: staff.id,
		actor_name: staff.name,
	});
	return { pendingToken: signStaffPending(staff.id, "enroll") };
}

export async function staffLogin(
	email: string,
	password: string,
): Promise<{ stage: "mfa" | "enroll"; pendingToken: string }> {
	const s = await db.platform_staff.findUnique({
		where: { email: email.trim().toLowerCase() },
		omit: { password: false },
	});
	if (!s || s.status !== "active" || !s.password) {
		await bcrypt.compare(password, DUMMY_HASH);
		throw invalidLogin();
	}
	const isLocked = !!s.locked_until && s.locked_until > new Date();
	if (!(await bcrypt.compare(password, s.password))) {
		// While locked a wrong password still gets the generic 401: a 429 would confirm the account exists.
		if (isLocked) throw invalidLogin();
		// Atomic increment: parallel wrong guesses must all count.
		const { failed_attempts } = await db.platform_staff.update({
			where: { id: s.id },
			data: { failed_attempts: { increment: 1 } },
			select: { failed_attempts: true },
		});
		if (failed_attempts >= LOCK_AFTER) {
			await db.platform_staff.update({
				where: { id: s.id },
				data: {
					failed_attempts: 0,
					locked_until: new Date(Date.now() + LOCK_MS),
				},
			});
			await auditLock(s, "password");
		}
		throw invalidLogin();
	}
	if (isLocked) throw locked();
	await db.platform_staff.update({
		where: { id: s.id },
		data: { failed_attempts: 0, locked_until: null },
	});
	const cred = await db.mfa_credential.findUnique({
		where: { user_id_role: { user_id: s.id, role: STAFF_ROLE } },
	});
	const stage = cred?.enabled ? "mfa" : "enroll";
	return { stage, pendingToken: signStaffPending(s.id, stage) };
}

export async function staffVerifyMfa(
	pendingToken: string,
	input: { code?: string; recoveryCode?: string },
): Promise<StaffSession> {
	const p = pending(() => verifyStaffPending(pendingToken, "mfa"));
	const s = await activeStaff(p.sid);
	const cred = await db.mfa_credential.findUnique({
		where: { user_id_role: { user_id: s.id, role: STAFF_ROLE } },
	});
	if (!cred?.enabled) throw signInAgain();
	if (cred.locked_until && cred.locked_until > new Date()) throw locked();

	let ok =
		!!input.code && verifyTotp(decryptSecret(cred.secret, KEY), input.code);
	if (!ok && input.recoveryCode) {
		const row = await db.mfa_recovery_code.findFirst({
			where: {
				user_id: s.id,
				role: STAFF_ROLE,
				code: hashRecoveryCode(input.recoveryCode),
				used_at: null,
			},
		});
		// Conditional claim: two simultaneous logins cannot both spend one code.
		ok =
			!!row &&
			(
				await db.mfa_recovery_code.updateMany({
					where: { id: row.id, used_at: null },
					data: { used_at: new Date() },
				})
			).count === 1;
	}
	if (!ok) {
		const { failed_attempts } = await db.mfa_credential.update({
			where: { id: cred.id },
			data: { failed_attempts: { increment: 1 } },
			select: { failed_attempts: true },
		});
		if (failed_attempts >= LOCK_AFTER) {
			await db.mfa_credential.update({
				where: { id: cred.id },
				data: {
					failed_attempts: 0,
					locked_until: new Date(Date.now() + LOCK_MS),
				},
			});
			await auditLock(s, "mfa");
		}
		throw httpError(401, ErrorCodes.INVALID_CREDENTIALS, "Invalid code");
	}
	await db.mfa_credential.update({
		where: { id: cred.id },
		data: { failed_attempts: 0, locked_until: null },
	});
	return session(s);
}

export async function staffEnrollStart(
	pendingToken: string,
): Promise<{ otpAuthUri: string; secret: string }> {
	const p = pending(() => verifyStaffPending(pendingToken, "enroll"));
	const s = await activeStaff(p.sid);
	const existing = await db.mfa_credential.findUnique({
		where: { user_id_role: { user_id: s.id, role: STAFF_ROLE } },
	});
	if (existing?.enabled)
		throw httpError(409, ErrorCodes.CONFLICT, "MFA is already set up");
	const secret = generateSecret();
	await db.mfa_credential.upsert({
		where: { user_id_role: { user_id: s.id, role: STAFF_ROLE } },
		create: {
			user_id: s.id,
			role: STAFF_ROLE,
			secret: encryptSecret(secret, KEY),
			enabled: false,
		},
		update: { secret: encryptSecret(secret, KEY), enabled: false },
	});
	return {
		otpAuthUri: buildOtpAuthUri(secret, s.email, "TradeWerks Back Office"),
		secret,
	};
}

export async function staffEnrollFinish(
	pendingToken: string,
	code: string,
): Promise<StaffSession & { recoveryCodes: string[] }> {
	const p = pending(() => verifyStaffPending(pendingToken, "enroll"));
	const s = await activeStaff(p.sid);
	const cred = await db.mfa_credential.findUnique({
		where: { user_id_role: { user_id: s.id, role: STAFF_ROLE } },
	});
	if (!cred)
		throw httpError(400, ErrorCodes.BAD_REQUEST, "Start MFA setup first");
	if (cred.enabled)
		throw httpError(409, ErrorCodes.CONFLICT, "MFA is already set up");
	if (!verifyTotp(decryptSecret(cred.secret, KEY), code))
		throw httpError(401, ErrorCodes.INVALID_CREDENTIALS, "Invalid code");
	const { codes, hashed_codes } = generateRecoveryCodes();
	await db.$transaction(async (tx) => {
		await tx.mfa_credential.update({
			where: { id: cred.id },
			data: {
				enabled: true,
				enrolled_at: new Date(),
				failed_attempts: 0,
				locked_until: null,
			},
		});
		await tx.mfa_recovery_code.deleteMany({
			where: { user_id: s.id, role: STAFF_ROLE },
		});
		await tx.mfa_recovery_code.createMany({
			data: hashed_codes.map((c) => ({
				user_id: s.id,
				role: STAFF_ROLE,
				code: c,
			})),
		});
	});
	return { ...(await session(s)), recoveryCodes: codes };
}

async function liveInvite(token: string) {
	const s = await db.platform_staff.findUnique({
		where: { invite_token_hash: hashInviteToken(token) },
	});
	if (
		!s ||
		s.status !== "invited" ||
		!s.invite_expires_at ||
		s.invite_expires_at <= new Date()
	)
		throw badInvite();
	return s;
}

export async function previewInvite(
	token: string,
): Promise<{ email: string; name: string }> {
	const s = await liveInvite(token);
	return { email: s.email, name: s.name };
}

export async function acceptInvite(
	token: string,
	name: string,
	password: string,
): Promise<{ pendingToken: string }> {
	const s = await liveInvite(token);
	const hash = await bcrypt.hash(password, 10);
	// Conditional on the token hash and status: a link spent in parallel loses.
	const { count } = await db.platform_staff.updateMany({
		where: {
			id: s.id,
			invite_token_hash: hashInviteToken(token),
			status: "invited",
		},
		data: {
			name: name.trim(),
			password: hash,
			status: "active",
			invite_token_hash: null,
			invite_expires_at: null,
		},
	});
	if (count !== 1) throw badInvite();
	setStaffActive(s.id, true, s.sessions_valid_after);
	await logActivity({
		event_type: "platform_staff.invite_accepted",
		action: "updated",
		entity_type: "platform_staff",
		entity_id: s.id,
		organization_id: null,
		actor_type: "platform_staff",
		actor_id: s.id,
		actor_name: name.trim(),
	});
	return { pendingToken: signStaffPending(s.id, "enroll") };
}
