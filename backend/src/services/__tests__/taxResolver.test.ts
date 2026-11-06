// backend/src/services/__tests__/taxResolver.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../lib/entitlements/quota.js", () => ({ consumeQuota: vi.fn() }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { log } from "../appLogger.js";
import { CircuitBreaker } from "../tax/circuitBreaker.js";
import { createTaxResolver, type ResolveAddressArgs } from "../tax/taxResolver.js";
import type { ProviderResult, TaxRateProvider } from "../tax/provider.js";
import { createZiptaxProvider } from "../tax/ziptax.js";
import type { TaxMetrics } from "../tax/taxMetrics.js";

const MADISON = "200 Martin Luther King Jr Blvd, Madison, WI 53703";
const OK_WI: ProviderResult = {
	status: "ok",
	state_code: "WI",
	components: [
		{ jurisdiction_type: "state", jurisdiction_name: "WI", jurisdiction_code: "55", rate: 0.05 },
		{ jurisdiction_type: "county", jurisdiction_name: "DANE", jurisdiction_code: "025", rate: 0.005 },
	],
	sourcing: "D",
	lat: 43.07,
	lng: -89.38,
};

/** In-memory stand-in for the two platform tables; mirrors the Prisma calls the resolver makes. */
function fakeDb() {
	const sets = new Map<string, any>();
	const rows = new Map<string, any>();
	let n = 0;
	const withSet = (row: any) => (row ? { ...row, rate_set: row.rate_set_id ? sets.get(row.rate_set_id) : null } : null);
	const api = {
		tax_rate_set: {
			findUnique: vi.fn(async ({ where }: any) =>
				where.id
					? (sets.get(where.id) ?? null)
					: ([...sets.values()].find((s) => s.composition_hash === where.composition_hash) ?? null),
			),
			create: vi.fn(async ({ data }: any) => {
				if ([...sets.values()].some((s) => s.composition_hash === data.composition_hash)) {
					throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
				}
				const id = `set-${++n}`;
				const set = {
					id,
					composition_hash: data.composition_hash,
					state_code: data.state_code,
					total_rate: Number(data.total_rate),
					components: data.components.create.map((c: any, i: number) => ({ ...c, id: `${id}-c${i}`, rate: Number(c.rate) })),
				};
				sets.set(id, set);
				return set;
			}),
		},
		tax_address_resolution: {
			findUnique: vi.fn(async ({ where }: any) => withSet(rows.get(where.address_key))),
			upsert: vi.fn(async ({ where, create, update }: any) => {
				const prev = rows.get(where.address_key);
				const next = prev ? { ...prev, ...update } : { id: `res-${++n}`, ...create };
				rows.set(where.address_key, next);
				return withSet(next);
			}),
		},
	};
	return { api, sets, rows };
}

function setup(
	over: {
		provider?: TaxRateProvider | null;
		allowed?: boolean;
		now?: Date;
		timeoutMs?: number;
		metrics?: TaxMetrics;
	} = {},
) {
	const store = fakeDb();
	let now = over.now ?? new Date("2026-10-14T15:00:00Z");
	const provider: TaxRateProvider | null =
		over.provider === undefined ? { name: "fixture", lookup: vi.fn(async () => OK_WI) } : over.provider;
	const consumeLookup = vi.fn(async () => over.allowed ?? true);
	const breaker = new CircuitBreaker(5, 60_000, () => now.getTime());
	const resolver = createTaxResolver({
		db: store.api as never,
		getProvider: () => provider,
		consumeLookup,
		breaker,
		now: () => now,
		timeoutMs: over.timeoutMs ?? 3_000,
		metrics: over.metrics,
	});
	const args = (a: Partial<ResolveAddressArgs> = {}): ResolveAddressArgs => ({
		orgId: "org1",
		address: MADISON,
		coords: null,
		...a,
	});
	return { store, provider, consumeLookup, resolver, args, setNow: (d: Date) => (now = d) };
}

