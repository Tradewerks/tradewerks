import { Plus, Download } from "lucide-react";
import { useState } from "react";
import LineItemCard, { type SourceJob } from "./LineItemCard";
import type { BaseLineItem, LineItemDisposition } from "../../../types/common";
import type { InventoryItem } from "../../../types/inventory";
import type { TaxGroup } from "../../../types/tax";
import { formatTaxGroupLabel } from "../../../types/tax";

interface LineItemsSectionProps {
	lineItems: BaseLineItem[];
	isLoading: boolean;
	onAdd: () => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, field: keyof BaseLineItem, value: string | number) => void;
	onUpdateSource?: (
		id: string,
		sourceJobId: string | null,
		sourceVisitId: string | null
	) => void;
	subtotal: number;
	required?: boolean;
	minItems?: number;
	dirtyFields?: Record<string, boolean>;
	onUndo?: (id: string, field: keyof BaseLineItem) => void;
	onClear?: (id: string, field: keyof BaseLineItem) => void;
	onUndoSource?: (id: string) => void;
	originalLineItemsMap?: Map<string, BaseLineItem>;
	// Source attribution context — linked jobs and their selected visits
	sourceJobs?: SourceJob[];
	// Import — if provided, shows the import button
	onImport?: () => void;
	importLabel?: string;
	importLoading?: boolean;
	// When true, the header row sticks to the top of the nearest scroll container
	stickyHeader?: boolean;
	inventoryItems?: InventoryItem[];
	/** Visit and recurring-plan forms — see LineItemCard's showDisposition. */
	showDisposition?: boolean;
	vehicles?: { id: string; name: string }[];
	onDispositionChange?: (
		id: string,
		disposition: LineItemDisposition | null,
		vehicleId?: string | null,
	) => void;
	// Without it the picker stays hidden and material lines fall back to freetext.
	onLinkInventory?: (
		id: string,
		link: { inventory_item_id: string; name: string; unit_price: number | null } | null,
	) => void;
	// Tax
	taxGroups?: TaxGroup[];
	clientExempt?: boolean;
	onTaxChange?: (id: string, groupId: string | null, taxable: boolean) => void;
	onTaxGroupBulkSet?: (groupId: string | null, taxable: boolean) => void;
}

const LineItemsSection = ({
	lineItems,
	isLoading,
	onAdd,
	onRemove,
	onUpdate,
	onUpdateSource,
	subtotal,
	required = false,
	minItems = 1,
	dirtyFields,
	onUndo,
	onClear,
	onUndoSource,
	originalLineItemsMap,
	sourceJobs = [],
	onImport,
	importLabel,
	importLoading = false,
	stickyHeader = false,
	inventoryItems,
	showDisposition,
	vehicles,
	onDispositionChange,
	onLinkInventory,
	taxGroups = [],
	clientExempt = false,
	onTaxChange,
	onTaxGroupBulkSet,
}: LineItemsSectionProps) => {
	const canRemove = lineItems.length > minItems;
	const [bulkSelectKey, setBulkSelectKey] = useState(0);

	return (
		<div className="flex flex-col gap-2 lg:gap-3">
			{/* Header row */}
			<div
				className={
					stickyHeader
						? "sticky top-0 z-10 bg-base -mx-4 sm:-mx-5 px-4 sm:px-5 pt-2"
						: undefined
				}
			>
				<div className={`flex items-center justify-between gap-2${stickyHeader ? " pb-2" : ""}`}>
					<h3 className="text-xs lg:text-sm font-semibold text-text-primary uppercase tracking-wider flex-shrink-0">
						Line Items {required && "*"}
					</h3>
					<div className="flex items-center gap-2 min-w-0">
						{/* Import button — shown when there are linked visit/job items to import */}
						{onImport && (
							<button
								type="button"
								onClick={onImport}
								disabled={isLoading || importLoading}
								className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-primary-border bg-primary-bg-dim text-xs font-medium text-primary-text hover:bg-primary-bg-subtle hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
							>
								<Download size={12} />
								{importLoading ? "Importing…" : (importLabel ?? "Import")}
							</button>
						)}
						{/* Bulk tax group selector — hidden when exempt or no groups configured */}
						{!clientExempt && taxGroups.length > 0 && onTaxGroupBulkSet && (
							<div className="flex items-center gap-1.5 flex-shrink-0">
								<span className="text-xs text-text-tertiary">Tax:</span>
								<select
									key={bulkSelectKey}
									onChange={(e) => {
										const val = e.target.value;
										if (val === "none") onTaxGroupBulkSet(null, false);
										else onTaxGroupBulkSet(val, true);
										setBulkSelectKey((k) => k + 1);
									}}
									defaultValue=""
									disabled={isLoading}
									title="Apply tax group to all items"
									className="border border-border px-2 h-[26px] rounded bg-base text-xs text-text-muted transition-colors focus:outline-none focus:border-primary hover:border-border-strong disabled:opacity-50 disabled:cursor-not-allowed [&>option]:bg-base [&>option]:text-text-primary"
								>
									<option value="" disabled hidden>
										Apply to all…
									</option>
									<option value="none">
										No Tax
									</option>
									{taxGroups.map((group) => (
										<option
											key={group.id}
											value={group.id}
										>
											{formatTaxGroupLabel(group)}
										</option>
									))}
								</select>
							</div>
						)}
						<div className="text-xs lg:text-sm text-text-tertiary flex-shrink-0">
							Subtotal:{" "}
							<span className="text-text-primary font-semibold">
								${subtotal.toFixed(2)}
							</span>
						</div>
					</div>
				</div>
				{stickyHeader && <div className="border-b border-border -mr-1.5 sm:-ml-1 sm:-mr-2.5" />}
			</div>

			{/* Line item cards */}
			<div className="flex flex-col gap-2 lg:gap-3">
				{lineItems.map((item, index) => (
					<LineItemCard
						key={item.id}
						item={item}
						index={index}
						isLoading={isLoading}
						canRemove={canRemove}
						onRemove={onRemove}
						onUpdate={onUpdate}
						dirtyFields={dirtyFields}
						onUndo={onUndo}
						onClear={onClear}
						onUndoSource={onUndoSource}
						originalLineItemsMap={originalLineItemsMap}
						onUpdateSource={onUpdateSource}
						sourceJobs={sourceJobs}
						inventoryItems={inventoryItems}
						showDisposition={showDisposition}
						vehicles={vehicles}
						onDispositionChange={onDispositionChange}
						onLinkInventory={onLinkInventory}
						taxGroups={taxGroups}
						clientExempt={clientExempt}
						onTaxChange={onTaxChange}
					/>
				))}
			</div>

			<button
				type="button"
				onClick={onAdd}
				disabled={isLoading}
				className="w-full flex items-center justify-center gap-1 px-3 py-1.5 lg:py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs lg:text-sm font-medium text-on-primary transition-colors"
			>
				<Plus size={14} />
				Add Item
			</button>
		</div>
	);
};

export default LineItemsSection;
