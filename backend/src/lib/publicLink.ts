import crypto from "node:crypto";
import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { getScopedDb } from "./context.js";
import { utcDayRange } from "./dayRange.js";
import { hashInviteToken } from "./inviteToken.js";

export type LinkPurpose = "unsubscribe" | "quote" | "invoice" | "visit";

export interface ResolvedLink {
	id: string;
	organization_id: string;
	purpose: LinkPurpose;
	entity_id: string;
	contact_id: string | null;
}

function secret(): string {
	const s = process.env.PUBLIC_LINK_SECRET;
	if (!s)
		throw new Error(
			"PUBLIC_LINK_SECRET is not set in environment variables",
		);
	return s;
}

// Deterministic, so one (org, purpose, entity, contact) always maps to the same
// link and callers can re-issue it per email without storing the token.
function deriveToken(
	orgId: string,
	purpose: LinkPurpose,
	entityId: string,
	contactId: string,
) {
	return crypto
		.createHmac("sha256", secret())
		.update([orgId, purpose, entityId, contactId].join("|"))
		.digest("base64url");
}

const laterExpiry = (a: Date | null, b: Date | null) =>
	a === null || b === null ? null : a > b ? a : b;

/**
 * Returns the public link URL for an entity. The same inputs yield the same token
 * (only its sha256 hash is stored); a repeat call can only extend the expiry
 * (null = never expires), except a visit link, whose expiry is set exactly. A revoked link is never revived: a new random token is
 * issued in a new row.
 */
export async function issueLink(
	orgId: string,
	p: {
		purpose: LinkPurpose;
		entityId: string;
		contactId?: string;
		expiresAt?: Date | null;
	},
): Promise<{ url: string; token: string }> {
	let token = deriveToken(orgId, p.purpose, p.entityId, p.contactId ?? "");
	const expiresAt = p.expiresAt ?? null;
	const sdb = getScopedDb(orgId);

	for (let attempt = 0; ; attempt++) {
		const tokenHash = hashInviteToken(token);
		const existing = await sdb.public_link.findFirst({
			where: { token_hash: tokenHash },
		});
		if (existing?.revoked_at) {
			token = crypto.randomBytes(32).toString("base64url");
			continue;
		}
		if (existing) {
			// A visit link follows the visit's current end, so one moved
			// earlier must not keep the old, later expiry.
			const next =
				p.purpose === "visit"
					? expiresAt
					: laterExpiry(existing.expires_at, expiresAt);
			if (next?.getTime() !== existing.expires_at?.getTime()) {
				await sdb.public_link.update({
					where: { id: existing.id },
					data: { expires_at: next },
				});
			}
			break;
		}
		try {
			await sdb.public_link.create({
				data: {
					organization_id: orgId,
					token_hash: tokenHash,
					purpose: p.purpose,
					entity_id: p.entityId,
					contact_id: p.contactId ?? null,
					expires_at: expiresAt,
				},
			});
			break;
		} catch (err) {
			// A concurrent issuer created the same deterministic row first; re-read it.
			if ((err as { code?: string }).code !== "P2002" || attempt > 2)
				throw err;
		}
	}

	const base = publicBaseUrl("FRONTEND_URL", "http://localhost:5173");
	return { url: `${base}/app/c/${token}`, token };
}

/**
 * issueLink for a link shown to a customer. Null when FRONTEND_URL is unset, so
 * a message never carries issueLink's localhost fallback.
 */
export async function issueMessageLink(
	orgId: string,
	p: Parameters<typeof issueLink>[1],
): Promise<string | null> {
	if (!process.env.FRONTEND_URL?.trim()) return null;
	return (await issueLink(orgId, p)).url;
}

type PublicUrlVar = "FRONTEND_URL" | "BACKEND_PUBLIC_URL";

/**
 * Production throws instead of using the dev fallback: a customer email with a
 * localhost link (above all an unsubscribe link) is worse than one that waits.
 * Both send paths retry a throw here, so setting the var lets them go out.
 */
