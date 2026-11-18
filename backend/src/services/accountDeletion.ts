import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { OPEN_VISIT_STATUSES } from "../lib/entitlements/seats.js";
import { logActivity } from "./logger.js";
import { log } from "./appLogger.js";
import { setUserActive } from "./userActiveCache.js";
import { getSocket } from "./socketService.js";
import { sendAccountDeletedEmail, sendOrganizationClosingEmail } from "./emailService.js";
import { runOrgPurge } from "./orgPurge.js";

// A person can delete their own account from their profile.
//
// Dispatchers and technicians: their row is scrubbed of personal data and kept,
// so the visits, time entries, notes and invoices they touched still belong to
// someone. That history is the employer's business record; the person's name,
// contact details, credentials, sessions and preferences are theirs, and go.
//
// The admin (the account that created the organization; there is one per org)
// cannot leave it ownerless, so deleting that account deletes the organization:
// everyone is signed out at once, then services/orgPurge.ts removes the data.

export const USER_CONFIRMATION = "DELETE";
export const DELETED_USER_NAME = "Deleted user";

export interface Caller {
	uid: string;
	role: string;
	organization_id?: string | null;
}

export interface ActorContext {
	userAgent?: string;
}

type Account = {
	table: "dispatcher" | "technician";
	id: string;
	orgId: string;
	email: string;
	isAdmin: boolean;
};

async function loadAccount(caller: Caller): Promise<Account & { password: string }> {
	const where = { id: caller.uid };
	const row =
		caller.role === "technician"
			? await db.technician.findUnique({
					where,
					select: { id: true, organization_id: true, email: true, password: true, deactivated_at: true, deleted_at: true },
				})
			: await db.dispatcher.findUnique({
					where,
					select: {
						id: true,
						organization_id: true,
						email: true,
						password: true,
						role: true,
						deactivated_at: true,
						deleted_at: true,
					},
				});
	if (!row || row.deleted_at || row.deactivated_at || !row.organization_id)
		throw httpError(404, ErrorCodes.NOT_FOUND, "Account not found");
	return {
		table: caller.role === "technician" ? "technician" : "dispatcher",
		id: row.id,
		orgId: row.organization_id,
		email: row.email,
		password: row.password,
		// The role column, not the token: a stale token must not decide this.
		isAdmin: "role" in row && row.role === "admin",
	};
}

async function blockersFor(account: Account): Promise<string[]> {
	if (account.table !== "technician") return [];
	const blockers: string[] = [];
	const open = await db.job_visit_technician.count({
		where: { tech_id: account.id, visit: { status: { in: [...OPEN_VISIT_STATUSES] } } },
	});
	if (open > 0)
		blockers.push(
			`You're assigned to ${open} open ${open === 1 ? "visit" : "visits"}. Ask your dispatcher to reassign ${open === 1 ? "it" : "them"} first.`,
		);
	const clockedIn = await db.technician_shift.count({ where: { tech_id: account.id, ended_at: null } });
	if (clockedIn > 0) blockers.push("You're clocked in. Clock out first.");
	return blockers;
}

export async function getDeletionPreview(caller: Caller) {
	const account = await loadAccount(caller);
	const org = await db.organization.findUnique({
		where: { id: account.orgId },
		select: { name: true, qb_realm_id: true, qb_access_token: true },
	});
	if (!org) throw httpError(404, ErrorCodes.NOT_FOUND, "Account not found");

	if (!account.isAdmin) {
		return {
			kind: "user" as const,
			confirmation: USER_CONFIRMATION,
			organization: { name: org.name },
			blockers: await blockersFor(account),
		};
	}

	const where = { organization_id: account.orgId };
	const people = { organization_id: account.orgId, deleted_at: null };
	const [dispatchers, technicians, clients, jobs, invoices] = await Promise.all([
		db.dispatcher.count({ where: people }),
		db.technician.count({ where: people }),
		db.client.count({ where }),
		db.job.count({ where }),
		db.invoice.count({ where }),
	]);
	return {
		kind: "organization" as const,
		confirmation: org.name,
		organization: {
			name: org.name,
			users: dispatchers + technicians,
			clients,
			jobs,
			invoices,
			quickbooksConnected: !!(org.qb_realm_id && org.qb_access_token),
		},
		blockers: [] as string[],
	};
}

