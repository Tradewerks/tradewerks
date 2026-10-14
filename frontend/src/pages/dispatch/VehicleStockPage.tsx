import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Trash2, Search, X, SlidersHorizontal, LayoutList, AlertTriangle } from "lucide-react";
import { getStockHealth } from "../../lib/stockUtils";
import { useVehiclesQuery } from "../../hooks/useVehicles";
import {
	useVehicleStockQuery,
	useUpdateVehicleStockItemMutation,
	useDeleteVehicleStockItemMutation,
	useAddVehicleStockItemMutation,
	useRestockRequestsQuery,
	useAcknowledgeRestockRequestMutation,
	useDismissRestockRequestMutation,
} from "../../hooks/useVehicleStock";
import FillToStandardPreview from "../../components/vehicles/FillToStandardPreview";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import EditVehicle from "../../components/vehicles/EditVehicle";
import RestockWorkflow from "../../components/vehicles/RestockWorkflow";
import AdjustStockModal from "../../components/vehicles/AdjustStockModal";
import LoadSvg from "../../assets/icons/loading.svg?react";
import type { VehicleStockItem, RestockRequest } from "../../types/vehicles";
import StockHistorySection from "../../components/vehicles/StockHistorySection";
import Card from "../../components/ui/Card";
import { HEADER_META } from "../../components/ui/headerActions";
import { unitLabel } from "../../lib/units";
import MaintenanceTab from "../../components/vehicles/maintenance/MaintenanceTab";
import ChangeHistory from "../../components/activity/ChangeHistory";
import UntrackedStockNotice from "../../components/entitlements/UntrackedStockNotice";

import { useOrgSettings } from "../../hooks/useOrg";
import { vehicleStockTabOrder, type VehicleStockTab as Tab } from "../../lib/restockEmphasis";

const STOCK_GRID = "grid-cols-[1fr_84px_84px_84px_84px_116px_36px]";

