import { db } from "../db.js"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { generateAccessToken } from "./jwtService.js"
import { getAllPermissions } from "../lib/permissionCatalogs.js"
import { log } from "./appLogger.js"
import { logActivity } from "./logger.js"
import type { oauth_auth_code, oauth_client } from "../../generated/prisma/client.js"

// Seconds
const ACCESS_TOKEN_TTL = 900; // 15 minutes
// Milliseconds
const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days
const AUTH_CODE_TTL = 60 * 1000; // 60 seconds

const DUMMY_PASSWORD_HASH = bcrypt.hashSync("oauth-no-user", 10);

export type OAuthErrorCode = 
      "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type";

export enum OAuthErrorCodes {
    INVALID_REQUEST = "invalid_request",
    INVALID_CLIENT = "invalid_client",
    INVALID_GRANT = "invalid_grant",
    UNAUTHORIZED_CLIENT = "unauthorized_client",
    UNSUPPORTED_GRANT_TYPE = "unsupported_grant_type"
}

export class OAuthError extends Error {
    constructor(
        public readonly code: OAuthErrorCode | OAuthErrorCodes,
        public readonly description: string,
        public readonly status: number = 400,
    ){
        super(description);
        this.name = "OAuthError";
    }

}

const sha256 = (v: string) => {
    return crypto.createHash("sha256").update(v).digest("hex");
};
const randomToken = () => {
    return crypto.randomBytes(32).toString("base64url");
};

export const authenticateUser = async (email: string, password: string) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    // all emails in db are set to lower case; login is not case sensitive
    email = email.toLowerCase();
    // password is omitted globally (db.ts); opt back in for the credential check.
    const user = (await db.dispatcher.findUnique({ where: { email }, omit: { password: false } }))
              ?? (await db.technician.findUnique({ where: { email }, omit: { password: false } }));
    const ok = await bcrypt.compare(password, user?.password ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) return null;
    const role = "role" in user ? user.role : "technician";
    return { userId: user.id, role, organizationId: user.organization_id };
}

export function verifyClientSecret(client: oauth_client, clientSecret: string) {
    if (!client || !clientSecret) throw new OAuthError(OAuthErrorCodes.INVALID_CLIENT, "Missing Arguments", 401);
    const hashedSecret = sha256(clientSecret);
    const a = Buffer.from(hashedSecret);
    const b = Buffer.from(client.client_secret);
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
        throw new OAuthError(OAuthErrorCodes.INVALID_CLIENT, "Invalid client", 401);
    }
}

function verifyPkce(rec: oauth_auth_code, codeVerifier?: string) {
    if (!rec.code_challenge) return;
    if (!codeVerifier) throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "code_verifier is required", 400);
    const challenge = rec.code_challenge_method === "S256"
        ? crypto.createHash("sha256").update(codeVerifier).digest("base64url")
        : codeVerifier; 
    const a = Buffer.from(challenge);
    const b = Buffer.from(rec.code_challenge);
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
        throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "PKCE verification failed", 400);
    }
}

export const getClient = async (clientId: string) => {
    return db.oauth_client.findUnique({ where: { client_id: clientId } });
}

export const isRedirectUriAllowed = (client: oauth_client, redirectUri: string) => {
    return client.redirect_uris.includes(redirectUri);
}

export const verifyClient = async (clientId: string, clientSecret: string) => {
    const client = await getClient(clientId);
    if (!client) throw new OAuthError(OAuthErrorCodes.INVALID_CLIENT, "Unknown client", 401);
    if (client.is_confidential) verifyClientSecret(client, clientSecret);
    return client;
}

export const exchangeAuthorizationCode = async (params: { client_id: string; client_secret: string; code: string; redirect_uri: string; code_verifier?: string }) => {
    const client = await db.oauth_client.findUnique({ where: { client_id: params.client_id } });
    if (!client) throw new OAuthError(OAuthErrorCodes.INVALID_CLIENT, "Unknown client", 401);
    if (client.is_confidential) verifyClientSecret(client, params.client_secret);
    const rec = await db.oauth_auth_code.findUnique({ where: { code_hash: sha256(params.code) } });
    if (!rec) throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "Invalid authorization code", 400);
    if (rec.client_id !== client.client_id || rec.redirect_uri !== params.redirect_uri)
        throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "Invalid authorization code", 400);
    verifyPkce(rec, params.code_verifier);
    const consumed = await db.oauth_auth_code.updateMany({
        where: {
            id: rec.id,
            consumed_at: null,
            expires_at: { gt: new Date() }
        },
        data: { consumed_at: new Date() }
    });
    if (consumed.count !== 1) throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "Expired or already used", 400);
    const access_token = await mintAccessToken(rec.user_id, rec.role);
    const refresh_token = await buildRefreshToken(rec);
    log.info({ evt: "oauth.token.granted", grant: "authorization_code", client_id: client.client_id, user_id: rec.user_id, role: rec.role, organization_id: rec.organization_id }, "OAuth access token granted");
    return { access_token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token };
}

