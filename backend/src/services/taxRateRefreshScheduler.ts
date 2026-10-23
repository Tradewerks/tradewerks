import type { Prisma } from "../../generated/prisma/client.js";
import { notifyDispatchers } from "../controllers/notificationsController.js";
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { DAY_MS } from "../lib/dayRange.js";
import { recomputeDocumentTotals } from "../lib/recomputeDocumentTotals.js";
import { recomputeOpenVisits } from "../lib/recomputeOpenVisits.js";
import { OPEN } from "../lib/statusTransitions.js";
import { log } from "./appLogger.js";
import { buildRateChangeNotice, type ChangedModel, type RateChange } from "./tax/rateChange.js";
import type { RateSetView } from "./tax/rateSet.js";
import { readTaxSnapshot } from "./tax/snapshot.js";
import { getOrgTaxContext } from "./tax/taxMode.js";
import { loadRateSet } from "./tax/taxResolver.js";

interface DraftRef {
	model: ChangedModel;
	id: string;
	orgId: string;
}

interface ChangedIds {
	orgId: string;
	model: ChangedModel;
	from: string;
	to: string;
}

/**
 * Guards a row already refreshed by an earlier run: only the run whose UPDATE matched the observed
 * valid_until goes on. Not exclusive on its own (the row stays expired, so a second instance could
 * re-claim mid-refresh); the per-resolution advisory lock in runTaxRateRefresh provides that.
 * A run that dies after claiming is picked up again tomorrow.
 */
async function claim(id: string, seen: Date, now: Date): Promise<boolean> {
	const { count } = await db.tax_address_resolution.updateMany({
		where: { id, valid_until: seen },
		data: { valid_until: now },
	});
	return count === 1;
}

/** Jobs first: their open visits resolve cache-only and need the row the job refreshes. */
async function draftsOf(resolutionId: string): Promise<DraftRef[]> {
	const select = { id: true, organization_id: true } as const;
	const [jobs, quotes, invoices] = await Promise.all([
		db.job.findMany({ where: { tax_resolution_id: resolutionId, status: OPEN }, select }),
		db.quote.findMany({ where: { tax_resolution_id: resolutionId, status: "Draft" }, select }),
		db.invoice.findMany({ where: { tax_resolution_id: resolutionId, status: "Draft" }, select }),
	]);
	const refs = (model: ChangedModel, rows: { id: string; organization_id: string | null }[]) =>
		rows.flatMap((r) => (r.organization_id ? [{ model, id: r.id, orgId: r.organization_id }] : []));
	return [...refs("job", jobs), ...refs("quote", quotes), ...refs("invoice", invoices)];
}

async function snapshotRateSetId(
	tx: Prisma.TransactionClient,
	d: DraftRef,
): Promise<string | null> {
	const args = { where: { id: d.id }, select: { tax_snapshot: true } } as const;
	const row =
		d.model === "quote"
			? await tx.quote.findFirst(args)
			: d.model === "job"
				? await tx.job.findFirst(args)
				: await tx.invoice.findFirst(args);
	const snap = readTaxSnapshot(row?.tax_snapshot);
	return snap?.version === 2 ? (snap.rate_set_id ?? null) : null;
}

/** One draft per transaction, like the auto-switch refresh: one failure cannot stall the rest. */
async function refreshDraft(d: DraftRef): Promise<ChangedIds | null> {
	const sdb = getScopedDb(d.orgId);
	try {
		const change = await sdb.$transaction(async (raw) => {
			const tx = raw as unknown as Prisma.TransactionClient;
			const before = await snapshotRateSetId(tx, d);
			const result = await recomputeDocumentTotals(d.model, d.id, d.orgId, tx);
			if (!result.ok) return null;
			const after = await snapshotRateSetId(tx, d);
			// No rate set before means it was never taxed at a resolved rate: nothing "changed".
			return before && after && before !== after
				? { orgId: d.orgId, model: d.model, from: before, to: after }
				: null;
		});
		if (d.model === "job") await recomputeOpenVisits(sdb, d.id, d.orgId, "tax rate refresh");
		return change;
	} catch (err) {
		log.error({ err, orgId: d.orgId, model: d.model, id: d.id }, "Draft recompute after tax rate refresh failed");
		return null;
	}
}

