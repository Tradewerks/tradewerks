import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Plus, FileSpreadsheet, Barcode, Truck, X, AlertTriangle } from "lucide-react";
import { BarcodeScanner } from "../../components/inventory/BarcodeScanner";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { useScanDispatcher } from "../../hooks/useScanDispatcher";
import InventoryItemView from "../../components/inventory/InventoryItemView";
import LowStockList from "../../components/inventory/LowStockList";
import CreateInventoryItem from "../../components/inventory/CreateInventoryItem";
import InventoryImportExport from "../../components/inventory/InventoryImportExport";
import TagPicker from "../../components/inventory/TagPicker";
import TagManagerModal from "../../components/inventory/TagManagerModal";
import FilterChips, { type FilterChip } from "../../components/ui/FilterChips";
import {
	useAllInventoryQuery,
	useDeleteInventoryItemMutation,
	useInventoryTagsQuery,
	useReconcileQueueQuery,
} from "../../hooks/useInventory";
import type { InventoryItem, InventorySortOption } from "../../types/inventory";
import LoadSvg from "../../assets/icons/loading.svg?react";
import SearchBar from "../../components/ui/SearchBar";
import ViewToggle from "../../components/ui/ViewToggle";
import PageControls from "../../components/ui/PageControls";
import StatusFilter from "../../components/ui/StatusFilter";
import { moneyRound } from "../../components/reconcile/reconcileFormat";
import PageHeader from "../../components/ui/PageHeader";
import { usePermission } from "../../hooks/usePermission";
import PageReportButton from "../../components/reports/PageReportButton";
import PageReportKpis from "../../components/reports/PageReportKpis";
import { usePageReport } from "../../components/reports/usePageReport";
import {
	useQBStatusQuery,
	useQBMappedItemsQuery,
} from "../../hooks/useQuickbooks";
import LinkQBItemModal from "../../components/quickbooks/LinkQBItemModal";
import LabelQueueToast from "../../components/inventory/labels/LabelQueueToast";
import LabelQueueButton from "../../components/inventory/labels/LabelQueueButton";
import { useInventoryViewMode } from "../../hooks/useInventoryViewMode";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { getItemStockStatus } from "../../util/util";
import UntrackedStockNotice from "../../components/entitlements/UntrackedStockNotice";

const SORT_OPTIONS: { value: InventorySortOption; label: string }[] = [
	{ value: "name", label: "Name A-Z" },
	{ value: "quantity_desc", label: "Highest Stock" },
	{ value: "quantity_asc", label: "Lowest Stock" },
	{ value: "most_used", label: "Most Used" },
	{ value: "recently_added", label: "Recently Added" },
];

// `none` is an item with no low-stock threshold — the badge's "No Alert".
const STOCK_OPTIONS = [
	{ value: "sufficient", label: "Sufficient" },
	{ value: "low", label: "Low" },
	{ value: "out_of_stock", label: "Out of Stock" },
	{ value: "none", label: "No Alert" },
];

