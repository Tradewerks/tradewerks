import { useState, useMemo, useEffect, useRef } from "react";
import {
	Search,
	Plus,
	Package,
	Pencil,
	ChevronDown,
	ChevronUp,
	AlertTriangle,
	Check,
	Trash2,
} from "lucide-react";
import { useVehicleStockQuery, useAddPartsUsedMutation, useUpdatePartsUsedQtyMutation } from "../../hooks/useVehicleStock";
import { useUpdateJobVisitMutation } from "../../hooks/useJobs";
import { useToast } from "../ui/useToast";

import { useTechnicianByIdQuery } from "../../hooks/useTechnicians";
import { useAuthStore } from "../../auth/authStore";
import { usePermission } from "../../hooks/usePermission";
import { useModule } from "../../hooks/useEntitlements";
import ExistingUnitPicker from "../vehicles/ExistingUnitPicker";
import ExistingBatchPicker from "../vehicles/ExistingBatchPicker";
import type { VehicleStockItem, AddPartsUsedInput } from "../../types/vehicles";
import type { VisitLineItem } from "../../types/jobs";
import { unitLabel } from "../../lib/units";
import { isStorableStockQty } from "../inventory/stockQtyPrecision";

type Mode = "edit" | "stock";

// -- Edit Parts Tab -------------------------------------------------------------

function EditPartsTab({
	lineItems,
	onUpdateQty,
	isPending,
	highlightedPartId,
}: {
	lineItems: VisitLineItem[];
	onUpdateQty: (item: VisitLineItem, newQty: number) => Promise<void>;
	isPending: boolean;
	highlightedPartId: string | null;
}) {
	const [pendingDeleteIdx, setPendingDeleteIdx] = useState<number | null>(null);
	const pendingDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (pendingDeleteTimer.current) clearTimeout(pendingDeleteTimer.current);
		};
	}, []);

	const handleDeleteClick = (item: VisitLineItem, idx: number) => {
		if (pendingDeleteIdx === idx) {
			if (pendingDeleteTimer.current) clearTimeout(pendingDeleteTimer.current);
			setPendingDeleteIdx(null);
			onUpdateQty(item, 0);
		} else {
			if (pendingDeleteTimer.current) clearTimeout(pendingDeleteTimer.current);
			setPendingDeleteIdx(idx);
			pendingDeleteTimer.current = setTimeout(() => setPendingDeleteIdx(null), 3000);
		}
	};

	if (lineItems.length === 0) {
		return (
			<div className="px-4 py-5 text-center bg-surface">
				<p className="text-sm text-text-faint">No parts added yet</p>
			</div>
		);
	}

	return (
		<div className="divide-y divide-border-subtle bg-surface">
			{lineItems.map((item, idx) => {
				const qty = Number(item.quantity);
				const unitPrice = Number(item.unit_price);
				const rowTotal = qty * unitPrice;
				const isOne = qty === 1;
				const isHighlighted = item.id != null && item.id === highlightedPartId;
				const isArmed = isOne && pendingDeleteIdx === idx;

				return (
					<div
						key={item.id ?? idx}
						className={`flex items-center justify-between px-4 py-2.5 gap-3 transition-colors ${
							isHighlighted ? "ring-1 ring-primary/40 bg-primary-hover/[.06]" : ""
						}`}
					>
						<div className="flex-1 min-w-0">
							<p className="text-sm text-text-primary line-clamp-2">{item.name}</p>
							{item.description && (
								<p className="text-xs text-text-faint truncate">
									{item.description}
								</p>
							)}
						</div>
						<div className="shrink-0 flex flex-col items-end gap-0.5">
							<div className="flex items-center gap-1.5">
								<button
									onClick={() =>
										isOne
											? handleDeleteClick(item, idx)
											: onUpdateQty(item, qty - 1)
									}
									disabled={isPending}
									className={`flex items-center justify-center w-5 h-5 rounded text-xs font-bold border transition-colors disabled:opacity-40 ${
										isArmed
											? "border-error bg-error/30 text-error-text"
											: isOne
												? "border-error/30 bg-error-bg text-error-text hover:bg-error/15"
												: "border-border bg-surface text-text-tertiary hover:bg-surface-raised"
									}`}
									aria-label={isOne ? "Remove part" : "Decrease quantity"}
								>
									{isOne ? <Trash2 size={10} /> : "-"}
								</button>
								<span className="text-sm font-semibold text-text-primary tabular-nums min-w-[18px] text-center">
									{qty}
								</span>
								<button
									onClick={() => {
										setPendingDeleteIdx(null);
										if (pendingDeleteTimer.current)
											clearTimeout(pendingDeleteTimer.current);
										onUpdateQty(item, qty + 1);
									}}
									disabled={isPending}
									className="flex items-center justify-center w-5 h-5 rounded text-xs font-bold border border-border bg-surface text-text-tertiary hover:bg-surface-raised transition-colors disabled:opacity-40"
									aria-label="Increase quantity"
								>
									+
								</button>
								<span className="text-sm text-text-primary tabular-nums">
									× ${unitPrice.toFixed(2)}
								</span>
							</div>
							<span className="text-xs text-text-muted tabular-nums">
								${rowTotal.toFixed(2)}
							</span>
						</div>
					</div>
				);
			})}
		</div>
	);
}