function VehicleIcon({ hasOut, hasLow }: { hasOut: boolean; hasLow: boolean }) {
	const stroke = hasOut ? "var(--color-error)" : hasLow ? "var(--color-warning)" : "var(--color-success)";
	const bg = hasOut ? "bg-error/10" : hasLow ? "bg-warning/10" : "bg-success/10";
	return (
		<div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${bg}`}>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
				<rect x="1" y="3" width="15" height="13" rx="2"/>
				<path d="M16 8h4l3 5v3h-7V8z"/>
				<circle cx="5.5" cy="18.5" r="2.5"/>
				<circle cx="18.5" cy="18.5" r="2.5"/>
			</svg>
		</div>
	);
}

/** On-hand level relative to standard (or 2×min when no standard set). */
function LevelGauge({ item }: { item: VehicleStockItem }) {
	const onHand = Number(item.qty_on_hand);
	const min = Number(item.qty_min);
	const standard = item.qty_standard !== null ? Number(item.qty_standard) : null;

	const health = getStockHealth(item);
	const isOut = health === "out";
	const isLow = health === "low";

	const target = standard !== null && standard > 0 ? standard : min > 0 ? min * 2 : 0;
	const pct = target > 0 ? Math.min(onHand / target, 1) * 100 : onHand > 0 ? 100 : 0;

	const barColor = isOut ? "bg-error" : isLow ? "bg-warning" : "bg-success/80";
	const textColor = isOut ? "text-error-text" : isLow ? "text-warning-text" : "text-success";
	const label = isOut ? "Out" : isLow ? "Low" : "OK";

	return (
		<div className="flex items-center justify-center gap-2">
			<div className="w-10 h-1.5 rounded-full bg-surface-inset border border-border overflow-hidden flex-shrink-0">
				<div
					className={`h-full ${barColor} transition-all duration-200`}
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className={`text-xs font-semibold w-7 text-left ${textColor}`}>{label}</span>
		</div>
	);
}

function StockRow({ item, onUpdateStandard, onUpdateMin, onDelete }: {
	item: VehicleStockItem;
	onUpdateStandard: (qty: number | null) => void;
	onUpdateMin: (qty: number) => void;
	onDelete: () => void;
}) {
	const navigate = useNavigate();
	const [editingStandard, setEditingStandard] = useState(false);
	const [stdVal, setStdVal] = useState(item.qty_standard !== null ? String(item.qty_standard) : "");
	const [editingMin, setEditingMin] = useState(false);
	const [minVal, setMinVal] = useState(String(item.qty_min));
	const [confirmDelete, setConfirmDelete] = useState(false);
	const deleteTimer = useRef<number>(-1);

	useEffect(() => () => { clearTimeout(deleteTimer.current); }, []);

	const handleDeleteClick = () => {
		if (confirmDelete) {
			clearTimeout(deleteTimer.current);
			setConfirmDelete(false);
			onDelete();
		} else {
			setConfirmDelete(true);
			deleteTimer.current = window.setTimeout(() => setConfirmDelete(false), 3000);
		}
	};

	const onHand = Number(item.qty_on_hand);
	const min = Number(item.qty_min);
	const health = getStockHealth(item);
	const isOut = health === "out";
	const isLow = health === "low";

	const inputBorder = isOut ? "border-error" : isLow ? "border-warning" : "border-border-input";
	const inputText   = isOut ? "text-error-text font-bold" : isLow ? "text-warning-text font-bold" : "text-text-primary font-semibold";
	const rowBg       = isOut ? "bg-error/10" : isLow ? "bg-warning/10" : "";

	const commitStandard = () => {
		if (!editingStandard) return;
		setEditingStandard(false);
		const trimmed = stdVal.trim();
		if (trimmed === "") {
			onUpdateStandard(null);
		} else {
			const n = Number(trimmed);
			if (!isNaN(n) && n >= 0) onUpdateStandard(n);
			else setStdVal(item.qty_standard !== null ? String(item.qty_standard) : "");
		}
	};

	const commitMin = () => {
		if (!editingMin) return;
		setEditingMin(false);
		const n = Number(minVal.trim());
		if (!isNaN(n) && n >= 0) onUpdateMin(n);
		else setMinVal(String(item.qty_min));
	};

	return (
		<div className={`grid ${STOCK_GRID} items-center px-5 py-2.5 border-b border-border/20 ${rowBg} hover:bg-surface-raised/40 transition-colors`}>
			<div>
				<button
					onClick={() => navigate(`/dispatch/inventory?highlight=${item.inventory_item_id}`)}
					className="text-sm font-medium text-text-primary hover:text-primary hover:underline transition-colors text-left"
				>
					{item.inventory_item.name}
				</button>
				<div className="text-xs text-text-muted">
					{[item.inventory_item.category, unitLabel(item.inventory_item.unit)]
						.filter(Boolean)
						.join(" · ")}
				</div>
			</div>
			<div className="flex justify-center">
				<span className={`text-sm tabular-nums ${
					Number(item.inventory_item.quantity) === 0
						? "text-error-text font-semibold"
						: item.inventory_item.low_stock_threshold !== null &&
						  Number(item.inventory_item.quantity) <= Number(item.inventory_item.low_stock_threshold)
						? "text-warning-text"
						: "text-text-muted"
				}`}>
					{Number(item.inventory_item.quantity)}
				</span>
			</div>
			<div className="flex justify-center">
				{editingStandard ? (
					<input
						autoFocus
						className="w-14 text-center text-sm rounded border border-primary text-text-primary font-semibold bg-surface px-1 py-0.5 outline-none"
						value={stdVal}
						onChange={(e) => setStdVal(e.target.value)}
						onBlur={commitStandard}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitStandard();
							if (e.key === "Escape") {
								setStdVal(item.qty_standard !== null ? String(item.qty_standard) : "");
								setEditingStandard(false);
							}
						}}
					/>
				) : item.qty_standard !== null ? (
					<button
						onClick={() => { setStdVal(String(item.qty_standard)); setEditingStandard(true); }}
						className="w-14 text-center text-sm rounded border border-border-input text-text-muted bg-surface px-1 py-0.5 hover:bg-surface-raised transition-colors"
					>
						{Number(item.qty_standard)}
					</button>
				) : (
					<button
						onClick={() => { setStdVal(""); setEditingStandard(true); }}
						className="w-14 text-center text-sm rounded border border-dashed border-border/40 text-text-faint bg-transparent px-1 py-0.5 hover:border-border hover:text-text-muted transition-colors"
					>
						—
					</button>
				)}
			</div>
			<div className="flex justify-center">
				<span className={`w-14 text-center text-sm rounded border ${inputBorder} ${inputText} bg-surface px-1 py-0.5`}>
					{onHand}
				</span>
			</div>
			<div className="flex justify-center">
				{editingMin ? (
					<input
						autoFocus
						className="w-14 text-center text-sm rounded border border-primary text-text-primary font-semibold bg-surface px-1 py-0.5 outline-none"
						value={minVal}
						onChange={(e) => setMinVal(e.target.value)}
						onBlur={commitMin}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitMin();
							if (e.key === "Escape") { setMinVal(String(item.qty_min)); setEditingMin(false); }
						}}
					/>
				) : (
					<button
						onClick={() => { setMinVal(String(item.qty_min)); setEditingMin(true); }}
						className="w-14 text-center text-sm rounded border border-border-input text-text-muted bg-surface px-1 py-0.5 hover:bg-surface-raised transition-colors"
					>
						{min}
					</button>
				)}
			</div>
			<LevelGauge item={item} />
			<div className="flex justify-center">
				{confirmDelete ? (
					<button
						onClick={handleDeleteClick}
						className="text-[10px] font-bold text-error-text bg-error/15 hover:bg-error/25 px-1.5 py-0.5 rounded transition-colors whitespace-nowrap"
					>
						Confirm?
					</button>
				) : (
					<button
						onClick={handleDeleteClick}
						aria-label={`Remove ${item.inventory_item.name} from stock list`}
						className="text-text-faint hover:text-error-text transition-colors"
					>
						<Trash2 size={14} />
					</button>
				)}
			</div>
		</div>
	);
}

function AddStockItemRow({ vehicleId, existingIds, onDone }: {
	vehicleId: string;
	existingIds: Set<string>;
	onDone: () => void;
}) {
	const [search, setSearch] = useState("");
	const [qtyMin, setQtyMin] = useState("1");
	const [qtyStandard, setQtyStandard] = useState("");
	const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
	const [sortMode, setSortMode] = useState<"name" | "category">("name");
	const [showFilter, setShowFilter] = useState(false);
	const addMutation = useAddVehicleStockItemMutation();
	const { data: allInventory = [] } = useAllInventoryQuery();
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => { inputRef.current?.focus(); }, []);

	const available = allInventory.filter((item) => !existingIds.has(item.id));
	const allCategories = Array.from(new Set(
		available.map((i) => i.category).filter((c): c is string => Boolean(c))
	)).sort();

	const q = search.toLowerCase().trim();
	const results = available
		.filter((item) => {
			const matchesSearch = !q ||
				item.name.toLowerCase().includes(q) ||
				item.alt_ids?.some((id) => id.toLowerCase().includes(q));
			const matchesCategory = selectedCategories.length === 0 ||
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
		setSelectedCategories((prev) => prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]);

	return (
		<div className="px-5 py-3 border-t border-border">
			<div className="flex items-center gap-2 mb-2">
				<div className="flex items-center gap-1">
					<label className="text-[10px] text-text-muted whitespace-nowrap">Min qty</label>
					<input
						type="number"
						min={0}
						value={qtyMin}
						onChange={(e) => setQtyMin(e.target.value)}
						className="w-14 text-xs bg-surface border border-border-input rounded px-1.5 py-1 text-text-primary outline-none focus:border-primary"
					/>
				</div>
				<div className="flex items-center gap-1">
					<label className="text-[10px] text-text-muted whitespace-nowrap">Standard qty</label>
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
							className={`flex items-center justify-center w-7 h-7 rounded border transition-colors ${
								showFilter
									? "bg-primary/15 border-primary/40 text-primary"
									: "border-border text-text-muted hover:text-text-secondary hover:border-border-strong"
							}`}
						>
							<SlidersHorizontal size={11} />
						</button>
					)}
					<button
						onClick={() => setSortMode((m) => m === "name" ? "category" : "name")}
						title={sortMode === "name" ? "Sort by category" : "Sort by name"}
						className={`flex items-center justify-center w-7 h-7 rounded border transition-colors ${
							sortMode === "category"
								? "bg-primary/15 border-primary/40 text-primary"
								: "border-border text-text-muted hover:text-text-secondary hover:border-border-strong"
						}`}
					>
						<LayoutList size={11} />
					</button>
				</div>
			</div>
			{showFilter && allCategories.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mb-2">
					{allCategories.map((cat) => {
						const active = selectedCategories.includes(cat);
						return (
							<button
								key={cat}
								onClick={() => toggleCategory(cat)}
								className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
									active
										? "bg-primary/15 border-primary/40 text-primary"
										: "bg-surface border-border text-text-muted hover:border-border-strong hover:text-text-secondary"
								}`}
							>
								{cat}
							</button>
						);
					})}
					{selectedCategories.length > 0 && (
						<button
							onClick={() => setSelectedCategories([])}
							className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full text-text-muted hover:text-text-secondary transition-colors"
						>
							<X size={9} />
							Clear
						</button>
					)}
				</div>
			)}
			<div className="relative">
				<div className="flex items-center gap-2 border border-primary rounded-md px-3 py-1.5 bg-base">
					<Search size={13} className="text-text-muted flex-shrink-0" />
					<input
						ref={inputRef}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}
						placeholder="Search inventory…"
						className="flex-1 text-sm bg-transparent text-text-primary placeholder:text-faint outline-none"
					/>
					<button onClick={onDone} className="text-text-faint hover:text-text-secondary transition-colors">
						<X size={13} />
					</button>
				</div>
				{results.length > 0 && (
					<div className="absolute left-0 right-0 top-full mt-1 bg-surface border border-border rounded-md shadow-lg z-20 max-h-48 overflow-y-auto">
						{results.map((item) => (
							<button
								key={item.id}
								onClick={() => handleSelect(item.id)}
								disabled={addMutation.isPending}
								className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-surface-raised transition-colors disabled:opacity-50"
							>
								<span className="text-sm text-text-primary">{item.name}</span>
								<span className="text-xs text-text-muted">
									{[item.category, unitLabel(item.unit)].filter(Boolean).join(" · ")}
								</span>
							</button>
						))}
					</div>
				)}
				{(q || selectedCategories.length > 0) && results.length === 0 && (
					<div className="absolute left-0 right-0 top-full mt-1 bg-surface border border-border rounded-md shadow-lg z-20 px-3 py-2">
						<span className="text-xs text-text-muted">No matching inventory items</span>
					</div>
				)}
			</div>
		</div>
	);
}


