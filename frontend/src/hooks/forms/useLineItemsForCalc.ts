import { useMemo } from "react";
import type { BaseLineItem } from "../../types/common";
import { effectiveLineGroupId } from "../../lib/taxEditorMode";
import type { LineItemForCalc } from "./useFinancialCalculations";

/** Lines as the server taxes them: an ungrouped line takes the client's group. */
export function useLineItemsForCalc(
	activeLineItems: BaseLineItem[],
	clientTaxGroupId: string | null,
): LineItemForCalc[] {
	return useMemo(
		() =>
			activeLineItems.map((item) => ({
				id: item.id,
				total: Number(item.total),
				taxable: item.taxable ?? true,
				tax_group_id: effectiveLineGroupId(item.tax_group_id, clientTaxGroupId),
			})),
		[activeLineItems, clientTaxGroupId],
	);
}
