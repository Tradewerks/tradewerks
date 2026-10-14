import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";
import {
    generateSecret,
    buildOtpAuthUri,
    verifyTotp,
    generateRecoveryCodes,
    hashRecoveryCode,
    KEY
} from "../services/totpService.js";
import { encryptSecret, decryptSecret } from "../services/crypto.js";
import { issueAuthTokens } from "./authenticationController.js";
import { verifyPendingToken } from "../services/jwtService.js";
import { logActivity } from "../services/logger.js";
import bcrypt from "bcryptjs";
import { Response } from "express";

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const actorTypeFor = (role: string) =>
    role === "technician" ? "technician" : "dispatcher";

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
        update: { secret: encryptSecret(secret, KEY), enabled: false },
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
    if (!verifyTotp(decryptSecret(credential.secret, KEY), code)) {
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
    if (credential.locked_until && credential.locked_until > new Date()) {
        return createErrorResponse(ErrorCodes.TOO_MANY_REQUESTS, "Too many attempts. Try again later.");
    }

    let ok = false;
    if (code) {
        ok = verifyTotp(decryptSecret(credential.secret, KEY), code);
    }
    if (!ok && backupCode) {
        const row = await db.mfa_recovery_code.findFirst({
            where: { user_id: pt.userId, role: pt.role, code: hashRecoveryCode(backupCode), used_at: null },
        });
        if (row) {
            await db.mfa_recovery_code.update({ where: { id: row.id }, data: { used_at: new Date() } });
            ok = true;
        }
    }

    if (!ok) {
        const attempts = credential.failed_attempts + 1;
        await db.mfa_credential.update({
            where: { id: credential.id },
            data: {
                failed_attempts: attempts,
                locked_until: attempts >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MS) : null,
            },
        });
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
    let reauthed = false;
    if (password) {
        reauthed = await bcrypt.compare(password, user.password);
    } else if (code) {
        const credential = await db.mfa_credential.findUnique({
            where: { user_id_role: { user_id: userId, role } }
        });
        reauthed = !!credential && verifyTotp(decryptSecret(credential.secret, KEY), code);
    } else if (backupCode) {
        const row = await db.mfa_recovery_code.findFirst({
            where: { user_id: userId, role, code: hashRecoveryCode(backupCode), used_at: null },
        });
        reauthed = !!row;
    }
    if (!reauthed) {
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
