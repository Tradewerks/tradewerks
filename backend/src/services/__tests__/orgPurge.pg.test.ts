import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

// Real Postgres: the purge is driven by the catalog, so only a migrated schema
// can show it is right. CI sets QUOTA_TEST_DATABASE_URL after `prisma migrate
// deploy`. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

vi.mock("../emailService.js", () => ({
	sendOrganizationDeletedEmail: vi.fn(),
	sendOrganizationClosingEmail: vi.fn(),
	sendAccountDeletedEmail: vi.fn(),
}));

type Purge = typeof import("../orgPurge.js");
type Edge = import("../orgPurge.js").PurgeEdge;
type Catalog = import("../orgPurge.js").PurgeCatalog;

// Columns that end like a file column but are not one.
const NOT_FILES = new Set([
	"dispatcher_notification.action_url",
	"technician_notification.action_url",
	// The org's public review page, a link out, not a stored file.
	"organization.review_url",
	// Paired with storage_url, which is the one queued.
	"inventory_import_source.storage_key",
	"data_import_source.storage_key",
]);

describe.runIf(DB_URL)("organization purge against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let purge: Purge;
	let catalog: Catalog;
	const tag = randomUUID().slice(0, 8);
	const q = () => db as unknown as { $queryRawUnsafe: <T>(s: string, ...v: unknown[]) => Promise<T> };

	async function buildOrg(name: string) {
		const provision = await import("../provisionOrganization.js");
		const planVersionId = (await provision.latestVersionId({}))!;
		const { orgId, adminId } = await db.$transaction((tx) =>
			provision.provisionOrganization(tx, {
				org: { name: `${name} ${tag}`, email: `${name}-${tag}@example.invalid` },
				admin: { name: `${name} admin`, email: `${name}-admin-${tag}@example.invalid`, password: "x" },
				businessType: "hvac",
				planVersionId,
				source: "signup",
			}),
		);
		await db.organization.update({
			where: { id: orgId },
			data: { logo_url: `https://files.example/${name}-${tag}-logo.png` },
		});
		const tech = await db.technician.create({
			data: {
				organization_id: orgId,
				name: `${name} tech`,
				email: `${name}-tech-${tag}@example.invalid`,
				phone: "",
				password: "x",
				title: "",
				description: "",
				hire_date: new Date(),
			},
		});
		const client = await db.client.create({
			data: { organization_id: orgId, name: "Client", address: "1 Main St", coords: {} },
		});
		const job = await db.job.create({
			data: {
				organization_id: orgId,
				client_id: client.id,
				job_number: `J-${tag}`,
				name: "Job",
				description: "",
				address: "1 Main St",
				coords: {},
			},
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
		const note = await db.job_note.create({ data: { organization_id: orgId, job_id: job.id, content: "note" } });
		await db.job_note_photo.create({
			data: { note_id: note.id, photo_url: `https://files.example/${name}-${tag}-photo.jpg`, photo_label: "p" },
		});
		await db.inventory_item.create({
			data: {
				organization_id: orgId,
				name: "Item",
				description: "",
				image_urls: [`https://files.example/${name}-${tag}-item.jpg`, "data:image/png;base64,AAAA"],
			},
		});
		// Tagged by org_id with no FK; reachable only through the technician.
		await db.technician_shift.create({
			data: { tech_id: tech.id, org_id: orgId, started_at: new Date(), ended_at: new Date() },
		});
		await db.jwt_refresh_token.create({
			data: { userId: adminId, role: "admin", token: `tok-${name}-${tag}`, expiresAt: new Date(Date.now() + 3_600_000) },
		});
		await db.mfa_credential.create({ data: { user_id: tech.id, role: "technician", secret: "s" } });
		await db.mfa_recovery_code.create({ data: { user_id: tech.id, role: "technician", code: `c-${tag}` } });
		await db.log.create({
			data: {
				organization_id: orgId,
				event_type: "client.created",
				action: "created",
				entity_type: "client",
				entity_id: client.id,
				actor_type: "system",
			},
		});
		return { orgId, adminId, techId: tech.id, clientId: client.id };
	}

	// Rows of `table` an org owns, found by walking NOT NULL keys up to a table
	// tagged with the org. Independent of the purge's own marking.
	function ownerPath(table: string, depth = 0): Edge[] | null {
		const t = catalog.tables.get(table)!;
		if (table === purge.ROOT_TABLE || purge.ORG_COLUMNS.some((c) => t.columns.has(c))) return [];
		if (depth > 6) return null;
		for (const e of catalog.edges) {
			if (e.child !== table || e.childNullable || e.parent === table) continue;
			const rest = ownerPath(e.parent, depth + 1);
			if (rest) return [e, ...rest];
		}
		return null;
	}

	async function ownedCounts(orgId: string): Promise<Record<string, number>> {
		const out: Record<string, number> = {};
		for (const table of [...catalog.tables.keys()].sort()) {
			const path = ownerPath(table);
			if (!path) continue;
			const joins = path.map((e, i) => `JOIN "${e.parent}" t${i + 1} ON t${i}."${e.childCol}" = t${i + 1}."${e.parentCol}"`);
			const last = path.length === 0 ? table : path[path.length - 1].parent;
			const lastCols = last === purge.ROOT_TABLE ? ["id"] : purge.ORG_COLUMNS.filter((c) => catalog.tables.get(last)!.columns.has(c));
			const where = lastCols.map((c) => `t${path.length}."${c}" = $1`).join(" OR ");
			const [{ n }] = await q().$queryRawUnsafe<{ n: number }[]>(
				`SELECT count(*)::int AS n FROM "${table}" t0 ${joins.join(" ")} WHERE ${where}`,
				orgId,
			);
			out[table] = n;
		}
		return out;
	}

	const requestDeletion = (orgId: string) =>
		db.organization.update({ where: { id: orgId }, data: { deletion_requested_at: new Date() } });

	let a: Awaited<ReturnType<typeof buildOrg>>;
	let b: Awaited<ReturnType<typeof buildOrg>>;

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		purge = await import("../orgPurge.js");
		catalog = await purge.loadPurgeCatalog(db as never);
		a = await buildOrg("alpha");
		b = await buildOrg("bravo");
	});

	afterAll(async () => {
		for (const id of [a?.orgId, b?.orgId]) {
			if (!id || !(await db.organization.findUnique({ where: { id } }))) continue;
			await requestDeletion(id);
			await purge.purgeOrganization(id);
		}
		await db.storage_purge.deleteMany({ where: { url: { contains: tag } } });
	});

	describe("coverage", () => {
		it("classifies every table: owned by an org, keyed by a user, or global", () => {
			const plan = purge.planPurge(catalog);
			const covered = new Set([
				...plan.tables,
				...purge.USER_KEYED_TABLES.map((u) => u.table),
				...purge.GLOBAL_TABLES,
			]);
			const unclassified = [...catalog.tables.keys()].filter((t) => !covered.has(t)).sort();
			// A new table here: give it an organization_id, a NOT NULL key to an org
			// table, or list it in orgPurge.ts (USER_KEYED_TABLES / GLOBAL_TABLES).
			expect(unclassified).toEqual([]);
			expect(purge.GLOBAL_TABLES.filter((t) => plan.tables.includes(t))).toEqual([]);
		});

		it("lists only file columns that exist, and every column that looks like one", () => {
			const plan = purge.planPurge(catalog);
			const missing = purge.FILE_COLUMNS.filter((f) => !catalog.tables.get(f.table)?.columns.has(f.column));
			expect(missing).toEqual([]);
			const listed = new Set(purge.FILE_COLUMNS.map((f) => `${f.table}.${f.column}`));
			const lookalikes = plan.tables.flatMap((t) =>
				[...catalog.tables.get(t)!.columns]
					.filter((c) => /(_url|_urls|storage_key)$/.test(c))
					.map((c) => `${t}.${c}`),
			);
			// A new stored-file column: add it to FILE_COLUMNS so purged orgs lose their files.
			expect(lookalikes.filter((c) => !listed.has(c) && !NOT_FILES.has(c)).sort()).toEqual([]);
		});

		it("has no FK cycle the planner cannot order", () => {
			expect(() => purge.planPurge(catalog)).not.toThrow();
		});
	});

	it("refuses an organization whose deletion was never requested", async () => {
		await expect(purge.purgeOrganization(b.orgId)).rejects.toThrow(/never requested/);
		expect(await db.organization.findUnique({ where: { id: b.orgId } })).not.toBeNull();
	});

	it("removes every row of the organization and leaves the other one exactly as it was", async () => {
		const bBefore = await ownedCounts(b.orgId);
		const aBefore = await ownedCounts(a.orgId);
		expect(aBefore.job_visit_technician).toBe(1);
		expect(aBefore.technician_shift).toBe(1);

		await requestDeletion(a.orgId);
		const result = await purge.purgeOrganization(a.orgId);
		expect(result).toMatchObject({ orgId: a.orgId, adminEmails: [`alpha-admin-${tag}@example.invalid`] });

		const aAfter = await ownedCounts(a.orgId);
		expect(Object.entries(aAfter).filter(([, n]) => n > 0)).toEqual([]);
		expect(await ownedCounts(b.orgId)).toEqual(bBefore);
		expect(await db.organization.findUnique({ where: { id: a.orgId } })).toBeNull();
	});

	it("deletes the users' sessions and sign-in factors, and only theirs", async () => {
		expect(await db.jwt_refresh_token.count({ where: { userId: a.adminId } })).toBe(0);
		expect(await db.mfa_credential.count({ where: { user_id: a.techId } })).toBe(0);
		expect(await db.mfa_recovery_code.count({ where: { user_id: a.techId } })).toBe(0);
		expect(await db.jwt_refresh_token.count({ where: { userId: b.adminId } })).toBe(1);
		expect(await db.mfa_credential.count({ where: { user_id: b.techId } })).toBe(1);
	});

	it("queues the organization's stored files, not inline images or another org's", async () => {
		const urls = (await db.storage_purge.findMany({ where: { url: { contains: tag } } })).map((r) => r.url).sort();
		expect(urls).toEqual(
			[
				`https://files.example/alpha-${tag}-item.jpg`,
				`https://files.example/alpha-${tag}-logo.png`,
				`https://files.example/alpha-${tag}-photo.jpg`,
			].sort(),
		);
	});

	it("leaves one anonymous record that the organization existed and was purged", async () => {
		const rows = await db.log.findMany({ where: { entity_id: a.orgId } });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ event_type: "organization.purged", organization_id: null, actor_type: "system" });
	});

	it("aborts, deleting nothing, when another org's row depends on this one", async () => {
		const c = await buildOrg("charlie");
		const d = await buildOrg("delta");
		// Corrupt on purpose: delta's job hangs off charlie's client.
		await db.job.create({
			data: {
				organization_id: d.orgId,
				client_id: c.clientId,
				job_number: `X-${tag}`,
				name: "Cross",
				description: "",
				address: "",
				coords: {},
			},
		});
		const before = await ownedCounts(c.orgId);
		await requestDeletion(c.orgId);
		await expect(purge.purgeOrganization(c.orgId)).rejects.toThrow(/another organization/);
		expect(await ownedCounts(c.orgId)).toEqual(before);

		await db.job.deleteMany({ where: { job_number: `X-${tag}` } });
		for (const id of [c.orgId, d.orgId]) {
			await requestDeletion(id);
			await purge.purgeOrganization(id);
		}
	});
});
