import { db } from "../db.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { log } from "../services/appLogger.js";
import {
	sendStaffInviteEmail,
	sendStaffSecurityNotice,
} from "../services/emailService.js";
import { STAFF_ROLE } from "./authService.js";
import { newInviteToken } from "../lib/inviteToken.js";

export type StaffActor = { id: string; name: string };
export type StaffRow = {
	id: string;
	email: string;
	name: string;
	status: "invited" | "active" | "disabled";
	accepted: boolean;
	mfa_enrolled: boolean;
	last_login: Date | null;
	invite_expires_at: Date | null;
	created_at: Date;
};

const INVITE_MS = 48 * 3600_000;
const select = {
	id: true,
	email: true,
	name: true,
	status: true,
	last_login: true,
	invite_expires_at: true,
	created_at: true,
} as const;

const newInvite = () => newInviteToken("/platform/invite", INVITE_MS);

type Tx = Pick<typeof db, "log">;
// Written in the action's own transaction: a security change without its audit row must not commit.
const audit = (tx: Tx, actor: StaffActor, event: string, targetId: string) =>
	tx.log.create({
		data: {
			event_type: `platform_staff.${event}`,
			action: "updated",
			entity_type: "platform_staff",
			entity_id: targetId,
			organization_id: null,
			actor_type: "platform_staff",
			actor_id: actor.id,
			actor_name: actor.name,
		},
	});

const NOTICE: Record<string, (actor: string, target: string) => string> = {
	invited: (a, t) => `${a} invited ${t} to the TradeWerks back office.`,
	invite_resent: (a, t) => `${a} sent ${t} a new back office invite link.`,
	disabled: (a, t) => `${a} disabled ${t}'s back office account.`,
	enabled: (a, t) => `${a} re-enabled ${t}'s back office account.`,
	mfa_reset: (a, t) =>
		`${a} reset ${t}'s two-step sign-in. ${t} gets an emailed setup link at the next sign-in.`,
};

async function notifyStaff(
	actor: StaffActor,
	event: keyof typeof NOTICE,
	target: { name: string; email: string },
): Promise<void> {
	try {
		const active = await db.platform_staff.findMany({
			where: { status: "active" },
			select: { email: true },
		});
		const to = [...new Set([...active.map((s) => s.email), target.email])];
		await sendStaffSecurityNotice(
			to,
			"TradeWerks back office: security change",
			`${NOTICE[event](actor.name, target.name)} If you did not expect this, tell the team right away.`,
		);
	} catch (err) {
		log.warn({ err, event }, "staff security notice failed");
	}
}

export async function listStaff(): Promise<StaffRow[]> {
	const [rows, creds] = await Promise.all([
		db.platform_staff.findMany({
			select: { ...select, password: true },
			orderBy: [{ status: "asc" }, { name: "asc" }],
		}),
		db.mfa_credential.findMany({
			where: { role: STAFF_ROLE, enabled: true },
			select: { user_id: true },
		}),
	]);
	const enrolled = new Set(creds.map((c) => c.user_id));
	return rows.map(({ password, ...r }) => ({
		...r,
		status: r.status as StaffRow["status"],
		accepted: password !== null,
		mfa_enrolled: enrolled.has(r.id),
	}));
}

export async function inviteStaff(
	actor: StaffActor,
	input: { email: string; name: string },
): Promise<{ staff: StaffRow; inviteUrl: string }> {
	const email = input.email.trim().toLowerCase();
	if (
		await db.platform_staff.findUnique({
			where: { email },
			select: { id: true },
		})
	)
		throw httpError(
			409,
			ErrorCodes.CONFLICT,
			"A staff account with this email already exists",
		);
	const inv = newInvite();
	const row = await db.$transaction(async (tx) => {
		const created = await tx.platform_staff.create({
			data: {
				email,
				name: input.name.trim(),
				status: "invited",
				invite_token_hash: inv.hash,
				invite_expires_at: inv.expires,
				invited_by_id: actor.id,
			},
			select,
		});
		await audit(tx, actor, "invited", created.id);
		return created;
	});
	await sendStaffInviteEmail(email, row.name, inv.url, actor.name);
	await notifyStaff(actor, "invited", row);
	return {
		staff: {
			...row,
			status: "invited",
			accepted: false,
			mfa_enrolled: false,
		},
		inviteUrl: inv.url,
	};
}

