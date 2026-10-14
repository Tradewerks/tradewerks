import jwt from "jsonwebtoken";

export type StaffPendingStage = "mfa" | "enroll";
export interface StaffClaims {
	kind: "staff";
	sid: string;
	email: string;
	name: string;
	iat?: number;
}
export interface StaffPendingClaims {
	kind: "staff_pending";
	sid: string;
	stage: StaffPendingStage;
}

export function platformSecret(): string | null {
	const s = process.env.PLATFORM_JWT_SECRET;
	if (!s || s.length < 32) return null;
	// A shared secret would let a token minted on one side verify on the other.
	if (s === process.env.JWT_ACCESS_SECRET || s === process.env.OTP_SECRET)
		return null;
	return s;
}

// Express "trust proxy": a hop count, true/false, or a list of trusted proxy addresses.
export function trustProxySetting(
	raw: string | undefined,
): number | boolean | string | undefined {
	const v = raw?.trim();
	if (!v) return undefined;
	if (/^\d+$/.test(v)) return Number(v);
	if (v === "true" || v === "false") return v === "true";
	return v;
}

export function platformProxyWarning(
	env: Record<string, string | undefined>,
): string | null {
	if (!env.PLATFORM_ALLOWED_IPS?.trim() || env.TRUST_PROXY?.trim())
		return null;
	return "PLATFORM_ALLOWED_IPS is set but TRUST_PROXY is not: behind a load balancer every request carries the balancer's IP, so the allow-list and the sign-in rate limit see one address.";
}

function secret(): string {
	const s = platformSecret();
	if (!s)
		throw new Error("PLATFORM_JWT_SECRET is missing, too short, or shared");
	return s;
}

export const signStaffToken = (s: {
	id: string;
	email: string;
	name: string;
}): string =>
	jwt.sign(
		{ kind: "staff", sid: s.id, email: s.email, name: s.name },
		secret(),
		{
			expiresIn: "8h",
		},
	);

export const signStaffPending = (
	sid: string,
	stage: StaffPendingStage,
): string =>
	jwt.sign({ kind: "staff_pending", sid, stage }, secret(), {
		expiresIn: "10m",
	});

export function verifyStaffClaims(token: string): StaffClaims {
	const c = jwt.verify(token, secret(), {
		algorithms: ["HS256"],
	}) as Partial<StaffClaims>;
	if (c.kind !== "staff" || typeof c.sid !== "string")
		throw new Error("Not a staff token");
	return c as StaffClaims;
}

export function verifyStaffPending(
	token: string,
	stage: StaffPendingStage,
): StaffPendingClaims {
	const c = jwt.verify(token, secret(), {
		algorithms: ["HS256"],
	}) as Partial<StaffPendingClaims>;
	if (
		c.kind !== "staff_pending" ||
		c.stage !== stage ||
		typeof c.sid !== "string"
	)
		throw new Error("Not a pending staff token for this stage");
	return c as StaffPendingClaims;
}
