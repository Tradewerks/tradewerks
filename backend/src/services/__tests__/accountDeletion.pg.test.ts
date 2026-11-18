import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

// Real Postgres for the scrub and the lockout. CI sets QUOTA_TEST_DATABASE_URL
// after `prisma migrate deploy`. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

const mail = vi.hoisted(() => ({
	sendAccountDeletedEmail: vi.fn(),
	sendOrganizationClosingEmail: vi.fn(),
	sendOrganizationDeletedEmail: vi.fn(),
}));
vi.mock("../emailService.js", () => mail);

const PASSWORD = "Corr3ct!horse";

describe.runIf(DB_URL)("deleting your own account, against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let svc: typeof import("../accountDeletion.js");
	const tag = randomUUID().slice(0, 8);
	let orgId: string;
	let adminId: string;
	const email = (who: string) => `${who}-${tag}@example.invalid`;

	async function addTech(who: string) {
		return db.technician.create({
			data: {
				organization_id: orgId,
				name: `Tech ${who}`,
				email: email(who),
				phone: "555-0100",
				password: await bcrypt.hash(PASSWORD, 4),
				title: "Lead",
				description: "About me",
				hire_date: new Date(),
				coords: { lat: 41.9, lng: -87.6 },
			},
		});
	}

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		svc = await import("../accountDeletion.js");
		const provision = await import("../provisionOrganization.js");
		const planVersionId = (await provision.latestVersionId({}))!;
		const password = await bcrypt.hash(PASSWORD, 4);
		({ orgId, adminId } = await db.$transaction((tx) =>
			provision.provisionOrganization(tx, {
				org: { name: `Acme ${tag}`, email: email("org") },
				admin: { name: "Ada Admin", email: email("admin"), password },
				businessType: "hvac",
				planVersionId,
				source: "signup",
			}),
		));
	});

	afterAll(async () => {
		if (!(await db.organization.findUnique({ where: { id: orgId } }))) return;
		const { purgeOrganization } = await import("../orgPurge.js");
		await db.organization.update({ where: { id: orgId }, data: { deletion_requested_at: new Date() } });
		await purgeOrganization(orgId);
	});

	it("tells a technician what deleting does, and what stands in the way", async () => {
		const tech = await addTech("blocked");
		const client = await db.client.create({ data: { organization_id: orgId, name: "C", address: "1 Main", coords: {} } });
		const job = await db.job.create({
			data: { organization_id: orgId, client_id: client.id, job_number: `J-${tag}`, name: "J", description: "", address: "", coords: {} },
		});
		const visit = await db.job_visit.create({
			data: {
				job_id: job.id,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: new Date(),
				scheduled_end_at: new Date(),
			},
		});
		await db.job_visit_technician.create({ data: { visit_id: visit.id, tech_id: tech.id } });
		const caller = { uid: tech.id, role: "technician" };

		const preview = await svc.getDeletionPreview(caller);
		expect(preview).toMatchObject({ kind: "user", confirmation: "DELETE", organization: { name: `Acme ${tag}` } });
		expect(preview.blockers).toEqual([expect.stringMatching(/1 open visit/)]);

		await expect(
			svc.deleteOwnAccount(caller, { password: PASSWORD, confirmation: "DELETE" }),
		).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNT_DELETION_BLOCKED" });
		expect((await db.technician.findUnique({ where: { id: tech.id } }))?.deleted_at).toBeNull();
	});

	it("refuses a wrong password with 403 and a wrong confirmation with 400", async () => {
		const tech = await addTech("careful");
		const caller = { uid: tech.id, role: "technician" };
		await expect(svc.deleteOwnAccount(caller, { password: "nope", confirmation: "DELETE" })).rejects.toMatchObject({
			statusCode: 403,
		});
		await expect(svc.deleteOwnAccount(caller, { password: PASSWORD, confirmation: "delete me" })).rejects.toMatchObject({
			statusCode: 400,
		});
	});

	it("scrubs a technician's personal data and keeps their work history", async () => {
		const tech = await addTech("leaving");
		const client = await db.client.create({ data: { organization_id: orgId, name: "C2", address: "", coords: {} } });
		const job = await db.job.create({
			data: { organization_id: orgId, client_id: client.id, job_number: `K-${tag}`, name: "K", description: "", address: "", coords: {} },
		});
		const visit = await db.job_visit.create({
			data: {
				job_id: job.id,
				status: "Completed",
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: new Date(),
				scheduled_end_at: new Date(),
			},
		});
		await db.job_visit_technician.create({ data: { visit_id: visit.id, tech_id: tech.id } });
		await db.jwt_refresh_token.create({
			data: { userId: tech.id, role: "technician", token: `t-${tag}`, expiresAt: new Date(Date.now() + 3_600_000) },
		});
		await db.mfa_credential.create({ data: { user_id: tech.id, role: "technician", secret: "s" } });
		await db.technician_notification.create({
			data: { technician_id: tech.id, type: "visit_assigned", title: "t", body: "b" },
		});
		await db.log.create({
			data: {
				organization_id: orgId,
				event_type: "technician.created",
				action: "created",
				entity_type: "technician",
				entity_id: tech.id,
				actor_type: "dispatcher",
				actor_id: adminId,
				changes: { email: { old: null, new: email("leaving") } },
			},
		});
		await db.log.create({
			data: {
				organization_id: orgId,
				event_type: "job_visit.started",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visit.id,
				actor_type: "technician",
				actor_id: tech.id,
				actor_name: "Tech leaving",
				ip_address: "203.0.113.9",
				user_agent: "phone",
			},
		});

		await expect(
			svc.deleteOwnAccount({ uid: tech.id, role: "technician" }, { password: PASSWORD, confirmation: "DELETE" }),
		).resolves.toEqual({ kind: "user" });

		const row = await db.technician.findUnique({ where: { id: tech.id } });
		expect(row).toMatchObject({
			name: "Deleted user",
			email: `deleted-${tech.id}@deleted.invalid`,
			phone: "",
			title: "",
			description: "",
			coords: {},
			status: "Offline",
		});
		expect(row?.deleted_at).toBeInstanceOf(Date);
		expect(row?.deactivated_at).toBeInstanceOf(Date);
		const withPassword = await db.technician.findUnique({ where: { id: tech.id }, omit: { password: false } });
		expect(await bcrypt.compare(PASSWORD, withPassword!.password)).toBe(false);

		expect(await db.jwt_refresh_token.count({ where: { userId: tech.id } })).toBe(0);
		expect(await db.mfa_credential.count({ where: { user_id: tech.id } })).toBe(0);
		expect(await db.technician_notification.count({ where: { technician_id: tech.id } })).toBe(0);
		// The employer's record of the visit stays, pointing at the scrubbed row.
		expect(await db.job_visit_technician.count({ where: { tech_id: tech.id } })).toBe(1);

		const about = await db.log.findFirst({ where: { entity_id: tech.id, event_type: "technician.created" } });
		expect(about?.changes).toBeNull();
		const by = await db.log.findFirst({ where: { entity_id: visit.id } });
		expect(by).toMatchObject({ actor_id: tech.id, actor_name: null, ip_address: null, user_agent: null });
		expect(await db.log.count({ where: { entity_id: tech.id, event_type: "account.deleted" } })).toBe(1);

		expect(mail.sendAccountDeletedEmail).toHaveBeenCalledWith(email("leaving"), `Acme ${tag}`);
		// The address is free again.
		const { loginEmailTaken } = await import("../provisionOrganization.js");
		expect(await loginEmailTaken(email("leaving"))).toBe(false);
		// And the account stays gone.
		await expect(svc.getDeletionPreview({ uid: tech.id, role: "technician" })).rejects.toMatchObject({ statusCode: 404 });
	});

	it("does not let an admin reactivate or edit an account its owner deleted", async () => {
		const tech = await addTech("gone");
		await svc.deleteOwnAccount({ uid: tech.id, role: "technician" }, { password: PASSWORD, confirmation: "DELETE" });
		const { reactivateTechnician, updateTechnician, getAllTechnicians } = await import(
			"../../controllers/techniciansController.js"
		);
		expect((await reactivateTechnician(tech.id, orgId)).err).toMatch(/deleted by its owner/);
		expect((await updateTechnician(tech.id, { name: "Back" }, orgId)).err).toMatch(/deleted by its owner/);
		expect((await getAllTechnicians(orgId)).map((t) => t.id)).not.toContain(tech.id);
	});

	it("scrubs a dispatcher the same way", async () => {
		const d = await db.dispatcher.create({
			data: {
				organization_id: orgId,
				name: "Dee Dispatch",
				email: email("dee"),
				phone: "555-0101",
				password: await bcrypt.hash(PASSWORD, 4),
				title: "Dispatcher",
				description: "",
				dashboard_layout: [{ i: "a", x: 0, y: 0, w: 1, h: 1 }],
			},
		});
		const preview = await svc.getDeletionPreview({ uid: d.id, role: "dispatcher" });
		expect(preview).toMatchObject({ kind: "user", blockers: [] });
		await svc.deleteOwnAccount({ uid: d.id, role: "dispatcher" }, { password: PASSWORD, confirmation: " DELETE " });
		const row = await db.dispatcher.findUnique({ where: { id: d.id } });
		expect(row).toMatchObject({ name: "Deleted user", phone: null, dashboard_layout: null, role: "dispatcher" });
		expect(row?.deleted_at).toBeInstanceOf(Date);
	});

	it("deletes the whole organization when the admin deletes their account", async () => {
		const member = await addTech("member");
		await db.jwt_refresh_token.create({
			data: { userId: member.id, role: "technician", token: `m-${tag}`, expiresAt: new Date(Date.now() + 3_600_000) },
		});
		const admin = { uid: adminId, role: "admin" };

		const preview = await svc.getDeletionPreview(admin);
		expect(preview).toMatchObject({
			kind: "organization",
			confirmation: `Acme ${tag}`,
			organization: { name: `Acme ${tag}`, quickbooksConnected: false },
		});

		await expect(svc.deleteOwnAccount(admin, { password: PASSWORD, confirmation: "Acme" })).rejects.toMatchObject({
			statusCode: 400,
		});
		// Case and spacing are forgiven; the name itself is not.
		await expect(
			svc.deleteOwnAccount(admin, { password: PASSWORD, confirmation: `  acme   ${tag.toUpperCase()} ` }),
		).resolves.toEqual({ kind: "organization" });

		// Locked out at once, before the purge runs.
		expect(await db.jwt_refresh_token.count({ where: { userId: member.id } })).toBe(0);

		for (let i = 0; i < 50 && (await db.organization.findUnique({ where: { id: orgId } })); i++)
			await new Promise((r) => setTimeout(r, 100));
		expect(await db.organization.findUnique({ where: { id: orgId } })).toBeNull();
		expect(await db.technician.count({ where: { organization_id: orgId } })).toBe(0);
		expect(mail.sendOrganizationClosingEmail).toHaveBeenCalledWith(email("member"), `Acme ${tag}`);
		expect(mail.sendOrganizationDeletedEmail).toHaveBeenCalledWith(email("admin"), `Acme ${tag}`);
	});
});
