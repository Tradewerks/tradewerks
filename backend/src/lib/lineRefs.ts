import type { Prisma } from "../../generated/prisma/client.js";
import { DocumentRuleError } from "./statusTransitions.js";
import {
	findForeignInventoryItemIds,
	unknownInventoryItemsMessage,
} from "./inventory.js";

/**
 * Catalog references a caller put on line items, checked against the
 * organization before they are persisted. invoice_line_item is not scoped by
 * getScopedDb, so a foreign id would sit on a real invoice line and any later
 * join through it would cross tenants. Jobs and visits are not checked here:
 * callers hold them to the document's own links, which is the stronger rule.
 */
export async function assertLineRefsInOrg(
	client: Prisma.TransactionClient,
	organizationId: string,
	lines: readonly {
		inventory_item_id?: string | null;
		tax_group_id?: string | null;
	}[],
): Promise<void> {
	const foreignItems = await findForeignInventoryItemIds(
		client,
		organizationId,
		lines.map((line) => line.inventory_item_id),
	);
	if (foreignItems.length > 0) {
		throw new DocumentRuleError(unknownInventoryItemsMessage(foreignItems));
	}

	const taxGroupIds = [
		...new Set(
			lines
				.map((line) => line.tax_group_id)
				.filter((id): id is string => !!id),
		),
	];
	if (taxGroupIds.length === 0) return;
	const found = await client.tax_group.findMany({
		where: { id: { in: taxGroupIds }, organization_id: organizationId },
		select: { id: true },
	});
	const known = new Set(found.map((group) => group.id));
	const foreignGroups = taxGroupIds.filter((id) => !known.has(id));
	if (foreignGroups.length > 0) {
		throw new DocumentRuleError(
			`Validation failed: unknown tax group ${foreignGroups.join(", ")}`,
		);
	}
}
