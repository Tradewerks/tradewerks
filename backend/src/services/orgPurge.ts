import { db } from "../db.js";
import { log } from "./appLogger.js";
import { deleteFiles, isOwnBucketUrl, storageConfigured } from "./wasabiService.js";
import { deleteImportSource, isLocalImportSource } from "./inventoryImport/sourceStorage.js";
import { sendOrganizationDeletedEmail } from "./emailService.js";

// Removes an organization and every row that belongs to it. The FK graph is read
// from the Postgres catalog at run time rather than listed by hand: the schema
// has ~120 tables and grows every few weeks, and a hand-kept list goes stale the
// first time someone adds a table. orgPurgeCoverage.pg.test.ts fails when a new
// table is neither reachable from the organization nor classified below.
//
// A row belongs to the org when it carries the org's id in an org column, or when
// it cannot exist without a row that belongs to the org (a NOT NULL or ON DELETE
// CASCADE foreign key to it). Rows that only point at org rows through a nullable
// RESTRICT key are detached (the key is set to NULL), never deleted, so the purge
// can only ever remove an org's own rows. A marked row tagged with a *different*
// org aborts the whole purge.

export const ROOT_TABLE = "organization";
export const ORG_COLUMNS = ["organization_id", "org_id"] as const;

// Per-user rows keyed by a plain user id (no FK, no org column). The purge
// deletes them for every dispatcher and technician it removes.
export const USER_KEYED_TABLES: readonly { table: string; column: string }[] = [
	{ table: "jwt_refresh_token", column: "userId" },
	{ table: "otp_verification", column: "userId" },
	{ table: "mfa_recovery_code", column: "user_id" },
	{ table: "mfa_credential", column: "user_id" },
	{ table: "sso_handoff", column: "user_id" },
];

// Platform-wide tables no organization owns. Listed so the coverage test can
// tell "deliberately global" from "forgotten".
export const GLOBAL_TABLES: readonly string[] = [
	"_prisma_migrations",
	"oauth_client",
	"plan",
	"plan_version",
	"platform_staff",
	"storage_purge",
	"tax_address_resolution",
	"tax_rate_set",
	"tax_rate_set_component",
];

// Columns holding a stored file's URL. Their values are queued in storage_purge
// inside the purge transaction and deleted from storage after it commits. Only
// URLs that can be ours are queued; inline data: images have nothing to delete.
export const FILE_COLUMNS: readonly { table: string; column: string; array?: true }[] = [
	{ table: "organization", column: "logo_url" },
	{ table: "job_note_photo", column: "photo_url" },
	{ table: "project_note_photo", column: "photo_url" },
	{ table: "inventory_item", column: "image_urls", array: true },
	{ table: "inventory_import_source", column: "storage_url" },
	{ table: "field_purchase", column: "receipt_image_url" },
];

export type OnDelete = "cascade" | "set_null" | "set_default" | "restrict" | "no_action";

export interface PurgeTable {
	name: string;
	pk: string[];
	columns: Set<string>;
}

export interface PurgeEdge {
	child: string;
	childCol: string;
	parent: string;
	parentCol: string;
	onDelete: OnDelete;
	childNullable: boolean;
}

export interface PurgeCatalog {
	tables: Map<string, PurgeTable>;
	edges: PurgeEdge[];
}

export interface PurgePlan {
	/** Tables that can hold the org's rows, root first. */
	tables: string[];
	seeds: { table: string; column: string }[];
	/** child rows that cannot outlive their parent row */
	markEdges: PurgeEdge[];
	/** nullable keys that would block deleting a parent; unmarked rows get NULL */
	detachEdges: PurgeEdge[];
	/** nullable keys inside a cycle of marked tables, nulled before deleting */
	cycleBreaks: PurgeEdge[];
	/** children before parents; the root comes last */
	deleteOrder: string[];
}

const blocks = (e: PurgeEdge) => e.onDelete === "restrict" || e.onDelete === "no_action";
const marks = (e: PurgeEdge) => e.onDelete === "cascade" || !e.childNullable;

