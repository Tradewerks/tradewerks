// backend/src/services/tax/taxResolver.ts
import { db } from "../../db.js";
import { consumeQuota } from "../../lib/entitlements/quota.js";
import { log } from "../appLogger.js";
import { addressLookupTarget, firstOfNextMonthUTC, type AddressLookupTarget } from "./address.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { getTaxRateProvider } from "./index.js";
import type { ProviderResult, TaxRateProvider } from "./provider.js";
import { otelTaxMetrics, type TaxMetrics } from "./taxMetrics.js";
import {
	canonicalComponents,
	compositionHash,
	isPlausibleRateSet,
	totalRate,
	type JurisdictionType,
	type RateComponent,
	type RateSetView,
} from "./rateSet.js";

export const TAX_LOOKUP_TIMEOUT_MS = 3_000;
/** How long a failed address is answered from its fallback without asking the provider again. */
export const FAILED_LOOKUP_HOLD_MS = 60_000;

const NO_ADDRESS = "No usable service address to look up";
const NO_PROVIDER = "No tax rate provider is configured";
const BREAKER_OPEN = "Tax rate service paused after repeated failures";
const QUOTA = "This month's tax lookups are used up";
const QUOTA_UNKNOWN = "Tax lookup allowance could not be checked";
const IMPLAUSIBLE = "Tax rate service returned an implausible rate";
const AMBIGUOUS = "The address could not be matched to a single tax jurisdiction";
const NOT_CACHED = "No current cached tax rate for this address";

export type AddressOutcome =
	| {
			kind: "rate";
			stale: boolean;
			resolution_id: string | null;
			rate_set: RateSetView;
			/** Provider O/D flag, data only: tax is always sourced to the service location. */
			sourcing: "O" | "D" | null;
			reasons: string[];
	  }
	| { kind: "none"; ambiguous: boolean; resolution_id: string | null; reasons: string[] };

export interface ResolveAddressArgs {
	orgId: string;
	address: string | null | undefined;
	coords: unknown;
	/** Re-look-up a still-valid row older than this (lock-time freshness). */
	maxAgeMs?: number;
	/**
	 * Answer from tax_address_resolution only: no provider call, no meter charge. Job visits
	 * recompute several at a time inside one 5 s transaction, so each must not risk a 3 s lookup.
	 */
	cacheOnly?: boolean;
}

type ResolverDb = Pick<typeof db, "tax_rate_set" | "tax_address_resolution">;

export interface TaxResolverDeps {
	db: ResolverDb;
	getProvider: () => TaxRateProvider | null;
	consumeLookup: (orgId: string) => Promise<boolean>;
	breaker: CircuitBreaker;
	now: () => Date;
	timeoutMs: number;
	/** Optional so tests that do not care need not stub it. */
	metrics?: TaxMetrics;
}

type One =
	| {
			kind: "rate";
			stale: boolean;
			resolution_id: string;
			rate_set: RateSetView;
			flag: "O" | "D" | null;
			reasons: string[];
	  }
	| { kind: "none"; ambiguous: boolean; resolution_id: string | null; reasons: string[] };

const RATE_SET_INCLUDE = { components: { orderBy: { sort_order: "asc" as const } } };
const ROW_INCLUDE = { rate_set: { include: RATE_SET_INCLUDE } };

type RateSetRow = {
	id: string;
	state_code: string;
	total_rate: unknown;
	components: {
		id: string;
		jurisdiction_type: string;
		jurisdiction_name: string;
		jurisdiction_code: string | null;
		rate: unknown;
	}[];
};

function toRateSetView(row: RateSetRow): RateSetView {
	return {
		id: row.id,
		state_code: row.state_code,
		total_rate: Number(row.total_rate),
		components: row.components.map((c) => ({
			id: c.id,
			jurisdiction_type: c.jurisdiction_type as JurisdictionType,
			jurisdiction_name: c.jurisdiction_name,
			jurisdiction_code: c.jurisdiction_code,
			rate: Number(c.rate),
		})),
	};
}

