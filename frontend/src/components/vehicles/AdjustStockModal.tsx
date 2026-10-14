import { useMemo, useState } from "react";
import { X, Receipt } from "lucide-react";
import { Link } from "react-router-dom";
import { useDialogA11y } from "../../hooks/useDialogA11y";
import { usePermission } from "../../hooks/usePermission";
import { useAdjustStockMutation } from "../../hooks/useVehicleStock";
import type {
	VehicleStockItem,
	VehicleAdjustmentType,
	AdjustStockInput,
} from "../../types/vehicles";
import { ADJUSTMENT_TYPE_LABELS } from "../../types/vehicles";
import { useAuthStore } from "../../auth/authStore";
import ExistingUnitPicker from "./ExistingUnitPicker";
import ExistingBatchPicker, { type BatchPickDirection } from "./ExistingBatchPicker";
import type { SerialUnitStatus } from "../../types/tracking";
import { unitLabel } from "../../lib/units";

const ADJUST_TYPE_PERMS: Record<VehicleAdjustmentType, string> = {
	field_loss: "adjust_field_loss",
	transfer: "adjust_transfer",
	audit: "adjust_audit",
	warehouse_exchange: "adjust_warehouse_exchange",
};

const TYPE_META: Record<
	VehicleAdjustmentType,
	{ label?: string; description: string; warehouseEffect: string | null; note?: string }
> = {
	warehouse_exchange: {
		label: "Return to Warehouse",
		description:
			"Return surplus parts to the warehouse — vehicle qty goes down, warehouse qty goes up",
		warehouseEffect: "Warehouse +",
	},
	field_loss: {
		description:
			"Parts used on jobs, damaged, or lost — permanently out of org inventory",
		warehouseEffect: null,
	},
	transfer: {
		description: "Receive parts from another vehicle — org total unchanged",
		warehouseEffect: null,
		note: "Adjust the source vehicle separately",
	},
	audit: {
		description: "Override count to match physical reality — no accounting impact",
		warehouseEffect: null,
	},
};