export function planPurge(catalog: PurgeCatalog): PurgePlan {
	if (!catalog.tables.has(ROOT_TABLE)) throw new Error(`purge: no ${ROOT_TABLE} table`);
	for (const e of catalog.edges) {
		if (!catalog.tables.has(e.child) || !catalog.tables.has(e.parent))
			throw new Error(`purge: FK ${e.child}.${e.childCol} references an unknown table`);
	}

	const seeds: { table: string; column: string }[] = [];
	for (const t of catalog.tables.values()) {
		if (t.name === ROOT_TABLE) continue;
		for (const col of ORG_COLUMNS) if (t.columns.has(col)) seeds.push({ table: t.name, column: col });
	}

	const inSet = new Set<string>([ROOT_TABLE, ...seeds.map((s) => s.table)]);
	const markEdges = catalog.edges.filter(marks);
	// Table-level closure over the marking edges.
	for (let grew = true; grew; ) {
		grew = false;
		for (const e of markEdges) {
			if (inSet.has(e.parent) && !inSet.has(e.child)) {
				inSet.add(e.child);
				grew = true;
			}
		}
	}

	const relevant = (e: PurgeEdge) => inSet.has(e.parent);
	// A row carrying the org's id in its own org column is marked by the seed, so
	// that column never needs detaching.
	const seedsItself = (e: PurgeEdge) => e.parent === ROOT_TABLE && (ORG_COLUMNS as readonly string[]).includes(e.childCol);
	const detachEdges = catalog.edges.filter(
		(e) => relevant(e) && blocks(e) && e.childNullable && !seedsItself(e),
	);

	// Delete order: Kahn's algorithm over edges between marked tables, child first.
	// A cycle is broken by first ignoring keys Postgres resolves itself (CASCADE,
	// SET NULL), then by nulling nullable RESTRICT keys up front. A cycle of NOT
	// NULL RESTRICT keys cannot hold rows at all, so it is a schema error.
	const internal = catalog.edges.filter(
		(e) => inSet.has(e.child) && inSet.has(e.parent) && e.child !== e.parent,
	);
	let active = internal.slice();
	const cycleBreaks: PurgeEdge[] = [];
	const remaining = new Set(inSet);
	const deleteOrder: string[] = [];
	while (remaining.size > 0) {
		const pending = new Set<string>();
		for (const e of active) if (remaining.has(e.child) && remaining.has(e.parent)) pending.add(e.parent);
		// Deterministic order keeps the plan stable between runs and in tests.
		const ready = [...remaining].filter((t) => !pending.has(t)).sort();
		if (ready.length > 0) {
			for (const t of ready) {
				deleteOrder.push(t);
				remaining.delete(t);
			}
			continue;
		}
		const stuck = (e: PurgeEdge) => remaining.has(e.child) && remaining.has(e.parent);
		const soft = active.filter((e) => stuck(e) && !blocks(e));
		if (soft.length > 0) {
			active = active.filter((e) => !soft.includes(e));
			continue;
		}
		const breakable = active.filter((e) => stuck(e) && e.childNullable);
		if (breakable.length === 0) {
			throw new Error(`purge: unbreakable FK cycle among ${[...remaining].sort().join(", ")}`);
		}
		cycleBreaks.push(...breakable);
		active = active.filter((e) => !breakable.includes(e));
	}
	// Root last; everything else already precedes it through the seed columns,
	// except tables tagged only by a column without an FK (org_id), which Kahn's
	// algorithm sees as unconstrained and may place anywhere.
	const ordered = deleteOrder.filter((t) => t !== ROOT_TABLE).concat(ROOT_TABLE);

	const tables = [ROOT_TABLE, ...[...inSet].filter((t) => t !== ROOT_TABLE).sort()];
	return {
		tables,
		seeds,
		markEdges: markEdges.filter(relevant),
		detachEdges,
		cycleBreaks,
		deleteOrder: ordered,
	};
}

// ── Catalog ────────────────────────────────────────────────────────────────

type RawQuery = <T = unknown>(sql: string, ...values: unknown[]) => Promise<T>;
interface Queryable {
	$queryRawUnsafe: RawQuery;
	$executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
}

const ON_DELETE: Record<string, OnDelete> = {
	c: "cascade",
	n: "set_null",
	d: "set_default",
	r: "restrict",
	a: "no_action",
};

