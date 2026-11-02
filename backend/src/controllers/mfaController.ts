import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";
import {
    generateSecret,
    buildOtpAuthUri,
    generateRecoveryCodes,
    KEY
} from "../services/totpService.js";
import { encryptSecret } from "../services/crypto.js";
import { acceptTotp, spendRecoveryCode } from "../services/mfaCode.js";
import { issueAuthTokens } from "./authenticationController.js";
import { verifyPendingToken } from "../services/jwtService.js";
import { logActivity } from "../services/logger.js";
import bcrypt from "bcryptjs";
import { Response } from "express";

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const actorTypeFor = (role: string) =>
    role === "technician" ? "technician" : "dispatcher";

// Atomic increment: parallel wrong codes must all count toward the lock.
async function countFailedCode(credentialId: string): Promise<number> {
    const { failed_attempts } = await db.mfa_credential.update({
        where: { id: credentialId },
        data: { failed_attempts: { increment: 1 } },
        select: { failed_attempts: true },
    });
    if (failed_attempts >= LOCKOUT_THRESHOLD) {
        await db.mfa_credential.update({
            where: { id: credentialId },
            data: { failed_attempts: 0, locked_until: new Date(Date.now() + LOCKOUT_MS) },
        });
    }
    return failed_attempts;
}

const isLocked = (c: { locked_until: Date | null }) => !!c.locked_until && c.locked_until > new Date();

async function resolveEmailOrg(userId: string, role: string): Promise<{ email: string; orgName: string; orgId: string | null }> {
    const user = role === "technician"
        ? await db.technician.findUnique({ where: { id: userId }, select: { email: true, organization_id: true, organization: { select: { name: true } } } })
        : await db.dispatcher.findUnique({ where: { id: userId }, select: { email: true, organization_id: true, organization: { select: { name: true } } } });

    if (!user || !user.email || !user.organization) {
        throw new Error("User not found or missing email/organization");
    }
    return { email: user.email, orgName: user.organization.name, orgId: user.organization_id };
}

async function getOrgId(userId: string, role: string): Promise<string | null> {
    const user = role === "technician"
        ? await db.technician.findUnique({ where: { id: userId }, select: { organization_id: true } })
        : await db.dispatcher.findUnique({ where: { id: userId }, select: { organization_id: true } });
    return user?.organization_id ?? null;
}

export async function setupTotp(userId: string, role: string): Promise<{ otpAuthUri: string; secret: string }> {
    const { email, orgName } = await resolveEmailOrg(userId, role);
    const secret = generateSecret();
    await db.mfa_credential.upsert({
        where: { user_id_role: { user_id: userId, role } },
        create: { user_id: userId, role, secret: encryptSecret(secret, KEY), enabled: false },
        update: { secret: encryptSecret(secret, KEY), enabled: false, last_used_step: null },
    });
    const otpAuthUri = buildOtpAuthUri(secret, email, orgName);
    // Return plaintext secret once so the client can render the QR / manual entry
    return { otpAuthUri, secret };
}

export async function enableTotp(userId: string, role: string, code: string, viaEnrollToken: boolean, res: Response) {
    const credential = await db.mfa_credential.findUnique({
        where: { user_id_role: { user_id: userId, role } }
    });
    if (!credential) {
        return createErrorResponse(ErrorCodes.VALIDATION_ERROR, "Start MFA setup first");
    }
    if (credential.enabled) {
        return createErrorResponse(ErrorCodes.VALIDATION_ERROR, "MFA is already enabled");
    }
    if (!(await acceptTotp(credential, code))) {
        return createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Invalid code");
    }

    const { codes, hashed_codes } = generateRecoveryCodes();
    await db.$transaction(async (tx) => {
        await tx.mfa_credential.update({
            where: { user_id_role: { user_id: userId, role } },
            data: { enabled: true, enrolled_at: new Date(), failed_attempts: 0, locked_until: null },
        });
        await tx.mfa_recovery_code.deleteMany({ where: { user_id: userId, role } });
        await tx.mfa_recovery_code.createMany({
            data: hashed_codes.map((code) => ({ user_id: userId, role, code })),
        });
    });

    const organization_id = await getOrgId(userId, role);
    await logActivity({
        event_type: "mfa.enabled",
        action: "updated",
        entity_type: "mfa",
        entity_id: userId,
        organization_id,
        actor_type: actorTypeFor(role),
        actor_id: userId,
    });

    if (viaEnrollToken) {
        const result = await issueAuthTokens(res, userId, role);
        return { data: { backupCodes: codes, session: result?.data ?? null } };
    }
    return { data: { backupCodes: codes } };
}

