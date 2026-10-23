const { sdb } = vi.hoisted(() => ({
	sdb: {
		organization: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
	},
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm-now"),
}));
vi.mock("../qb/qbQuery.js", () => ({
	qbQueryAll: vi.fn(),
	getAccountId: vi.fn(async () => "exp-1"),
}));
vi.mock("../stockMovements.js", () => ({ recordMovements: vi.fn() }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { qbFetch } from "../quickbooksService.js";
import { qbQueryAll } from "../qb/qbQuery.js";
import {
	ensureTaxableItem,
	isItemRefFault,
	loadTaxableItem,
	qbLineItemRef,
	TAXABLE_ITEM_NAME,
	withTaxableItemRecovery,
} from "../qb/qbTaxableItem.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const standIn = { id: "T-1", name: TAXABLE_ITEM_NAME };

describe("qbLineItemRef", () => {
	const mapped = {
		name: "Capacitor",
		taxable: true,
		inventory_item: { name: "Capacitor 45/5", external_mappings: [{ external_id: "55" }] },
	};

	it("uses the mapped QuickBooks item first", () => {
		expect(qbLineItemRef(mapped, standIn)).toEqual({ value: "55", name: "Capacitor 45/5" });
		expect(qbLineItemRef({ ...mapped, taxable: false }, null).value).toBe("55");
	});

	it("uses the stand-in for a taxable unmapped line", () => {
		expect(qbLineItemRef({ name: "Labor", taxable: true, inventory_item: null }, standIn)).toEqual({
			value: "T-1",
			name: TAXABLE_ITEM_NAME,
		});
	});

	it("falls back to Services for a non-taxable line or when there is no stand-in", () => {
		const services = { value: "1", name: "Services" };
		expect(qbLineItemRef({ name: "Labor", taxable: false, inventory_item: null }, standIn)).toEqual(
			services,
		);
		expect(qbLineItemRef({ name: "Labor", taxable: true, inventory_item: null }, null)).toEqual(
			services,
		);
	});
});

describe("loadTaxableItem", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the stored item for the requested realm", async () => {
		sdb.organization.findUnique.mockResolvedValue({
			qb_taxable_item_id: "T-1",
			qb_taxable_item_realm_id: "realm-now",
		});
		expect(await loadTaxableItem(sdb as never, "org1", "realm-now")).toEqual(standIn);
	});

	it("ignores an item stored for another QuickBooks company", async () => {
		sdb.organization.findUnique.mockResolvedValue({
			qb_taxable_item_id: "T-OLD",
			qb_taxable_item_realm_id: "realm-old",
		});
		expect(await loadTaxableItem(sdb as never, "org1", "realm-now")).toBeNull();
	});
});

describe("ensureTaxableItem", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(qbQueryAll).mockImplementation(async (_org: string, entity: string) =>
			entity === "Account" ? [{ Id: "inc-1", AccountSubType: "ServiceFeeIncome" }] : [],
		);
		mockFn(qbFetch).mockResolvedValue({ Item: { Id: "T-NEW" } });
	});

	it("returns the stored item without calling QuickBooks", async () => {
		sdb.organization.findUnique.mockResolvedValue({
			qb_taxable_item_id: "T-1",
			qb_taxable_item_realm_id: "realm-now",
		});
		expect(await ensureTaxableItem("org1", "realm-now")).toEqual(standIn);
		expect(qbFetch).not.toHaveBeenCalled();
	});

	it("creates a new item after a company switch and overwrites both columns", async () => {
		sdb.organization.findUnique.mockResolvedValue({
			qb_taxable_item_id: "T-OLD",
			qb_taxable_item_realm_id: "realm-old",
		});

		expect(await ensureTaxableItem("org1", "realm-now")).toEqual({
			id: "T-NEW",
			name: TAXABLE_ITEM_NAME,
		});
		expect(sdb.organization.update).toHaveBeenCalledWith({
			where: { id: "org1" },
			data: { qb_taxable_item_id: "T-NEW", qb_taxable_item_realm_id: "realm-now" },
		});
		const sentIds = mockFn(qbFetch).mock.calls.map((c) => JSON.stringify(c));
		expect(sentIds.some((s) => s.includes("T-OLD"))).toBe(false);
	});

	it("creates a taxable Service item with no tax classification", async () => {
		sdb.organization.findUnique.mockResolvedValue(null);

		await ensureTaxableItem("org1", "realm-now");

		const create = mockFn(qbFetch).mock.calls.find((c) => c[1] === "POST" && c[2] === "/item");
		expect(create![3]).toMatchObject({ Name: TAXABLE_ITEM_NAME, Type: "Service", Taxable: true });
		expect(create![3]).not.toHaveProperty("TaxClassificationRef");
	});

	it("returns null instead of throwing when QuickBooks rejects", async () => {
		sdb.organization.findUnique.mockResolvedValue(null);
		mockFn(qbFetch).mockRejectedValue(new Error("6240 duplicate name"));

		await expect(ensureTaxableItem("org1", "realm-now")).resolves.toBeNull();
		expect(sdb.organization.update).not.toHaveBeenCalled();
	});
});