export async function loadPurgeCatalog(q: Queryable): Promise<PurgeCatalog> {
	const tableRows = await q.$queryRawUnsafe<{ name: string; pk: string[] | null; columns: string[] }[]>(`
		SELECT c.relname AS name,
			(SELECT array_agg(a.attname::text ORDER BY k.ord)
				FROM pg_index i
				CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
				JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
				WHERE i.indrelid = c.oid AND i.indisprimary) AS pk,
			(SELECT array_agg(a.attname::text)
				FROM pg_attribute a
				WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
		FROM pg_class c
		WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`);
	const edgeRows = await q.$queryRawUnsafe<
		{ child: string; child_cols: string[]; parent: string; parent_cols: string[]; del: string; nullable: boolean }[]
	>(`
		SELECT ch.relname AS child, pa.relname AS parent, k.confdeltype::text AS del,
			(SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY AS x(attnum, ord)
				JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS child_cols,
			(SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY AS x(attnum, ord)
				JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum) AS parent_cols,
			NOT bool_and(a.attnotnull) AS nullable
		FROM pg_constraint k
		JOIN pg_class ch ON ch.oid = k.conrelid
		JOIN pg_class pa ON pa.oid = k.confrelid
		JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
		WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
		GROUP BY k.oid, ch.relname, pa.relname, k.confdeltype, k.conkey, k.confkey, k.conrelid, k.confrelid`);

	const tables = new Map<string, PurgeTable>();
	for (const r of tableRows) {
		if (!r.pk || r.pk.length === 0) throw new Error(`purge: table ${r.name} has no primary key`);
		tables.set(r.name, { name: r.name, pk: r.pk, columns: new Set(r.columns) });
	}
	const edges: PurgeEdge[] = edgeRows.map((r) => {
		if (r.child_cols.length !== 1)
			throw new Error(`purge: composite FK on ${r.child} is not supported`);
		return {
			child: r.child,
			childCol: r.child_cols[0],
			parent: r.parent,
			parentCol: r.parent_cols[0],
			onDelete: ON_DELETE[r.del] ?? "no_action",
			childNullable: r.nullable,
		};
	});
	return { tables, edges };
}

// ── Execution ──────────────────────────────────────────────────────────────

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface PurgeResult {
	orgId: string;
	orgName: string;
	adminEmails: string[];
	rowsDeleted: number;
	filesQueued: number;
	detached: number;
}

// Generous: a large org is a few hundred thousand rows. lock_timeout stops the
// purge from queueing forever behind a long write; the sweeper simply retries.
const PURGE_TX_TIMEOUT_MS = 10 * 60_000;

