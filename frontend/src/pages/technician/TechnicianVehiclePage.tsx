import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
	Truck,
	Package,
	AlertTriangle,
	PackageX,
	X,
	Search,
	RotateCcw,
	SlidersHorizontal,
	LayoutList,
	ClipboardCheck,
	History,
	ListChecks,
	BellPlus,
} from "lucide-react";
import { useAuthStore } from "../../auth/authStore";
import { usePermission } from "../../hooks/usePermission";
import { useTechnicianByIdQuery } from "../../hooks/useTechnicians";
import { useVehiclesQuery, useSetTechnicianVehicleMutation, useVehicleMaintenanceReminderQuery } from "../../hooks/useVehicles";
import { dueFor, STATUS_RANK, STATUS_LABEL, STATUS_CLASSNAME, type ReminderDue } from "../../util/vehicleMaintenanceStatus";
import {
	useVehicleStockQuery,
	useRestockRequestMutation,
	useAddVehicleStockItemMutation,
	useVehicleStockConflictsQuery,
	useBulkRestockMutation,
} from "../../hooks/useVehicleStock";
import RestockStatusList from "../../components/technicianComponents/RestockStatusList";
import RemoveStockItemSheet from "../../components/technicianComponents/RemoveStockItemSheet";
import FillToStandardPreview from "../../components/vehicles/FillToStandardPreview";
import VehicleStockActionRow from "../../components/vehicles/VehicleStockActionRow";
import { useOrgSettings } from "../../hooks/useOrg";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { useScanDispatcher } from "../../hooks/useScanDispatcher";
import { BarcodeScanner } from "../../components/inventory/BarcodeScanner";
import { TrackingBadges } from "../../components/inventory/TrackingBadges";
import AdjustStockModal from "../../components/vehicles/AdjustStockModal";
import RestockWorkflow from "../../components/vehicles/RestockWorkflow";
import StockHistorySection from "../../components/vehicles/StockHistorySection";
import SerialSheet, {
	type SerialSheetTarget,
} from "../../components/inventory/tracking/SerialSheet";
import LotSheet, {
	type LotSheetTarget,
} from "../../components/inventory/tracking/LotSheet";
import EmptyState from "../../components/ui/EmptyState";
import { effectiveRestockMode, emptyVehicleStockCopy } from "../../lib/restockEmphasis";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import { useToast } from "../../components/ui/useToast";
import type {
	Vehicle,
	VehicleStockItem,
	VehicleStockConflict,
	BulkRestockInput,
	VehicleMaintenanceReminder,
} from "../../types/vehicles";
import { MAINTENANCE_CATEGORY_LABELS } from "../../types/vehicles";
import type { InventoryItem } from "../../types/inventory";
import { unitLabel } from "../../lib/units";
import CreateMaintenanceReminderModal from "../../components/vehicles/maintenance/CreateMaintenanceReminderModal";
import TechPage from "../../components/technician/TechPage";

// ── Vehicle Status ────────────────────────────────────────────────────────────

type VehicleStatus = "unavailable" | "in-use" | "stocked" | "available";

function getVehicleStatus(v: Vehicle): VehicleStatus {
	if (v.status === "inactive") return "unavailable";
	if ((v.current_technicians ?? []).length > 0) return "in-use";
	if ((v.stock_items ?? []).some((i) => Number(i.qty_on_hand) > 0)) return "stocked";
	return "available";
}

function getVehicleSubtitle(v: Pick<Vehicle, "color" | "type" | "license_plate">): string | null {
	const parts = [v.color, v.type].filter(Boolean).join(" ");
	const result = v.license_plate ? `${parts} · ${v.license_plate}` : parts;
	return result || null;
}