// -- Stock Mode ----------------------------------------------------------------

function StockPartPicker({
	stockItems,
	visitId,
	vehicleId,
	technicianId,
	lineItems,
	search,
	onSearchChange,
	onSwitchToEdit,
	onClose,
}: {
	stockItems: VehicleStockItem[];
	visitId: string;
	vehicleId: string;
	technicianId: string;
	lineItems: VisitLineItem[];
	search: string;
	onSearchChange: (q: string) => void;
	onSwitchToEdit: (partId: string) => void;
	onClose: () => void;
}) {
	const addParts = useAddPartsUsedMutation();
	const toast = useToast();
	const [selected, setSelected] = useState<VehicleStockItem | null>(null);
	const [qty, setQty] = useState("1");
	const [err, setErr] = useState<string | null>(null);
	const [targetCount, setTargetCount] = useState(1);
	const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
	const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

	const filtered = useMemo(() => {
		const q = search.toLowerCase();
		if (!q) return stockItems;
		return stockItems.filter(
			(i) =>
				i.inventory_item.name.toLowerCase().includes(q) ||
				(i.inventory_item.category?.toLowerCase().includes(q) ?? false) ||
				(i.inventory_item.alt_ids?.some((id) => id.toLowerCase().includes(q)) ?? false)
		);
	}, [stockItems, search]);

	const findExistingLineItem = (stockItem: VehicleStockItem): VisitLineItem | undefined =>
		lineItems.find((li) => li.inventory_item_id === stockItem.inventory_item.id);

	const handleConfirm = async () => {
		if (!selected) return;
		const isSerialized = selected.inventory_item.is_serialized;
		const isBatchTracked = selected.inventory_item.is_batch_tracked;

		let data: AddPartsUsedInput;
		if (isSerialized) {
			if (selectedUnits.length !== targetCount) {
				setErr("Select exactly the target number of units.");
				return;
			}
			data = {
				stock_item_id: selected.id,
				qty_used: targetCount,
				technician_id: technicianId,
				serial_unit_ids: selectedUnits,
			};
		} else {
			const parsedQty = Number(qty);
			if (!parsedQty || parsedQty <= 0) {
				setErr("Enter a valid quantity.");
				return;
			}
			// The ledger stores two decimals; the server would silently round
			// 2.505, so catch it here where the tech can still correct it.
			if (!isStorableStockQty(parsedQty)) {
				setErr("Quantity must be to two decimal places.");
				return;
			}
			if (parsedQty > Number(selected.qty_on_hand)) {
				setErr("Not enough stock on hand.");
				return;
			}
			data = {
				stock_item_id: selected.id,
				qty_used: parsedQty,
				technician_id: technicianId,
				...(isBatchTracked && selectedBatchId ? { batch_id: selectedBatchId } : {}),
			};
		}

		setErr(null);
		try {
			await addParts.mutateAsync({ visitId, vehicleId, data });
			toast.success(`Added ${selected.inventory_item.name}`);
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to add part");
		}
	};

	if (selected) {
		const isSerialized = selected.inventory_item.is_serialized;
		const isBatchTracked = selected.inventory_item.is_batch_tracked;
		const confirmDisabled =
			addParts.isPending || (isSerialized && selectedUnits.length !== targetCount);

		return (
			<div className="p-4 bg-surface">
				<p
					className="text-sm font-semibold text-text-primary mb-1 line-clamp-2 break-words"
					title={selected.inventory_item.name}
				>
					{selected.inventory_item.name}
				</p>
				<p className="text-xs text-text-muted mb-4">
					On hand: {Number(selected.qty_on_hand)}{" "}
					{unitLabel(
						selected.inventory_item.unit,
						Number(selected.qty_on_hand)
					)}
				</p>
				{isSerialized ? (
					<div className="mb-3">
						<div className="flex items-center justify-between mb-2">
							<label className="text-xs text-text-tertiary">
								Units to use
							</label>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={() =>
										setTargetCount((c) => Math.max(1, c - 1))
									}
									className="flex items-center justify-center w-11 h-11 rounded-md text-sm font-bold border border-border bg-surface text-text-secondary hover:bg-surface-raised transition-colors"
									aria-label="Decrease units to use"
								>
									-
								</button>
								<span className="text-sm font-semibold text-text-primary tabular-nums min-w-[18px] text-center">
									{targetCount}
								</span>
								<button
									type="button"
									onClick={() => setTargetCount((c) => c + 1)}
									className="flex items-center justify-center w-11 h-11 rounded-md text-sm font-bold border border-border bg-surface text-text-secondary hover:bg-surface-raised transition-colors"
									aria-label="Increase units to use"
								>
									+
								</button>
							</div>
						</div>
						<ExistingUnitPicker
							// Picking which units left the van IS this step, so the
							// list opens. Restock rows collapse it instead.
							defaultOpen
							itemId={selected.inventory_item.id}
							itemName={selected.inventory_item.name}
							statusFilter="on_vehicle"
							vehicleId={vehicleId}
							targetCount={targetCount}
							value={selectedUnits}
							onChange={setSelectedUnits}
						/>
					</div>
				) : (
					<>
						<label className="text-xs text-text-tertiary mb-1 block">
							Quantity Used
						</label>
						<input
							type="number"
							min="0.01"
							step="0.01"
							inputMode="decimal"
							max={Number(selected.qty_on_hand)}
							value={qty}
							onChange={(e) => setQty(e.target.value)}
							autoFocus
							className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-border-strong mb-3 tabular-nums"
						/>
						{isBatchTracked && (
							<div className="mb-3">
								<ExistingBatchPicker
									itemId={selected.inventory_item.id}
									vehicleId={vehicleId}
									direction="vehicle_out"
									value={selectedBatchId}
									onChange={setSelectedBatchId}
								/>
							</div>
						)}
					</>
				)}
				{err && <p className="text-xs text-error-text mb-2">{err}</p>}
				<div className="flex gap-2">
					<button
						onClick={() => setSelected(null)}
						className="flex-1 py-2 text-sm rounded-lg border border-border text-text-tertiary hover:bg-surface"
					>
						Back
					</button>
					<button
						onClick={handleConfirm}
						disabled={confirmDisabled}
						className="flex-1 py-2 text-sm rounded-lg bg-primary-hover hover:bg-primary text-on-primary font-medium disabled:opacity-40"
					>
						{addParts.isPending ? "Adding…" : "Add Part"}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="p-4 bg-surface">
			<div className="relative mb-3">
				<Search
					size={13}
					className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
				/>
				<input
					type="text"
					placeholder="Search parts…"
					value={search}
					onChange={(e) => onSearchChange(e.target.value)}
					autoFocus
					className="w-full bg-surface border border-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-text-primary placeholder:text-faint focus:outline-none focus:border-border-strong"
				/>
			</div>
			<div className="divide-y divide-border-subtle overflow-y-auto max-h-56">
				{filtered.length === 0 && (
					<p className="px-4 py-4 text-center text-sm text-text-faint">
						No matching parts
					</p>
				)}
				{filtered.map((item) => (
					<div
						key={item.id}
						className="flex items-center justify-between px-4 py-2.5 hover:bg-surface-raised transition-colors"
					>
						<div className="min-w-0 flex-1">
							{/* Clamped to two lines, full name in the title — a 255-char part
							    name could take most of the screen. */}
							<p
								className="text-sm text-text-primary line-clamp-2 break-words"
								title={item.inventory_item.name}
							>
								{item.inventory_item.name}
							</p>
							<p className="text-[10px] text-text-muted mt-0.5 line-clamp-2 break-words">
								{item.inventory_item.category
									? `${item.inventory_item.category} — `
									: ""}
								<span
									className={
										Number(item.qty_on_hand) <=
										Number(item.qty_min)
											? "text-warning-text"
											: ""
									}
								>
									{Number(item.qty_on_hand)} on hand
									{Number(item.qty_on_hand) <=
										Number(item.qty_min) && (
										<AlertTriangle
											size={10}
											className="inline text-warning-text ml-0.5"
											aria-hidden="true"
										/>
									)}
								</span>
								{/* Capped at two + a count — a long alt_ids join buried the
								    on-hand figure this row exists to show. Search still
								    matches every alternate. */}
								{item.inventory_item.alt_ids && item.inventory_item.alt_ids.length > 0 && (
									<span title={item.inventory_item.alt_ids.join(" · ")}>
										{" · "}
										{item.inventory_item.alt_ids.slice(0, 2).join(" · ")}
										{item.inventory_item.alt_ids.length > 2 &&
											` +${item.inventory_item.alt_ids.length - 2}`}
									</span>
								)}
							</p>
						</div>
						{(() => {
							const existing = findExistingLineItem(item);
							return existing ? (
								<button
									onClick={() =>
										onSwitchToEdit(existing.id ?? "")
									}
									className="ml-3 shrink-0 px-2.5 py-1 rounded text-[10px] font-semibold bg-success-bg text-success-text border border-success-border hover:bg-success/25 transition-colors flex items-center gap-1"
								>
									<Check size={10} /> Added
								</button>
							) : (
								<button
									onClick={() => {
										setSelected(item);
										setQty("1");
										setTargetCount(1);
										setSelectedUnits([]);
										setSelectedBatchId(null);
										setErr(null);
									}}
									className="ml-3 shrink-0 px-2.5 py-1 rounded text-[10px] font-semibold bg-primary-bg text-primary-text hover:bg-primary-bg-subtle hover:text-primary-text transition-colors border border-primary-border"
								>
									+ Add
								</button>
							);
						})()}
					</div>
				))}
			</div>
		</div>
	);
}

// -- Main Component ------------------------------------------------------------

export default function PartsUsedSection({
	visitId,
	lineItems = [],
}: {
	visitId: string;
	lineItems: VisitLineItem[];
}) {
	const runningTotal = lineItems.reduce((sum, li) => sum + Number(li.quantity) * Number(li.unit_price), 0);
	const { user } = useAuthStore();
	// Using parts from the truck is a Vehicle Stock write, not just an Inventory one.
	const vehicleStockOn = useModule("vehicle_stock") === "on";
	const canUseInventory = usePermission("use_inventory") && vehicleStockOn;
	const { data: techProfile } = useTechnicianByIdQuery(user?.userId ?? null);
	const vehicleId = techProfile?.current_vehicle_id ?? null;
	const { data: stockItems = [] } = useVehicleStockQuery(vehicleId);
	const updateVisit = useUpdateJobVisitMutation();
	const updatePartsQty = useUpdatePartsUsedQtyMutation();
	const toast = useToast();

	const handleQtyChange = async (item: VisitLineItem, newQty: number) => {
		// Stock-linked lines carry their own serial/batch ledger — route qty
		// changes through the dedicated endpoint so decreases/deletes release the
		// exact consumed units back to the vehicle instead of silently desyncing
		// the ledger from what's displayed.
		if (item.inventory_item_id && item.id && item.fulfillment_status === "used") {
			if (!user?.userId) return;
			try {
				await updatePartsQty.mutateAsync({
					visitId,
					lineItemId: item.id,
					vehicleId,
					data: { technician_id: user.userId, quantity: newQty },
				});
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Failed to update part");
			}
			return;
		}

		const updatedItems =
			newQty <= 0
				? lineItems.filter((li) => li.id !== item.id)
				: lineItems.map((li) =>
						li.id === item.id
							? {
									...li,
									quantity: newQty,
									total: parseFloat(
										(newQty * Number(li.unit_price)).toFixed(2)
									),
								}
							: li
					);
		try {
			await updateVisit.mutateAsync({
				id: visitId,
				data: {
					line_items: updatedItems.map((li) => ({
						id: li.id,
						name: li.name,
						description: li.description ?? null,
						quantity: Number(li.quantity),
						unit_price: Number(li.unit_price),
						total: parseFloat(
							(Number(li.quantity) * Number(li.unit_price)).toFixed(2)
						),
						item_type: li.item_type ?? null,
						source: li.source,
					})),
				},
			});
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update part");
		}
	};

	const [expanded, setExpanded] = useState(true);
	const [adding, setAdding] = useState(false);
	const [mode, setMode] = useState<Mode>("edit");
	const [stockSearch, setStockSearch] = useState("");
	const [highlightedPartId, setHighlightedPartId] = useState<string | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!adding) return;
		const handler = (e: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setAdding(false);
				setStockSearch("");
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [adding]);

	useEffect(() => {
		if (!highlightedPartId) return;
		const timer = setTimeout(() => setHighlightedPartId(null), 1500);
		return () => clearTimeout(timer);
	}, [highlightedPartId]);

	const handleSwitchToEdit = (partId: string) => {
		setMode("edit");
		if (partId) setHighlightedPartId(partId);
	};

	const hasStock = stockItems.length > 0;

	return (
		<div
			ref={containerRef}
			className="rounded-xl border border-border-subtle bg-base overflow-hidden"
		>
			{/* Header */}
			<button
				onClick={() => setExpanded((p) => !p)}
				aria-expanded={expanded}
				aria-controls="parts-used-panel"
				className="w-full flex items-center justify-between px-4 py-3 border-b border-border-subtle"
			>
				<span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
					{adding && <span className="text-primary-text">Editing </span>}
					Parts Used
					{lineItems.length > 0 && (
						<span className="ml-2 text-text-muted font-normal normal-case tracking-normal">
							({lineItems.length})
						</span>
					)}
				</span>
				{expanded ? (
					<ChevronUp size={14} className="text-text-muted" />
				) : (
					<ChevronDown size={14} className="text-text-muted" />
				)}
			</button>

			{expanded && (
				<div id="parts-used-panel">
					{/* Add part trigger */}
					{!adding ? (
						<div className="px-4 py-3 border-b border-border-subtle">
							<button
								onClick={() => {
									setAdding(true);
									setStockSearch("");
								}}
								className="flex items-center gap-2 text-sm text-primary-text hover:text-primary-text transition-colors"
							>
								<Plus size={14} />
								Add / Edit Parts
							</button>
						</div>
					) : (
						<div className="border-b border-border-subtle">
							{/* Vehicle Stock appears only when the tech may draw from it */}
							<div className="flex px-4 pt-3 gap-2 mb-0">
								<button
									onClick={() => setMode("edit")}
									className={`flex-1 flex min-h-11 items-center justify-center gap-1.5 py-2.5 rounded-md text-sm font-medium transition-colors ${
										mode === "edit"
											? "bg-surface-raised text-text-primary"
											: "text-text-secondary hover:text-text-primary"
									}`}
								>
									<Pencil size={12} />
									Edit Parts
								</button>
								{canUseInventory && (
									<button
										onClick={() => setMode("stock")}
										className={`flex-1 flex min-h-11 items-center justify-center gap-1.5 py-2.5 rounded-md text-sm font-medium transition-colors ${
											mode === "stock"
												? "bg-surface-raised text-text-primary"
												: "text-text-secondary hover:text-text-primary"
										}`}
									>
										<Package size={12} />
										Vehicle Stock
									</button>
								)}
							</div>

							{mode === "edit" ? (
								<div className="pt-3">
									<EditPartsTab
										lineItems={lineItems}
										onUpdateQty={handleQtyChange}
										isPending={updateVisit.isPending || updatePartsQty.isPending}
										highlightedPartId={highlightedPartId}
									/>
								</div>
							) : mode === "stock" && hasStock && user?.userId ? (
								<StockPartPicker
									stockItems={stockItems}
									visitId={visitId}
									vehicleId={vehicleId!}
									technicianId={user.userId}
									lineItems={lineItems}
									search={stockSearch}
									onSearchChange={setStockSearch}
									onSwitchToEdit={handleSwitchToEdit}
									onClose={() => {
										setAdding(false);
										setStockSearch("");
									}}
								/>
							) : (
								<div className="px-4 py-4">
									<p className="text-sm text-text-muted">
										Nothing on the truck. A part bought at a store or
										supply house is a field purchase — start one from
										this visit and photograph the receipt.
									</p>
								</div>
							)}

							{/* Done strip — persistent close, always visible */}
							<div className="px-4 py-2.5 bg-base border-t border-border-subtle">
								<button
									onClick={() => {
										setAdding(false);
										setStockSearch("");
									}}
									className="w-full py-2.5 rounded-lg bg-primary-hover hover:bg-primary text-on-primary text-sm font-bold transition-colors"
								>
									Done
								</button>
							</div>
						</div>
					)}

					{/* Parts list — read-only, shown only when not editing */}
					{!adding && (
						<>
							{lineItems.length === 0 ? (
								<p className="px-4 py-5 text-center text-sm text-text-faint">
									No parts added yet
								</p>
							) : (
								<div className="divide-y divide-border-subtle">
									{lineItems.map((item, idx) => {
										const qty = Number(item.quantity);
										const unitPrice = Number(item.unit_price);
										const rowTotal = qty * unitPrice;

										return (
											<div
												key={item.id ?? idx}
												className="flex items-center justify-between px-4 py-2.5"
											>
												<div className="flex-1 min-w-0">
													<p className="text-sm text-text-primary line-clamp-2">
														{item.name}
													</p>
													{item.description && (
														<p className="text-xs text-text-faint truncate">
															{item.description}
														</p>
													)}
												</div>
												<div className="text-right shrink-0 ml-4">
													<p className="text-sm text-text-primary tabular-nums">
														{qty} × ${unitPrice.toFixed(2)}
													</p>
													<p className="text-xs text-text-muted tabular-nums">
														${rowTotal.toFixed(2)}
													</p>
												</div>
											</div>
										);
									})}
								</div>
							)}
						</>
					)}

					{/* Running total — shown only when not editing */}
					{!adding && lineItems.length > 0 && (
						<div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
							<span className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
								Running Total
							</span>
							<span className="text-base font-bold text-text-primary tabular-nums">
								${runningTotal.toFixed(2)}
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