const qbFault = (code: string, message = "Object Not Found") =>
	new Error(
		`QB POST /invoice → 400: {"Fault":{"Error":[{"Message":"${message}","code":"${code}"}],"type":"ValidationFault"}}`,
	);

describe("isItemRefFault", () => {
	it("matches QuickBooks' inactive-reference and invalid-reference faults", () => {
		expect(isItemRefFault(qbFault("610"))).toBe(true);
		expect(isItemRefFault(qbFault("2500", "Invalid Reference Id"))).toBe(true);
	});

	it("ignores other faults and non-JSON errors", () => {
		expect(isItemRefFault(qbFault("6000"))).toBe(false);
		expect(isItemRefFault(new Error("QB POST /invoice → 401: Unauthorized"))).toBe(false);
		expect(isItemRefFault("610")).toBe(false);
	});
});

describe("withTaxableItemRecovery", () => {
	const stale = { id: "T-STALE", name: TAXABLE_ITEM_NAME };
	const usesIt = () => true;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(qbQueryAll).mockImplementation(async (_org: string, entity: string) =>
			entity === "Account" ? [{ Id: "inc-1", AccountSubType: "ServiceFeeIncome" }] : [],
		);
		mockFn(qbFetch).mockResolvedValue({ Item: { Id: "T-NEW" } });
	});

	it("clears a stale stand-in id, re-creates the item and retries once", async () => {
		const push = vi
			.fn()
			.mockRejectedValueOnce(qbFault("610"))
			.mockResolvedValueOnce("pushed");

		await expect(
			withTaxableItemRecovery("org1", "realm-now", stale, usesIt, push),
		).resolves.toBe("pushed");

		expect(push).toHaveBeenCalledTimes(2);
		expect(push.mock.calls[1][0]).toEqual({ id: "T-NEW", name: TAXABLE_ITEM_NAME });
		expect(sdb.organization.update.mock.calls.map((c) => (c as any)[0].data)).toEqual([
			{ qb_taxable_item_id: null, qb_taxable_item_realm_id: null },
			{ qb_taxable_item_id: "T-NEW", qb_taxable_item_realm_id: "realm-now" },
		]);
	});

	it("reactivates an inactive stand-in instead of creating a duplicate", async () => {
		mockFn(qbQueryAll).mockImplementation(async (_org: string, entity: string, where: string) =>
			entity === "Item" && where.includes("Active IN (true, false)")
				? [{ Id: "T-STALE", SyncToken: "4", Active: false }]
				: [],
		);
		const push = vi.fn().mockRejectedValueOnce(qbFault("610")).mockResolvedValueOnce("ok");

		await withTaxableItemRecovery("org1", "realm-now", stale, usesIt, push);

		const posts = mockFn(qbFetch).mock.calls.filter((c) => c[1] === "POST" && c[2] === "/item");
		expect(posts).toHaveLength(1);
		expect(posts[0][3]).toEqual({ Id: "T-STALE", SyncToken: "4", sparse: true, Active: true });
		expect(push.mock.calls[1][0]).toEqual(stale);
	});

	it("does not retry when the fault is not an item reference", async () => {
		const push = vi.fn().mockRejectedValue(qbFault("6000"));

		await expect(withTaxableItemRecovery("org1", "realm-now", stale, usesIt, push)).rejects.toThrow(
			/6000/,
		);
		expect(push).toHaveBeenCalledTimes(1);
		expect(sdb.organization.update).not.toHaveBeenCalled();
		expect(qbQueryAll).not.toHaveBeenCalled();
	});

	it("does not retry when the payload did not use the stand-in", async () => {
		const push = vi.fn().mockRejectedValue(qbFault("610"));

		await expect(
			withTaxableItemRecovery("org1", "realm-now", stale, () => false, push),
		).rejects.toThrow();
		expect(push).toHaveBeenCalledTimes(1);
		expect(sdb.organization.update).not.toHaveBeenCalled();
	});

	it("does not retry when the stored stand-in is still active", async () => {
		mockFn(qbQueryAll).mockResolvedValue([{ Id: "T-STALE", SyncToken: "1", Active: true }]);
		const push = vi.fn().mockRejectedValue(qbFault("610"));

		await expect(withTaxableItemRecovery("org1", "realm-now", stale, usesIt, push)).rejects.toThrow();
		expect(push).toHaveBeenCalledTimes(1);
		expect(sdb.organization.update).toHaveBeenLastCalledWith({
			where: { id: "org1" },
			data: { qb_taxable_item_id: "T-STALE", qb_taxable_item_realm_id: "realm-now" },
		});
	});

	it("retries at most once", async () => {
		const push = vi.fn().mockRejectedValue(qbFault("610"));

		await expect(withTaxableItemRecovery("org1", "realm-now", stale, usesIt, push)).rejects.toThrow(
			/610/,
		);
		expect(push).toHaveBeenCalledTimes(2);
	});

	it("makes no QuickBooks call on the happy path", async () => {
		const push = vi.fn().mockResolvedValue("ok");

		await withTaxableItemRecovery("org1", "realm-now", stale, usesIt, push);

		expect(qbFetch).not.toHaveBeenCalled();
		expect(qbQueryAll).not.toHaveBeenCalled();
		expect(sdb.organization.update).not.toHaveBeenCalled();
	});
});
