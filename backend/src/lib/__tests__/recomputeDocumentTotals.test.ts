import { describe, it, expect, vi } from "vitest";
import {
	recomputeDocumentTotals,
	lockDocumentTaxSnapshot,
} from "../recomputeDocumentTotals.js";
import type { Prisma } from "../../../generated/prisma/client.js";

// A tx whose document lookups all miss. The not-found branch returns before any
// tax calculation, so nothing else needs stubbing.
const missingTx = {
	invoice: { findFirst: vi.fn().mockResolvedValue(null) },
	quote: { findFirst: vi.fn().mockResolvedValue(null) },
} as unknown as Prisma.TransactionClient;

describe("recomputeDocumentTotals — DW-32 result contract", () => {
	it("reports not_found instead of a bare false when the id resolves to nothing", async () => {
		const result = await recomputeDocumentTotals(
			"invoice",
			"missing",
			"org1",
			missingTx,
		);
		expect(result).toEqual({ ok: false, reason: "not_found" });
	});

	it("lockDocumentTaxSnapshot throws on a missing document rather than silently skipping", async () => {
		await expect(
			lockDocumentTaxSnapshot("invoice", "missing", "org1", missingTx),
		).rejects.toThrow(/not found/);
	});
});