function TypeStep({
	selected,
	onSelect,
	onNext,
	onClose,
	availableTypes,
	vehicleId,
}: {
	selected: VehicleAdjustmentType | null;
	onSelect: (t: VehicleAdjustmentType) => void;
	onNext: () => void;
	onClose: () => void;
	availableTypes: VehicleAdjustmentType[];
	vehicleId: string;
}) {
	return (
		<>
			<div className="px-5 py-4 space-y-2">
				{availableTypes.length === 0 ? (
					<div className="py-8 text-center">
						<p className="text-sm text-text-muted">
							No adjustment types available.
						</p>
						<p className="text-xs text-text-faint mt-1">
							Contact your dispatcher to enable adjustment
							permissions.
						</p>
					</div>
				) : (
					<>
						<p className="text-xs text-text-secondary mb-3">
							Select the type of stock adjustment.
						</p>
						{availableTypes.map((type) => {
							const meta = TYPE_META[type];
							const isSelected = selected === type;
							return (
								<button
									key={type}
									onClick={() =>
										onSelect(type)
									}
									className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
										isSelected
											? "border-primary bg-primary/10"
											: "border-border bg-surface hover:bg-surface-raised"
									}`}
								>
									<div className="flex items-center justify-between gap-3">
										<span className="text-sm font-semibold text-text-primary">
											{meta.label ??
												ADJUSTMENT_TYPE_LABELS[
													type
												]}
										</span>
										{meta.warehouseEffect && (
											<span className="text-xs font-semibold px-2 py-0.5 rounded border flex-shrink-0 text-primary bg-primary/10 border-primary/30">
												{
													meta.warehouseEffect
												}
											</span>
										)}
									</div>
									<p className="text-xs text-text-secondary mt-1">
										{meta.description}
									</p>
									{meta.note && (
										<p className="text-[10px] text-text-muted mt-1 italic">
											{meta.note}
										</p>
									)}
								</button>
							);
						})}
					</>
				)}
				<BuyFromSupplierDoorway vehicleId={vehicleId} />
			</div>
			<StepFooter
				onBack={onClose}
				backLabel="Cancel"
				onNext={onNext}
				nextLabel="Next →"
				nextDisabled={!selected}
			/>
		</>
	);
}

/**
 * Buying externally is not a stock adjustment: it spends money, so it needs a
 * grant, a limit, a receipt and a dispatcher's yes — this tile hands off to
 * that flow instead of adjusting stock directly. The tile stays because the
 * muscle memory does.
 */
function BuyFromSupplierDoorway({ vehicleId }: { vehicleId?: string | null }) {
	const canBuy = usePermission("request_field_purchase");
	if (!canBuy) return null;
	return (
		<Link
			// The truck rides along, so a part bought to restock it defaults back
			// onto it instead of into the warehouse.
			to={`/technician/purchases${vehicleId ? `?vehicleId=${vehicleId}` : ""}`}
			className="block w-full text-left px-4 py-3 rounded-lg border border-dashed border-border bg-surface hover:bg-surface-raised transition-colors"
		>
			<span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
				<Receipt size={14} className="text-text-muted" />
				Record a field purchase
			</span>
			<p className="text-xs text-text-secondary mt-1">
				Bought a part at a store or supply house. Photograph the receipt to get
				reimbursed.
			</p>
		</Link>
	);
}

function QuantitiesStep({
	type,
	stockItems,
	quantities,
	note,
	onQtyChange,
	onNoteChange,
	onBack,
	onNext,
}: {
	type: VehicleAdjustmentType;
	stockItems: VehicleStockItem[];
	quantities: Record<string, number>;
	note: string;
	onQtyChange: (id: string, qty: number) => void;
	onNoteChange: (v: string) => void;
	onBack: () => void;
	onNext: () => void;
}) {
	const [clampedId, setClampedId] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const isDecreaseOnly = isDecreaseOnlyType(type);
	const isReturn = type === "warehouse_exchange";
	const hasChanges = isDecreaseOnly
		? stockItems.some((i) => quantities[i.id] < Number(i.qty_on_hand))
		: stockItems.some((i) => quantities[i.id] !== Number(i.qty_on_hand));

	// Filtering hides rows, never edits them: a quantity typed and then filtered
	// out is still counted by `hasChanges` and still submitted.
	const shown = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return stockItems;
		return stockItems.filter((i) => i.inventory_item.name.toLowerCase().includes(q));
	}, [stockItems, filter]);

	return (
		<>
			<div className="px-5 py-4">
				<p className="text-xs text-text-secondary mb-3">
					{isReturn
						? "Set the qty to return to the warehouse. Only items with a lower qty will be recorded."
						: type === "field_loss"
							? "Set the new qty after loss. Only items with a lower qty will be recorded."
							: "Edit quantities below. Only items with changed quantities will be recorded."}
				</p>
				{isDecreaseOnly && (
					<div className="flex items-start gap-2 text-xs text-warning-text bg-warning/10 border border-warning/20 rounded-md px-3 py-2 mb-3">
						<span className="font-semibold flex-shrink-0">
							⚠
						</span>
						<span>
							{isReturn
								? "Quantities can only be decreased — this adjustment returns stock to the warehouse."
								: "Quantities can only be decreased — this adjustment records permanent stock loss."}
						</span>
					</div>
				)}
				<div className="mb-3">
					<NoteField value={note} onChange={onNoteChange} />
				</div>
				{stockItems.length > 8 && (
					<input
						type="text"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter items…"
						className="w-full mb-2 text-sm bg-surface border border-border-input rounded-md px-3 py-2 text-text-primary placeholder:text-faint outline-none focus:border-primary"
					/>
				)}
				<div className="bg-surface rounded-lg border border-border overflow-hidden mb-3">
					<div className="grid grid-cols-[1fr_72px_80px] px-4 py-2 border-b border-border-subtle text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
						<span>Item</span>
						<span className="text-center">Current</span>
						<span className="text-center">New Qty</span>
					</div>
					{shown.length === 0 && (
						<div className="px-4 py-6 text-center text-xs text-text-muted">
							No items match that.
						</div>
					)}
					{shown.map((item) => {
						const current = Number(item.qty_on_hand);
						const newQty = quantities[item.id] ?? current;
						const changed = isDecreaseOnly
							? newQty < current
							: newQty !== current;
						const showClampWarning = clampedId === item.id;

						return (
							<div
								key={item.id}
								className={`grid grid-cols-[1fr_72px_80px] items-center px-4 py-2 border-b border-border-subtle last:border-0 ${changed ? "bg-primary/5" : ""}`}
							>
								<div className="min-w-0">
									<span className="text-sm text-text-primary">
										{
											item
												.inventory_item
												.name
										}
									</span>
									{showClampWarning && (
										<span className="block text-[10px] text-warning-text mt-0.5">
											Cannot
											exceed
											current qty
										</span>
									)}
								</div>
								<span className="text-center text-sm text-text-secondary">
									{current}
								</span>
								<div className="flex justify-center">
									<input
										type="number"
										min={0}
										value={newQty}
										onChange={(e) => {
											const raw = clampNumber(
												e.target.value,
												{
													min: 0,
													fallback: 0,
												}
											);
											if (
												isDecreaseOnly &&
												raw >
													current
											) {
												setClampedId(
													item.id
												);
												onQtyChange(
													item.id,
													current
												);
											} else {
												setClampedId(
													null
												);
												onQtyChange(
													item.id,
													raw
												);
											}
										}}
										onBlur={() =>
											setClampedId(
												null
											)
										}
										className={`w-16 text-center text-sm rounded border ${
											showClampWarning
												? "border-warning text-warning-text"
												: changed
													? "border-primary text-text-primary font-semibold"
													: "border-border-input text-text-secondary"
										} bg-base px-1 py-0.5 outline-none focus:border-primary`}
									/>
								</div>
							</div>
						);
					})}
				</div>
			</div>
			<StepFooter
				onBack={onBack}
				onNext={onNext}
				nextLabel="Review →"
				nextDisabled={!hasChanges}
			/>
		</>
	);
}

function ConfirmStep({
	type,
	stockItems,
	quantities,
	note,
	onBack,
	onConfirm,
	isPending,
	error,
}: {
	type: VehicleAdjustmentType;
	stockItems: VehicleStockItem[];
	quantities: Record<string, number>;
	note: string;
	onBack: () => void;
	onConfirm: () => void;
	isPending: boolean;
	error: string | null;
}) {
	const meta = TYPE_META[type];
	const isDecreaseOnly = isDecreaseOnlyType(type);
	const changedItems = stockItems.filter((i) => {
		const newQty = quantities[i.id] ?? Number(i.qty_on_hand);
		return isDecreaseOnly
			? newQty < Number(i.qty_on_hand)
			: newQty !== Number(i.qty_on_hand);
	});

	return (
		<>
			<div className="px-5 py-4">
				<p className="text-xs text-text-secondary mb-3">
					Review changes.{" "}
					{meta.warehouseEffect
						? "Warehouse quantities will be updated."
						: "No warehouse impact."}
				</p>
				<div className="bg-surface rounded-lg border border-border overflow-hidden mb-3">
					<div className="px-4 py-2 border-b border-border-subtle text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
						{meta.label ?? ADJUSTMENT_TYPE_LABELS[type]} —{" "}
						{changedItems.length} item
						{changedItems.length !== 1 ? "s" : ""}
					</div>
					{changedItems.map((item) => {
						const current = Number(item.qty_on_hand);
						const newQty = quantities[item.id];
						const delta = newQty - current;
						return (
							<div
								key={item.id}
								className="flex items-center justify-between px-4 py-2 border-b border-border-subtle last:border-0"
							>
								<span className="text-sm text-text-primary">
									{item.inventory_item.name}
								</span>
								<div className="flex items-center gap-3">
									<span className="text-sm text-text-secondary">
										{current} → {newQty}
									</span>
									<span
										className={`text-sm font-semibold ${delta > 0 ? "text-success" : "text-error-text"}`}
									>
										{delta > 0
											? "+"
											: ""}
										{delta}
									</span>
								</div>
							</div>
						);
					})}
				</div>
				{note && (
					<p className="text-xs text-text-secondary italic mb-3">
						Note: {note}
					</p>
				)}
				{error && (
					<p className="text-xs text-error-text bg-error/10 border border-error/30 rounded-md px-3 py-2">
						{error}
					</p>
				)}
			</div>
			<StepFooter
				onBack={onBack}
				onNext={onConfirm}
				nextLabel="Apply Adjustment"
				isPending={isPending}
			/>
		</>
	);
}

const isDecreaseOnlyType = (t: VehicleAdjustmentType): boolean =>
	t === "warehouse_exchange" || t === "field_loss";

// Parses a number-input's raw string, floors it when step is a whole number
// (qty fields), falls back when the parse is NaN, then clamps to [min, max].
// Reproduces each call site's prior hand-rolled parse+clamp exactly.
function clampNumber(
	raw: string,
	opts: { min?: number; max?: number; step?: number; fallback: number }
): number {
	const { min, max, step, fallback } = opts;
	let n = parseFloat(raw);
	if (step === 1) n = Math.floor(n);
	if (Number.isNaN(n)) n = fallback;
	if (min !== undefined) n = Math.max(min, n);
	if (max !== undefined) n = Math.min(max, n);
	return n;
}

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	return (
		<div>
			<label className="block text-xs text-text-secondary mb-1">
				Note (optional)
			</label>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				rows={2}
				maxLength={500}
				placeholder="Reason for adjustment…"
				className="w-full text-sm bg-surface border border-border-input rounded-md px-3 py-2 text-text-primary placeholder:text-faint outline-none focus:border-primary resize-none"
			/>
		</div>
	);
}

function StepFooter({
	onBack,
	backLabel = "← Back",
	onNext,
	nextLabel,
	nextDisabled,
	isPending,
}: {
	onBack: () => void;
	backLabel?: string;
	onNext: () => void;
	nextLabel: string;
	nextDisabled?: boolean;
	isPending?: boolean;
}) {
	return (
		// Sticky, not trailing: every step renders inside the modal's scrolling
		// body, so a long list would otherwise push "Review →" below the fold with it.
		<div className="sticky bottom-0 z-10 flex items-center justify-between px-5 py-3 border-t border-border bg-base">
			<button
				onClick={onBack}
				disabled={isPending}
				className="px-3 py-1.5 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised transition-colors disabled:opacity-50"
			>
				{backLabel}
			</button>
			<button
				onClick={onNext}
				disabled={isPending || nextDisabled}
				className="px-4 py-2 text-sm font-semibold bg-primary hover:enabled:bg-primary-hover text-on-primary rounded-md transition-colors disabled:opacity-50"
			>
				{isPending ? "Saving…" : nextLabel}
			</button>
		</div>
	);
}

// A resolved line that needs serial/batch capture before the adjustment can
// be submitted. `key` matches whatever the line will key its captured value
// on (stock_item_id for existing on-truck lines, inventory_item_id for
// supplier_purchase catalog lines — new_item lines are never tracked, since a
// freshly-created provisional item can't already be serialized/batch-tracked).
interface TrackingLineReq {
	key: string;
	inventoryItemId: string;
	name: string;
	qty: number; // abs(delta) — how many units/serials this line needs
	// The item's unit of measure, carried so the summary can say "3 ft" instead
	// of the hardcoded "3 units". A serialized item is almost always "each", so
	// this changes nothing there; it matters for a batch-tracked item measured
	// in ft or lb.
	unit: string;
	delta: number; // signed — direction drives which candidate pool applies
	isSerialized: boolean;
	isBatchTracked: boolean;
	// ExistingUnitPicker props, precomputed once from existingUnitFilterFor
	// below. Undefined for supplier_purchase lines, which use
	// SerialCaptureList instead and never render ExistingUnitPicker.
	statusFilter?: SerialUnitStatus;
	vehicleIdForPicker?: string;
}

// Existing-unit-picker filter for a non-supplier_purchase line, derived from
// how adjustStock (vehiclesController.ts) builds each movement's
// from_location_type per type/direction:
//  - delta < 0 (out of this vehicle): every type moves FROM this vehicle
//    (warehouse_exchange→"vehicle", field_loss→"vehicle", transfer/audit
//    (no target)→"vehicle") — candidates are units on_vehicle at this vehicle.
//  - delta > 0, warehouse_exchange (restock): FROM "warehouse" — candidates
//    are units in_warehouse (no vehicle scope; a global pool).
//  - delta > 0, audit/transfer (no target_vehicle_id wired by this modal):
//    FROM "adjustment" — inventoryTracking.ts's applySerialMovement skips the
//    from-status check entirely for external/adjustment sources, so the
//    backend imposes no location constraint here. No status filter applied;
//    every unit for the item is shown (documented judgment call — see report).
function existingUnitFilterFor(
	type: VehicleAdjustmentType,
	delta: number
): { statusFilter?: SerialUnitStatus; scopeToVehicle: boolean } {
	if (delta < 0) return { statusFilter: "on_vehicle", scopeToVehicle: true };
	if (type === "warehouse_exchange")
		return { statusFilter: "in_warehouse", scopeToVehicle: false };
	return { scopeToVehicle: false };
}

function existingBatchDirectionFor(type: VehicleAdjustmentType, delta: number): BatchPickDirection {
	if (delta < 0) return "vehicle_out";
	if (type === "warehouse_exchange") return "warehouse_in";
	return "unconstrained";
}

function TrackingStep({
	type,
	vehicleId,
	lines,
	serialValues,
	onSerialChange,
	batchPickValues,
	onBatchPickChange,
	onBack,
	onNext,
	canProceed,
}: {
	type: VehicleAdjustmentType;
	vehicleId: string;
	lines: TrackingLineReq[];
	serialValues: Record<string, string[]>;
	onSerialChange: (key: string, value: string[]) => void;
	batchPickValues: Record<string, string | null>;
	onBatchPickChange: (key: string, value: string | null) => void;
	onBack: () => void;
	onNext: () => void;
	canProceed: boolean;
}) {
	return (
		<>
			<div className="px-5 py-4 space-y-3">
				<p className="text-xs text-text-secondary mb-1">
					Select which existing serialized units or lots this adjustment affects.
				</p>
				{lines.map((line) => (
					<div
						key={line.key}
						className="bg-surface rounded-lg border border-border p-3"
					>
						<div className="flex items-center justify-between mb-2">
							<span className="text-sm font-semibold text-text-primary">
								{line.name}
							</span>
							<span className="text-xs text-text-muted">
								{line.qty} {unitLabel(line.unit, line.qty)}
							</span>
						</div>

						{line.isSerialized && (
							<ExistingUnitPicker
								itemId={line.inventoryItemId}
								itemName={line.name}
								targetCount={line.qty}
								statusFilter={line.statusFilter}
								vehicleId={line.vehicleIdForPicker}
								value={serialValues[line.key] ?? []}
								onChange={(v) =>
									onSerialChange(line.key, v)
								}
								// Naming the units IS this step, so the list opens.
								// Restock rows collapse it instead — see the prop's
								// doc comment.
								defaultOpen
							/>
						)}

						{line.isBatchTracked && (
							<ExistingBatchPicker
								itemId={line.inventoryItemId}
								vehicleId={vehicleId}
								direction={existingBatchDirectionFor(
									type,
									line.delta
								)}
								value={
									batchPickValues[line.key] ??
									null
								}
								onChange={(v) =>
									onBatchPickChange(
										line.key,
										v
									)
								}
							/>
						)}
					</div>
				))}
			</div>
			<StepFooter
				onBack={onBack}
				onNext={onNext}
				nextLabel="Review →"
				nextDisabled={!canProceed}
			/>
		</>
	);
}

const STEP_ORDER = ["type", "quantities", "tracking", "confirm"] as const;
type ModalStep = (typeof STEP_ORDER)[number];

const STEP_TITLES: Record<ModalStep, string> = {
	type: "Adjust Stock",
	quantities: "Edit Quantities",
	tracking: "Serial / Batch Tracking",
	confirm: "Confirm Adjustment",
};

const STEP_LABELS: Record<ModalStep, string> = {
	type: "Type",
	quantities: "Quantities",
	tracking: "Tracking",
	confirm: "Confirm",
};

export default function AdjustStockModal({
	vehicleId,
	stockItems,
	onClose,
	onSuccess,
	onError,
	initialType,
	initialFocusItemId,
	initialSerialUnitId,
}: {
	vehicleId: string;
	stockItems: VehicleStockItem[];
	onClose: () => void;
	// Optional — fired right after a successful submit (before onClose), so a
	// caller can toast without this shared modal needing to know about any
	// particular toast system. Dispatch's VehicleStockPage doesn't pass these,
	// so its behavior (no toast) is unchanged.
	onSuccess?: () => void;
	onError?: (message: string) => void;
	initialType?: VehicleAdjustmentType;
	initialFocusItemId?: string;
	// serial_unit id to preselect in ExistingUnitPicker. Only meaningful
	// alongside initialFocusItemId, whose stock_item_id is the serialValues key
	// for non-supplier_purchase lines. Lets SerialSheet deep-link a specific
	// unit into field_loss so the tech doesn't re-pick what they just scanned.
	initialSerialUnitId?: string;
}) {
	const [modalStep, setModalStep] = useState<ModalStep>(initialType ? "quantities" : "type");
	const [selectedType, setSelectedType] = useState<VehicleAdjustmentType | null>(
		initialType ?? null
	);
	const [note, setNote] = useState("");
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [quantities, setQuantities] = useState<Record<string, number>>(() =>
		Object.fromEntries(
			stockItems.map((i) => [
				i.id,
				i.id === initialFocusItemId && initialType === "field_loss"
					? Math.max(0, Number(i.qty_on_hand) - 1)
					: Number(i.qty_on_hand),
			])
		)
	);
	// Tracking-step capture state, keyed by TrackingLineReq.key, which is the
	// stock_item_id of the line being adjusted.
	const [serialValues, setSerialValues] = useState<Record<string, string[]>>(() =>
		initialSerialUnitId && initialFocusItemId
			? { [initialFocusItemId]: [initialSerialUnitId] }
			: {}
	);
	const [batchPickValues, setBatchPickValues] = useState<Record<string, string | null>>({});

	const adjustMutation = useAdjustStockMutation(vehicleId);
	const { user } = useAuthStore();

	const availableTypes = useMemo<VehicleAdjustmentType[]>(() => {
		const allTypes = Object.keys(TYPE_META) as VehicleAdjustmentType[];
		if (!user || user.role !== "technician") return allTypes;
		return allTypes.filter((t) => user.permissions.includes(ADJUST_TYPE_PERMS[t]));
	}, [user]);
	const handleQtyChange = (id: string, qty: number) => {
		setQuantities((prev) => ({ ...prev, [id]: qty }));
	};

	// Lines that need serial/batch capture before this adjustment can submit:
	// the on-truck lines actually changing, mirroring handleConfirm's own
	// changedLines derivation below so the two never disagree.
	const trackingLines = useMemo<TrackingLineReq[]>(() => {
		if (!selectedType) return [];

		const isDecreaseOnly = isDecreaseOnlyType(selectedType);
		const lines: TrackingLineReq[] = [];
		for (const item of stockItems) {
			const current = Number(item.qty_on_hand);
			const newQty = quantities[item.id] ?? current;
			const changed = isDecreaseOnly ? newQty < current : newQty !== current;
			if (!changed) continue;
			const inv = item.inventory_item;
			if (!inv.is_serialized && !inv.is_batch_tracked) continue;
			const delta = newQty - current;
			const { statusFilter, scopeToVehicle } = existingUnitFilterFor(selectedType, delta);
			lines.push({
				key: item.id,
				inventoryItemId: inv.id,
				name: inv.name,
				qty: Math.abs(delta),
				unit: inv.unit,
				delta,
				isSerialized: inv.is_serialized,
				isBatchTracked: inv.is_batch_tracked,
				statusFilter,
				vehicleIdForPicker: scopeToVehicle ? vehicleId : undefined,
			});
		}
		return lines;
	}, [selectedType, stockItems, quantities, vehicleId]);

	const needsTrackingStep = trackingLines.length > 0;
	const visibleSteps = useMemo(
		() => STEP_ORDER.filter((s) => s !== "tracking" || needsTrackingStep),
		[needsTrackingStep]
	);

	const trackingSatisfied = useMemo(() => {
		return trackingLines.every((line) => {
			const serialOk =
				!line.isSerialized ||
				(serialValues[line.key] ?? []).length === line.qty;
			const batchOk =
				!line.isBatchTracked ||
				true; // existing-batch pick is always optional (FIFO fallback)
			return serialOk && batchOk;
		});
	}, [trackingLines, serialValues]);

	const handleConfirm = async () => {
		if (!selectedType) return;
		setSubmitError(null);

		try {
			const isDecreaseOnly = isDecreaseOnlyType(selectedType);
			const changedLines = stockItems
				.filter((i) =>
					isDecreaseOnly
						? quantities[i.id] < Number(i.qty_on_hand)
						: quantities[i.id] !== Number(i.qty_on_hand)
				)
				.map((i) => {
					const delta = quantities[i.id] - Number(i.qty_on_hand);
					const inv = i.inventory_item;
					const line: AdjustStockInput["lines"][number] = {
						stock_item_id: i.id,
						qty_after: quantities[i.id],
					};
					if (inv.is_serialized) {
						line.serial_unit_ids = serialValues[i.id] ?? [];
					} else if (inv.is_batch_tracked) {
						const pick = batchPickValues[i.id];
						if (pick)
							line.batch_picks = [
								{
									batch_id: pick,
									qty: Math.abs(delta),
								},
							];
					}
					return line;
				});

			await adjustMutation.mutateAsync({
				type: selectedType,
				note: note.trim() || null,
				lines: changedLines,
			});
			onSuccess?.();
			onClose();
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : "Failed to adjust stock";
			setSubmitError(message);
			onError?.(message);
		}
	};

	const stepIndex = visibleSteps.indexOf(modalStep);
	const dialogA11y = useDialogA11y<HTMLDivElement>(onClose);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
			<div
				{...dialogA11y}
				aria-label={STEP_TITLES[modalStep]}
				// overflow-hidden, not just rounded-xl: the step footers are sticky with an
				// opaque bg-base, so without clipping they paint square over the bottom corners.
				className="bg-canvas border border-border rounded-xl overflow-hidden shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
			>
				{/* Header */}
				<div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
					<span className="text-sm font-bold text-text-primary">
						{STEP_TITLES[modalStep]}
					</span>
					<button
						onClick={onClose}
						aria-label="Close"
						className="text-text-faint hover:text-text-secondary transition-colors"
					>
						<X size={16} />
					</button>
				</div>

				{/* Step indicator */}
				<div className="flex items-center px-5 py-2 border-b border-border/30 bg-base/40 flex-shrink-0">
					{visibleSteps.map((s, i) => (
						<div key={s} className="flex items-center gap-1">
							{i > 0 && (
								<div
									className={`w-6 h-px mx-1 ${stepIndex >= i ? "bg-primary" : "bg-border"}`}
								/>
							)}
							<div
								className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
									stepIndex === i
										? "bg-primary text-on-primary"
										: stepIndex > i
											? "bg-success text-on-primary"
											: "bg-surface border border-border text-text-faint"
								}`}
							>
								{stepIndex > i ? "✓" : i + 1}
							</div>
							<span
								className={`text-[10px] font-medium whitespace-nowrap ${stepIndex === i ? "text-text-primary" : "text-text-muted"}`}
							>
								{STEP_LABELS[s]}
							</span>
						</div>
					))}
				</div>

				{/* Scrollable body */}
				<div className="flex-1 overflow-auto rounded-xl min-h-0">
					{modalStep === "type" && (
						<TypeStep
							selected={selectedType}
							onSelect={setSelectedType}
							onNext={() => setModalStep("quantities")}
							onClose={onClose}
							availableTypes={availableTypes}
							vehicleId={vehicleId}
						/>
					)}
					{modalStep === "quantities" && selectedType && (
							<QuantitiesStep
								type={selectedType}
								stockItems={stockItems}
								quantities={quantities}
								note={note}
								onQtyChange={handleQtyChange}
								onNoteChange={setNote}
								onBack={() => {
									setQuantities(
										Object.fromEntries(
											stockItems.map(
												(
													i
												) => [
													i.id,
													Number(
														i.qty_on_hand
													),
												]
											)
										)
									);
									setNote("");
									setModalStep("type");
								}}
								onNext={() =>
									setModalStep(
										needsTrackingStep
											? "tracking"
											: "confirm"
									)
								}
							/>
						)}
					{modalStep === "tracking" && selectedType && (
						<TrackingStep
							type={selectedType}
							vehicleId={vehicleId}
							lines={trackingLines}
							serialValues={serialValues}
							onSerialChange={(key, v) =>
								setSerialValues((prev) => ({
									...prev,
									[key]: v,
								}))
							}
							batchPickValues={batchPickValues}
							onBatchPickChange={(key, v) =>
								setBatchPickValues((prev) => ({
									...prev,
									[key]: v,
								}))
							}
							onBack={() => setModalStep("quantities")}
							onNext={() => setModalStep("confirm")}
							canProceed={trackingSatisfied}
						/>
					)}
					{modalStep === "confirm" && selectedType && (
						<ConfirmStep
							type={selectedType}
							stockItems={stockItems}
							quantities={quantities}
							note={note}
							onBack={() => {
								setSubmitError(null);
								setModalStep(
									needsTrackingStep
										? "tracking"
										: "quantities"
								);
							}}
							onConfirm={handleConfirm}
							isPending={adjustMutation.isPending}
							error={submitError}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