async function notifyChanges(changed: ChangedIds[]): Promise<void> {
	const byOrg = new Map<string, ChangedIds[]>();
	for (const c of changed) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c]);
	const sets = new Map<string, RateSetView | null>();
	const setOf = async (id: string) => {
		if (!sets.has(id)) sets.set(id, await loadRateSet(id));
		return sets.get(id) ?? null;
	};
	for (const [orgId, list] of byOrg) {
		try {
			const changes: RateChange[] = [];
			for (const c of list) {
				const [from, to] = await Promise.all([setOf(c.from), setOf(c.to)]);
				if (from && to) changes.push({ model: c.model, from, to });
			}
			if (changes.length === 0) continue;
			await notifyDispatchers({ type: "tax_rate_changed", ...buildRateChangeNotice(changes) }, orgId);
		} catch (err) {
			log.error({ err, orgId }, "Tax rate change notification failed - continuing");
		}
	}
}

/**
 * Spec §5: refreshes expired resolutions that open drafts still use. The recompute re-resolves
 * the row and charges the lookup to the org whose draft it is; the rest hit the fresh cache.
 * Returns the number of drafts recomputed.
 */
export async function runTaxRateRefresh(now = new Date()): Promise<number> {
	// Base client on purpose: resolutions are platform-scoped and drafts span every org.
	const due = await db.tax_address_resolution.findMany({
		where: {
			valid_until: { lt: now },
			OR: [
				{ quotes: { some: { status: "Draft" } } },
				{ jobs: { some: { status: OPEN } } },
				{ invoices: { some: { status: "Draft" } } },
			],
		},
		select: { id: true, valid_until: true },
	});
	if (due.length === 0) return 0;
	log.info({ count: due.length }, "Refreshing expired tax rate resolutions");

	const autoByOrg = new Map<string, boolean>();
	const isAuto = async (orgId: string) => {
		if (!autoByOrg.has(orgId)) {
			try {
				autoByOrg.set(orgId, (await getOrgTaxContext(orgId)).mode === "auto");
			} catch (err) {
				log.warn({ err, orgId }, "Tax context unavailable; skipping org's drafts this run");
				autoByOrg.set(orgId, false);
			}
		}
		return autoByOrg.get(orgId)!;
	};

	const changed: ChangedIds[] = [];
	let recomputed = 0;
	for (const row of due) {
		try {
			// The lock tx only holds the lock; draft recomputes use their own transactions/connections.
			await db.$transaction(
				async (lock) => {
					const [{ got }] = await lock.$queryRaw<
						{ got: boolean }[]
					>`SELECT pg_try_advisory_xact_lock(hashtext(${"tax_refresh:" + row.id})) AS got`;
					if (!got) {
						log.debug({ resolutionId: row.id }, "Tax rate refresh held by another instance - skipping");
						return;
					}
					if (!(await claim(row.id, row.valid_until, now))) return;
					for (const d of await draftsOf(row.id)) {
						// An org that lost tax_auto is taxed as manual: no lookup to refresh, nothing to charge.
						if (!(await isAuto(d.orgId))) continue;
						recomputed += 1;
						const c = await refreshDraft(d);
						if (c) changed.push(c);
					}
				},
				{ timeout: 300_000, maxWait: 10_000 },
			);
		} catch (err) {
			log.error({ err, resolutionId: row.id }, "Tax rate refresh failed for resolution - continuing");
		}
	}
	await notifyChanges(changed);
	return recomputed;
}

export function startTaxRateRefreshInterval(): void {
	// Startup run catches a month boundary missed during downtime.
	runTaxRateRefresh().catch((err) => log.error({ err }, "Tax rate refresh startup run failed"));
	setInterval(() => {
		runTaxRateRefresh().catch((err) => log.error({ err }, "Tax rate refresh interval run failed"));
	}, DAY_MS);
}
