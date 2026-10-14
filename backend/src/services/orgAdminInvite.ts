import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { hashInviteToken, newInviteToken } from "../lib/inviteToken.js";
import { DAY_MS } from "../lib/dayRange.js";

export const newOrgInvite = () => newInviteToken("/accept-invite", 7 * DAY_MS);

// One message for unknown, expired and spent: the page must not reveal which.
const badInvite = () =>
	httpError(404, ErrorCodes.NOT_FOUND, "This invite link is invalid or has expired");

// Base client, not getScopedDb: the caller is signed out and the token is the only scope.
async function liveInvite(token: string) {
	const d = await db.dispatcher.findUnique({
		where: { invite_token_hash: hashInviteToken(token) },
		select: {
			id: true,
			email: true,
			invite_expires_at: true,
			organization: { select: { name: true } },
		},
	});
	if (!d || !d.invite_expires_at || d.invite_expires_at <= new Date()) throw badInvite();
	return d;
}

export async function previewOrgInvite(token: string) {
	const d = await liveInvite(token);
	return { company: d.organization?.name ?? "", email: d.email };
}

export async function acceptOrgInvite(token: string, password: string) {
	const d = await liveInvite(token);
	const hash = await bcrypt.hash(password, 10);
	const now = new Date();
	// Conditional on hash and expiry: a double submit or a resend in between loses.
	const { count } = await db.dispatcher.updateMany({
		where: {
			id: d.id,
			invite_token_hash: hashInviteToken(token),
			invite_expires_at: { gt: now },
		},
		data: {
			password: hash,
			email_verified_at: now,
			// Not null: login treats a null last_login as a temporary password to replace.
			last_login: now,
			invite_token_hash: null,
			invite_expires_at: null,
		},
	});
	if (count !== 1) throw badInvite();
	return { email: d.email };
}