describe("taxResolver.resolveAddress", () => {
	beforeEach(() => vi.clearAllMocks());

	it("misses the cache, calls the provider once, caches until the 1st of next month", async () => {
		const t = setup();
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "rate", stale: false, sourcing: "D", reasons: [] });
		expect(out.kind === "rate" && out.rate_set.total_rate).toBe(0.055);
		expect(t.provider!.lookup).toHaveBeenCalledTimes(1);
		expect(t.consumeLookup).toHaveBeenCalledWith("org1");
		const row = [...t.store.rows.values()][0];
		expect(row).toMatchObject({ status: "ok", provider: "fixture", sourcing: "D" });
		expect(row.valid_until.toISOString()).toBe("2026-11-01T00:00:00.000Z");
	});

	it("serves a valid cached row without calling the provider", async () => {
		const t = setup();
		await t.resolver.resolveAddress(t.args());
		const out = await t.resolver.resolveAddress(t.args({ address: "200 Martin Luther King Jr Blvd, Madison, Wisconsin 53703" }));
		expect(out).toMatchObject({ kind: "rate" });
		expect(t.provider!.lookup).toHaveBeenCalledTimes(1);
	});

	it("re-resolves an expired row and repoints it at the changed rate set", async () => {
		const t = setup();
		await t.resolver.resolveAddress(t.args());
		t.setNow(new Date("2026-11-02T00:00:00Z"));
		vi.mocked(t.provider!.lookup).mockResolvedValueOnce({
			...OK_WI,
			components: [OK_WI.status === "ok" ? OK_WI.components[0] : (null as never), { jurisdiction_type: "county", jurisdiction_name: "DANE", jurisdiction_code: "025", rate: 0.006 }],
		} as ProviderResult);
		const out = await t.resolver.resolveAddress(t.args());
		expect(t.provider!.lookup).toHaveBeenCalledTimes(2);
		const row = [...t.store.rows.values()][0];
		expect(row.rate_set_id).not.toBe("set-1");
		expect(out.kind).toBe("rate");
		expect(out.kind === "rate" && out.rate_set.id).not.toBe("set-1");
	});

	it("re-resolves a still-valid row older than maxAgeMs (lock rule) and not a younger one", async () => {
		const t = setup({ now: new Date("2026-10-02T12:00:00Z") });
		await t.resolver.resolveAddress(t.args());
		const week = 7 * 24 * 3600_000;
		t.setNow(new Date("2026-10-08T12:00:00Z"));
		await t.resolver.resolveAddress(t.args({ maxAgeMs: week }));
		expect(t.provider!.lookup).toHaveBeenCalledTimes(1);
		t.setNow(new Date("2026-10-10T12:00:00Z"));
		await t.resolver.resolveAddress(t.args({ maxAgeMs: week }));
		expect(t.provider!.lookup).toHaveBeenCalledTimes(2);
	});

	it("falls back to the cached rate set as stale when a re-resolve fails", async () => {
		const t = setup({ now: new Date("2026-10-02T12:00:00Z") });
		await t.resolver.resolveAddress(t.args());
		t.setNow(new Date("2026-11-03T00:00:00Z"));
		vi.mocked(t.provider!.lookup).mockResolvedValueOnce({ status: "failed", reason: "Tax rate service error (HTTP 503)" });
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "rate", stale: true });
		expect(out.reasons[0]).toBe("Tax rate service error (HTTP 503); using the rate looked up on 2026-10-02");
	});

	it("holds a failed address for 60 s without calling the provider again", async () => {
		const lookup = vi.fn(async () => ({ status: "failed", reason: "down" }) as ProviderResult);
		const t = setup({ provider: { name: "ziptax", lookup } });
		await t.resolver.resolveAddress(t.args());
		t.setNow(new Date("2026-10-14T15:00:59Z"));
		const held = await t.resolver.resolveAddress(t.args({ maxAgeMs: 7 * 24 * 3600_000 }));
		expect(held).toEqual({ kind: "none", ambiguous: false, resolution_id: null, reasons: ["down"] });
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(t.consumeLookup).toHaveBeenCalledTimes(1);
		t.setNow(new Date("2026-10-14T15:01:01Z"));
		await t.resolver.resolveAddress(t.args());
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("serves the stale cached rate while a failed address is held", async () => {
		const t = setup({ now: new Date("2026-10-02T12:00:00Z") });
		await t.resolver.resolveAddress(t.args());
		t.setNow(new Date("2026-11-03T00:00:00Z"));
		vi.mocked(t.provider!.lookup).mockResolvedValueOnce({ status: "failed", reason: "down" });
		await t.resolver.resolveAddress(t.args());
		const held = await t.resolver.resolveAddress(t.args());
		expect(held).toMatchObject({ kind: "rate", stale: true });
		expect(held.reasons[0]).toBe("down; using the rate looked up on 2026-10-02");
		expect(t.provider!.lookup).toHaveBeenCalledTimes(2);
	});

	it("returns none with the reason when the provider fails and nothing is cached", async () => {
		const t = setup({ provider: { name: "ziptax", lookup: vi.fn(async () => ({ status: "failed", reason: "down" }) as ProviderResult) } });
		expect(await t.resolver.resolveAddress(t.args())).toEqual({ kind: "none", ambiguous: false, resolution_id: null, reasons: ["down"] });
		expect(t.store.rows.size).toBe(0);
	});

	// Review Focus 4: schema drift must not become a month-long cached "ambiguous".
	it("does not cache a 200 whose body is not the v60 shape", async () => {
		const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
		const ziptax = createZiptaxProvider("k", fetchImpl as unknown as typeof fetch);
		const t = setup({ provider: ziptax });
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "none", ambiguous: false });
		expect(t.store.rows.size).toBe(0);
	});

	it("treats an exhausted lookup meter as a provider failure without calling the provider", async () => {
		const t = setup({ allowed: false });
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "none", reasons: ["This month's tax lookups are used up"] });
		expect(t.provider!.lookup).not.toHaveBeenCalled();
	});

	// The quota is one org's; holding it by address would hand org A's reason to org B.
	it("never holds a quota failure against another org at the same address", async () => {
		const t = setup();
		(t.consumeLookup as any).mockImplementation(async (orgId: string) => orgId !== "orgA");
		const a = await t.resolver.resolveAddress(t.args({ orgId: "orgA" }));
		expect(a).toMatchObject({ kind: "none", reasons: ["This month's tax lookups are used up"] });
		t.setNow(new Date("2026-10-14T15:00:10Z"));
		const b = await t.resolver.resolveAddress(t.args({ orgId: "orgB" }));
		expect(t.provider!.lookup).toHaveBeenCalledTimes(1);
		expect(b).toMatchObject({ kind: "rate" });
	});

	it("never holds a meter outage either", async () => {
		const t = setup();
		t.consumeLookup.mockRejectedValueOnce(new Error("redis down"));
		await t.resolver.resolveAddress(t.args({ orgId: "orgA" }));
		await t.resolver.resolveAddress(t.args({ orgId: "orgB" }));
		expect(t.provider!.lookup).toHaveBeenCalledTimes(1);
	});

	describe("cacheOnly (job visits)", () => {
		it("serves a valid cached row", async () => {
			const t = setup();
			await t.resolver.resolveAddress(t.args());
			const out = await t.resolver.resolveAddress(t.args({ cacheOnly: true }));
			expect(out).toMatchObject({ kind: "rate", stale: false });
			expect(t.provider!.lookup).toHaveBeenCalledTimes(1);
			expect(t.consumeLookup).toHaveBeenCalledTimes(1);
		});

		it("falls back on a miss without calling the provider or the meter", async () => {
			const t = setup();
			const out = await t.resolver.resolveAddress(t.args({ cacheOnly: true }));
			expect(out).toMatchObject({ kind: "none", ambiguous: false, resolution_id: null });
			expect(out.reasons).toHaveLength(1);
			expect(t.provider!.lookup).not.toHaveBeenCalled();
			expect(t.consumeLookup).not.toHaveBeenCalled();
			expect(t.store.rows.size).toBe(0);
		});

		it("serves an expired row as stale without calling the provider or the meter", async () => {
			const t = setup({ now: new Date("2026-10-02T12:00:00Z") });
			await t.resolver.resolveAddress(t.args());
			t.setNow(new Date("2026-11-03T00:00:00Z"));
			const out = await t.resolver.resolveAddress(t.args({ cacheOnly: true }));
			expect(out).toMatchObject({ kind: "rate", stale: true });
			expect(out.reasons[0]).toMatch(/using the rate looked up on 2026-10-02$/);
			expect(t.provider!.lookup).toHaveBeenCalledTimes(1);
			expect(t.consumeLookup).toHaveBeenCalledTimes(1);
		});
	});

	it("opens the breaker after 5 consecutive failures and retries after 60 s", async () => {
		const lookup = vi.fn(async () => ({ status: "failed", reason: "down" }) as ProviderResult);
		const t = setup({ provider: { name: "ziptax", lookup } });
		// Distinct addresses: a repeat of one failed address is held without a provider call.
		const street = (i: number) => t.args({ address: `${100 + i} State St, Madison, WI 53703` });
		for (let i = 0; i < 5; i++) await t.resolver.resolveAddress(street(i));
		expect(lookup).toHaveBeenCalledTimes(5);
		const paused = await t.resolver.resolveAddress(t.args());
		expect(lookup).toHaveBeenCalledTimes(5);
		expect(paused.reasons[0]).toMatch(/paused/);
		expect(t.consumeLookup).toHaveBeenCalledTimes(5);
		t.setNow(new Date(new Date("2026-10-14T15:00:00Z").getTime() + 61_000));
		await t.resolver.resolveAddress(t.args());
		expect(lookup).toHaveBeenCalledTimes(6);
	});

	it("times out a slow provider within the budget", async () => {
		const lookup = vi.fn(
			(_input: unknown, signal: AbortSignal) =>
				new Promise<ProviderResult>((resolve) =>
					signal.addEventListener("abort", () => resolve({ status: "failed", reason: "Tax rate lookup timed out" })),
				),
		);
		const t = setup({ provider: { name: "ziptax", lookup }, timeoutMs: 20 });
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "none", reasons: ["Tax rate lookup timed out"] });
	});

	it("rejects an implausible combined rate as a failure and logs it at error level", async () => {
		const t = setup({
			provider: {
				name: "ziptax",
				lookup: vi.fn(async () => ({ ...OK_WI, components: [{ jurisdiction_type: "state", jurisdiction_name: "WI", jurisdiction_code: null, rate: 0.2 }] }) as ProviderResult),
			},
		});
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "none", reasons: ["Tax rate service returned an implausible rate"] });
		expect(log.error).toHaveBeenCalled();
		expect(t.store.sets.size).toBe(0);
	});

	it("caches an ambiguous answer so the same bad address is not re-billed this month", async () => {
		const lookup = vi.fn(async () => ({ status: "ambiguous", reason: "PO box" }) as ProviderResult);
		const t = setup({ provider: { name: "ziptax", lookup } });
		const first = await t.resolver.resolveAddress(t.args());
		const second = await t.resolver.resolveAddress(t.args());
		// The same text on a fresh lookup and a cache hit, so a draft's review_reason is stable.
		const reasons = ["The address could not be matched to a single tax jurisdiction"];
		expect(first).toMatchObject({ kind: "none", ambiguous: true, reasons });
		expect(second).toMatchObject({ kind: "none", ambiguous: true, reasons });
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("records an origin flag as data and still taxes at the service address, in one lookup", async () => {
		const lookup = vi.fn(async () => ({ ...OK_WI, sourcing: "O" }) as ProviderResult);
		const t = setup({ provider: { name: "ziptax", lookup } });
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "rate", sourcing: "O" });
		expect(out.kind === "rate" && out.rate_set.total_rate).toBe(0.055);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(t.consumeLookup).toHaveBeenCalledTimes(1);
		const cached = await t.resolver.resolveAddress(t.args());
		expect(cached).toMatchObject({ kind: "rate", sourcing: "O" });
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	// Review Focus 3
	it("reads the winner's rate set when another draft created it first", async () => {
		const t = setup();
		const winner = await t.store.api.tax_rate_set.create({
			data: {
				composition_hash: "will-be-replaced",
				state_code: "WI",
				total_rate: "0.055000",
				components: { create: [] },
			},
		});
		// Simulate the race: the first findUnique misses, then create hits the unique index.
		const { compositionHash } = await import("../tax/rateSet.js");
		winner.composition_hash = compositionHash("WI", (OK_WI as Extract<ProviderResult, { status: "ok" }>).components);
		t.store.api.tax_rate_set.findUnique.mockResolvedValueOnce(null);
		const out = await t.resolver.resolveAddress(t.args());
		expect(out).toMatchObject({ kind: "rate" });
		expect(out.kind === "rate" && out.rate_set.id).toBe(winner.id);
	});

	it("returns none without a provider call when there is no usable address", async () => {
		const t = setup();
		expect(await t.resolver.resolveAddress(t.args({ address: "", coords: null }))).toMatchObject({
			kind: "none",
			reasons: ["No usable service address to look up"],
		});
		expect(t.provider!.lookup).not.toHaveBeenCalled();
	});

	it("treats a missing provider as a failure", async () => {
		const t = setup({ provider: null });
		expect(await t.resolver.resolveAddress(t.args())).toMatchObject({
			kind: "none",
			reasons: ["No tax rate provider is configured"],
		});
	});
});