const deleteBodySchema = z.object({
	password: z.string().min(1, "Enter your password").max(128),
	confirmation: z.string().max(500),
});

const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export async function deleteOwnAccount(caller: Caller, body: unknown, context: ActorContext = {}) {
	const parsed = deleteBodySchema.safeParse(body);
	if (!parsed.success) throw httpError(400, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message);

	const account = await loadAccount(caller);
	// 403, not 401: a 401 makes the app try a token refresh and sign out.
	if (!(await bcrypt.compare(parsed.data.password, account.password)))
		throw httpError(403, ErrorCodes.INVALID_CREDENTIALS, "That password isn't right");

	if (account.isAdmin) {
		const org = await db.organization.findUnique({ where: { id: account.orgId }, select: { name: true } });
		if (!org || normalize(parsed.data.confirmation) !== normalize(org.name))
			throw httpError(400, ErrorCodes.VALIDATION_ERROR, `Type ${org?.name ?? "the organization name"} to confirm`);
		return requestOrganizationDeletion(account, org.name, context);
	}

	if (parsed.data.confirmation.trim() !== USER_CONFIRMATION)
		throw httpError(400, ErrorCodes.VALIDATION_ERROR, `Type ${USER_CONFIRMATION} to confirm`);
	const blockers = await blockersFor(account);
	if (blockers.length > 0) throw httpError(409, ErrorCodes.ACCOUNT_DELETION_BLOCKED, blockers.join(" "));
	return anonymizeAccount(account, context);
}

const disconnect = (room: string) => {
	try {
		getSocket().in(room).disconnectSockets(true);
	} catch (err) {
		log.warn({ err, room }, "sockets not disconnected after account deletion");
	}
};

// ── One person ─────────────────────────────────────────────────────────────

async function anonymizeAccount(account: Account, context: ActorContext) {
	const now = new Date();
	const { id, orgId } = account;
	// Nobody knows this password, so the row can never be signed in to again.
	const lockedPassword = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
	// Unique (the column is) and undeliverable (.invalid is reserved), and it
	// frees the real address for a future signup.
	const tombstoneEmail = `deleted-${id}@deleted.invalid`;
	const orgName = (await db.organization.findUnique({ where: { id: orgId }, select: { name: true } }))?.name ?? "your organization";

	await db.$transaction(async (tx) => {
		const scrubbed = {
			name: DELETED_USER_NAME,
			email: tombstoneEmail,
			password: lockedPassword,
			title: "",
			description: "",
			theme: "system",
			password_reset_token: null,
			password_reset_token_expires_at: null,
			deactivated_at: now,
			deleted_at: now,
		};
		// updateMany with the guard: two tabs deleting at once scrub the row once.
		const updated =
			account.table === "technician"
				? await tx.technician.updateMany({
						where: { id, deleted_at: null },
						data: {
							...scrubbed,
							phone: "",
							coords: {},
							last_ping_at: null,
							status: "Offline",
							current_vehicle_id: null,
						},
					})
				: await tx.dispatcher.updateMany({
						where: { id, deleted_at: null },
						data: {
							...scrubbed,
							phone: null,
							email_verification_token: null,
							email_verified_at: null,
							invite_token_hash: null,
							invite_expires_at: null,
							muted_notification_types: [],
							dashboard_layout: Prisma.DbNull,
							report_layout: Prisma.DbNull,
							kpi_layout: Prisma.DbNull,
						},
					});
		if (updated.count === 0) throw httpError(404, ErrorCodes.NOT_FOUND, "Account not found");

		// Sessions, sign-in factors and connected apps.
		await tx.jwt_refresh_token.deleteMany({ where: { userId: id } });
		await tx.otp_verification.deleteMany({ where: { userId: id } });
		await tx.mfa_recovery_code.deleteMany({ where: { user_id: id } });
		await tx.mfa_credential.deleteMany({ where: { user_id: id } });
		await tx.sso_handoff.deleteMany({ where: { user_id: id } });
		await tx.oauth_auth_code.deleteMany({ where: { user_id: id } });
		await tx.oauth_refresh_token.deleteMany({ where: { user_id: id } });
		// Their own things: AI assistant chats (messages cascade), inbox, favorites.
		await tx.assistant_conversation.deleteMany({ where: { user_id: id } });
		if (account.table === "technician") {
			await tx.technician_notification.deleteMany({ where: { technician_id: id } });
		} else {
			await tx.dispatcher_notification.deleteMany({ where: { dispatcher_id: id } });
			await tx.report_favorite.deleteMany({ where: { dispatcher_id: id } });
		}

		// The audit trail keeps what happened and when, not who they were: the
		// account's own create/update entries carry their name, email and phone.
		await tx.log.updateMany({
			where: { actor_id: id },
			data: { actor_name: null, ip_address: null, user_agent: null },
		});
		await tx.log.updateMany({
			where: { entity_id: id, entity_type: { in: ["dispatcher", "technician", "user"] } },
			data: { changes: Prisma.DbNull },
		});

		await logActivity({
			event_type: "account.deleted",
			action: "deleted",
			entity_type: account.table,
			entity_id: id,
			organization_id: orgId,
			actor_type: account.table,
			actor_id: id,
			user_agent: context.userAgent,
		});
	});

	setUserActive(id, false);
	disconnect(account.table === "technician" ? `tech:${id}` : `dispatcher:${id}`);
	log.info({ evt: "account.deleted", userId: id, orgId }, "Account deleted by its owner");
	void sendAccountDeletedEmail(account.email, orgName);
	return { kind: "user" as const };
}