function publicBaseUrl(name: PublicUrlVar, devFallback: string): string {
	const v = process.env[name]?.trim().replace(/\/+$/, "");
	if (v) return v;
	if (process.env.NODE_ENV === "production")
		throw new Error(`${name} is not set`);
	return devFallback;
}

/** Startup warning for production when a customer-link base URL is unset. */
export function publicUrlWarning(
	env: Record<string, string | undefined>,
): string | null {
	if (env.NODE_ENV !== "production") return null;
	const missing = (["FRONTEND_URL", "BACKEND_PUBLIC_URL"] as const).filter(
		(k) => !env[k]?.trim(),
	);
	if (!missing.length) return null;
	return `${missing.join(" and ")} not set: customer emails with an unsubscribe link will not send until it is.`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a link for this entity should stop working, for callers of issueLink.
 * Quote: its expiry, else the end of its valid-until day in `timezone` (the
 * picker stores that day's local midnight), else 60 days after creation. Invoice:
 * 180 days from now. Visit: a day after the scheduled end, or 30 days after it
 * was completed (the summary and shared photos live behind it). Unsubscribe:
 * never.
 */
export function linkExpiry(
	purpose: LinkPurpose,
	entity: {
		expires_at?: Date | null;
		valid_until?: Date | null;
		created_at?: Date | null;
		scheduled_end_at?: Date | null;
		status?: string;
		actual_end_at?: Date | null;
		timezone?: string | null;
	} = {},
	now = new Date(),
): Date | null {
	switch (purpose) {
		case "quote":
			return (
				entity.expires_at ??
				(entity.valid_until
					? utcDayRange(
							entity.valid_until,
							1,
							entity.timezone ?? "UTC",
						).end
					: null) ??
				new Date((entity.created_at ?? now).getTime() + 60 * DAY_MS)
			);
		case "invoice":
			return new Date(now.getTime() + 180 * DAY_MS);
		case "visit":
			if (entity.status === "Completed")
				return new Date(
					(entity.actual_end_at ?? now).getTime() + 30 * DAY_MS,
				);
			return new Date(
				(entity.scheduled_end_at ?? now).getTime() + DAY_MS,
			);
		case "unsubscribe":
			return null;
	}
}

/**
 * Sets the expiry of every live link to this visit, for every contact. A link
 * that has already expired stays dead.
 */
export async function extendVisitLinks(
	orgId: string,
	visitId: string,
	expiresAt: Date | null,
): Promise<void> {
	await getScopedDb(orgId).public_link.updateMany({
		where: {
			purpose: "visit",
			entity_id: visitId,
			revoked_at: null,
			OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
		},
		data: { expires_at: expiresAt },
	});
}

/** Null for an unknown, revoked or expired token; never throws. */
export async function resolveLink(token: string): Promise<ResolvedLink | null> {
	try {
		if (!token) return null;
		const row = await db.public_link.findUnique({
			where: { token_hash: hashInviteToken(token) },
		});
		if (!row || row.revoked_at) return null;
		if (row.expires_at && row.expires_at.getTime() <= Date.now())
			return null;
		if (!row.first_used_at) {
			await db.public_link
				.updateMany({
					where: { id: row.id, first_used_at: null },
					data: { first_used_at: new Date() },
				})
				.catch((err) =>
					log.warn(
						{ err, link_id: row.id },
						"failed to stamp public link first use",
					),
				);
		}
		return {
			id: row.id,
			organization_id: row.organization_id,
			purpose: row.purpose as LinkPurpose,
			entity_id: row.entity_id,
			contact_id: row.contact_id,
		};
	} catch {
		return null;
	}
}

/** RFC 8058 one-click headers for a marketing-style send; the POST target is the backend. */
export function unsubscribeHeaders(
	token: string,
): { Name: string; Value: string }[] {
	const base = publicBaseUrl("BACKEND_PUBLIC_URL", "http://localhost:3000");
	return [
		{
			Name: "List-Unsubscribe",
			Value: `<${base}/public/unsubscribe/one-click?t=${encodeURIComponent(token)}>`,
		},
		{ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
	];
}