export default function InventoryPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const navigate = useNavigate();
	const [sort, setSort] = useState<InventorySortOption>("name");
	const [search, setSearch] = useState("");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [unassignedOnly, setUnassignedOnly] = useState(false);
	// URL-backed so the report popover's stock-status slices drill here.
	const {
		terms: stockTerms,
		removeTerm: removeStockFilter,
		clearAll: clearStockFilter,
	} = useMultiSearch("stock");
	// getAll() hands back a new array every render; key on its contents so
	// filteredItems only recomputes when the selection changes.
	const stockKey = stockTerms.join(",");
	const stockFilter = useMemo(() => (stockKey ? stockKey.split(",") : []), [stockKey]);
	const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [isImportExportOpen, setIsImportExportOpen] = useState(false);
	const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useInventoryViewMode();
	const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
	const [pendingScrollToId, setPendingScrollToId] = useState<string | null>(null);
	const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const qbConnected = !!useQBStatusQuery().data?.connected;
	const [linkItem, setLinkItem] = useState<InventoryItem | null>(null);
	
	const [isScannerOpen, setIsScannerOpen] = useState(false);
	const [scanNotFoundCode, setScanNotFoundCode] = useState<string | null>(null);
	const [createPrefillBarcode, setCreatePrefillBarcode] = useState<string | undefined>(undefined);

	//permissions
	const MANAGE_INVENTORY = usePermission("manage_inventory");
	const report = usePageReport("inventory", "Inventory report");

	const { data: inventoryItems = [], isLoading, error } = useAllInventoryQuery(sort);
	// The reconcile page reads this same cached query, so arriving costs no
	// extra round trip. Value not count: this chip has to earn a click.
	const { data: reconcile } = useReconcileQueueQuery(undefined, MANAGE_INVENTORY);
	const reconcileCount = (reconcile?.provisional_total ?? 0) + (reconcile?.unmapped_total ?? 0);
	const reconcileValue = (reconcile?.unmapped_value ?? 0) + (reconcile?.provisional_value ?? 0);

	const { data: mappedItems = [] } = useQBMappedItemsQuery(qbConnected);

	const { data: allTags = [] } = useInventoryTagsQuery();

	const deleteMutation = useDeleteInventoryItemMutation();

	// Distinct categories already in use, fed to the create/edit form's datalist.
	// Derived from the list this page already holds — no extra request, and no
	// new endpoint, since category is freetext with no canonical vocabulary.
	const categorySuggestions = useMemo(
		() =>
			[...new Set(inventoryItems.map((i) => i.category).filter(Boolean))]
				.sort((a, b) => a!.localeCompare(b!))
				.map((c) => c as string),
		[inventoryItems]
	);

	const filteredItems = useMemo(() => {
		let items = inventoryItems;

		if (search.trim()) {
			const q = search.toLowerCase();
			items = items.filter(
				(item) =>
					item.name.toLowerCase().includes(q) ||
					(item.sku && item.sku.toLowerCase().includes(q)) ||
					(item.barcode && item.barcode.toLowerCase().includes(q)) ||
					(item.location?.toLowerCase().includes(q) ?? false) ||
					// Matches the technician vehicle page and AdjustStockModal,
					// which already searched category — this page was the outlier.
					(item.category?.toLowerCase().includes(q) ?? false) ||
					(item.alt_ids?.some((id) => id.toLowerCase().includes(q)) ?? false),
			);
		}

		if (selectedTagIds.length > 0) {
			items = items.filter((item) =>
				item.tags?.some((t) => selectedTagIds.includes(t.id)),
			);
		}

		if (unassignedOnly) {
			items = items.filter((item) => item.location == null);
		}

		if (stockFilter.length > 0) {
			items = items.filter((item) =>
				stockFilter.includes(getItemStockStatus(item) ?? "none"),
			);
		}

		return items;
	}, [inventoryItems, search, selectedTagIds, unassignedOnly, stockFilter]);

	const mappedIds = useMemo(() => {
		return new Set(mappedItems.map((item) => item.inventory_item_id));
	}, [mappedItems]);

	const stockChips: FilterChip[] = stockFilter.map((value) => ({
		label: `Stock: ${STOCK_OPTIONS.find((o) => o.value === value)?.label ?? value}`,
		color: "green" as const,
		onRemove: () => removeStockFilter(value),
	}));

	const activeTagChips: FilterChip[] = selectedTagIds.flatMap((id) => {
		const tag = allTags.find((t) => t.id === id);
		if (!tag) return [];
		return [{
			label: tag.label,
			color: "blue" as const,
			onRemove: () => setSelectedTagIds((prev) => prev.filter((i) => i !== id)),
		}];
	});

	if (unassignedOnly) {
		activeTagChips.push({
			label: "Unassigned location",
			color: "blue" as const,
			onRemove: () => setUnassignedOnly(false),
		});
	}

	const scrollAndHighlight = useCallback((itemId: string) => {
		cardRefs.current
			.get(itemId)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		// Only one item highlighted at a time — a new scan/click replaces
		// whichever card was previously highlighted. Clear first (even if
		// it's the same id) so the outline restarts, then set in the next frame.
		setHighlightedItemId(null);
		requestAnimationFrame(() => {
			setHighlightedItemId(itemId);
		});
	}, []);

	const handleHighlightMouseLeave = useCallback((itemId: string) => {
		setHighlightedItemId((prev) => (prev === itemId ? null : prev));
	}, []);

	useEffect(() => {
		if (!pendingScrollToId) return;
		if (!filteredItems.some((i) => i.id === pendingScrollToId)) return;
		scrollAndHighlight(pendingScrollToId);
		setPendingScrollToId(null);
	}, [pendingScrollToId, filteredItems, scrollAndHighlight]);

	const handleLowStockClick = useCallback(
		(itemId: string) => {
			if (!filteredItems.some((i) => i.id === itemId)) {
				setSearch("");
				setPendingScrollToId(itemId);
			} else {
				scrollAndHighlight(itemId);
			}
		},
		[filteredItems, scrollAndHighlight]
	);

	// useScanDispatcher directly rather than the useBarcodeScanHandler wrapper:
	// the wrapper collapses every code shape onto onItem, discarding the serial.
	// A `SN:` label needs to open that exact unit's drawer, not just its card.
	const { handleScan: scanAndBranch } = useScanDispatcher({
		onItem: (item) => {
			setSearch("");
			handleLowStockClick(item.id);
		},
		onSerial: (serial) =>
			navigate(
				`/dispatch/inventory/items/${serial.item.id}?tab=tracking&serial=${serial.serialUnitId}`,
			),
		// onBatch omitted deliberately — it falls back to onItem(batch.item),
		// which highlights the parent item's card. Batch detail is still a full
		// page; routing a scan straight there is a separate decision.
		onNotFound: (code) => setScanNotFoundCode(code),
	});

	const handleBarcodeScan = useCallback(
		async (code: string) => {
			setScanNotFoundCode(null);
			await scanAndBranch(code);
		},
		[scanAndBranch]
	);

	// Wedge listener off while a modal owns scan input — otherwise scanning into
	// the Create/Edit Barcode field (data-barcode-input) double-fires the page
	// handler behind the modal (search cleared, wrong card highlighted).
	useBarcodeScanner(handleBarcodeScan, !isCreateOpen && !editingItem && !isScannerOpen);

	useEffect(() => {
		const highlightId = searchParams.get("highlight");
		if (!highlightId) return;
		setSearchParams((p) => { p.delete("highlight"); return p; }, { replace: true });
		handleLowStockClick(highlightId);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);  // run once on mount only

	const handleDelete = async (id: string) => {
		try {
			await deleteMutation.mutateAsync(id);
			setDeleteConfirmId(null);
			setDeleteError(null);
		} catch (e) {
			setDeleteError(
				e instanceof Error ? e.message : "Delete failed. Please try again."
			);
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<LoadSvg className="w-12 h-12 animate-spin text-primary" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex items-center justify-center h-full text-error-text">
				Failed to load inventory: {error.message}
			</div>
		);
	}

	return (
		<div className="flex h-full text-text-primary">
			{/* Main content */}
			<div className="flex-1 overflow-y-auto mr-7">
				<UntrackedStockNotice module="inventory" />
				<PageHeader title="Inventory" subtitle={<PageReportKpis report={report} />}>
					<PageReportButton report={report} />
						<LabelQueueButton />
						{/* Value-carrying, and absent entirely when there is nothing
						    to reconcile — a chip that is always there stops being
						    read. */}
						{MANAGE_INVENTORY && reconcileCount > 0 && (
							<button
								onClick={() => navigate("/dispatch/inventory/reconcile")}
								className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-warning/15 hover:bg-warning/25 border border-warning/40 text-sm font-medium text-warning-text transition-colors"
							>
								<AlertTriangle size={14} />
								Reconcile {reconcileCount}
								{reconcileValue > 0 && (
									<span className="tabular-nums opacity-80">
										· {moneyRound(reconcileValue)}
									</span>
								)}
							</button>
						)}
						<button
							onClick={() => navigate("/dispatch/inventory/suppliers")}
						className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-surface-raised border border-border text-sm font-medium text-text-secondary transition-colors"
					>
						<Truck size={14} />
						Suppliers
					</button>
					<button
						onClick={() => setIsImportExportOpen(true)}
						className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-surface-raised border border-border text-sm font-medium text-text-secondary transition-colors"
					>
						<FileSpreadsheet size={14} />
						Import / Export
					</button>
					<button
							title={!MANAGE_INVENTORY ? "You don't have permission to perform this action" : undefined}
							disabled={!MANAGE_INVENTORY}
							onClick={() => {
								if (!MANAGE_INVENTORY) return;
								setIsCreateOpen(true);
							}}
							className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary-hover hover:enabled:bg-primary-active text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							<Plus size={14} />
							New Item
						</button>
				</PageHeader>


				<PageControls
					className="mb-4"
					left={
						<div className="flex items-center gap-2 w-full">
							<SearchBar
								placeholder="Search name, SKU, barcode, category, location..."
								value={search}
								onChange={setSearch}
							/>
							<button
								onClick={() => setIsScannerOpen(true)}
								title="Scan barcode"
								className="inline-flex items-center justify-center h-9 w-9 flex-shrink-0 rounded-md bg-surface hover:bg-surface-raised border border-border text-text-secondary transition-colors"
							>
								<Barcode size={14} />
							</button>
						</div>
					}
					middle={
						<div className="flex items-center gap-2">
							<StatusFilter
								paramKey="stock"
								placeholder="Stock"
								allLabel="Any stock level"
								options={STOCK_OPTIONS}
							/>
							<TagPicker
								tags={allTags}
								selectedIds={selectedTagIds}
								onChange={setSelectedTagIds}
								onManage={() => setIsTagManagerOpen(true)}
							/>
							<StatusFilter
								placeholder="Sort"
								hideAll
								// StatusFilter became multi-select upstream, but a
								// sort is one-of: the array holds exactly the
								// active option, and picking another replaces it.
								values={[sort]}
								onChange={(v) =>
									v && setSort(v as InventorySortOption)
								}
								options={SORT_OPTIONS}
								exclusive
							/>
							<button
								type="button"
								onClick={() => setUnassignedOnly((v) => !v)}
								aria-pressed={unassignedOnly}
								title="Show only items with no location assigned"
								className={`flex items-center h-9 px-3 rounded-md border text-sm transition-colors cursor-pointer whitespace-nowrap ${
									unassignedOnly
										? "bg-primary-bg border-primary text-primary-text"
										: "bg-base border-border text-text-tertiary hover:text-text-primary"
								}`}
							>
								Unassigned location
							</button>
						</div>
					}
					right={
						<ViewToggle
							value={viewMode}
							onChange={setViewMode}
						/>
					}
				/>

				<FilterChips
					filters={[...stockChips, ...activeTagChips]}
					resultCount={filteredItems.length}
					onClearAll={() => {
						setSearch("");
						setSelectedTagIds([]);
						setUnassignedOnly(false);
						clearStockFilter();
					}}
				/>

				<div>
					{/* @container/list lets each list row decide whether it has
					    room to show Item Settings + Delete outright or must fold
					    them into its kebab — see InventoryItemView. */}
					<div
						className={
							viewMode === "card"
								? "grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3"
								: "@container/list flex flex-col gap-2"
						}
					>
						{filteredItems.map((item) => (
							<div
								key={item.id}
								ref={(el) => {
									if (el) cardRefs.current.set(item.id, el);
									else cardRefs.current.delete(item.id);
								}}
								// min-w-0: a grid item defaults to min-width:auto, so a
								// card holding an unbreakable 100-character SKU grew
								// its own track past its 1fr share and out of the
								// container.
								className="relative group h-full min-w-0"
							>
								<InventoryItemView
									item={item}
									viewMode={viewMode}
									isHighlighted={highlightedItemId === item.id}
									onHighlightMouseLeave={() => handleHighlightMouseLeave(item.id)}
									// Gated like onDelete below: the server enforces
									// manage_inventory on PATCH, so without it the edit
									// affordance only led to a rejected save.
									onEditItem={
										MANAGE_INVENTORY
											? () => setEditingItem(item)
											: undefined
									}
									onClick={() =>
										navigate(`/dispatch/inventory/items/${item.id}`)
									}
									// Undefined without permission rather than a
									// no-op handler — the row/card then renders no
									// delete affordance at all instead of a button
									// that silently does nothing.
									onDelete={
										MANAGE_INVENTORY
											? () =>
													setDeleteConfirmId(
														item.id
													)
											: undefined
									}
									onLinkQB={MANAGE_INVENTORY ? () => setLinkItem(item) : undefined}
									isLinkedToQB={mappedIds.has(item.id)}
									qbConnected={qbConnected}
								/>
							</div>
						))}

						{filteredItems.length === 0 && (
							<div className="w-full py-12 text-center text-text-muted">
								{search ||
								selectedTagIds.length > 0 ||
								unassignedOnly ||
								stockFilter.length > 0
									? "No items match your filters"
									: "No inventory items yet. Click \"New Item\" to add one."}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Low Stock Sidebar */}
			<LowStockList items={inventoryItems} onItemClick={handleLowStockClick} />

			{/* Import / Export Modal */}
			<InventoryImportExport
				isOpen={isImportExportOpen}
				onClose={() => setIsImportExportOpen(false)}
			/>

			{/* Tag Manager */}
			<TagManagerModal
				isOpen={isTagManagerOpen}
				onClose={() => setIsTagManagerOpen(false)}
			/>

			{/* Create/Edit Modal */}
			<CreateInventoryItem
				isOpen={isCreateOpen || !!editingItem}
				onClose={() => {
					setIsCreateOpen(false);
					setEditingItem(null);
					setCreatePrefillBarcode(undefined);
				}}
				existingItem={editingItem}
				prefillBarcode={createPrefillBarcode}
				categorySuggestions={categorySuggestions}
			/>

			{/* Barcode Scanner */}
			{isScannerOpen && (
				<BarcodeScanner
					onScan={(code) => {
						setIsScannerOpen(false);
						handleBarcodeScan(code);
					}}
					onClose={() => setIsScannerOpen(false)}
				/>
			)}

			{/* Scan: no matching item */}
			{scanNotFoundCode && (
				<div role="alert" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-error-bg border border-error-border rounded-lg shadow-2xl px-4 py-3">
					<span className="text-sm font-medium text-error-text">
						No item found for "{scanNotFoundCode}"
					</span>
					{MANAGE_INVENTORY && (
						<button
							onClick={() => {
								setCreatePrefillBarcode(scanNotFoundCode);
								setIsCreateOpen(true);
								setScanNotFoundCode(null);
							}}
							className="text-sm font-semibold text-primary hover:underline flex-shrink-0"
						>
							Add it
						</button>
					)}
					<button
						onClick={() => setScanNotFoundCode(null)}
						className="text-error-text/70 hover:text-error-text transition-colors flex-shrink-0"
					>
						<X size={14} />
					</button>
				</div>
			)}

			{/* Label-queue add confirmation toast */}
			<LabelQueueToast />

			{/* Link to QuickBooks Modal */}
			{linkItem && (
				<LinkQBItemModal
					item={linkItem}
					isOpen={!!linkItem}
					onClose={() => setLinkItem(null)}
				/>
			)}

			{/* Delete Confirmation */}
			{deleteConfirmId && (
				<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
					<div className="bg-base border border-border rounded-xl p-6 max-w-sm w-full mx-4">
						<h3 className="text-lg font-semibold text-text-primary mb-2">
							Delete Item
						</h3>
						<p className="text-sm text-text-tertiary mb-4">
							Are you sure you want to delete this inventory item? This action can be undone by
							reactivating the item.
						</p>
						{deleteError && (
							<p className="text-sm text-error-text mb-3">
								{deleteError}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<button
								onClick={() => {
									setDeleteConfirmId(null);
									setDeleteError(null);
								}}
								className="px-3 py-1.5 rounded-md border border-border text-sm text-text-tertiary hover:text-text-primary hover:bg-surface transition-colors"
							>
								Cancel
							</button>
							<button
								onClick={() => handleDelete(deleteConfirmId)}
								disabled={deleteMutation.isPending || !MANAGE_INVENTORY}
								className="px-3 py-1.5 rounded-md bg-error hover:enabled:bg-error-strong text-sm font-medium text-on-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{deleteMutation.isPending ? "Deleting..." : "Delete"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