function SectionHeader({ label, count, tone }: { label: string; count: number; tone: "warning" | "muted" }) {
	return (
		<div className={`flex items-center gap-2 px-5 pt-3 pb-1 ${tone === "warning" ? "text-warning-text" : "text-text-faint"}`}>
			<span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
			<span className="text-[10px] font-semibold tabular-nums">{count}</span>
			<div className={`flex-1 h-px ${tone === "warning" ? "bg-warning/20" : "bg-border/30"}`} />
		</div>
	);
}

function StockTab({ vehicleId, stockItems, isLoading }: {
	vehicleId: string;
	stockItems: VehicleStockItem[];
	isLoading: boolean;
}) {
	const [addOpen, setAddOpen] = useState(false);
	const [adjustOpen, setAdjustOpen] = useState(false);
	const updateMutation = useUpdateVehicleStockItemMutation();
	const deleteMutation = useDeleteVehicleStockItemMutation();

	if (isLoading) return <div className="flex justify-center py-16"><LoadSvg className="w-8 h-8" /></div>;

	const HEALTH_ORDER: Record<"out" | "low" | "ok", number> = { out: 0, low: 1, ok: 2 };
	const sorted = [...stockItems].sort((a, b) => HEALTH_ORDER[getStockHealth(a)] - HEALTH_ORDER[getStockHealth(b)]);
	const needsAttention = sorted.filter((i) => getStockHealth(i) !== "ok");
	const stocked = sorted.filter((i) => getStockHealth(i) === "ok");

	const existingIds = new Set(stockItems.map((i) => i.inventory_item_id));
	const unconfiguredCount = stockItems.filter((i) => i.qty_standard === null && Number(i.qty_min) === 0).length;

	const renderRow = (item: VehicleStockItem) => (
		<StockRow
			key={item.id}
			item={item}
			onUpdateStandard={(qty_standard) => updateMutation.mutate({ vehicleId, itemId: item.id, data: { qty_standard } })}
			onUpdateMin={(qty_min) => updateMutation.mutate({ vehicleId, itemId: item.id, data: { qty_min } })}
			onDelete={() => deleteMutation.mutate({ vehicleId, itemId: item.id })}
		/>
	);

	return (
		<div>
			{/* One toolbar row: the unconfigured-items notice shares the line with
			    Adjust Stock instead of stacking a full-width banner above it. */}
			<div className="flex items-center gap-3 px-5 py-2 border-b border-border/10 mt-2">
				{unconfiguredCount > 0 && (
					<div className="flex min-w-0 items-center gap-2 rounded-md border border-warning-border bg-warning-bg px-2.5 py-1 text-xs text-warning-text">
						<AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
						<span className="min-w-0">
							<span className="font-semibold">{unconfiguredCount} item{unconfiguredCount !== 1 ? "s" : ""}</span>{" "}
							{unconfiguredCount !== 1 ? "have" : "has"} no standard or min qty — invisible to EOD and conflict alerts.{" "}
							<span className="text-warning-text/70">Set them in the Standard / Min columns.</span>
						</span>
					</div>
				)}
				<button
					onClick={() => setAdjustOpen(true)}
					className="ml-auto shrink-0 px-3 py-1.5 text-xs font-semibold bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
				>
					Adjust Stock
				</button>
			</div>
			{sorted.length > 0 && (
				<div className={`grid ${STOCK_GRID} px-5 py-2 border-b border-border/30 sticky top-0 bg-canvas z-10`}>
					{["Item", "Warehouse", "Standard", "On Hand", "Min", "Level", ""].map((h) => (
						<div key={h} className="text-[10px] font-semibold text-text-muted uppercase tracking-wider text-center first:text-left">{h}</div>
					))}
				</div>
			)}
			{sorted.length === 0 && !addOpen && (
				<div className="flex flex-col items-center justify-center py-14 text-center">
					<p className="text-sm font-medium text-text-secondary">No stock tracked on this vehicle</p>
					<p className="text-xs text-text-muted mt-1 max-w-72">
						Add inventory items to track on-hand quantities, get low-stock alerts, and enable end-of-day restocking.
					</p>
				</div>
			)}
			{needsAttention.length > 0 && (
				<>
					<SectionHeader label="Needs attention" count={needsAttention.length} tone="warning" />
					{needsAttention.map(renderRow)}
				</>
			)}
			{needsAttention.length > 0 && stocked.length > 0 && (
				<SectionHeader label="Stocked" count={stocked.length} tone="muted" />
			)}
			{(needsAttention.length > 0 ? stocked : sorted).map(renderRow)}
			{addOpen ? (
				<AddStockItemRow vehicleId={vehicleId} existingIds={existingIds} onDone={() => setAddOpen(false)} />
			) : (
				<div className="px-5 py-3 border-t border-border">
					<button
						onClick={() => setAddOpen(true)}
						className="w-full border border-dashed border-border rounded-md py-2 text-xs text-text-muted hover:text-text-secondary hover:border-border-strong transition-colors"
					>
						+ Search inventory to add item…
					</button>
				</div>
			)}
			{adjustOpen && (
				<AdjustStockModal
					vehicleId={vehicleId}
					stockItems={sorted}
					onClose={() => setAdjustOpen(false)}
				/>
			)}
		</div>
	);
}

