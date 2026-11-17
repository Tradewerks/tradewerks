import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "../../../generated/prisma/client.js";
import { assertInventoryItemsInOrg } from "../inventory.js";
import { assertTaxGroupsInOrg } from "../taxHelpers.js";

// A foreign id is the caller's mistake: it must reach the global handler as a 400, not a 500.
describe("org-membership asserts carry a 400", () => {
	it("unknown inventory item", async () => {
		const client = { inventory_item: { findMany: vi.fn(async () => []) } };
		await expect(
			assertInventoryItemsInOrg(client as never, "org-1", ["item-x"]),
		).rejects.toMatchObject({
			statusCode: 400,
			code: "VALIDATION_ERROR",
			message: "Validation failed: unknown inventory item item-x",
		});
	});

	it("unknown tax group", async () => {
		const tx = { tax_group: { count: vi.fn(async () => 0) } };
		await expect(
			assertTaxGroupsInOrg(tx as unknown as Prisma.TransactionClient, "org-1", ["tg-x"]),
		).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR", message: "Tax group not found" });
	});
});