export async function purgeOrganization(orgId: string): Promise<PurgeResult | null> {
	return db.$transaction(
		async (tx) => {
			const q = tx as unknown as Queryable;
			await q.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);

			// SKIP LOCKED: another instance already purging this org owns the row.
			const [org] = await q.$queryRawUnsafe<
				{ id: string; name: string; deletion_requested_at: Date | null }[]
			>(`SELECT id, name, deletion_requested_at FROM "organization" WHERE id = $1 FOR UPDATE SKIP LOCKED`, orgId);
			if (!org) return null;
			if (!org.deletion_requested_at) throw new Error("purge: organization deletion was never requested");

			const catalog = await loadPurgeCatalog(q);
			const plan = planPurge(catalog);
			const temp = new Map(plan.tables.map((t, i) => [t, ident(`_purge_${i}`)]));
			const pkOf = (t: string) => catalog.tables.get(t)!.pk;
			const pkJoin = (alias: string, other: string, t: string) =>
				pkOf(t).map((c) => `${alias}.${ident(c)} = ${other}.${ident(c)}`).join(" AND ");

			for (const t of plan.tables) {
				const cols = pkOf(t).map(ident).join(", ");
				await q.$executeRawUnsafe(
					`CREATE TEMP TABLE ${temp.get(t)} ON COMMIT DROP AS SELECT ${cols} FROM ${ident(t)} WITH NO DATA`,
				);
				await q.$executeRawUnsafe(`ALTER TABLE ${temp.get(t)} ADD PRIMARY KEY (${cols})`);
			}

			// 1. Mark: the org row, every row tagged with the org, then their dependents.
			await q.$executeRawUnsafe(`INSERT INTO ${temp.get(ROOT_TABLE)} SELECT id FROM "organization" WHERE id = $1`, orgId);
			for (const s of plan.seeds) {
				const cols = pkOf(s.table).map(ident).join(", ");
				await q.$executeRawUnsafe(
					`INSERT INTO ${temp.get(s.table)} SELECT ${cols} FROM ${ident(s.table)} WHERE ${ident(s.column)} = $1 ON CONFLICT DO NOTHING`,
					orgId,
				);
			}
			// Semi-naive: a pass only follows edges out of tables that grew in the last one.
			let grew = new Set(plan.tables);
			for (let pass = 0; grew.size > 0; pass++) {
				if (pass > 50) throw new Error("purge: marking did not converge");
				const next = new Set<string>();
				for (const e of plan.markEdges) {
					if (!grew.has(e.parent)) continue;
					const added = await q.$executeRawUnsafe(
						`INSERT INTO ${temp.get(e.child)}
						SELECT ${pkOf(e.child).map((c) => `c.${ident(c)}`).join(", ")}
						FROM ${ident(e.child)} c
						JOIN ${ident(e.parent)} p ON c.${ident(e.childCol)} = p.${ident(e.parentCol)}
						JOIN ${temp.get(e.parent)} m ON ${pkJoin("p", "m", e.parent)}
						ON CONFLICT DO NOTHING`,
					);
					if (added > 0) next.add(e.child);
				}
				grew = next;
			}

			// 2. Refuse to touch another tenant's rows.
			for (const s of plan.seeds) {
				const [{ n }] = await q.$queryRawUnsafe<{ n: number }[]>(
					`SELECT count(*)::int AS n FROM ${ident(s.table)} t JOIN ${temp.get(s.table)} m ON ${pkJoin("t", "m", s.table)}
					WHERE t.${ident(s.column)} IS NOT NULL AND t.${ident(s.column)} <> $1`,
					orgId,
				);
				if (n > 0) throw new Error(`purge: ${n} ${s.table} rows of another organization depend on this one`);
			}

			// 3. Rows keyed by user id with no FK: sessions, MFA, one-time codes.
			const users = `SELECT id FROM ${temp.get("dispatcher")} UNION SELECT id FROM ${temp.get("technician")}`;
			let rowsDeleted = 0;
			for (const u of USER_KEYED_TABLES) {
				if (!catalog.tables.get(u.table)?.columns.has(u.column)) continue;
				rowsDeleted += await q.$executeRawUnsafe(
					`DELETE FROM ${ident(u.table)} WHERE ${ident(u.column)} IN (${users})`,
				);
			}

			// 4. Queue stored files, in this transaction so a crash cannot orphan them.
			let filesQueued = 0;
			for (const f of FILE_COLUMNS) {
				if (!temp.has(f.table) || !catalog.tables.get(f.table)?.columns.has(f.column)) continue;
				const value = f.array ? `unnest(t.${ident(f.column)})` : `t.${ident(f.column)}`;
				filesQueued += await q.$executeRawUnsafe(
					`INSERT INTO "storage_purge" (id, url)
					SELECT gen_random_uuid()::text, u FROM (
						SELECT ${value} AS u FROM ${ident(f.table)} t JOIN ${temp.get(f.table)} m ON ${pkJoin("t", "m", f.table)}
					) files WHERE u ~ '^(https?|local-import)://'`,
				);
			}

			const admins = await q.$queryRawUnsafe<{ email: string }[]>(
				`SELECT d.email FROM "dispatcher" d JOIN ${temp.get("dispatcher")} m ON m.id = d.id
				WHERE d.role = 'admin' AND d.deleted_at IS NULL`,
			);

			// 5. Detach rows outside the org that point in through nullable keys.
			let detached = 0;
			for (const e of plan.detachEdges) {
				const notMarked = temp.has(e.child)
					? `AND NOT EXISTS (SELECT 1 FROM ${temp.get(e.child)} x WHERE ${pkJoin("c", "x", e.child)})`
					: "";
				detached += await q.$executeRawUnsafe(
					`UPDATE ${ident(e.child)} c SET ${ident(e.childCol)} = NULL
					FROM ${ident(e.parent)} p JOIN ${temp.get(e.parent)} m ON ${pkJoin("p", "m", e.parent)}
					WHERE c.${ident(e.childCol)} = p.${ident(e.parentCol)} ${notMarked}`,
				);
			}
			for (const e of plan.cycleBreaks) {
				await q.$executeRawUnsafe(
					`UPDATE ${ident(e.child)} c SET ${ident(e.childCol)} = NULL
					FROM ${temp.get(e.child)} m WHERE ${pkJoin("c", "m", e.child)} AND c.${ident(e.childCol)} IS NOT NULL`,
				);
			}

			// 6. Delete, children first.
			for (const t of plan.deleteOrder) {
				rowsDeleted += await q.$executeRawUnsafe(
					`DELETE FROM ${ident(t)} t USING ${temp.get(t)} m WHERE ${pkJoin("t", "m", t)}`,
				);
			}

			// The only trace left: no names, no emails, no customer data.
			await tx.log.create({
				data: {
					organization_id: null,
					event_type: "organization.purged",
					action: "deleted",
					entity_type: "organization",
					entity_id: orgId,
					actor_type: "system",
					changes: { rows: { old: rowsDeleted, new: 0 }, files: { old: filesQueued, new: 0 } },
				},
			});

			return {
				orgId,
				orgName: org.name,
				adminEmails: admins.map((a) => a.email),
				rowsDeleted,
				filesQueued,
				detached,
			};
		},
		{ timeout: PURGE_TX_TIMEOUT_MS, maxWait: 10_000 },
	);
}

