import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
} from "../types/responses.js";
import {
    handleCallback,
    buildAuthorizationUrl,
    mintHandoffCode,
    consumeHandoffCode,
    getAvailableProviders,
    SSO_ENABLED,
} from "../services/ssoService.js";
import { getScopedDb } from '../lib/context.js';
import { issueAuthTokens } from '../controllers/authenticationController.js';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
const isProd = process.env.NODE_ENV === "production";

// SSO is temporarily disabled (see ssoService.SSO_ENABLED). /providers still
// responds (getAvailableProviders returns []) so the login page renders cleanly;
// the initiation/exchange routes short-circuit with a 404.
function requireSsoEnabled(_req: Request, res: Response, next: NextFunction) {
    if (!SSO_ENABLED) {
        return res
            .status(404)
            .json(createErrorResponse(ErrorCodes.NOT_FOUND, "SSO is disabled"));
    }
    next();
}

function readCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie ?? "";
    const match = header.split(";").find((c) => c.trim().startsWith(name + "="));
    return match
        ? decodeURIComponent(match.trim().slice(name.length + 1))
        : undefined;
}

router.get("/providers", (_req, res) => {
    return res.json(createSuccessResponse({ providers: getAvailableProviders() }));
});

router.get("/start", requireSsoEnabled, async (req, res) => {
    const provider = req.query.provider as "google" | "microsoft";
    if (!provider) {
        return res
            .status(400)
            .json(createErrorResponse(ErrorCodes.INVALID_INPUT, "Missing provider"));
    }
    //if (!config) return res.redirect(`${FRONTEND_URL}/app/login?sso=error`);

    const { url, state, nonce, codeVerifier } = await buildAuthorizationUrl(provider);

    res.cookie(
        "sso_state",
        JSON.stringify({ provider, state, nonce, codeVerifier }),
        { httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 1000 * 60 * 10 }
    );

    return res.redirect(url);
});

router.get("/callback", requireSsoEnabled, async (req, res) => {
    const raw = readCookie(req, "sso_state");
    res.clearCookie("sso_state");
    const ssoState = raw ? JSON.parse(raw) : null;
    if (!ssoState || req.query.state !== ssoState.state) {
        return res.redirect(`${FRONTEND_URL}/app/login?sso=error`);
    }
    //if (!config) return res.redirect(`${FRONTEND_URL}/app/login?sso=error`);

    let email: string;
    try {
        ({ email } = (await handleCallback(
            ssoState.provider,
            new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`),
            ssoState
        )) as { email: string });
    } catch (error) {
        return res.redirect(`${FRONTEND_URL}/app/login?sso=error`);
    }

    const sdb = getScopedDb(ssoState.orgId);
    const user =
        (await sdb.technician.findFirst({ where: { email } })) ??
        (await sdb.dispatcher.findFirst({ where: { email } }));
    if (!user) return res.redirect(`${FRONTEND_URL}/app/login?sso=error`);

    const role = "role" in user ? user.role : "technician";
    const code = await mintHandoffCode(user.id, role);
    return res.redirect(`${FRONTEND_URL}/app/auth/sso/complete?code=${code}`);
});

router.post("/exchange", requireSsoEnabled, async (req, res) => {
    const code = req.body.code as string;
    const response = await consumeHandoffCode(code);
    if (!response) {
        return res
            .status(401)
            .json(createErrorResponse(ErrorCodes.INVALID_TOKEN, "Invalid code"));
    }
    const result = await issueAuthTokens(res, response.userId, response.role);
    if (!result || !result.data) {
        return res
            .status(500)
            .json(createErrorResponse(ErrorCodes.SERVER_ERROR, "Unable to issue auth tokens"));
    }
    return res.json(createSuccessResponse(result.data));
});

export default router;
