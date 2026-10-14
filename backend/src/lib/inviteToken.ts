import crypto from "node:crypto";

// Only the hash is stored; the raw token travels once, inside the emailed link.
export const hashInviteToken = (token: string) =>
	crypto.createHash("sha256").update(token).digest("hex");

export function newInviteToken(path: string, ttlMs: number) {
	const token = crypto.randomBytes(32).toString("base64url");
	const base = process.env.FRONTEND_URL ?? "http://localhost:5173";
	return {
		token,
		hash: hashInviteToken(token),
		expires: new Date(Date.now() + ttlMs),
		url: `${base}${path}?token=${token}`,
	};
}