export async function verifyMfa(res: Response, pendingToken: string, code?: string, backupCode?: string) {
    const pt = verifyPendingToken(pendingToken);
    if (pt.stage !== "pending_totp") {
        return createErrorResponse(ErrorCodes.INVALID_TOKEN, "Invalid session");
    }
    const credential = await db.mfa_credential.findUnique({
        where: { user_id_role: { user_id: pt.userId, role: pt.role } }
    });
    if (!credential || !credential.enabled) {
        return createErrorResponse(ErrorCodes.INVALID_TOKEN, "MFA not enabled");
    }
    if (isLocked(credential)) {
        return createErrorResponse(ErrorCodes.TOO_MANY_REQUESTS, "Too many attempts. Try again later.");
    }

    const ok =
        (await acceptTotp(credential, code)) ||
        (await spendRecoveryCode(pt.userId, pt.role, backupCode));
    if (!ok) {
        const attempts = await countFailedCode(credential.id);
        log.info({ userId: pt.userId, role: pt.role, attempts }, "MFA verify failed");
        return createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Invalid code");
    }

    await db.mfa_credential.update({
        where: { id: credential.id },
        data: { failed_attempts: 0, locked_until: null },
    });
    return issueAuthTokens(res, pt.userId, pt.role);
}

export async function disableTotp(userId: string, role: string, password?: string, code?: string, backupCode?: string) {
    // password is omitted globally (db.ts); opt back in to re-authenticate below.
    const user = role === "technician"
        ? await db.technician.findUnique({ where: { id: userId }, omit: { password: false } })
        : await db.dispatcher.findUnique({ where: { id: userId }, omit: { password: false } });
    if (!user) {
        return createErrorResponse(ErrorCodes.NOT_FOUND, "User not found");
    }

    // require password or valid TOTP code before disabling
    const credential = await db.mfa_credential.findUnique({
        where: { user_id_role: { user_id: userId, role } }
    });
    // A signed-in session must not get unlimited guesses at the factor it is removing.
    if (credential && isLocked(credential)) {
        return createErrorResponse(ErrorCodes.TOO_MANY_REQUESTS, "Too many attempts. Try again later.");
    }
    let reauthed = false;
    if (password) {
        reauthed = typeof password === "string" && await bcrypt.compare(password, user.password);
    } else if (code) {
        reauthed = !!credential && await acceptTotp(credential, code);
    } else if (backupCode) {
        reauthed = await spendRecoveryCode(userId, role, backupCode);
    }
    if (!reauthed) {
        if (credential) await countFailedCode(credential.id);
        return createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Password, code, or backup code required to disable MFA");
    }

    await db.$transaction(async (tx) => {
        await tx.mfa_credential.deleteMany({ where: { user_id: userId, role } });
        await tx.mfa_recovery_code.deleteMany({ where: { user_id: userId, role } });
    });
    await logActivity({
        event_type: "mfa.disabled",
        action: "updated",
        entity_type: "mfa",
        entity_id: userId,
        organization_id: user.organization_id ?? null,
        actor_type: actorTypeFor(role),
        actor_id: userId,
    });
    return { data: null };
}

export async function getMfaStatus(userId: string, role: string) {
    const credential = await db.mfa_credential.findUnique({
        where: { user_id_role: { user_id: userId, role } }
    });
    return { data: { enabled: credential?.enabled ?? false, enrolledAt: credential?.enrolled_at ?? null } };
}

export async function resetMfa(targetUserId: string, targetRole: string, actorId: string, actorRole: string) {
    const organization_id = await getOrgId(targetUserId, targetRole);
    // Rows carry the token role ("admin" for org admins); never touch platform_staff rows.
    const roles = targetRole === "technician" ? ["technician"] : ["admin", "dispatcher"];
    await db.$transaction(async (tx) => {
        await tx.mfa_credential.deleteMany({ where: { user_id: targetUserId, role: { in: roles } } });
        await tx.mfa_recovery_code.deleteMany({ where: { user_id: targetUserId, role: { in: roles } } });
    });
    await logActivity({
        event_type: "mfa.reset",
        action: "updated",
        entity_type: "mfa",
        entity_id: targetUserId,
        organization_id,
        actor_type: actorTypeFor(actorRole),
        actor_id: actorId,
        reason: "Admin reset of user MFA",
    });
    return { data: null };
}