function AlertCard({ request, onAcknowledge, onDismiss }: {
	request: RestockRequest;
	onAcknowledge: (id: string) => void;
	onDismiss: (id: string) => void;
}) {
	const age = (() => {
		const ms = Date.now() - new Date(request.created_at).getTime();
		const hours = Math.floor(ms / 3_600_000);
		if (hours < 1) return "just now";
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	})();

	const isPending = request.status === "pending";
	const isAcknowledged = request.status === "acknowledged";
	const isResolved = request.status === "resolved" || request.status === "dismissed";

	return (
		<div className={`bg-surface rounded-lg border px-4 py-3 ${isResolved ? "border-border opacity-60" : isPending ? "border-border" : "border-primary/30"}`}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 mb-0.5">
						<span className="text-sm font-semibold text-text-primary truncate">
							{request.stock_item.inventory_item.name}
						</span>
						<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${
							isPending ? "bg-warning/20 text-warning-text" :
							isAcknowledged ? "bg-primary/15 text-primary" :
							"bg-surface-raised text-text-muted"
						}`}>
							{isPending ? "Pending" : isAcknowledged ? "Acknowledged" : request.status === "dismissed" ? "Dismissed" : "Resolved"}
						</span>
					</div>
					<div className="text-xs text-text-muted">
						{request.technician?.name ?? "Unknown tech"} · {age}
						{request.qty_requested !== null && ` · requested ${Number(request.qty_requested)}`}
					</div>
					<div className="text-xs text-text-muted mt-0.5">
						On hand: <span className={`font-semibold ${Number(request.stock_item.qty_on_hand) === 0 ? "text-error-text" : "text-text-primary"}`}>
							{Number(request.stock_item.qty_on_hand)}
						</span>
					</div>
					{request.note && (
						<div className="text-xs text-text-muted italic mt-1">"{request.note}"</div>
					)}
					{isResolved && request.resolved_note && (
						<div className="text-xs text-success mt-1">{request.resolved_note}</div>
					)}
					{isAcknowledged && request.acknowledged_at && (
						<div className="text-xs text-primary mt-1">
							Acknowledged {new Date(request.acknowledged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
						</div>
					)}
				</div>
				{!isResolved && (
					<div className="flex items-center gap-2 flex-shrink-0">
						{isPending && (
							<button
								onClick={() => onAcknowledge(request.id)}
								className="px-3 py-1.5 text-xs font-semibold bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-md transition-colors"
							>
								Acknowledge
							</button>
						)}
						<button
							onClick={() => onDismiss(request.id)}
							className="px-3 py-1.5 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised transition-colors"
						>
							Dismiss
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

function AlertsTab({ vehicleId }: { vehicleId: string }) {
	const [showResolved, setShowResolved] = useState(false);
	const { data: allRequests = [], isLoading } = useRestockRequestsQuery(undefined, vehicleId);
	const acknowledgeMutation = useAcknowledgeRestockRequestMutation();
	const dismissMutation = useDismissRestockRequestMutation();

	if (isLoading) return <div className="flex justify-center py-16"><LoadSvg className="w-8 h-8" /></div>;

	const active = allRequests.filter((r) => r.status === "pending" || r.status === "acknowledged");
	const resolved = allRequests.filter((r) => r.status === "resolved" || r.status === "dismissed");
	const displayed = showResolved ? [...active, ...resolved] : active;

	return (
		<div>
			<div className="px-5 pt-4 pb-2 flex items-center justify-between">
				<span className="text-xs text-text-muted">
					{active.length === 0 ? "No open requests" : `${active.length} open request${active.length !== 1 ? "s" : ""}`}
				</span>
				{resolved.length > 0 && (
					<button
						onClick={() => setShowResolved((v) => !v)}
						className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border text-xs font-medium text-text-muted hover:text-text-secondary hover:bg-surface-raised hover:border-border-hover transition-colors"
					>
						{showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}
					</button>
				)}
			</div>
			{displayed.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-12 text-text-muted">
					<p className="text-sm font-medium">No restock requests</p>
					<p className="text-xs mt-1">Restock requests from technicians on this vehicle appear here</p>
				</div>
			) : (
				<div className="px-5 pb-4 space-y-3">
					{displayed.map((r) => (
						<AlertCard
							key={r.id}
							request={r}
							onAcknowledge={(id) => acknowledgeMutation.mutate(id)}
							onDismiss={(id) => dismissMutation.mutate(id)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export default function VehicleStockPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const initialTab = searchParams.get("tab");
	const [activeTab, setActiveTab] = useState<Tab>(
		initialTab === "restock" || initialTab === "alerts" || initialTab === "maintenance" || initialTab === "activity" ? initialTab : "stock"
	);
	const [isEditOpen, setIsEditOpen] = useState(false);
	const [fillOpen, setFillOpen] = useState(false);

	const { data: org } = useOrgSettings();
	const { data: vehicles } = useVehiclesQuery();
	const { data: stockItems = [], isLoading: stockLoading } = useVehicleStockQuery(id ?? "");
	const { data: alertRequests = [] } = useRestockRequestsQuery(undefined, id ?? "");
	const pendingAlertCount = alertRequests.filter((r) => r.status === "pending" || r.status === "acknowledged").length;

	if (!id) return null;
	const vehicleId = id;

	const vehicle = vehicles?.find((v) => v.id === vehicleId);
	const activeVehicles = vehicles?.filter((v) => v.status === "active") ?? [];

	const techNames = vehicle?.current_technicians?.map((t) => t.name).join(", ") ?? "";
	const vehicleSubtitle = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ")
		+ (vehicle?.license_plate ? ` · ${vehicle.license_plate}` : "")
		+ (techNames ? ` · ${techNames}` : "");

	const outCount = stockItems.filter((i) => getStockHealth(i) === "out").length;
	const lowCount = stockItems.filter((i) => getStockHealth(i) === "low").length;
	const hasAnyOut = outCount > 0;
	const hasAnyLow = !hasAnyOut && lowCount > 0;

	return (
		<div className="flex flex-col h-full text-text-primary">
			<UntrackedStockNotice module="vehicle_stock" className="mx-5 mt-4" />
			{/* Vehicle header */}
			<div className="px-5 pt-4 border-b border-border">
				<div className="flex items-start justify-between pb-3">
					<div className="flex items-center gap-3">
						<VehicleIcon hasOut={hasAnyOut} hasLow={hasAnyLow} />
						<div>
							<div className="flex items-center gap-2">
								<span className="text-lg font-bold text-text-primary">{vehicle?.name ?? "Vehicle"}</span>
								{vehicle?.status === "active" && (
									<span className="text-[10px] font-bold bg-success/15 text-success px-2 py-0.5 rounded">ACTIVE</span>
								)}
								{outCount > 0 && (
									<span className="text-[10px] font-bold bg-error/15 text-error-text px-2 py-0.5 rounded">
										{outCount} OUT
									</span>
								)}
								{lowCount > 0 && (
									<span className="text-[10px] font-bold bg-warning/15 text-warning-text px-2 py-0.5 rounded">
										{lowCount} LOW
									</span>
								)}
							</div>
							<div className="text-xs text-text-muted mt-1">{vehicleSubtitle}</div>
						</div>
					</div>
					<div className="flex items-center gap-2">
						{activeVehicles.length > 1 && (
							<select
								aria-label="Switch vehicle"
								value={vehicleId}
								onChange={(e) => navigate(`/dispatch/vehicles/${e.target.value}/stock`)}
								className="text-xs bg-surface border border-border rounded-md px-2 py-1.5 text-text-secondary outline-none focus:border-primary cursor-pointer"
							>
								{activeVehicles.map((v) => (
									<option key={v.id} value={v.id}>{v.name}</option>
								))}
							</select>
						)}
						<button
							onClick={() => setIsEditOpen(true)}
							className="px-3 py-1.5 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors"
						>
							Edit Vehicle
						</button>
						<button
							onClick={() => setFillOpen(true)}
							className="px-3 py-1.5 text-xs font-semibold bg-primary hover:bg-primary-hover text-on-primary rounded-md transition-colors"
						>
							↑ Fill to Standard
						</button>
					</div>
				</div>
				{/* Tabs */}
				<div className="flex gap-0 -mb-px">
					{vehicleStockTabOrder(org?.restock_mode).map((t) => (
						<button
							key={t}
							onClick={() => setActiveTab(t)}
							className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
								activeTab === t
									? "border-primary text-primary"
									: "border-transparent text-text-muted hover:text-text-secondary"
							}`}
						>
							{t === "stock" && "Stock"}
							{t === "restock" && "Warehouse Restock"}
							{t === "alerts" && (
								<>
									Requests
									{pendingAlertCount > 0 && (
										<span className="bg-warning/20 text-warning-text text-[10px] font-bold px-1.5 py-0.5 rounded-full">
											{pendingAlertCount}
										</span>
									)}
								</>
							)}
							{t === "maintenance" && "Maintenance"}
							{t === "activity" && "Activity"}
						</button>
					))}
				</div>
			</div>

			{/* Tab content */}
			<div className="flex-1 overflow-auto min-h-0">
				{activeTab === "stock"   && <StockTab vehicleId={vehicleId} stockItems={stockItems} isLoading={stockLoading} />}
				{activeTab === "restock" && <RestockWorkflow vehicleId={vehicleId} stockItems={stockItems} />}
				{activeTab === "alerts"  && <AlertsTab vehicleId={vehicleId} />}
				{activeTab === "maintenance" && <MaintenanceTab vehicleId={vehicleId} />}
				{/* Stock History lives here, not under the Stock table: it is a
				    ledger of what happened to the stock, the same kind of record as
				    the change log, while the Stock tab is the live state to act on. */}
				{activeTab === "activity" && (
					<div className="p-5 space-y-4">
						<Card
							title="Stock History"
							flush
							headerAction={
								<span className={HEADER_META}>Every movement on and off this vehicle</span>
							}
						>
							<StockHistorySection vehicleId={vehicleId} stockItems={stockItems} density="desk" />
						</Card>
						<ChangeHistory scope={{ kind: "entity", type: "vehicle", id: vehicleId }} />
					</div>
				)}
			</div>

			{vehicle && (
				<EditVehicle
					isOpen={isEditOpen}
					onClose={() => setIsEditOpen(false)}
					vehicle={vehicle}
				/>
			)}

			{fillOpen && (
				<>
					<div className="fixed inset-0 z-40 bg-overlay" onClick={() => setFillOpen(false)} />
					<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
						<div className="bg-base border border-border rounded-xl w-full max-w-lg max-h-[80vh] overflow-auto">
							<div className="px-4 pt-4 pb-1 text-sm font-semibold text-text-primary border-b border-border">Fill to Standard</div>
							<FillToStandardPreview vehicleId={vehicleId} onClose={() => setFillOpen(false)} />
						</div>
					</div>
				</>
			)}
		</div>
	);
}
