import type { LineItemSeed } from "../../hooks/forms/useLineItems";
import type { JobLineItem, VisitLineItem } from "../../types/jobs";

/** Seed for an invoice line copied from a job line; keeps the line's own tax group. */
export function jobLineSeed(item: JobLineItem, jobId: string): LineItemSeed {
	return {
		name: item.name ?? "",
		description: item.description ?? "",
		quantity: Number(item.quantity ?? 1),
		unit_price: Number(item.unit_price ?? 0),
		item_type: item.item_type ?? "",
		inventory_item_id: item.inventory_item_id ?? null,
		source_job_id: jobId,
		source_visit_id: null,
		taxable: item.taxable,
		tax_group_id: item.tax_group_id ?? null,
	};
}

/** Seed for an invoice line copied from a visit line; keeps the line's own tax group. */
export function visitLineSeed(
	li: VisitLineItem,
	visitId: string,
	jobId: string | null,
): LineItemSeed {
	return {
		name: li.name,
		description: li.description ?? "",
		quantity: Number(li.quantity),
		unit_price: Number(li.unit_price),
		item_type: li.item_type ?? "",
		// The visit is where the link is real — a tech scanned or picked this part.
		inventory_item_id: li.inventory_item_id ?? null,
		source_visit_id: visitId,
		source_job_id: jobId,
		taxable: li.taxable,
		tax_group_id: li.tax_group_id ?? null,
	};
}
