import { Request, Response } from "express";
import {
    authenticateUser,
    exchangeAuthorizationCode,
    getClient,
    isRedirectUriAllowed,
    OAuthError,
    OAuthErrorCodes,
    rotateRefreshToken,
    verifyClient,
    issueAuthCode
} from '../services/oauthService.js'
import { renderConsentPage, renderError } from '../views/oauthViews.js'
import { log } from '../services/appLogger.js'
import { logActivity } from '../services/logger.js'
import { mfaChallengeFor } from "../services/mfaService.js";
import { generatePendingToken, verifyPendingToken } from "../services/jwtService.js";
import { checkMfaCode } from "./mfaController.js";


function readClientCredentials(req: Request) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Basic ")) {
        const base64Credentials = authHeader.substring(6);
        const credentials = Buffer.from(base64Credentials, "base64").toString("utf-8");
        const [client_id, client_secret] = credentials.split(":");
        if (!client_id || !client_secret) {
            throw new OAuthError(OAuthErrorCodes.INVALID_CLIENT, "Invalid client credentials", 401);
        }
        return { client_id, client_secret };
    }
    const client_id = req.body?.client_id as string | undefined;
    const client_secret = req.body?.client_secret as string | undefined;
    
    if (!client_id || !client_secret) {
        throw new OAuthError(OAuthErrorCodes.INVALID_CLIENT, "Invalid client credentials", 401);
    }
    return { client_id, client_secret };
}

export const getAuthorization = async (req: Request, res: Response) => {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = req.query as {
        client_id: string;
        redirect_uri: string;
        response_type: string;
        state?: string;
        code_challenge?: string;
        code_challenge_method?: string;
    };
    if (!client_id || !redirect_uri || !response_type) {
        return res.status(400).send(renderError("Missing required parameters"));
    }

    const client = await getClient(client_id);
    if (!client || !isRedirectUriAllowed(client, redirect_uri)) {
        log.warn({ evt: "oauth.authorize.rejected", client_id, redirect_uri, reason: !client ? "unknown_client" : "redirect_uri_mismatch" }, "OAuth authorize rejected");
        return res.status(400).send(renderError("Invalid client or redirect_uri"));
    }
    if (response_type !== "code") {
        log.warn({ evt: "oauth.authorize.unsupported_response_type", client_id, response_type }, "OAuth authorize: unsupported response_type");
        return res.redirect(`${redirect_uri}?error=unsupported_response_type&state=${encodeURIComponent(state ?? "")}`);
    }
    return res.send(renderConsentPage({ client, client_id, redirect_uri, state, code_challenge, code_challenge_method }));
}

export const postAuthorizeDecision = async (req: Request, res: Response) => {
    const { email, password, action, client_id, redirect_uri, state, code_challenge, code_challenge_method, mfa_token, code } = req.body as {
        email: string;
        password: string;
        action: string;
        client_id: string;
        redirect_uri: string;
        state?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        mfa_token?: string;
        code?: string;
    };
    if (!action || !client_id || !redirect_uri || (action !== "deny" && !mfa_token && (!email || !password))) {
        return res.status(400).send(renderError("Missing required parameters"));
    }

    const client = await getClient(client_id);
    if (!client || !isRedirectUriAllowed(client, redirect_uri)) {
        log.warn({ evt: "oauth.authorize.rejected", client_id, redirect_uri, reason: !client ? "unknown_client" : "redirect_uri_mismatch" }, "OAuth authorize decision rejected");
        return res.status(400).send(renderError("Invalid client or redirect_uri"));
    }

    if (action === "deny") {
        log.info({ evt: "oauth.consent.denied", client_id }, "OAuth consent denied by user");
        return res.redirect(`${redirect_uri}?error=access_denied&state=${encodeURIComponent(state ?? "")}`);
    }
    const params = { client, client_id, redirect_uri, state, code_challenge, code_challenge_method };
    let user: { userId: string; role: string; organizationId: string | null } | null; 
    
    if (mfa_token) {
        let pt; 
        try {
            pt = verifyPendingToken(mfa_token);
        } catch (err) {
            return res.send(renderConsentPage({ ...params, error: "Session expired, sign in again"}));
        }
        if (pt.stage !== "pending_oauth_totp") 
            return res.status(400).send(renderError("Invalid session"));

        const isTotp = /^\d{6}$/.test(code ?? "");
        const result = await checkMfaCode(pt.userId, pt.role, isTotp ? code : undefined, isTotp ? undefined : code);
        if (result !== "ok") {
            const error = result === "locked" ? "Too many attempts. Try again later." : "Invalid code";
            return res.send(renderConsentPage({ ...params, mfaStep: true, pendingToken: mfa_token, error }));
        }
        user = { userId: pt.userId, role: pt.role, organizationId: pt.organization_id };
    } else {
        user = await authenticateUser(email, password);
        if (!user) {
            log.warn({ evt: "oauth.consent.login_failed", client_id, email }, "OAuth consent login failed");
            return res.send(renderConsentPage({ ...params, error: "Invalid credentials" }));
        }
        const challenge = await mfaChallengeFor(user.userId, user.role, user.organizationId);
        if (challenge === "enroll")
            return res.send(renderConsentPage({ ...params, error: "Your organization requires MFA. Set it up in the app first." }));
        if (challenge === "totp"){
            const pendingToken = generatePendingToken({id: user.userId, organization_id: user.organizationId, email: ""}, user.role, "pending_oauth_totp");
            return res.send(renderConsentPage({ ...params, mfaStep: true, pendingToken }));
        }
    }


    const authCode = await issueAuthCode({
        clientId: client_id,
        user,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
    });
    await logActivity({
        event_type: "oauth_client.authorized",
        action: "authorized",
        entity_type: "oauth_client",
        entity_id: client_id,
        organization_id: user.organizationId,
        actor_type: user.role === "technician" ? "technician" : "dispatcher",
        actor_id: user.userId,
        reason: `Authorized OAuth client "${client.name}"`,
        ip_address: req.ip,
        user_agent: req.headers["user-agent"],
    });
    return res.redirect(`${redirect_uri}?code=${authCode}&state=${encodeURIComponent(state ?? "")}`);
}

export const postToken = async (req: Request, res: Response) => {
    try {
        const grant_type = req.body.grant_type as string;
        const creds = readClientCredentials(req);
        const ret = grant_type === "authorization_code"
        ? await exchangeAuthorizationCode({ client_id: creds.client_id, client_secret: creds.client_secret, code: req.body.code, redirect_uri: req.body.redirect_uri, code_verifier: req.body.code_verifier })
        : grant_type === "refresh_token"
        ? await (async () => {
            await verifyClient(creds.client_id, creds.client_secret);
            return rotateRefreshToken({ clientId: creds.client_id, refreshToken: req.body.refresh_token });
          })()
        : (() => { throw new OAuthError(OAuthErrorCodes.UNSUPPORTED_GRANT_TYPE, "Unsupported grant type", 400); })();
        return res.json(ret); // Raw Oauth2 json
    } catch (error) {
        if (error instanceof OAuthError) {
            log.warn({ evt: "oauth.token.error", grant_type: req.body?.grant_type, error_code: error.code, status: error.status }, "OAuth token request failed");
            return res.status(error.status).json({ error: error.code, error_description: error.description });
        }
        throw error;
    }
}