// ── The whole organization ─────────────────────────────────────────────────

async function requestOrganizationDeletion(account: Account, orgName: string, context: ActorContext) {
	const now = new Date();
	const orgId = account.orgId;

	const members = await db.$transaction(async (tx) => {
		const claimed = await tx.organization.updateMany({
			where: { id: orgId, deletion_requested_at: null },
			data: { deletion_requested_at: now, deletion_attempts: 0 },
		});
		if (claimed.count === 0) return null;

		const active = { organization_id: orgId, deactivated_at: null, deleted_at: null };
		const [dispatchers, technicians] = await Promise.all([
			tx.dispatcher.findMany({ where: active, select: { id: true, email: true, role: true } }),
			tx.technician.findMany({ where: active, select: { id: true, email: true } }),
		]);
		const everyone = await Promise.all([
			tx.dispatcher.findMany({ where: { organization_id: orgId }, select: { id: true } }),
			tx.technician.findMany({ where: { organization_id: orgId }, select: { id: true } }),
		]);
		const allIds = everyone.flat().map((u) => u.id);

		// Lock everyone out now; the purge may take a while on a big org.
		await tx.dispatcher.updateMany({ where: active, data: { deactivated_at: now } });
		await tx.technician.updateMany({ where: active, data: { deactivated_at: now, status: "Offline" } });
		await tx.jwt_refresh_token.deleteMany({ where: { userId: { in: allIds } } });
		await tx.oauth_refresh_token.deleteMany({ where: { organization_id: orgId } });

		await logActivity({
			event_type: "organization.deletion_requested",
			action: "deleted",
			entity_type: "organization",
			entity_id: orgId,
			organization_id: orgId,
			actor_type: "dispatcher",
			actor_id: account.id,
			user_agent: context.userAgent,
		});
		return { dispatchers, technicians, allIds };
	});

	// Already requested (a second tab, a retried request): the purge is on its way.
	if (!members) return { kind: "organization" as const };

	for (const uid of members.allIds) setUserActive(uid, false);
	disconnect(`org:${orgId}`);
	log.info({ evt: "org.deletion_requested", orgId, users: members.allIds.length }, "Organization deletion requested by its admin");

	const notify = [
		...members.dispatchers.filter((d) => d.id !== account.id && d.role !== "admin"),
		...members.technicians,
	];
	// Not awaited: the admin's request returns now, members hear why their sign-in
	// stopped working, and the purge runs on. A crash before the purge finishes is
	// picked up by the sweeper (startOrgPurgeSweeper).
	setImmediate(async () => {
		for (const m of notify) await sendOrganizationClosingEmail(m.email, orgName);
		await runOrgPurge(orgId);
	});
	return { kind: "organization" as const };
}