const mintAccessToken = async (userId: string, role: string): Promise<string> => {
    const user = role === "technician"
        ? await db.technician.findUnique({ where: { id: userId } })
        : await db.dispatcher.findUnique({ where: { id: userId } });
    if (!user || user.deactivated_at) throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "User no longer exists", 400);

    let orgTimezone: string | null = null;
    if (user.organization_id) {
        const org = await db.organization.findUnique({
            where: { id: user.organization_id },
            select: { timezone: true }
        });
        orgTimezone = org?.timezone ?? null;
    }

    let permissions: string[];
    if (role === "admin") {
        permissions = getAllPermissions("dispatcher");
    } else {
        const roleId = user.organization_role_id;
        if (roleId) {
            const orgRole = await db.organization_role.findUnique({
                where: { id: roleId },
                select: { permissions: true }
            });
            permissions = orgRole?.permissions ?? [];
        } else {
            permissions = [];
        }
    }

    return generateAccessToken(user, role, orgTimezone, permissions);
}

const buildRefreshToken = async (rec: oauth_auth_code): Promise<string> => {
    const token = randomToken();
    await db.oauth_refresh_token.create({
        data: {
            token_hash: sha256(token),
            client_id: rec.client_id,
            user_id: rec.user_id,
            role: rec.role,
            organization_id: rec.organization_id,
            scope: rec.scope,
            expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL)
        }
    });

    return token;
}

export const issueAuthCode = async (params: {
    clientId: string;
    user: { userId: string; role: string; organizationId: string | null };
    redirectUri: string;
    scope?: string | null;
    codeChallenge?: string | null;
    codeChallengeMethod?: string | null;
}): Promise<string> => {
    const code = randomToken();
    await db.oauth_auth_code.create({
        data: {
            code_hash: sha256(code),
            client_id: params.clientId,
            user_id: params.user.userId,
            role: params.user.role,
            organization_id: params.user.organizationId,
            redirect_uri: params.redirectUri,
            scope: params.scope,
            code_challenge: params.codeChallenge,
            code_challenge_method: params.codeChallengeMethod,
            expires_at: new Date(Date.now() + AUTH_CODE_TTL)
        }
    });
    log.info({ evt: "oauth.code.issued", client_id: params.clientId, user_id: params.user.userId, role: params.user.role, organization_id: params.user.organizationId }, "OAuth authorization code issued");
    return code;
}

export const rotateRefreshToken = async (params: { refreshToken: string; clientId: string }) => {
    const rec = await db.oauth_refresh_token.findUnique({
        where: { token_hash: sha256(params.refreshToken) }
    });
    if (!rec || rec.client_id !== params.clientId)
        throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "Invalid refresh token", 400);

    if (rec.revoked_at) {
        await db.oauth_refresh_token.updateMany({
            where: { user_id: rec.user_id, client_id: rec.client_id, revoked_at: null },
            data: { revoked_at: new Date() }
        });
        log.error({ evt: "oauth.refresh.reuse_detected", client_id: rec.client_id, user_id: rec.user_id, organization_id: rec.organization_id }, "OAuth refresh token reuse detected — revoked entire token family");
        await logActivity({
            event_type: "oauth_refresh_token.reuse_detected",
            action: "reuse_detected",
            entity_type: "oauth_refresh_token",
            entity_id: rec.id,
            organization_id: rec.organization_id,
            actor_type: "system",
            reason: `Refresh token reuse detected for user ${rec.user_id} / client ${rec.client_id}; revoked entire token family`,
        });
        throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "Refresh token reuse detected", 400);
    }

    if (rec.expires_at < new Date())
        throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "Refresh token expired", 400);

    const revoked = await db.oauth_refresh_token.updateMany({
        where: { id: rec.id, revoked_at: null },
        data: { revoked_at: new Date() }
    });
    if (revoked.count !== 1) {
        await db.oauth_refresh_token.updateMany({
            where: { user_id: rec.user_id, client_id: rec.client_id, revoked_at: null },
            data: { revoked_at: new Date() }
        });
        log.error({ evt: "oauth.refresh.reuse_detected", client_id: rec.client_id, user_id: rec.user_id, organization_id: rec.organization_id, reason: "concurrent_use" }, "OAuth refresh token reuse detected (race) — revoked entire token family");
        await logActivity({
            event_type: "oauth_refresh_token.reuse_detected",
            action: "reuse_detected",
            entity_type: "oauth_refresh_token",
            entity_id: rec.id,
            organization_id: rec.organization_id,
            actor_type: "system",
            reason: `Refresh token reuse detected (concurrent use) for user ${rec.user_id} / client ${rec.client_id}; revoked entire token family`,
        });
        throw new OAuthError(OAuthErrorCodes.INVALID_GRANT, "Refresh token reuse detected", 400);
    }

    const newToken = randomToken();
    const created = await db.oauth_refresh_token.create({
        data: {
            token_hash: sha256(newToken),
            client_id: rec.client_id,
            user_id: rec.user_id,
            role: rec.role,
            organization_id: rec.organization_id,
            scope: rec.scope,
            expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL)
        }
    });
    await db.oauth_refresh_token.update({
        where: { id: rec.id },
        data: { replaced_by: created.id }
    });

    const access_token = await mintAccessToken(rec.user_id, rec.role);
    log.info({ evt: "oauth.refresh.rotated", client_id: rec.client_id, user_id: rec.user_id, organization_id: rec.organization_id }, "OAuth refresh token rotated");
    return { access_token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token: newToken };
}