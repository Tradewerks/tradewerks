export type LineItemToCreate = {
	name: string;
	description: string | null;
	quantity: number;
	unit_price: number;
	total?: number; // Optional - calculated if not provided
	source: "quote" | "recurring_plan" | "manual" | "field_addition";
	item_type: "labor" | "material" | "equipment" | "other" | null;
	sort_order?: number; // Optional - defaulted by context
	tax_group_id?: string | null;
	taxable?: boolean;
	inventory_item_id?: string | null;
};

// For logging
export type ChangeSet = Record<string, { old: any; new: any }>;

export type OccurrenceGenerationResult = {
	generated: number;
	skipped: number;
	start_date: Date;
	end_date: Date;
};

export type VisitGenerationResult = {
	visit_id: string;
	occurrence_id: string;
	scheduled_start_at: Date;
	scheduled_end_at: Date;
	template_version: number;
};