function VehicleStatusBadge({ status }: { status: VehicleStatus }) {
	const styles: Record<VehicleStatus, string> = {
		unavailable: "bg-surface-raised text-text-tertiary",
		"in-use": "bg-warning/10 text-warning-text",
		stocked: "bg-success/10 text-success-text",
		available: "bg-surface text-text-tertiary",
	};
	const labels: Record<VehicleStatus, string> = {
		unavailable: "Unavailable",
		"in-use": "In-use",
		stocked: "Stocked",
		available: "Available",
	};
	return (
		<span
			className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${styles[status]}`}
		>
			{labels[status]}
		</span>
	);
}

// ── Unified Vehicle List ──────────────────────────────────────────────────────

function VehicleList({
	vehicles,
	currentVehicleId = null,
	onSelect,
	onCancel,
	rideAlongPendingId,
	onRideAlongRequest,
	onRideAlongCancel,
	onRideAlongConfirm,
	isPending = false,
}: {
	vehicles: Vehicle[];
	currentVehicleId?: string | null;
	onSelect: (vehicleId: string) => void;
	onCancel?: () => void;
	rideAlongPendingId: string | null;
	onRideAlongRequest: (vehicleId: string) => void;
	onRideAlongCancel: () => void;
	onRideAlongConfirm: (vehicleId: string) => void;
	isPending?: boolean;
}) {
	if (vehicles.length === 0) {
		return (
			<EmptyState
				icon={<Truck size={28} />}
				title="No vehicles available"
				description="Contact your dispatcher to get a vehicle assigned."
			/>
		);
	}

	return (
		<div>
			{vehicles.map((v) => {
				const status = getVehicleStatus(v);
				const isCurrent = v.id === currentVehicleId;
				const isRideAlongPending = v.id === rideAlongPendingId;
				const subtitle = getVehicleSubtitle(v);

				return (
					<div key={v.id}>
						<div
							className={`flex items-center gap-3 px-4 py-3 bg-surface border-b border-border-subtle ${isCurrent ? "bg-primary-bg-dim border-l-2 border-l-primary" : ""}`}
						>
							<div className="flex-1 min-w-0">
								<p className="text-sm font-semibold text-text-primary truncate">
									{v.name}
								</p>
								{subtitle && (
									<p className="text-xs mt-0.5 truncate text-text-muted">
										{subtitle}
									</p>
								)}
							</div>
							<VehicleStatusBadge status={status} />
							{isCurrent ? (
								<span className="text-xs font-medium px-3 py-1.5 rounded-lg bg-surface-raised text-text-tertiary shrink-0">
									Current
								</span>
							) : status !== "unavailable" ? (
								<button
									onClick={() =>
										status === "in-use"
											? onRideAlongRequest(
													v.id
												)
											: onSelect(
													v.id
												)
									}
									disabled={isPending}
									className="text-xs font-medium px-3 py-2.5 rounded-lg bg-primary-hover hover:bg-primary text-on-primary transition-colors shrink-0 disabled:opacity-50 disabled:pointer-events-none"
								>
									Select
								</button>
							) : null}
						</div>
						{isRideAlongPending && (
							<div className="px-4 py-3 bg-warning/5 border-b border-warning/20 flex items-center justify-between gap-3">
								<p className="text-xs text-warning-text">
									Ride along with{" "}
									{(
										v.current_technicians ??
										[]
									)
										.map((t) => t.name)
										.join(", ")}
									?
								</p>
								<div className="flex items-center gap-2 shrink-0">
									<button
										onClick={
											onRideAlongCancel
										}
										disabled={isPending}
										className="text-xs text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 py-2.5 px-1"
									>
										Cancel
									</button>
									<button
										onClick={() =>
											onRideAlongConfirm(
												v.id
											)
										}
										disabled={isPending}
										className="text-xs font-medium px-3 py-2.5 rounded-lg bg-warning/20 text-warning-text hover:bg-warning/30 transition-colors disabled:opacity-50 disabled:pointer-events-none"
									>
										Confirm
									</button>
								</div>
							</div>
						)}
					</div>
				);
			})}
			{onCancel && (
				<button
					onClick={onCancel}
					className="w-full py-3 text-sm text-text-muted hover:text-text-secondary transition-colors text-center border-t border-border-subtle"
				>
					Cancel
				</button>
			)}
		</div>
	);
}

// ── Stock Item Row ────────────────────────────────────────────────────────────

// Quantity formatting goes through lib/units now, which renders a count as
// "units" instead of suppressing it entirely.

function StockItemRow({
	item,
	onRestock,
	onOpenSerials,
	onOpenLots,
	batchMode = false,
	batchQty,
	onBatchQtyChange,
	isHighlighted = false,
	rowRef,
}: {
	item: VehicleStockItem;
	onRestock: (item: VehicleStockItem) => void;
	// Only wired for serialized items — opens SerialSheet in list mode.
	onOpenSerials?: (item: VehicleStockItem) => void;
	// Only wired for batch-tracked items — opens LotSheet in list mode.
	onOpenLots?: (item: VehicleStockItem) => void;
	batchMode?: boolean;
	batchQty?: number;
	onBatchQtyChange?: (id: string, qty: number) => void;
	isHighlighted?: boolean;
	rowRef?: (el: HTMLDivElement | null) => void;
}) {
	const isEmpty = Number(item.qty_on_hand) === 0;
	const isLow =
		Number(item.qty_on_hand) > 0 && Number(item.qty_on_hand) <= Number(item.qty_min);
	const unit = item.inventory_item.unit;

	const qtyColor = isEmpty
		? "text-error-text"
		: isLow
			? "text-warning-text"
			: "text-text-primary";

	const warehouseQty = Number(item.inventory_item.quantity);
	const warehouseColor =
		warehouseQty === 0
			? "text-error-text"
			: item.inventory_item.low_stock_threshold != null &&
				  warehouseQty <= Number(item.inventory_item.low_stock_threshold)
				? "text-warning-text"
				: "text-text-muted";

	const isSelected = batchMode && batchQty !== undefined && batchQty > 0;

	return (
		<div
			ref={rowRef}
			className={`flex items-center gap-3 px-4 py-3 border-b border-border-subtle last:border-0 transition-colors ${
				isSelected ? "bg-primary-hover/5" : ""
			} ${isHighlighted ? "highlight-active" : ""}`}
		>
			<div className="flex-1 min-w-0">
				{/* Two lines on a phone: one truncated line of a 255-character
				    part name is mostly ellipsis, and the name is the only thing
				    a tech identifies the row by. */}
				<p
					className="text-sm text-text-primary line-clamp-2 break-words"
					title={item.inventory_item.name}
				>
					{item.inventory_item.name}
				</p>
				<div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
					<TrackingBadges
						item={item.inventory_item}
						onSerialClick={
							onOpenSerials
								? () => onOpenSerials(item)
								: undefined
						}
						onBatchClick={
							onOpenLots
								? () => onOpenLots(item)
								: undefined
						}
					/>
					{item.inventory_item.category && (
						<>
							{/* Capped: category is org-defined freetext up to 100
							    characters, and an uncapped chip wrapped inside
							    itself and doubled the row's height. */}
							<span
								className="text-[10px] px-1.5 py-0.5 bg-surface text-text-secondary rounded max-w-[9rem] truncate"
								title={item.inventory_item.category}
							>
								{item.inventory_item.category}
							</span>
							<span className="text-[10px] text-text-faint">
								·
							</span>
						</>
					)}
					<span className="text-[10px] text-text-muted">
						Min {Number(item.qty_min)}{" "}
						{unitLabel(unit, Number(item.qty_min))}
					</span>
					<span className="text-[10px] text-text-faint">·</span>
					<span
						className={`text-[10px] tabular-nums ${warehouseColor}`}
					>
						Stock {warehouseQty}
					</span>
					{item.inventory_item.alt_ids &&
						item.inventory_item.alt_ids.length > 0 && (
							<>
								<span className="text-[10px] text-text-faint">
									·
								</span>
								{/* Two alternates, then a count. There's no cap on
								    how many an item carries or how long each one
								    is, and the whole list joined ran ten lines
								    deep on a phone — it's a search aid here, not
								    something a tech reads down. */}
								<span
									className="text-[10px] text-text-muted max-w-[12rem] truncate"
									title={item.inventory_item.alt_ids.join(" · ")}
								>
									{item.inventory_item.alt_ids
										.slice(0, 2)
										.join(" · ")}
									{item.inventory_item.alt_ids.length > 2 &&
										` +${item.inventory_item.alt_ids.length - 2}`}
								</span>
							</>
						)}
				</div>
			</div>
			{batchMode && onBatchQtyChange ? (
				<div className="flex items-center gap-1 shrink-0">
					<button
						onClick={() =>
							onBatchQtyChange(
								item.id,
								Math.max(0, (batchQty ?? 0) - 1)
							)
						}
						aria-label="Decrease quantity"
						className="w-7 h-7 rounded border border-border text-text-secondary text-sm font-semibold hover:bg-surface transition-colors leading-none"
					>
						−
					</button>
					<span
						className={`w-6 text-center text-sm font-bold tabular-nums ${
							(batchQty ?? 0) > 0
								? "text-primary-text"
								: "text-text-faint"
						}`}
					>
						{batchQty ?? 0}
					</span>
					<button
						onClick={() =>
							onBatchQtyChange(
								item.id,
								(batchQty ?? 0) + 1
							)
						}
						aria-label="Increase quantity"
						className="w-7 h-7 rounded border border-border text-text-secondary text-sm font-semibold hover:bg-surface transition-colors leading-none"
					>
						+
					</button>
				</div>
			) : !batchMode && (isEmpty || isLow) ? (
				<button
					onClick={() => onRestock(item)}
					title="Request restock"
					aria-label={`Request restock for ${item.inventory_item.name}`}
					className="flex items-center justify-center w-11 h-11 rounded-lg bg-warning/10 text-warning-text hover:bg-warning/20 transition-colors shrink-0"
				>
					<RotateCcw size={14} />
				</button>
			) : null}
			<div className="text-right shrink-0">
				<p className={`text-base font-semibold tabular-nums ${qtyColor}`}>
					{Number(item.qty_on_hand)}
				</p>
				<p className="text-[10px] text-text-muted">
					{unitLabel(unit, Number(item.qty_on_hand))}
				</p>
			</div>
		</div>
	);
}

// ── Category Group Header ─────────────────────────────────────────────────────

function CategoryHeader({ label }: { label: string }) {
	return (
		<div className="px-4 py-1.5 bg-base border-b border-border-subtle">
			<span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
				{label}
			</span>
		</div>
	);
}

// ── Loading Skeleton ──────────────────────────────────────────────────────────

function VehicleCardSkeleton() {
	return (
		<div className="px-4 py-4 animate-pulse">
			<div className="h-4 w-36 bg-surface rounded mb-2" />
			<div className="h-3 w-28 bg-surface rounded" />
		</div>
	);
}

// ── Stock Conflict Warning ────────────────────────────────────────────────────

function StockConflictWarning({ conflicts }: { conflicts: VehicleStockConflict[] }) {
	return (
		<div className="rounded-xl border border-error bg-base overflow-hidden">
			<div className="px-4 py-2.5 bg-error/10 border-b border-error/30 flex items-center gap-2">
				<AlertTriangle size={14} className="text-error-text shrink-0" />
				<span className="text-sm font-semibold text-error-text">
					Stock issue for today's visits
				</span>
			</div>
			<div className="divide-y divide-border-subtle">
				{conflicts.map((conflict, i) => {
					const time = new Date(
						conflict.scheduledAt
					).toLocaleTimeString([], {
						hour: "numeric",
						minute: "2-digit",
					});
					return (
						<div key={i} className="px-4 py-3">
							<div className="flex items-center gap-2 mb-2">
								<span className="text-sm font-semibold text-text-primary">
									{conflict.visitName}
								</span>
								<span className="text-xs text-text-muted">
									{time}
								</span>
							</div>
							<div className="space-y-1">
								{conflict.conflicts.map((item) => (
									<div
										key={
											item.inventoryItemId
										}
										className="flex items-center justify-between bg-base rounded px-3 py-1.5"
									>
										<span className="text-xs text-text-primary">
											{
												item.itemName
											}
										</span>
										<div className="flex items-center gap-2">
											<span className="text-xs text-text-muted">
												Need{" "}
												<span className="text-text-primary font-semibold">
													{
														item.qtyNeeded
													}
												</span>
											</span>
											<span
												className={`text-xs font-bold ${item.qtyOnHand === 0 ? "text-error-text" : "text-warning-text"}`}
											>
												Have{" "}
												{
													item.qtyOnHand
												}
											</span>
										</div>
									</div>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function MaintenanceReminderWarning(
	{ reminders, setIsCreateReminderModalOpen }: 
	{ reminders: { reminder: VehicleMaintenanceReminder; due: ReminderDue }[]; setIsCreateReminderModalOpen: (open: boolean) => void }
) {
	const noneDue = reminders.length <= 0;
	const hasOverdue = reminders.some(({ due }) => due.status === "overdue");
	return (
		<div className={`rounded-xl border ${hasOverdue ? "border-error" : "border-warning"} bg-base overflow-hidden`}>
			<div className={`px-4 py-2.5 border-b flex items-center gap-2 ${hasOverdue ? "bg-error/10 border-error/30" : "bg-warning/10 border-warning/30"}`}>
				{hasOverdue && (<AlertTriangle size={14} className={`shrink-0 ${hasOverdue ? "text-error-text" : "text-warning-text"}`} />)}
				<span className={`text-sm font-semibold flex-1 ${hasOverdue ? "text-error-text" : "text-warning-text"}`}>
					{hasOverdue ? "Maintenance due" : "Maintenance reminders"}
				</span>
				<button
					className="inline-flex items-center gap-1.5 rounded-md bg-primary hover:bg-primary-hover px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors"
					onClick={() => setIsCreateReminderModalOpen(true)}
				>
					<BellPlus size={14}/> Create Reminder
				</button>
			</div>
			<div className="divide-y divide-border-subtle">
				{noneDue 
				?  (
					<>
						<p className="p-2">No upcoming reminders</p>
					</>
				)
				: reminders.map(({ reminder, due }) => (
					<div key={reminder.id} className="px-4 py-3 flex items-center justify-between gap-2">
						<div className="min-w-0">
							<span className="text-sm font-semibold text-text-primary">{reminder.title}</span>
							<span className="text-xs text-text-muted ml-2">
								{MAINTENANCE_CATEGORY_LABELS[reminder.category]}
							</span>
						</div>
						<div className="flex items-center gap-2 shrink-0">
							{due.status !== "none" && (
								<span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_CLASSNAME[due.status]}`}>
									{STATUS_LABEL[due.status]}
								</span>
							)}
							<span className="text-xs text-text-muted">{due.dueLines[0]}</span>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ── Add to Stock Sheet ───────────────────────────────────────────────────────

