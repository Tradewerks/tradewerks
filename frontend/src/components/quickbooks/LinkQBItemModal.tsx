import { useMemo, useState } from "react";
import type { InventoryItem } from "../../types/inventory";
import {
	useLinkQBItemMutation,
	useQBItemsQuery,
	useQBMappedItemsQuery,
} from "../../hooks/useQuickbooks";
import FullPopup from "../ui/FullPopup";
import { TemplateSearch, type TemplateSearchResult } from "../ui/forms/TemplateSearch";

interface LinkQBItemModalProps {
	item: InventoryItem;
	onClose: () => void;
	isOpen: boolean;
}

export default function LinkQBItemModal({ item, onClose, isOpen }: LinkQBItemModalProps) {
	const { data: qbItems, isLoading: itemsLoading } = useQBItemsQuery(isOpen);
	const { data: mappedItems } = useQBMappedItemsQuery(isOpen);
	const linkMutation = useLinkQBItemMutation();
	const [selectedQbIds, setSelectedQbIds] = useState<string[]>([]);
	const selectedQbId = selectedQbIds[0];

	// Only offer QB items that aren't already linked to some inventory item
	const availableQbItems = useMemo(() => {
		const mappedExternalIds = new Set((mappedItems ?? []).map((m) => m.external_id));
		return (qbItems ?? []).filter((q) => !mappedExternalIds.has(q.Id));
	}, [qbItems, mappedItems]);

	const handleLink = async () => {
		if (!selectedQbId) return;
		try {
			await linkMutation.mutateAsync({ inventory_item_id: item.id, qb_item_id: selectedQbId });
			setSelectedQbIds([]);
			onClose();
		} catch (error) {
			console.error("Error linking QuickBooks item:", error);
		}
	};

	const templateResults = useMemo((): TemplateSearchResult[] => {
		return availableQbItems.map((i) => ({
			id: i.Id,
			title: i.Name,
			subtitle: i.Sku,
			detail: i.Description
				? i.Description.slice(0, 80) + (i.Description.length > 80 ? "…" : "")
				: undefined,
		}));
	}, [availableQbItems]);

	const handleToggleSelect = (id: string) => {
		setSelectedQbIds([id]);
	}

	const content = (
		<div className="flex flex-col px-5 py-5">
			<h2 className="mb-1 text-lg font-semibold text-text-primary">Link to QuickBooks Item</h2>
			<p className="mb-4 text-xs text-text-muted">
				Map <span className="font-medium text-text-secondary">{item.name}</span> to an existing
				QuickBooks item so synced invoice lines use the right product.
			</p>

			<TemplateSearch
				heading="Link QB Item"
				headingHint={`Select an item to link to`}
				placeholder="Search for items by number, name, or client..."
				results={templateResults}
				clients={[]}
				isLoading={itemsLoading}
				selectedIds={selectedQbIds}
				onToggleSelect={handleToggleSelect}
				onSelect={() => {}}
				onClose={onClose}
				emptyHint={"No items available to link to"}
			/>

			{linkMutation.isError && (
				<p className="mt-2 text-xs text-error-text">
					{(linkMutation.error as Error)?.message || "Failed to link item."}
				</p>
			)}

			<div className="mt-5 flex justify-end gap-2">
				<button
					type="button"
					onClick={onClose}
					className="rounded-md border border-border bg-base px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={handleLink}
					disabled={!selectedQbId || linkMutation.isPending}
					className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					{linkMutation.isPending ? "Linking…" : "Link"}
				</button>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={isOpen} onClose={onClose} size="md" />;
}