describe("taxResolver metrics", () => {
	beforeEach(() => vi.clearAllMocks());
	const spy = () => ({ providerCall: vi.fn(), cacheHit: vi.fn() });

	it("records one provider call with its outcome and latency, then a cache hit", async () => {
		const metrics = spy();
		const t = setup({ metrics });
		await t.resolver.resolveAddress(t.args());
		expect(metrics.providerCall).toHaveBeenCalledTimes(1);
		expect(metrics.providerCall).toHaveBeenCalledWith("ok", expect.any(Number));
		expect(metrics.cacheHit).not.toHaveBeenCalled();
		await t.resolver.resolveAddress(t.args());
		expect(metrics.cacheHit).toHaveBeenCalledTimes(1);
		expect(metrics.providerCall).toHaveBeenCalledTimes(1);
	});

	it("labels an implausible rate as a failed call", async () => {
		const metrics = spy();
		const implausible: ProviderResult = {
			...(OK_WI as Extract<ProviderResult, { status: "ok" }>),
			components: [
				{ jurisdiction_type: "state", jurisdiction_name: "WI", jurisdiction_code: "55", rate: 0.4 },
			],
		};
		const t = setup({ metrics, provider: { name: "fixture", lookup: vi.fn(async () => implausible) } });
		await t.resolver.resolveAddress(t.args());
		expect(metrics.providerCall).toHaveBeenCalledWith("failed", expect.any(Number));
	});

	it("does not count a lookup the meter refused, or a held failure, as a provider call", async () => {
		const metrics = spy();
		const refused = setup({ metrics, allowed: false });
		await refused.resolver.resolveAddress(refused.args());
		expect(metrics.providerCall).not.toHaveBeenCalled();

		const failing = setup({
			metrics,
			provider: { name: "fixture", lookup: vi.fn(async () => ({ status: "failed", reason: "down" }) as ProviderResult) },
		});
		await failing.resolver.resolveAddress(failing.args());
		await failing.resolver.resolveAddress(failing.args());
		expect(metrics.providerCall).toHaveBeenCalledTimes(1);
	});
});
