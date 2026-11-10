import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";

// The callback is public, so `state` is the only proof of which org and user began the flow.
// A distinct audience keeps access tokens from being replayed as state; the derived key keeps
// state from being replayed as an access token.
const AUDIENCE = "qb-oauth-state";
const TTL_SECONDS = 600;

function secret(): Buffer {
	const s = process.env.JWT_ACCESS_SECRET;
	if (!s) throw new Error("JWT_ACCESS_SECRET is not defined in environment variables");
	return createHmac("sha256", s).update("qb-oauth-state").digest();
}

export function signQbOAuthState(orgId: string, userId: string, now?: Date): string {
	const iat = Math.floor((now ?? new Date()).getTime() / 1000);
	return jwt.sign({ org: orgId, uid: userId, iat }, secret(), {
		audience: AUDIENCE,
		expiresIn: TTL_SECONDS,
	});
}

export function verifyQbOAuthState(
	state: string,
	now?: Date,
): { orgId: string; userId: string } | null {
	try {
		const payload = jwt.verify(state, secret(), {
			audience: AUDIENCE,
			algorithms: ["HS256"],
			...(now ? { clockTimestamp: Math.floor(now.getTime() / 1000) } : {}),
		}) as { org?: unknown; uid?: unknown };
		if (typeof payload.org !== "string" || typeof payload.uid !== "string") return null;
		return { orgId: payload.org, userId: payload.uid };
	} catch {
		return null;
	}
}
