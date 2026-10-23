/** Structural, so the scoped-db transaction client fits as well as Prisma.TransactionClient. */
interface InventoryTaxableReader {
	inventory_item: {
		findMany(args: {
			where: { id: { in: string[] }; organization_id: string };
			select: { id: true; taxable: true };
		}): Promise<{ id: string; taxable: boolean }[]>;
	};
}

type TaxableLine = { inventory_item_id?: string | null; taxable?: boolean };

/**
 * A new line takes its inventory item's `taxable` once, when added; later item edits never reach
 * it. An explicit `taxable` from the client wins.
 */
export async function applyInventoryTaxable<T extends TaxableLine>(
	tx: InventoryTaxableReader,
	orgId: string,
	lines: T[],
): Promise<(T & TaxableLine)[]> {
	const ids = [
		...new Set(
			lines
				.filter((l) => l.taxable === undefined && l.inventory_item_id)
				.map((l) => l.inventory_item_id as string),
		),
	];
	if (ids.length === 0) return lines;
	const rows = await tx.inventory_item.findMany({
		where: { id: { in: ids }, organization_id: orgId },
		select: { id: true, taxable: true },
	});
	const byId = new Map(rows.map((r) => [r.id, r.taxable]));
	return lines.map((l) =>
		l.taxable === undefined && l.inventory_item_id && byId.has(l.inventory_item_id)
			? { ...l, taxable: byId.get(l.inventory_item_id) as boolean }
			: l,
	);
}

/**
 * Update paths: fill only lines not already stored. Filling an existing line that omits `taxable`
 * would overwrite its stored value with the inventory default.
 * Returns a lookup giving each incoming line its filled version (existing lines unchanged).
 */
export async function applyInventoryTaxableToNewLines<T extends TaxableLine & { id?: string }>(
	tx: InventoryTaxableReader,
	orgId: string,
	lines: T[],
	existingIds: { has(id: string): boolean },
): Promise<(line: T) => T & TaxableLine> {
	const newLines = lines.filter((l) => !(l.id && existingIds.has(l.id)));
	const filled = await applyInventoryTaxable(tx, orgId, newLines);
	const byLine = new Map(newLines.map((l, k) => [l, filled[k]]));
	return (line) => byLine.get(line) ?? line;
}

type LineTaxFields = { taxable?: boolean; tax_group_id?: string | null };

/** Existing line: only the fields the client sent, so an omitted one keeps its stored value. */
export function lineTaxFieldsForUpdate(item: LineTaxFields): LineTaxFields {
	return {
		...(item.taxable !== undefined && { taxable: item.taxable }),
		...(item.tax_group_id !== undefined && { tax_group_id: item.tax_group_id }),
	};
}

/** New line: pass it after the inventory fill; a line still without a flag is taxable. */
export function lineTaxFieldsForCreate(item: LineTaxFields): {
	taxable: boolean;
	tax_group_id: string | null;
} {
	return { taxable: item.taxable ?? true, tax_group_id: item.tax_group_id ?? null };
}