function AddStockItemSheet({
	vehicleId,
	existingIds,
	onDone,
}: {
	vehicleId: string;
	existingIds: Set<string>;
	onDone: () => void;
}) {
	const [search, setSearch] = useState("");
	const [qtyMin, setQtyMin] = useState("1");
	const [qtyStandard, setQtyStandard] = useState("1");
	const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
	const [sortMode, setSortMode] = useState<"name" | "category">("name");
	const [showFilter, setShowFilter] = useState(false);
	const addMutation = useAddVehicleStockItemMutation();
	const { data: allInventory = [] } = useAllInventoryQuery();

	const available = allInventory.filter((item) => !existingIds.has(item.id));
	const allCategories = Array.from(
		new Set(available.map((i) => i.category).filter((c): c is string => Boolean(c)))
	).sort();

	const q = search.toLowerCase().trim();
	const results = available
		.filter((item) => {
			const matchesSearch =
				!q ||
				item.name.toLowerCase().includes(q) ||
				item.alt_ids?.some((id) => id.toLowerCase().includes(q));
			const matchesCategory =
				selectedCategories.length === 0 ||
				selectedCategories.includes(item.category ?? "");
			return matchesSearch && matchesCategory;
		})
		.sort((a, b) => {
			if (sortMode === "category") {
				const catA = a.category ?? "";
				const catB = b.category ?? "";
				if (catA !== catB) {
					if (!catA) return 1;
					if (!catB) return -1;
					return catA.localeCompare(catB);
				}
			}
			return a.name.localeCompare(b.name);
		})
		.slice(0, 20);

	const handleSelect = async (inventoryItemId: string) => {
		const min = parseFloat(qtyMin);
		const std = qtyStandard.trim() !== "" ? parseFloat(qtyStandard) : null;
		await addMutation.mutateAsync({
			vehicleId,
			data: {
				inventory_item_id: inventoryItemId,
				qty_on_hand: 0,
				qty_min: !isNaN(min) && min >= 0 ? min : 1,
				qty_standard: std !== null && !isNaN(std) && std >= 0 ? std : null,
			},
		});
		onDone();
	};

	const toggleCategory = (cat: string) =>
		setSelectedCategories((prev) =>
			prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
		);

	return (
		<div className="px-4 py-3 space-y-3">
			<div className="flex items-center gap-2">
				<div className="flex items-center gap-1.5">
					<label className="text-[10px] text-text-muted whitespace-nowrap">
						Min qty
					</label>
					<input
						type="number"
						min={0}
						value={qtyMin}
						onChange={(e) => setQtyMin(e.target.value)}
						className="w-14 text-xs bg-surface border border-border-input rounded px-1.5 py-1 text-text-primary outline-none focus:border-primary"
					/>
				</div>
				<div className="flex items-center gap-1.5">
					<label className="text-[10px] text-text-muted whitespace-nowrap">
						Standard
					</label>
					<input
						type="number"
						min={0}
						value={qtyStandard}
						onChange={(e) => setQtyStandard(e.target.value)}
						placeholder="—"
						className="w-14 text-xs bg-surface border border-border-input rounded px-1.5 py-1 text-text-primary outline-none focus:border-primary placeholder:text-text-faint"
					/>
				</div>
				<div className="flex items-center gap-1 ml-auto">
					{allCategories.length > 0 && (
						<button
							onClick={() => setShowFilter((v) => !v)}
							title="Filter by category"
							className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
								showFilter
									? "bg-primary-hover/20 border-primary-hover/40 text-primary-text"
									: "bg-surface border-border text-text-muted hover:text-text-secondary"
							}`}
						>
							<SlidersHorizontal size={12} />
						</button>
					)}
					<button
						onClick={() =>
							setSortMode((m) =>
								m === "name" ? "category" : "name"
							)
						}
						title={
							sortMode === "name"
								? "Sort by category"
								: "Sort by name"
						}
						className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
							sortMode === "category"
								? "bg-primary-hover/20 border-primary-hover/40 text-primary-text"
								: "bg-surface border-border text-text-muted hover:text-text-secondary"
						}`}
					>
						<LayoutList size={12} />
					</button>
				</div>
			</div>
			{showFilter && allCategories.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{allCategories.map((cat) => {
						const active = selectedCategories.includes(cat);
						return (
							<button
								key={cat}
								onClick={() => toggleCategory(cat)}
								className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
									active
										? "bg-primary-hover/20 border-primary-hover/40 text-primary-text"
										: "bg-surface border-border text-text-tertiary hover:border-border-strong hover:text-text-secondary"
								}`}
							>
								{cat}
							</button>
						);
					})}
					{selectedCategories.length > 0 && (
						<button
							onClick={() => setSelectedCategories([])}
							className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full text-text-muted hover:text-text-secondary transition-colors"
						>
							<X size={10} />
							Clear
						</button>
					)}
				</div>
			)}
			<div className="flex items-center gap-2 bg-surface-inset border border-border rounded-lg px-3 py-1.5">
				<Search size={13} className="text-text-faint flex-shrink-0" />
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search catalog…"
					className="flex-1 text-sm bg-transparent text-text-primary placeholder:text-faint outline-none"
				/>
				{search && (
					<button
						onClick={() => setSearch("")}
						aria-label="Clear search"
						className="text-text-faint hover:text-text-secondary transition-colors"
					>
						<X size={13} />
					</button>
				)}
			</div>
			{results.length > 0 ? (
				<div className="border border-border rounded-lg overflow-hidden divide-y divide-border-subtle">
					{results.map((item) => (
						<button
							key={item.id}
							onClick={() => handleSelect(item.id)}
							disabled={addMutation.isPending}
							className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-surface-raised transition-colors disabled:opacity-50"
						>
							{/* min-w-0 so a long name shrinks rather than shoving
							    the unit label off the row's right edge. */}
							<div className="min-w-0 flex-1">
								<p
									className="text-sm text-text-primary line-clamp-2 break-words"
									title={item.name}
								>
									{item.name}
								</p>
								{item.category && (
									<p
										className="text-[10px] text-text-muted truncate"
										title={item.category}
									>
										{item.category}
									</p>
								)}
							</div>
							<span className="text-xs text-text-muted shrink-0 ml-2">
								{unitLabel(item.unit)}
							</span>
						</button>
					))}
				</div>
			) : q || selectedCategories.length > 0 ? (
				<p className="text-xs text-text-muted text-center py-2">
					No matching items
				</p>
			) : (
				<p className="text-xs text-text-muted text-center py-2">
					Search or filter to browse the catalog
				</p>
			)}
		</div>
	);
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TechnicianVehiclePage() {
	const { user } = useAuthStore();
	const { data: techProfile, isLoading: techLoading } = useTechnicianByIdQuery(
		user?.userId ?? null
	);
    const [isCreateReminderModalOpen, setIsCreateReminderModalOpen] = useState(false);
	const { data: vehicles = [], isLoading: vehiclesLoading } = useVehiclesQuery();
	const currentVehicleId = techProfile?.current_vehicle_id ?? null;
	const { data: stockItems = [] } = useVehicleStockQuery(currentVehicleId);
	const { data: stockConflicts = [] } = useVehicleStockConflictsQuery();
	const myConflicts = stockConflicts.filter((c) => c.vehicleId === currentVehicleId);
	const { data: maintenanceReminders = [] } = useVehicleMaintenanceReminderQuery(currentVehicleId);
	const currentOdometerMi = vehicles.find((v) => v.id === currentVehicleId)?.current_odometer_mi ?? null;
	const dueReminders = maintenanceReminders
		.map((reminder) => ({ reminder, due: dueFor(reminder, currentOdometerMi) }))
		.filter(({ due, reminder }) => (due.status === "overdue" || due.status === "duesoon") && reminder.acknowledged_at == null)
		.sort((a, b) => STATUS_RANK[a.due.status] - STATUS_RANK[b.due.status] || a.due.urgency - b.due.urgency);
	const setVehicle = useSetTechnicianVehicleMutation();
	const restockMutation = useRestockRequestMutation();
	const bulk = useBulkRestockMutation(currentVehicleId ?? "");
	const toast = useToast();

	const canStock = usePermission("stock_own_vehicle");
	const canRestock = usePermission("complete_own_restock");
	const canUseInventory = usePermission("use_inventory");
	const canFieldLoss = usePermission("adjust_field_loss");
	const canAdjustStock = useMemo(() => {
		if (!user || user.role !== "technician") return true;
		const adjustPerms = [
			"adjust_field_loss",
			"adjust_transfer",
			"adjust_audit",
			"adjust_warehouse_exchange",
		];
		return adjustPerms.some((p) => user.permissions.includes(p));
	}, [user]);
	const { data: orgSettings, isError: orgSettingsError } = useOrgSettings();

	const [showVehicleList, setShowVehicleList] = useState(false);
	const [adjustOpen, setAdjustOpen] = useState(false);
	const [restockOpen, setRestockOpen] = useState(false);
	const [showStockHistory, setShowStockHistory] = useState(false);
	const [showAddItem, setShowAddItem] = useState(false);
	const [stockEditMode, setStockEditMode] = useState<"add" | "remove">("add");
	const [showInventory, setShowInventory] = useState(true);
	const [fillOpen, setFillOpen] = useState(false);
	const [restockTarget, setRestockTarget] = useState<VehicleStockItem | null>(null);
	const [restockQty, setRestockQty] = useState(1);
	const [restockNote, setRestockNote] = useState("");
	const [showCheckOutConfirm, setShowCheckOutConfirm] = useState(false);
	const [switchPendingId, setSwitchPendingId] = useState<string | null>(null);
	const [rideAlongPendingId, setRideAlongPendingId] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [showFilter, setShowFilter] = useState(false);
	const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
	const [sortMode, setSortMode] = useState<"name" | "category">("name");
	const [batchMode, setBatchMode] = useState(false);
	const [batchQtys, setBatchQtys] = useState<Record<string, number>>({});
	const [showBatchConfirm, setShowBatchConfirm] = useState(false);
	const [isScannerOpen, setIsScannerOpen] = useState(false);
	const [scanFocusItemId, setScanFocusItemId] = useState<string | null>(null);
	const [highlightedStockItemId, setHighlightedStockItemId] = useState<string | null>(null);
	const [serialTarget, setSerialTarget] = useState<SerialSheetTarget | null>(null);
	const [lotTarget, setLotTarget] = useState<LotSheetTarget | null>(null);
	const [pendingLostSerialId, setPendingLostSerialId] = useState<string | null>(null);

	const stockRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	// Highlight is armed (not cleared) while the scan-triggered Adjust Stock modal
	// is open, then cleared on the tech's next tap anywhere — not on a timer, and
	// not on mouseleave, since touch devices have no reliable hover state.
	const clearHighlightRef = useRef<() => void>(() => {});

	const armHighlightClear = useCallback(() => {
		clearHighlightRef.current();
		const handleOutsideTap = () => {
			setHighlightedStockItemId(null);
			clearHighlightRef.current = () => {};
		};
		const timeoutId = window.setTimeout(() => {
			document.addEventListener("click", handleOutsideTap, { once: true });
		}, 0);
		clearHighlightRef.current = () => {
			window.clearTimeout(timeoutId);
			document.removeEventListener("click", handleOutsideTap);
		};
	}, []);

	useEffect(() => {
		return () => {
			clearHighlightRef.current();
		};
	}, []);

	const currentVehicle =
		vehicles.find((v) => v.id === currentVehicleId) ??
		techProfile?.current_vehicle ??
		null;

	// All categories derived from unfiltered stock items
	const allCategories = useMemo(() => {
		return Array.from(
			new Set(
				stockItems
					.map((i) => i.inventory_item.category)
					.filter((c): c is string => Boolean(c))
			)
		).sort();
	}, [stockItems]);

	const assignVehicle = (vehicleId: string | null, errorMsg: string) => {
		if (!user?.userId) return;
		setVehicle.mutate(
			{ technicianId: user.userId, vehicleId },
			{
				onError: () => toast.error(errorMsg),
			}
		);
	};

	const findStockItemOrWarn = (inventoryItemId: string): VehicleStockItem | null => {
		const stockItem = stockItems.find((s) => s.inventory_item_id === inventoryItemId);
		if (!stockItem) {
			toast.error("Item not on this vehicle.");
			return null;
		}
		return stockItem;
	};

	const focusStockItem = (item: InventoryItem) => {
		const stockItem = findStockItemOrWarn(item.id);
		if (!stockItem) return;
		clearHighlightRef.current();
		setHighlightedStockItemId(stockItem.id);
		stockRowRefs.current
			.get(stockItem.id)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		setScanFocusItemId(stockItem.id);
		setAdjustOpen(true);
	};

	// Scan-anything: /inventory/resolve routes items, serial stickers, and lot
	// labels. The old useBarcodeScanHandler only matched barcode/sku/alt_ids, so
	// a serial sticker fell through to "No item found" even though the backend
	// resolved it fine. onBatch is omitted deliberately — the dispatcher falls
	// back to onItem(batch.item), which is v1's "focus the parent item".
	const { handleScan: handleBarcodeScan } = useScanDispatcher({
		onItem: focusStockItem,
		onSerial: (serial) =>
			setSerialTarget({ mode: "serial", serialId: serial.serialUnitId }),
		onNotFound: () => toast.error("No item found for that code."),
	});

	useBarcodeScanner(handleBarcodeScan, canFieldLoss);

	const handleSelectVehicle = (vehicleId: string) => {
		if (vehicleId === currentVehicleId) {
			setShowVehicleList(false);
			return;
		}
		if (currentVehicleId) {
			setSwitchPendingId(vehicleId);
			return;
		}
		assignVehicle(vehicleId, "Failed to assign vehicle. Please try again.");
		setShowVehicleList(false);
	};

	const handleConfirmSwitch = () => {
		if (!switchPendingId) return;
		assignVehicle(switchPendingId, "Failed to switch vehicle. Please try again.");
		setSwitchPendingId(null);
		setShowVehicleList(false);
	};

	const handleRideAlongConfirm = (vehicleId: string) => {
		assignVehicle(vehicleId, "Failed to assign vehicle. Please try again.");
		setRideAlongPendingId(null);
		setShowVehicleList(false);
	};

	const handleCheckOut = () => {
		assignVehicle(null, "Failed to check out. Please try again.");
		setShowCheckOutConfirm(false);
	};

	// Opens the qty/note sheet — default qty fills the gap to standard when set
	const handleRestock = (item: VehicleStockItem) => {
		if (!currentVehicleId) return;
		const gap =
			item.qty_standard !== null
				? Math.max(
						Math.ceil(
							Number(item.qty_standard) -
								Number(item.qty_on_hand)
						),
						1
					)
				: 1;
		setRestockTarget(item);
		setRestockQty(gap);
		setRestockNote("");
	};

	const submitRestock = () => {
		if (!currentVehicleId || !restockTarget) return;
		const item = restockTarget;
		restockMutation.mutate(
			{
				vehicleId: currentVehicleId,
				itemId: item.id,
				data: {
					qty_requested: restockQty,
					note: restockNote.trim() || null,
				},
			},
			{
				onSuccess: () =>
					toast.success(
						`Restock requested for ${item.inventory_item.name}`
					),
				onError: () =>
					toast.error(
						"Failed to send restock request. Please try again."
					),
			}
		);
		setRestockTarget(null);
	};

	const submitBatch = async () => {
		const items = Object.entries(batchQtys)
			.filter(([, q]) => q > 0)
			.map(([stock_item_id, qty_requested]) => ({
				stock_item_id,
				qty_requested,
			}));
		if (items.length === 0) return;
		const input: BulkRestockInput = { items };
		try {
			await bulk.mutateAsync(input);
			toast.success(
				`Restock requested for ${items.length} item${items.length > 1 ? "s" : ""}`
			);
			setBatchMode(false);
			setBatchQtys({});
		} catch {
			toast.error("Failed to send restock request. Please try again.");
		}
	};

	const handleOpenBatchMode = () => {
		const defaults: Record<string, number> = {};
		for (const item of stockItems) {
			const isEmpty = Number(item.qty_on_hand) === 0;
			const isLow =
				Number(item.qty_on_hand) > 0 &&
				Number(item.qty_on_hand) <= Number(item.qty_min);
			defaults[item.id] =
				isEmpty || isLow
					? item.qty_standard !== null
						? Math.max(
								Math.ceil(
									Number(item.qty_standard) -
										Number(
											item.qty_on_hand
										)
								),
								1
							)
						: 1
					: 0;
		}
		setBatchQtys(defaults);
		setBatchMode(true);
	};

	const toggleCategory = (cat: string) => {
		setSelectedCategories((prev) =>
			prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
		);
	};

	const { outOfStockItems, lowStockItems, sortedItems } = useMemo(() => {
		const q = searchQuery.toLowerCase();
		const filtered = stockItems.filter((item) => {
			const matchesSearch =
				!q ||
				item.inventory_item.name.toLowerCase().includes(q) ||
				(item.inventory_item.category?.toLowerCase().includes(q) ??
					false) ||
				(item.inventory_item.alt_ids?.some((id) =>
					id.toLowerCase().includes(q)
				) ??
					false);
			const matchesCategory =
				!showFilter ||
				selectedCategories.length === 0 ||
				selectedCategories.includes(item.inventory_item.category ?? "");
			return matchesSearch && matchesCategory;
		});

		const outOfStock = filtered.filter((i) => Number(i.qty_on_hand) === 0);
		const lowStock = filtered.filter(
			(i) =>
				Number(i.qty_on_hand) > 0 &&
				Number(i.qty_on_hand) <= Number(i.qty_min)
		);

		const sorted = [...filtered].sort((a, b) => {
			if (sortMode === "name") {
				return a.inventory_item.name.localeCompare(b.inventory_item.name);
			}
			// Category mode: named categories A→Z, uncategorized last
			const catA = a.inventory_item.category ?? "";
			const catB = b.inventory_item.category ?? "";
			if (catA !== catB) {
				if (!catA) return 1;
				if (!catB) return -1;
				return catA.localeCompare(catB);
			}
			return a.inventory_item.name.localeCompare(b.inventory_item.name);
		});

		return {
			outOfStockItems: outOfStock,
			lowStockItems: lowStock,
			sortedItems: sorted,
		};
	}, [stockItems, searchQuery, selectedCategories, sortMode, showFilter]);

	// Build category groups for grouped render mode
	const categoryGroups = useMemo(() => {
		if (sortMode !== "category") return null;
		const groups: { label: string; items: VehicleStockItem[] }[] = [];
		for (const item of sortedItems) {
			const label = item.inventory_item.category || "Uncategorized";
			const last = groups[groups.length - 1];
			if (last && last.label === label) {
				last.items.push(item);
			} else {
				groups.push({ label, items: [item] });
			}
		}
		return groups;
	}, [sortedItems, sortMode]);

	const selectedCount = Object.values(batchQtys).filter((q) => q > 0).length;
	const selectedEntries = Object.entries(batchQtys).filter(([, q]) => q > 0);

	const renderStockItem = (item: VehicleStockItem) => (
		<StockItemRow
			key={item.id}
			item={item}
			onRestock={handleRestock}
			onOpenSerials={(stockItem) =>
				setSerialTarget({
					mode: "item",
					itemId: stockItem.inventory_item_id,
					itemName: stockItem.inventory_item.name,
				})
			}
			onOpenLots={(stockItem) =>
				setLotTarget({
					itemId: stockItem.inventory_item_id,
					itemName: stockItem.inventory_item.name,
				})
			}
			batchMode={batchMode}
			batchQty={batchQtys[item.id]}
			onBatchQtyChange={(id, qty) =>
				setBatchQtys((prev) => ({ ...prev, [id]: qty }))
			}
			isHighlighted={highlightedStockItemId === item.id}
			rowRef={(el) => {
				if (el) stockRowRefs.current.set(item.id, el);
				else stockRowRefs.current.delete(item.id);
			}}
		/>
	);

	const filtersActive = showFilter && selectedCategories.length > 0;
	const isPageLoading = techLoading || vehiclesLoading;

	// ── Switch confirmation overlay ───────────────────────────────────────────
	if (switchPendingId) {
		const pending = vehicles.find((v) => v.id === switchPendingId);
		return (
			<TechPage className="space-y-4">
				<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
					<div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
						<Truck size={15} className="text-text-muted" />
						<span className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
							Switch Vehicle
						</span>
					</div>
					<div className="px-4 py-5">
						<p className="text-sm text-text-secondary mb-1">
							Switch to{" "}
							<span className="text-text-primary font-medium">
								{pending?.name}
							</span>
							?
						</p>
						<p className="text-xs text-text-muted mb-4">
							Parts tracked today stay on record —
							switching won't remove them.
						</p>
						<div className="flex gap-2">
							<button
								onClick={() =>
									setSwitchPendingId(null)
								}
								disabled={setVehicle.isPending}
								className="flex-1 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface transition-colors disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								onClick={handleConfirmSwitch}
								disabled={setVehicle.isPending}
								className="flex-1 py-2 text-sm rounded-lg bg-primary-hover hover:bg-primary text-on-primary font-medium transition-colors disabled:opacity-50"
							>
								{setVehicle.isPending
									? "Switching…"
									: "Switch"}
							</button>
						</div>
					</div>
				</div>
			</TechPage>
		);
	}

	return (
		<TechPage className="space-y-4">
			{/* ── Vehicle card ──────────────────────────────────────────────────── */}
			<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
				<div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
					<Truck size={15} className="text-text-muted" />
					<span className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
						Vehicle
					</span>
				</div>

				{isPageLoading ? (
					<VehicleCardSkeleton />
				) : !currentVehicle ? (
					/* ── State A: No vehicle selected ──────────────────────────── */
					<>
						<div className="px-4 py-5 border-b border-border-subtle">
							<EmptyState
								icon={<Truck size={17} />}
								title="No vehicle selected"
								description="Select a vehicle to begin your day"
								action={{
									label: "Open vehicle list",
									onClick: () =>
										setShowVehicleList(
											true
										),
									icon: (
										<LayoutList
											size={14}
										/>
									),
								}}
							/>
						</div>
						<VehicleList
							vehicles={vehicles}
							onSelect={handleSelectVehicle}
							rideAlongPendingId={rideAlongPendingId}
							onRideAlongRequest={setRideAlongPendingId}
							onRideAlongCancel={() =>
								setRideAlongPendingId(null)
							}
							onRideAlongConfirm={handleRideAlongConfirm}
							isPending={setVehicle.isPending}
						/>
					</>
				) : showVehicleList ? (
					/* ── State C: Switching ─────────────────────────────────────── */
					<VehicleList
						vehicles={vehicles.filter(
							(v) => v.status === "active"
						)}
						currentVehicleId={currentVehicleId}
						onSelect={handleSelectVehicle}
						onCancel={() => setShowVehicleList(false)}
						rideAlongPendingId={rideAlongPendingId}
						onRideAlongRequest={setRideAlongPendingId}
						onRideAlongCancel={() =>
							setRideAlongPendingId(null)
						}
						onRideAlongConfirm={handleRideAlongConfirm}
						isPending={setVehicle.isPending}
					/>
				) : showCheckOutConfirm ? (
					/* ── Check-out confirmation ─────────────────────────────────── */
					<div className="px-4 py-4">
						<p className="text-sm text-text-secondary mb-1">
							Check out of{" "}
							<span className="text-text-primary font-medium">
								{currentVehicle.name}
							</span>
							?
						</p>
						<p className="text-xs text-text-muted mb-4">
							Your stock records will remain. You can
							select a vehicle again tomorrow.
						</p>
						<div className="flex gap-2">
							<button
								onClick={() =>
									setShowCheckOutConfirm(
										false
									)
								}
								disabled={setVehicle.isPending}
								className="flex-1 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface transition-colors disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								onClick={handleCheckOut}
								disabled={setVehicle.isPending}
								className="flex-1 py-2 text-sm rounded-lg bg-error-strong/80 hover:bg-error-strong text-on-primary font-medium transition-colors disabled:opacity-50"
							>
								{setVehicle.isPending
									? "Checking out…"
									: "Check Out"}
							</button>
						</div>
					</div>
				) : (
					/* ── State B: Vehicle selected ──────────────────────────────── */
					<div className="px-4 py-4">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="font-semibold text-text-primary truncate">
									{currentVehicle.name}
								</p>
								{getVehicleSubtitle(
									currentVehicle
								) ? (
									<p className="text-sm text-text-muted mt-0.5 truncate">
										{getVehicleSubtitle(
											currentVehicle
										)}
									</p>
								) : null}
								{currentVehicle.notes && (
									<p className="text-xs text-text-muted mt-2 leading-relaxed line-clamp-3">
										{
											currentVehicle.notes
										}
									</p>
								)}
							</div>
							<div className="flex items-center gap-3 shrink-0">
								<button
									onClick={() =>
										setShowVehicleList(
											true
										)
									}
									className="text-sm text-primary-text hover:text-primary-text font-medium transition-colors"
								>
									Switch
								</button>
								<button
									onClick={() =>
										setShowCheckOutConfirm(
											true
										)
									}
									className="text-sm text-text-muted hover:text-text-secondary font-medium transition-colors"
								>
									Check out
								</button>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* ── Visit stock conflicts ────────────────────────────────────────── */}
			{myConflicts.length > 0 && !showVehicleList && !showCheckOutConfirm && (
				<StockConflictWarning conflicts={myConflicts} />
			)}

			{/* ── Vehicle Reminders ─────────────────────────────────────────────── */}
			{!showVehicleList && !showCheckOutConfirm && (
				<MaintenanceReminderWarning reminders={dueReminders} setIsCreateReminderModalOpen={setIsCreateReminderModalOpen}/>
			)}

			{/* ── Inventory ─────────────────────────────────────────────────────── */}
			{currentVehicleId && !showVehicleList && !showCheckOutConfirm && (
				<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
					<button
						onClick={() => setShowInventory((v) => !v)}
						className="w-full px-4 py-3 flex items-center gap-2 text-left hover:cursor-pointer"
					>
						<Package size={15} className="text-text-muted" />
						<span className="text-xs font-medium text-text-tertiary uppercase tracking-wide flex-1">
							Inventory
						</span>
						{!showInventory && outOfStockItems.length > 0 && (
							<span className="text-[10px] font-semibold text-error-text">
								{outOfStockItems.length} out
							</span>
						)}
						{!showInventory &&
							outOfStockItems.length === 0 &&
							lowStockItems.length > 0 && (
								<span className="text-[10px] font-semibold text-warning-text">
									{lowStockItems.length} low
								</span>
							)}
						<span className="text-xs text-text-muted">
							{showInventory ? "Hide" : "Open"}
						</span>
					</button>

					{showInventory && (
						<>
							{!batchMode && (canStock || stockItems.length > 0) && (
								<VehicleStockActionRow
									restockMode={effectiveRestockMode(
										orgSettings?.restock_mode,
										orgSettingsError,
									)}
									canStock={canStock}
									canAdjustStock={canAdjustStock}
									canFieldLoss={canFieldLoss}
									hasStockItems={stockItems.length > 0}
									onFill={() => setFillOpen(true)}
									onAdjust={() => setAdjustOpen(true)}
									onRequestRestock={handleOpenBatchMode}
									onScan={() => setIsScannerOpen(true)}
								/>
							)}

							{/* Out of stock bar */}
							{outOfStockItems.length > 0 && (
								<div
									role="status"
									className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-error/5 text-error-text text-xs font-medium"
								>
									<PackageX
										size={13}
										aria-hidden="true"
									/>
									{outOfStockItems.length}{" "}
									item
									{outOfStockItems.length > 1
										? "s"
										: ""}{" "}
									out of stock
								</div>
							)}
							{/* Low stock bar */}
							{lowStockItems.length > 0 && (
								<div
									role="status"
									className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-warning/5 text-warning-text text-xs font-medium"
								>
									<AlertTriangle
										size={13}
										aria-hidden="true"
									/>
									{lowStockItems.length} item
									{lowStockItems.length > 1
										? "s"
										: ""}{" "}
									low stock
								</div>
							)}

							{/* Search + filter + sort toolbar */}
							<div className="px-4 py-2 border-b border-border-subtle space-y-2">
								<div className="flex items-center gap-2">
									<div className="relative flex-1">
										<Search
											size={13}
											className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint pointer-events-none"
										/>
										<input
											type="text"
											placeholder="Search items..."
											value={
												searchQuery
											}
											onChange={(
												e
											) =>
												setSearchQuery(
													e
														.target
														.value
												)
											}
											aria-label="Search inventory items"
											className="w-full bg-surface-inset border border-border rounded-lg pl-8 pr-8 py-1.5 text-sm text-text-primary placeholder:text-faint focus:outline-none focus:border-border-strong"
										/>
										{searchQuery && (
											<button
												onClick={() =>
													setSearchQuery(
														""
													)
												}
												aria-label="Clear search"
												className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
											>
												<X
													size={
														13
													}
												/>
											</button>
										)}
									</div>
									{allCategories.length >
										0 && (
										<button
											onClick={() =>
												setShowFilter(
													(
														v
													) =>
														!v
												)
											}
											aria-label="Filter by category"
											title="Filter by category"
											className={`flex items-center justify-center w-11 h-11 rounded-lg border transition-colors shrink-0 ${
												showFilter
													? "bg-primary-hover/20 border-primary-hover/40 text-primary-text"
													: "bg-surface border-border text-text-muted hover:text-text-secondary hover:border-border-strong"
											}`}
										>
											<SlidersHorizontal
												size={
													13
												}
											/>
										</button>
									)}
									<button
										onClick={() =>
											setSortMode(
												(
													m
												) =>
													m ===
													"name"
														? "category"
														: "name"
											)
										}
										aria-label={
											sortMode ===
											"name"
												? "Sort by category"
												: "Sort by name"
										}
										title={
											sortMode ===
											"name"
												? "Sort by category"
												: "Sort by name"
										}
										className={`flex items-center justify-center w-11 h-11 rounded-lg border transition-colors shrink-0 ${
											sortMode ===
											"category"
												? "bg-primary-hover/20 border-primary-hover/40 text-primary-text"
												: "bg-surface border-border text-text-muted hover:text-text-secondary hover:border-border-strong"
										}`}
									>
										<LayoutList
											size={13}
										/>
									</button>
								</div>

								{/* Category filter chips */}
								{showFilter &&
									allCategories.length >
										0 && (
										<div className="flex flex-wrap gap-1.5">
											{allCategories.map(
												(
													cat
												) => {
													const active =
														selectedCategories.includes(
															cat
														);
													return (
														<button
															key={
																cat
															}
															onClick={() =>
																toggleCategory(
																	cat
																)
															}
															className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
																active
																	? "bg-primary-hover/20 border-primary-hover/40 text-primary-text"
																	: "bg-surface border-border text-text-tertiary hover:border-border-strong hover:text-text-secondary"
															}`}
														>
															{
																cat
															}
														</button>
													);
												}
											)}
											{filtersActive && (
												<button
													onClick={() =>
														setSelectedCategories(
															[]
														)
													}
													className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full text-text-muted hover:text-text-secondary transition-colors"
												>
													<X
														size={
															10
														}
													/>
													Clear
												</button>
											)}
										</div>
									)}
							</div>

							{/* Batch restock action bar */}
							{batchMode && (
								<div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-2.5 bg-canvas border-b border-border">
									<span className="text-xs text-text-muted">
										{selectedCount >
										0 ? (
											<span className="font-semibold text-text-primary">
												{
													selectedCount
												}
											</span>
										) : (
											"0"
										)}{" "}
										item
										{selectedCount !== 1
											? "s"
											: ""}{" "}
										selected
									</span>
									<div className="flex items-center gap-2">
										<button
											onClick={() => {
												setBatchMode(
													false
												);
												setBatchQtys(
													{}
												);
											}}
											className="px-3 py-1.5 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised transition-colors"
										>
											Cancel
										</button>
										<button
											onClick={() =>
												setShowBatchConfirm(
													true
												)
											}
											disabled={
												selectedCount ===
												0
											}
											className="px-3 py-1.5 text-xs font-semibold rounded-md bg-primary-hover hover:enabled:bg-primary text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
										>
											Send Request
											{selectedCount >
											0
												? ` (${selectedCount})`
												: ""}
										</button>
									</div>
								</div>
							)}

							{/* Stock list */}
							{sortedItems.length === 0 ? (
								searchQuery || filtersActive ? (
									<EmptyState
										title={
											searchQuery && filtersActive
												? `No items match "${searchQuery}" in selected categories`
												: searchQuery
													? `No items match "${searchQuery}"`
													: "No items in selected categories"
										}
										action={{
											label: "Clear filters",
											onClick: () => {
												setSearchQuery("");
												setSelectedCategories([]);
											},
											icon: <RotateCcw size={14} />,
										}}
									/>
								) : (
									<EmptyState
										{...emptyVehicleStockCopy(canStock)}
										action={
											canStock
												? {
														label: "Add stock items",
														onClick: () => {
															setStockEditMode("add");
															setShowAddItem(true);
														},
														icon: <ListChecks size={14} />,
													}
												: undefined
										}
									/>
								)
							) : categoryGroups ? (
								<div>
									{categoryGroups.map(
										(group) => (
											<div
												key={
													group.label
												}
											>
												<CategoryHeader
													label={
														group.label
													}
												/>
												{group.items.map(
													renderStockItem
												)}
											</div>
										)
									)}
								</div>
							) : (
								<div>
									{sortedItems.map(
										renderStockItem
									)}
								</div>
							)}
						</>
					)}
				</div>
			)}

			{/* ── Add to stock list ──────────────────────────────────────────────── */}
			{canStock &&
				currentVehicleId &&
				!showVehicleList &&
				!showCheckOutConfirm && (
					<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
						<button
							onClick={() => setShowAddItem((v) => !v)}
							className="w-full px-4 py-3 flex items-center gap-2 text-left hover:cursor-pointer"
						>
							<ListChecks
								size={15}
								className="text-text-muted"
							/>
							<span className="text-xs font-medium text-text-tertiary uppercase tracking-wide flex-1">
								Add / Remove Stock Items
							</span>
							<span className="text-xs text-text-muted">
								{showAddItem ? "Hide" : "Open"}
							</span>
						</button>
						{showAddItem && (
							<div className="border-t border-border-subtle">
								{/* Same control as the Warehouse Restock mode switch —
								    two mode switches on one page reading differently
								    was the tell that one of them was hand-rolled. */}
								<div className="px-3 py-2">
									<SegmentedToggle<"add" | "remove">
										ariaLabel="Stock list mode"
										value={stockEditMode}
										onChange={setStockEditMode}
										fullWidth
										variant="flat"
										options={[
											{ id: "add", label: "Add" },
											{ id: "remove", label: "Remove" },
										]}
									/>
								</div>
								{stockEditMode === "add" ? (
									<AddStockItemSheet
										vehicleId={currentVehicleId}
										existingIds={
											new Set(
												stockItems.map(
													(
														i
													) =>
														i.inventory_item_id
												)
											)
										}
										onDone={() =>
											setShowAddItem(
												false
											)
										}
									/>
								) : (
									<RemoveStockItemSheet
										vehicleId={currentVehicleId}
										stockItems={stockItems}
										onAdjust={(item) => {
											clearHighlightRef.current();
											setHighlightedStockItemId(item.id);
											setScanFocusItemId(item.id);
											setAdjustOpen(true);
										}}
									/>
								)}
							</div>
						)}
					</div>
				)}

			{/* ── End of day (optional — never gates anything) ─────────────────── */}
			{canRestock &&
				currentVehicleId &&
				!showVehicleList &&
				!showCheckOutConfirm && (
					<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
						<button
							onClick={() => setRestockOpen((v) => !v)}
							className="w-full px-4 py-3 flex items-center gap-2 text-left hover:cursor-pointer"
						>
							<ClipboardCheck
								size={15}
								className="text-text-muted"
							/>
							<span className="text-xs font-medium text-text-tertiary uppercase tracking-wide flex-1">
								Warehouse Restock
							</span>
							<span className="text-xs text-text-muted">
								{restockOpen ? "Hide" : "Open"}
							</span>
						</button>
						{restockOpen && (
							<div className="border-t border-border-subtle">
								<RestockWorkflow
									vehicleId={currentVehicleId}
									stockItems={stockItems}
									layout="mobile"
								/>
							</div>
						)}
					</div>
				)}

			{/* ── Stock History ────────────────────────────────────────────────── */}
			{currentVehicleId &&
				!showVehicleList &&
				!showCheckOutConfirm &&
				(canStock || canUseInventory) && (
					<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
						<button
							onClick={() =>
								setShowStockHistory((v) => !v)
							}
							className="w-full px-4 py-3 flex items-center gap-2 text-left hover:cursor-pointer"
						>
							<History
								size={15}
								className="text-text-muted"
							/>
							<span className="text-xs font-medium text-text-tertiary uppercase tracking-wide flex-1">
								Stock History
							</span>
							<span className="text-xs text-text-muted">
								{showStockHistory ? "Hide" : "Open"}
							</span>
						</button>
						{showStockHistory && (
							<div className="border-t border-border-subtle">
								<StockHistorySection
									vehicleId={currentVehicleId}
									stockItems={stockItems}
								/>
							</div>
						)}
					</div>
				)}

			{/* ── Restock status list ──────────────────────────────────────────── */}
			{currentVehicleId && !showVehicleList && !showCheckOutConfirm && (
				<RestockStatusList vehicleId={currentVehicleId} />
			)}

			{/* Serial unit sheet — scan a sticker or tap a Serialized badge */}
			{currentVehicleId && (
				<SerialSheet
					target={serialTarget}
					onClose={() => setSerialTarget(null)}
					vehicleId={currentVehicleId}
					onReportLost={({ serialUnitId, inventoryItemId }) => {
						const stockItem = findStockItemOrWarn(inventoryItemId);
						if (!stockItem) return;
						setSerialTarget(null);
						clearHighlightRef.current();
						setHighlightedStockItemId(stockItem.id);
						setScanFocusItemId(stockItem.id);
						setPendingLostSerialId(serialUnitId);
						setAdjustOpen(true);
					}}
				/>
			)}

			{/* Lot sheet — tap a Batch badge */}
			{currentVehicleId && (
				<LotSheet
					target={lotTarget}
					onClose={() => setLotTarget(null)}
					vehicleId={currentVehicleId}
				/>
			)}

			{/* Stock adjust modal (self-serve) */}
			{adjustOpen && currentVehicleId && (
				<AdjustStockModal
					key={`${scanFocusItemId ?? "manual"}:${pendingLostSerialId ?? ""}`}
					vehicleId={currentVehicleId}
					stockItems={stockItems}
					onClose={() => {
						setAdjustOpen(false);
						if (scanFocusItemId) armHighlightClear();
						setScanFocusItemId(null);
						setPendingLostSerialId(null);
					}}
					onSuccess={() => toast.success("Stock adjusted")}
					onError={(message) => toast.error(message)}
					initialType={scanFocusItemId ? "field_loss" : undefined}
					initialFocusItemId={scanFocusItemId ?? undefined}
					initialSerialUnitId={pendingLostSerialId ?? undefined}
				/>
			)}

			{/* Barcode scanner (camera) */}
			{isScannerOpen && (
				<BarcodeScanner
					onScan={(code) => {
						setIsScannerOpen(false);
						handleBarcodeScan(code);
					}}
					onClose={() => setIsScannerOpen(false)}
				/>
			)}

			{/* Restock request sheet — qty + optional note */}
			{restockTarget && (
				<>
					<div
						className="fixed inset-0 z-[55] bg-overlay"
						onClick={() => setRestockTarget(null)}
					/>
					<div
						className="fixed inset-0 z-[60] flex items-center justify-center px-4"
						onClick={() => setRestockTarget(null)}
					>
						<div
							className="bg-base border border-border rounded-xl w-full max-w-sm px-4 pt-4 pb-5 shadow-2xl"
							onClick={(e) => e.stopPropagation()}
						>
							{/* Clamped: the sheet is max-w-sm, and a 255-character
							    part name pushed the quantity stepper off the
							    bottom of a phone screen. */}
							<p
								className="text-sm font-semibold text-text-primary mb-0.5 line-clamp-2 break-words"
								title={restockTarget.inventory_item.name}
							>
								Request restock —{" "}
								{restockTarget.inventory_item.name}
							</p>
							<p className="text-xs text-text-muted mb-4">
								On hand{" "}
								{Number(restockTarget.qty_on_hand)}
								{restockTarget.qty_standard !==
									null &&
									` · standard ${Number(restockTarget.qty_standard)}`}
								{` · warehouse ${Number(restockTarget.inventory_item.quantity)}`}
							</p>
							<div className="flex items-center justify-center gap-4 mb-4">
								<button
									onClick={() =>
										setRestockQty((q) =>
											Math.max(
												1,
												q -
													1
											)
										)
									}
									className="w-11 h-11 rounded-lg border border-border text-text-secondary text-lg font-semibold hover:bg-surface transition-colors"
									aria-label="Decrease quantity"
								>
									−
								</button>
								<span className="w-12 text-center text-xl font-bold text-text-primary tabular-nums">
									{restockQty}
								</span>
								<button
									onClick={() =>
										setRestockQty(
											(q) => q + 1
										)
									}
									className="w-11 h-11 rounded-lg border border-border text-text-secondary text-lg font-semibold hover:bg-surface transition-colors"
									aria-label="Increase quantity"
								>
									+
								</button>
							</div>
							<input
								value={restockNote}
								onChange={(e) =>
									setRestockNote(
										e.target.value
									)
								}
								placeholder="Note (optional)"
								maxLength={500}
								className="w-full mb-4 bg-surface-inset border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-faint focus:outline-none focus:border-border-strong"
							/>
							<div className="flex gap-2">
								<button
									onClick={() =>
										setRestockTarget(
											null
										)
									}
									className="flex-1 py-2.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface transition-colors"
								>
									Cancel
								</button>
								<button
									onClick={submitRestock}
									disabled={
										restockMutation.isPending
									}
									className="flex-1 py-2.5 text-sm rounded-lg bg-primary-hover hover:bg-primary text-on-primary font-medium transition-colors disabled:opacity-50"
								>
									{restockMutation.isPending
										? "Sending…"
										: "Request"}
								</button>
							</div>
						</div>
					</div>
				</>
			)}

			{/* Fill to Standard modal */}
			{fillOpen && currentVehicleId && (
				<div
					className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay"
					onClick={() => setFillOpen(false)}
				>
					<div
						className="bg-canvas border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col mx-4"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
							<span className="text-sm font-bold text-text-primary">
								Fill to Standard
							</span>
							<button
								onClick={() => setFillOpen(false)}
								aria-label="Close"
								className="text-text-faint hover:text-text-secondary transition-colors"
							>
								<X size={16} />
							</button>
						</div>
						<div className="overflow-y-auto flex-1">
							<FillToStandardPreview
								vehicleId={currentVehicleId}
								onClose={() => setFillOpen(false)}
								onSuccess={() =>
									toast.success(
										"Vehicle filled to standard"
									)
								}
								onError={(message) =>
									toast.error(message)
								}
							/>
						</div>
					</div>
				</div>
			)}

			{/* Bulk restock confirmation modal */}
			{showBatchConfirm && (
				<>
					<div
						className="fixed inset-0 z-[55] bg-overlay"
						onClick={() => setShowBatchConfirm(false)}
					/>
					<div
						className="fixed inset-0 z-[60] flex items-center justify-center px-4"
						onClick={() => setShowBatchConfirm(false)}
					>
						<div
							className="bg-base border border-border rounded-xl w-full max-w-sm shadow-2xl"
							onClick={(e) => e.stopPropagation()}
						>
							<div className="flex items-center justify-between px-4 py-3.5 border-b border-border">
								<div>
									<p className="text-sm font-semibold text-text-primary">
										Bulk Restock Request
									</p>
									<p className="text-xs text-text-muted mt-0.5">
										{
											selectedEntries.length
										}{" "}
										item
										{selectedEntries.length >
										1
											? "s"
											: ""}{" "}
										selected
									</p>
								</div>
								<button
									onClick={() =>
										setShowBatchConfirm(
											false
										)
									}
									aria-label="Close"
									className="text-text-faint hover:text-text-secondary transition-colors p-1 -mr-1"
								>
									<X size={15} />
								</button>
							</div>
							<div className="max-h-64 overflow-y-auto divide-y divide-border-subtle">
								{selectedEntries.map(
									([id, qty]) => {
										const item =
											stockItems.find(
												(
													i
												) =>
													i.id ===
													id
											);
										if (!item)
											return null;
										const unit =
											item
												.inventory_item
												.unit;
										return (
											<div
												key={
													id
												}
												className="flex items-center gap-3 px-4 py-2.5"
											>
												<div className="flex-1 min-w-0">
													<p className="text-sm text-text-primary truncate">
														{
															item
																.inventory_item
																.name
														}
													</p>
													{item
														.inventory_item
														.category && (
														<span className="text-[10px] text-text-muted">
															{
																item
																	.inventory_item
																	.category
															}
														</span>
													)}
												</div>
												<div className="text-right shrink-0">
													<p className="text-sm font-semibold tabular-nums text-primary-text">
														+
														{
															qty
														}
													</p>
													<p className="text-[10px] text-text-faint">
														{unitLabel(
															unit,
															qty
														)}
													</p>
												</div>
											</div>
										);
									}
								)}
							</div>
							<div className="flex gap-2 px-4 py-3.5 border-t border-border">
								<button
									onClick={() =>
										setShowBatchConfirm(
											false
										)
									}
									className="flex-1 py-2.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface transition-colors"
								>
									Cancel
								</button>
								<button
									onClick={() => {
										setShowBatchConfirm(
											false
										);
										submitBatch();
									}}
									disabled={bulk.isPending}
									className="flex-1 py-2.5 text-sm rounded-lg bg-primary-hover hover:bg-primary text-on-primary font-medium transition-colors disabled:opacity-50"
								>
									{bulk.isPending
										? "Requesting…"
										: "Request"}
								</button>
							</div>
						</div>
					</div>
				</>
			)}

			{isCreateReminderModalOpen && (
				<CreateMaintenanceReminderModal
					vehicleId={currentVehicleId ?? ""}
					isModalOpen={isCreateReminderModalOpen}
					setIsModalOpen={setIsCreateReminderModalOpen}
				/>
			)}
		</TechPage>
	);
}