const flagOf = (s: string | null | undefined): "O" | "D" | null =>
	s === "O" || s === "D" ? s : null;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function createTaxResolver(deps: TaxResolverDeps) {
	// Process-local, like the breaker. A recompute and a lock can share one 5 s transaction,
	// so a second 3 s provider call for the same failing address must not happen.
	const recentFailures = new Map<string, { until: number; reason: string }>();

	function heldFailure(key: string, nowMs: number): string | null {
		const hit = recentFailures.get(key);
		if (!hit) return null;
		if (hit.until > nowMs) return hit.reason;
		recentFailures.delete(key);
		return null;
	}

	function holdFailure(key: string, nowMs: number, reason: string): void {
		for (const [k, v] of recentFailures) if (v.until <= nowMs) recentFailures.delete(k);
		recentFailures.set(key, { until: nowMs + FAILED_LOOKUP_HOLD_MS, reason });
	}

	async function upsertRateSet(
		state: string,
		components: RateComponent[]
	): Promise<RateSetView> {
		const canonical = canonicalComponents(components);
		const hash = compositionHash(state, canonical);
		const found = await deps.db.tax_rate_set.findUnique({
			where: { composition_hash: hash },
			include: RATE_SET_INCLUDE,
		});
		if (found) return toRateSetView(found);
		try {
			const created = await deps.db.tax_rate_set.create({
				data: {
					composition_hash: hash,
					state_code: state,
					total_rate: totalRate(canonical).toFixed(6),
					components: {
						create: canonical.map((c, i) => ({
							jurisdiction_type: c.jurisdiction_type,
							jurisdiction_name: c.jurisdiction_name,
							jurisdiction_code: c.jurisdiction_code,
							rate: c.rate.toFixed(6),
							sort_order: i,
						})),
					},
				},
				include: RATE_SET_INCLUDE,
			});
			return toRateSetView(created);
		} catch (err) {
			// Two drafts resolving the same new jurisdiction at once: the loser reads the winner.
			if ((err as { code?: string }).code !== "P2002") throw err;
			const winner = await deps.db.tax_rate_set.findUnique({
				where: { composition_hash: hash },
				include: RATE_SET_INCLUDE,
			});
			if (!winner) throw err;
			return toRateSetView(winner);
		}
	}

	/** `called`: the provider itself answered (or timed out), so the failure is the address's to hold. */
	async function callProvider(
		orgId: string,
		target: AddressLookupTarget
	): Promise<{ result: ProviderResult; providerName: string; called: boolean }> {
		const fail = (reason: string, providerName = "none") => ({
			result: { status: "failed", reason } as ProviderResult,
			providerName,
			called: false,
		});
		if (deps.breaker.isOpen()) return fail(BREAKER_OPEN);
		const provider = deps.getProvider();
		if (!provider) return fail(NO_PROVIDER);
		let allowed: boolean;
		try {
			allowed = await deps.consumeLookup(orgId);
		} catch (err) {
			log.warn(
				{ err, orgId },
				"tax lookup meter unavailable; treating as provider failure"
			);
			return fail(QUOTA_UNKNOWN, provider.name);
		}
		// Over the cap is a provider failure for the chain, but not the provider's fault.
		if (!allowed) return fail(QUOTA, provider.name);

		const started = performance.now();
		let result: ProviderResult;
		try {
			result = await provider.lookup(
				target.input,
				AbortSignal.timeout(deps.timeoutMs)
			);
		} catch (err) {
			log.warn(
				{ err, provider: provider.name },
				"tax provider threw; treated as failure"
			);
			result = { status: "failed", reason: "Tax rate lookup failed" };
		}
		if (result.status === "ok" && !isPlausibleRateSet(result.components)) {
			log.error(
				{
					provider: provider.name,
					state: result.state_code,
					total: totalRate(result.components),
				},
				"Tax provider rate outside [0, 0.15]; treated as failure"
			);
			result = { status: "failed", reason: IMPLAUSIBLE };
		}
		deps.metrics?.providerCall(result.status, (performance.now() - started) / 1000);
		if (result.status === "failed") deps.breaker.recordFailure();
		else deps.breaker.recordSuccess();
		return { result, providerName: provider.name, called: true };
	}

	async function lookUp(
		orgId: string,
		target: AddressLookupTarget,
		nowMs: number,
		cacheOnly: boolean
	): Promise<{ result: ProviderResult; providerName: string }> {
		const failed = (reason: string) => ({
			result: { status: "failed", reason } as ProviderResult,
			providerName: "none",
		});
		if (cacheOnly) return failed(NOT_CACHED);
		const held = heldFailure(target.key, nowMs);
		if (held !== null) return failed(held);
		const { result, providerName, called } = await callProvider(orgId, target);
		// Quota and meter failures are one org's, not the address's: holding them by address
		// would hand org A's reason to org B.
		if (called && result.status === "failed")
			holdFailure(target.key, nowMs, result.reason);
		return { result, providerName };
	}

	async function resolveOne(
		orgId: string,
		address: string | null | undefined,
		coords: unknown,
		maxAgeMs: number | undefined,
		cacheOnly: boolean
	): Promise<One> {
		const target = addressLookupTarget(address, coords);
		if (!target)
			return {
				kind: "none",
				ambiguous: false,
				resolution_id: null,
				reasons: [NO_ADDRESS],
			};

		const row = await deps.db.tax_address_resolution.findUnique({
			where: { address_key: target.key },
			include: ROW_INCLUDE,
		});
		const now = deps.now();
		const usable =
			row != null &&
			row.valid_until > now &&
			(maxAgeMs === undefined ||
				now.getTime() - row.resolved_at.getTime() <= maxAgeMs);
		if (row && usable) {
			if (row.status === "ok" && row.rate_set) {
				deps.metrics?.cacheHit();
				return {
					kind: "rate",
					stale: false,
					resolution_id: row.id,
					rate_set: toRateSetView(row.rate_set),
					flag: flagOf(row.sourcing),
					reasons: [],
				};
			}
			if (row.status === "ambiguous") {
				deps.metrics?.cacheHit();
				return {
					kind: "none",
					ambiguous: true,
					resolution_id: row.id,
					reasons: [AMBIGUOUS],
				};
			}
		}

		const { result, providerName } = await lookUp(
			orgId,
			target,
			now.getTime(),
			cacheOnly
		);
		const validUntil = firstOfNextMonthUTC(now);

		if (result.status === "ok") {
			const rateSet = await upsertRateSet(result.state_code, result.components);
			const common = {
				rate_set_id: rateSet.id,
				provider: providerName,
				status: "ok",
				sourcing: result.sourcing,
				resolved_at: now,
				valid_until: validUntil,
				lat: result.lat ?? target.lat,
				lng: result.lng ?? target.lng,
			};
			const saved = await deps.db.tax_address_resolution.upsert({
				where: { address_key: target.key },
				create: {
					address_key: target.key,
					normalized_address: target.normalized,
					...common,
				},
				update: common,
			});
			return {
				kind: "rate",
				stale: false,
				resolution_id: saved.id,
				rate_set: rateSet,
				flag: result.sourcing,
				reasons: [],
			};
		}

		if (result.status === "ambiguous") {
			const common = {
				rate_set_id: null,
				provider: providerName,
				status: "ambiguous",
				sourcing: null,
				resolved_at: now,
				valid_until: validUntil,
			};
			const saved = await deps.db.tax_address_resolution.upsert({
				where: { address_key: target.key },
				create: {
					address_key: target.key,
					normalized_address: target.normalized,
					lat: target.lat,
					lng: target.lng,
					...common,
				},
				update: common,
			});
			// The provider's own reason is not stored, so a cache hit could not repeat it.
			return {
				kind: "none",
				ambiguous: true,
				resolution_id: saved.id,
				reasons: [AMBIGUOUS],
			};
		}

		// Failures are never persisted (only held in-process for FAILED_LOOKUP_HOLD_MS): an outage
		// must not stick until month end.
		if (row?.status === "ok" && row.rate_set) {
			return {
				kind: "rate",
				stale: true,
				resolution_id: row.id,
				rate_set: toRateSetView(row.rate_set),
				flag: flagOf(row.sourcing),
				reasons: [
					`${result.reason}; using the rate looked up on ${ymd(row.resolved_at)}`,
				],
			};
		}
		return {
			kind: "none",
			ambiguous: false,
			resolution_id: row?.id ?? null,
			reasons: [result.reason],
		};
	}

	async function resolveAddress(args: ResolveAddressArgs): Promise<AddressOutcome> {
		// One lookup at the service location; recompute runs inside a 5 s interactive transaction.
		const one = await resolveOne(
			args.orgId,
			args.address,
			args.coords,
			args.maxAgeMs,
			args.cacheOnly === true
		);
		if (one.kind === "none") return one;
		const { flag, ...rest } = one;
		return { ...rest, sourcing: flag };
	}

	async function loadRateSet(id: string): Promise<RateSetView | null> {
		const row = await deps.db.tax_rate_set.findUnique({
			where: { id },
			include: RATE_SET_INCLUDE,
		});
		return row ? toRateSetView(row) : null;
	}

	return { resolveAddress, loadRateSet };
}

const defaultResolver = createTaxResolver({
	db,
	getProvider: getTaxRateProvider,
	consumeLookup: async (orgId) => (await consumeQuota(orgId, "tax_lookups_month")).allowed,
	breaker: new CircuitBreaker(5, 60_000),
	now: () => new Date(),
	timeoutMs: TAX_LOOKUP_TIMEOUT_MS,
	metrics: otelTaxMetrics,
});

export const resolveAddressTax = (args: ResolveAddressArgs) => defaultResolver.resolveAddress(args);
export const loadRateSet = (id: string) => defaultResolver.loadRateSet(id);