export async function resendInvite(
	actor: StaffActor,
	id: string,
): Promise<{ inviteUrl: string }> {
	const s = await db.platform_staff.findUnique({
		where: { id },
		select: { id: true, email: true, name: true, status: true },
	});
	if (!s)
		throw httpError(404, ErrorCodes.NOT_FOUND, "Staff member not found");
	if (s.status !== "invited")
		throw httpError(
			409,
			ErrorCodes.CONFLICT,
			"Only a pending invite can be resent",
		);
	const inv = newInvite();
	await db.$transaction(async (tx) => {
		await tx.platform_staff.update({
			where: { id },
			data: {
				invite_token_hash: inv.hash,
				invite_expires_at: inv.expires,
			},
		});
		await audit(tx, actor, "invite_resent", id);
	});
	await sendStaffInviteEmail(s.email, s.name, inv.url, actor.name);
	await notifyStaff(actor, "invite_resent", s);
	return { inviteUrl: inv.url };
}

export async function setStaffStatus(
	actor: StaffActor,
	id: string,
	status: "active" | "disabled",
): Promise<void> {
	if (id === actor.id)
		throw httpError(
			409,
			ErrorCodes.CONFLICT,
			"You can't change your own account's status.",
		);
	const target = await db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(9, 0)`;
		const s = await tx.platform_staff.findUnique({
			where: { id },
			select: {
				id: true,
				email: true,
				name: true,
				status: true,
				password: true,
			},
		});
		if (!s)
			throw httpError(
				404,
				ErrorCodes.NOT_FOUND,
				"Staff member not found",
			);
		if (status === "active") {
			if (s.status !== "disabled")
				throw httpError(
					409,
					ErrorCodes.CONFLICT,
					"Only a disabled account can be enabled",
				);
			if (s.password === null)
				throw httpError(
					409,
					ErrorCodes.CONFLICT,
					"This invite was never accepted. Invite them again instead.",
				);
			await tx.platform_staff.update({
				where: { id },
				data: { status: "active", disabled_at: null },
			});
			await audit(tx, actor, "enabled", id);
			return s;
		}
		if (s.status === "disabled") return null;
		if (
			s.status === "active" &&
			(await tx.platform_staff.count({ where: { status: "active" } })) <=
				1
		)
			throw httpError(
				409,
				ErrorCodes.CONFLICT,
				"This is the last active staff account.",
			);
		await tx.platform_staff.update({
			where: { id },
			data: {
				status: "disabled",
				disabled_at: new Date(),
				sessions_valid_after: new Date(),
				invite_token_hash: null,
				invite_expires_at: null,
				enroll_token_hash: null,
				enroll_expires_at: null,
			},
		});
		await audit(tx, actor, "disabled", id);
		return s;
	});
	if (target)
		await notifyStaff(
			actor,
			status === "active" ? "enabled" : "disabled",
			target,
		);
}

export async function resetStaffMfa(
	actor: StaffActor,
	id: string,
): Promise<void> {
	if (id === actor.id)
		throw httpError(
			409,
			ErrorCodes.CONFLICT,
			"Ask another staff member to reset your MFA.",
		);
	const s = await db.platform_staff.findUnique({
		where: { id },
		select: { id: true, email: true, name: true },
	});
	if (!s)
		throw httpError(404, ErrorCodes.NOT_FOUND, "Staff member not found");
	await db.$transaction(async (tx) => {
		await tx.mfa_credential.deleteMany({
			where: { user_id: id, role: STAFF_ROLE },
		});
		await tx.mfa_recovery_code.deleteMany({
			where: { user_id: id, role: STAFF_ROLE },
		});
		await tx.platform_staff.update({
			where: { id },
			// A link issued before the reset is dropped; the next sign-in mails a fresh one.
			data: {
				sessions_valid_after: new Date(),
				enroll_token_hash: null,
				enroll_expires_at: null,
			},
		});
		await audit(tx, actor, "mfa_reset", id);
	});
	await notifyStaff(actor, "mfa_reset", s);
}

export async function listStaffActivity() {
	const rows = await db.log.findMany({
		where: { entity_type: "platform_staff", organization_id: null },
		orderBy: { timestamp: "desc" },
		take: 100,
		select: {
			id: true,
			timestamp: true,
			event_type: true,
			actor_type: true,
			actor_name: true,
			entity_id: true,
			changes: true,
		},
	});
	const staff = await db.platform_staff.findMany({
		where: { id: { in: [...new Set(rows.map((r) => r.entity_id))] } },
		select: { id: true, name: true },
	});
	const names = new Map(staff.map((s) => [s.id, s.name]));
	return rows.map((r) => ({
		...r,
		target_name: names.get(r.entity_id) ?? null,
	}));
}
