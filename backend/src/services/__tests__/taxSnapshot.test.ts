import { describe, it, expect } from "vitest";
import { calculateDocumentTax } from "../taxEngine.js";
import { isLockedSnapshot, readTaxSnapshot, toSnapshotV2 } from "../tax/snapshot.js";

const v1 = calculateDocumentTax(
	{
		line_items: [
			{
				id: "l1",
				total_cents: 10000,
				taxable: true,
				tax_group: {
					id: "set-1",
					name: "Dane, WI (auto)",
					rates: [
						{
							id: "c1",
							name: "WI",
							rate: 0.05,
							jurisdiction: "state",
						},
						{
							id: "c2",
							name: "Local District: 37",
							rate: 0.00125,
							jurisdiction: "district",
						},
					],
				},
			},
		],
	},
	false
).snapshot;

describe("toSnapshotV2", () => {
	it("keeps every v1 figure and adds provenance", () => {
		const v2 = toSnapshotV2(v1, {
			source: "provider",
			rate_set_id: "set-1",
			review_reason: null,
			sourcing: "D",
		});
		expect(v2).toMatchObject({
			version: 2,
			source: "provider",
			rate_set_id: "set-1",
			sourcing: "D",
			rounding: "line_floor",
			locked_at: "draft",
			total_tax_cents: v1.total_tax_cents,
			subtotal_cents: 10000,
		});
		expect(v2.review_reason).toBeUndefined();
		expect(v2.groups[0].rates.map((r) => r.jurisdiction_type)).toEqual([
			"state",
			"district",
		]);
	});

	it("leaves free-text manual jurisdiction labels without a type unless they match", () => {
		const manual = calculateDocumentTax(
			{
				line_items: [
					{
						id: "l1",
						total_cents: 100,
						taxable: true,
						tax_group: {
							id: "g",
							name: "G",
							rates: [
								{
									id: "r",
									name: "Fed",
									rate: 0.1,
									jurisdiction: "Federal",
								},
								{
									id: "s",
									name: "St",
									rate: 0.01,
									jurisdiction: "State",
								},
							],
						},
					},
				],
			},
			false
		).snapshot;
		const v2 = toSnapshotV2(manual, {
			source: "manual_override",
			rate_set_id: null,
			review_reason: null,
			sourcing: null,
		});
		expect(v2.groups[0].rates[0].jurisdiction_type).toBeUndefined();
		expect(v2.groups[0].rates[1].jurisdiction_type).toBe("state");
		expect("rate_set_id" in v2).toBe(false);
	});
});

describe("readTaxSnapshot", () => {
	it("reads v1 and v2 and rejects junk", () => {
		expect(readTaxSnapshot(v1)?.version).toBe(1);
		expect(
			readTaxSnapshot(
				toSnapshotV2(v1, {
					source: null,
					rate_set_id: null,
					review_reason: "x",
					sourcing: null,
				})
			)?.version
		).toBe(2);
		expect(readTaxSnapshot(null)).toBeNull();
		expect(readTaxSnapshot({ version: 3, groups: [] })).toBeNull();
		expect(readTaxSnapshot({ version: 2 })).toBeNull();
	});
});

describe("isLockedSnapshot", () => {
	it("treats a draft or missing snapshot as unlocked", () => {
		expect(isLockedSnapshot(null)).toBe(false);
		expect(isLockedSnapshot({ locked_at: "draft" })).toBe(false);
		expect(isLockedSnapshot({ locked_at: "2026-10-14T00:00:00.000Z" })).toBe(true);
	});
});