/**
 * Runs one purge and does the follow-up work. Never throws: a failure is counted
 * on the org row and logged, and the sweeper tries again on its next pass.
 */
export async function runOrgPurge(orgId: string): Promise<boolean> {
	const started = Date.now();
	try {
		const result = await purgeOrganization(orgId);
		if (!result) return false;
		log.info(
			{
				evt: "org.purged",
				orgId,
				rowsDeleted: result.rowsDeleted,
				filesQueued: result.filesQueued,
				detached: result.detached,
				ms: Date.now() - started,
			},
			"Organization purged",
		);
		for (const to of result.adminEmails) await sendOrganizationDeletedEmail(to, result.orgName);
		void drainStoragePurge().catch((err) => log.error({ err }, "storage purge drain failed"));
		return true;
	} catch (err) {
		const attempts = await db.organization
			.update({ where: { id: orgId }, data: { deletion_attempts: { increment: 1 } }, select: { deletion_attempts: true } })
			.then((o) => o.deletion_attempts)
			.catch(() => null);
		// Past a few tries this is not a lock race any more; someone has to look.
		const level = attempts !== null && attempts >= 3 ? "error" : "warn";
		log[level]({ err, evt: "org.purge_failed", orgId, attempts }, "Organization purge failed; will retry");
		return false;
	}
}

// ── Stored files ───────────────────────────────────────────────────────────

const STORAGE_BATCH = 200;
const STORAGE_MAX_ATTEMPTS = 20;

/** Deletes queued files; rows that keep failing stay behind, logged, for a person. */
export async function drainStoragePurge(): Promise<number> {
	let removed = 0;
	for (;;) {
		const done = await db.$transaction(
			async (tx) => {
				const q = tx as unknown as Queryable;
				const rows = await q.$queryRawUnsafe<{ id: string; url: string; attempts: number }[]>(
					`SELECT id, url, attempts FROM "storage_purge" WHERE attempts < $1
					ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
					STORAGE_MAX_ATTEMPTS,
					STORAGE_BATCH,
				);
				if (rows.length === 0) return null;

				const ok = new Set<string>();
				const remote = rows.filter((r) => !isLocalImportSource(r.url) && isOwnBucketUrl(r.url));
				for (const r of rows) {
					// Not ours (an external image link): nothing to delete.
					if (!isLocalImportSource(r.url) && !isOwnBucketUrl(r.url)) ok.add(r.id);
				}
				for (const r of rows.filter((r) => isLocalImportSource(r.url))) {
					try {
						await deleteImportSource(r.url);
						ok.add(r.id);
					} catch (err) {
						log.warn({ err, id: r.id }, "local import source not deleted");
					}
				}
				if (remote.length > 0 && storageConfigured()) {
					const failed = await deleteFiles(remote.map((r) => r.url));
					for (const r of remote) if (!failed.has(r.url)) ok.add(r.id);
				}

				const okIds = [...ok];
				const failedRows = rows.filter((r) => !ok.has(r.id));
				if (okIds.length > 0) await tx.storage_purge.deleteMany({ where: { id: { in: okIds } } });
				if (failedRows.length > 0) {
					await tx.storage_purge.updateMany({
						where: { id: { in: failedRows.map((r) => r.id) } },
						data: { attempts: { increment: 1 } },
					});
					for (const r of failedRows) {
						if (r.attempts + 1 >= STORAGE_MAX_ATTEMPTS)
							log.error({ id: r.id }, "Stored file of a purged organization could not be deleted");
					}
				}
				return { removed: okIds.length, progressed: okIds.length > 0 };
			},
			{ timeout: 120_000, maxWait: 10_000 },
		);
		if (!done) break;
		removed += done.removed;
		// Every row in the batch failed (storage down): stop until the next pass.
		if (!done.progressed) break;
	}
	return removed;
}

// ── Sweeper ────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 5 * 60_000;

export async function sweepPendingDeletions(): Promise<void> {
	const pending = await db.organization.findMany({
		where: { deletion_requested_at: { not: null } },
		select: { id: true },
		orderBy: { deletion_requested_at: "asc" },
		take: 5,
	});
	for (const { id } of pending) await runOrgPurge(id);
	await drainStoragePurge();
}

export function startOrgPurgeSweeper(): void {
	const run = () =>
		sweepPendingDeletions().catch((err) => log.error({ err }, "organization purge sweep failed"));
	// First pass soon after boot picks up purges a restart interrupted.
	setTimeout(run, 30_000).unref();
	setInterval(run, SWEEP_INTERVAL_MS).unref();
}
