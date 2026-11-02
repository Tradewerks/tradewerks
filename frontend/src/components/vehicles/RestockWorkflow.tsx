import { useState, useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import LoadSvg from "../../assets/icons/loading.svg?react";
import { formatter } from "../../util/util";
import { formatRestockDate } from "../../lib/stockUtils";
import SegmentedToggle from "../ui/SegmentedToggle";
import {
	useCompleteRestockMutation,
	useTomorrowRequirementsQuery,
	useVehicleUsageTodayQuery,
} from "../../hooks/useVehicleStock";
import ExistingUnitPicker from "./ExistingUnitPicker";
import ExistingBatchPicker from "./ExistingBatchPicker";
import RestockSummaryModal, { type RestockSummaryLine } from "./RestockSummaryModal";
import type { VehicleStockItem, VehicleRestockRecord } from "../../types/vehicles";

type SubTab = "restock" | "prepare";

interface RestockLine {
	stockItemId: string;
	item: VehicleStockItem;
	qtyToRestock: number;
	tomorrowNeed: number;
	// Optional "scan units loaded" capture (P8-2) — existing warehouse units/lot
	// being moved onto the vehicle for this line. Warn-don't-block: submitting
	// with these empty/short is always valid, the backend records the gap.
	serialUnitIds: string[];
	batchId: string | null;
}

type TrackingPatch = { serialUnitIds?: string[]; batchId?: string | null };

// ── CompleteStep ──────────────────────────────────────────────────────────────

function CompleteStep({ record, stockItems, onReset }: {
	record: VehicleRestockRecord;
	stockItems: VehicleStockItem[];
	/** Starts a fresh run. Lives here rather than beside the mode switch — after a
	 *  completed restock, "start another" is the next step, not a mode. */
	onReset: () => void;
}) {
	const hasShortfall = record.restock_lines.some((l) => l.qty_shortfall > 0);
	return (
		<div className="px-5 py-6">
			<div className="flex flex-col items-center text-center mb-6">
				<div className="w-12 h-12 rounded-full bg-success/15 border-2 border-success flex items-center justify-center text-xl mb-3">✓</div>
				<div className="text-base font-bold text-text-primary">{record.mode === "prepare" ? "Prep Complete" : "Restock Complete"}</div>
				<div className="text-xs text-text-muted mt-1">
					{formatRestockDate(record.completed_at)}
					{" · "}{record.completed_by?.name ?? record.completed_by_tech?.name ?? "—"}
				</div>
			</div>
			{record.restock_lines.length > 0 && (
				<div className="bg-surface rounded-lg border border-border overflow-hidden mb-4">
					<div className="px-4 py-2 border-b border-border-subtle text-[10px] font-semibold text-text-muted uppercase tracking-wider">Restocked</div>
					{record.restock_lines.map((line) => (
						<div key={line.id} className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border-subtle last:border-0">
							{(() => {
								const name =
									stockItems.find((s) => s.id === line.stock_item_id)?.inventory_item
										.name ?? line.stock_item_id;
								return (
									<span
										className="text-sm text-text-primary min-w-0 truncate"
										title={name}
									>
										{name}
									</span>
								);
							})()}
							<div className="flex items-center gap-3 shrink-0">
								<span className="text-sm font-semibold text-success">+{line.qty_restocked}</span>
								{line.qty_shortfall > 0 && <span className="text-xs text-warning-text">({line.qty_shortfall} short)</span>}
							</div>
						</div>
					))}
				</div>
			)}
			{record.restock_lines.length === 0 && (
				<p className="text-sm text-text-muted text-center mb-4">No items restocked — all were at or above standard.</p>
			)}
			{hasShortfall && (
				<p className="text-xs text-warning-text mb-4">Some items were short in the warehouse. Order more stock to fully restock next time.</p>
			)}
			<button
				onClick={onReset}
				className="w-full px-4 py-2.5 text-sm font-semibold bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
			>
				Start another restock
			</button>
		</div>
	);
}

// ── RestockContextPanel — implemented in Task 2 ───────────────────────────────────

function RestockContextPanel({ vehicleId, showHeader = false }: { vehicleId: string; showHeader?: boolean }) {
	const { data: groups = [], isLoading } = useVehicleUsageTodayQuery(vehicleId);
	if (isLoading) return <div className="flex justify-center py-16"><LoadSvg className="w-8 h-8" /></div>;

	const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);

	return (
		<div className="px-4 py-4">
			{showHeader && (
				<div className="flex items-center gap-2 mb-3">
					<span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Usage Since Last Restock</span>
					{totalItems > 0 && (
						<span className="text-[10px] font-bold bg-surface-raised border border-border text-text-muted px-1.5 py-0.5 rounded">{totalItems}</span>
					)}
				</div>
			)}
			{groups.length === 0 ? (
				<p className="text-sm text-text-muted">No usage since last restock — proceed to restock.</p>
			) : (
				<div className="space-y-3">
					{groups.map((group) => (
						<div key={group.visitId} className="bg-surface rounded-lg border border-border overflow-hidden">
							<div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between">
								<span className="text-sm font-semibold text-text-primary">{group.visitName}</span>
								{group.scheduledAt && (
									<span className="text-xs text-text-muted">
										{new Date(group.scheduledAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
									</span>
								)}
							</div>
							<div className="divide-y divide-border-subtle">
								{group.items.map((item) => (
									<div key={item.itemName} className="flex items-center justify-between gap-3 px-4 py-2">
										<span
											className="text-sm text-text-primary min-w-0 truncate"
											title={item.itemName}
										>
											{item.itemName}
										</span>
										<span className="text-sm font-semibold text-error-text shrink-0">−{item.qtyUsed}</span>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── PrepContextPanel — implemented in Task 2 ──────────────────────────────────

function PrepContextPanel({ vehicleId }: { vehicleId: string }) {
	const { data: visits = [], isLoading } = useTomorrowRequirementsQuery(vehicleId);
	if (isLoading) return <div className="flex justify-center py-16"><LoadSvg className="w-8 h-8" /></div>;

	return (
		<div className="px-4 py-4">
			<div className="flex items-center gap-2 mb-3">
				<span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Tomorrow's Visits</span>
				{visits.length > 0 && (
					<span className="text-[10px] font-bold bg-surface-raised border border-border text-text-muted px-1.5 py-0.5 rounded">{visits.length}</span>
				)}
			</div>
			{visits.length === 0 ? (
				<p className="text-sm text-text-muted">No visits scheduled for tomorrow.</p>
			) : (
				<div className="space-y-3">
					{visits.map((visit) => (
						<div key={visit.visitId} className="bg-surface rounded-lg border border-border overflow-hidden">
							<div className="px-4 py-2 border-b border-border-subtle">
								<div className="flex items-center justify-between">
									<span className="text-sm font-semibold text-text-primary">{visit.visitName}</span>
									{visit.scheduledAt && (
										<span className="text-xs text-text-muted">
											{new Date(visit.scheduledAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
										</span>
									)}
								</div>
								<span className="text-xs text-text-muted">{visit.clientName}</span>
							</div>
							<div className="divide-y divide-border-subtle">
								{visit.items.map((item) => {
									const isShort = item.qtyOnHand < item.qtyNeeded;
									const isEqual = item.qtyOnHand === item.qtyNeeded;
									return (
										<div key={item.inventoryItemId} className="flex items-center justify-between gap-3 px-4 py-2">
											<span
												className="text-sm text-text-primary min-w-0 truncate"
												title={item.itemName}
											>
												{item.itemName}
											</span>
											<div className="flex items-center gap-2 text-xs shrink-0">
												<span className="text-text-muted">Need <span className="text-text-primary font-semibold">{item.qtyNeeded}</span></span>
												<span className={`font-semibold ${isShort ? "text-error-text" : isEqual ? "text-warning-text" : "text-success"}`}>
													Have {item.qtyOnHand}
												</span>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── RestockPanel — implemented in Task 3 ──────────────────────────────────────

const RESTOCK_GRID = "grid-cols-[1fr_72px_72px_80px_80px]";
const PREP_GRID = "grid-cols-[1fr_64px_64px_72px_72px_80px]";

function RestockRow({ line, met, subTab, grid, mobile, vehicleId, onChange, onTrackingChange }: {
	line: RestockLine;
	/** This line is at or above its standard — nothing to add. Marked in green
	 *  rather than dimmed: half-opacity text is the first thing to disappear on a
	 *  phone screen in daylight, which is exactly where this UI is used. */
	met: boolean;
	subTab: SubTab;
	grid: string;
	mobile: boolean;
	vehicleId: string;
	onChange: (stockItemId: string, qty: number) => void;
	onTrackingChange: (stockItemId: string, patch: TrackingPatch) => void;
}) {
	const onHand = Number(line.item.qty_on_hand);
	const standard = line.item.qty_standard !== null ? Number(line.item.qty_standard) : null;
	const warehouse = Number(line.item.inventory_item.quantity);
	const overLimit = line.qtyToRestock > warehouse;
	const invItem = line.item.inventory_item;
	const showTracking = line.qtyToRestock > 0 && (invItem.is_serialized || invItem.is_batch_tracked);
	const [nameExpanded, setNameExpanded] = useState(false);
	const advisoryId = `restock-advisory-${line.stockItemId}`;
	// Tighter gutters on a phone: the row now sits inside a bordered table with its
	// own margin, so desktop's px-5 would eat the name column.
	const rowPad = mobile ? "px-3.5" : "px-5";
	const rowInset = mobile ? "mx-3.5" : "mx-5";
	return (
		// Row dividers sit one token below the section rules: 1px of `border`
		// separates items, 2px of `border-strong` separates the section blocks. Both
		// at the same weight and the table read as one undifferentiated stack.
		<div className="border-b border-border last:border-b-0">
			{/* The grid holds the numbers, and only the numbers — every column is one
			    line tall, so the figures and the input stay on one optical line.
			    Anything prose-shaped (the over-limit advisory, the tracking pickers)
			    goes in the full-width band below, where it can wrap instead of being
			    clipped by the section's rounded overflow-hidden shell. */}
			<div className={`grid ${grid} items-center ${rowPad} py-2.5 gap-x-1`}>
				{/* Tap to see the whole name. Part names run to 255 characters, and
				    an unclamped one pushed this row's figures out of alignment with
				    every other row. */}
				<button
					type="button"
					onClick={() => setNameExpanded((v) => !v)}
					aria-expanded={nameExpanded}
					title={invItem.name}
					className={`min-w-0 text-left text-sm text-text-primary ${
						nameExpanded ? "break-words" : "truncate"
					}`}
				>
					{invItem.name}
				</button>
					{/* A met line's on-hand figure is the reason it's met, so it carries
				    the green — same signal as the group's header and rule. */}
				<span
					className={`text-center text-sm tabular-nums ${
						met ? "text-success-text font-medium" : "text-text-secondary"
					}`}
				>
					{onHand}
				</span>
				{!mobile && (
					<span className="text-center text-sm tabular-nums text-text-secondary">{standard ?? "—"}</span>
				)}
				{subTab === "prepare" && (
					<span className={`text-center text-sm tabular-nums font-medium ${line.tomorrowNeed > onHand ? "text-warning-text" : "text-text-secondary"}`}>
						{line.tomorrowNeed > 0 ? line.tomorrowNeed : "—"}
					</span>
				)}
				{/* Compact past five digits so a large warehouse count can't widen a
				    56px column; the exact figure stays in the title. */}
				<span
					title={`${warehouse} in warehouse`}
					className={`text-center text-sm tabular-nums font-medium ${
						warehouse === 0 ? "text-error-text font-semibold" : overLimit ? "text-warning-text" : "text-text-secondary"
					}`}
				>
					{warehouse >= 100_000 ? formatter.format(warehouse) : warehouse}
				</span>
				<div className="flex justify-center">
					<input
						type="number"
						min={0}
						value={line.qtyToRestock}
						onChange={(e) => onChange(line.stockItemId, Math.max(0, Number(e.target.value)))}
						aria-invalid={overLimit}
						aria-describedby={overLimit ? advisoryId : undefined}
						aria-label={`Quantity to add for ${invItem.name}`}
						// Fixed height and no siblings in this cell: the input used to
						// sit above an inline warning, so the moment a line went over
						// the limit it slid off the row's centre line.
						className={`w-16 h-8 text-center text-sm rounded border ${
							overLimit ? "border-warning text-warning-text" : "border-border-input text-text-primary"
						} bg-base px-1 outline-none focus:border-primary`}
					/>
				</div>
			</div>

			{overLimit && (
				<div
					id={advisoryId}
					role="status"
					className={`${rowInset} mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5`}
				>
					<span className="text-[11px] text-warning-text">
						Only {warehouse} in warehouse — this line will be capped at {warehouse}.
					</span>
					{/* Fills the input rather than enforcing anything: submitting an
					    over-limit line stays legal and the backend records the
					    shortfall. This is the shortcut for when it wasn't intended. */}
					<button
						type="button"
						onClick={() => onChange(line.stockItemId, warehouse)}
						className="text-[11px] font-semibold text-warning-text underline decoration-warning/50 hover:decoration-warning"
					>
						Use {warehouse}
					</button>
				</div>
			)}

			{showTracking && (
				<div className={`${rowPad} pb-3`}>
					{invItem.is_serialized ? (
						<>
							<ExistingUnitPicker
								itemId={invItem.id}
								itemName={invItem.name}
								statusFilter="in_warehouse"
								targetCount={line.qtyToRestock}
								value={line.serialUnitIds}
								onChange={(ids) => onTrackingChange(line.stockItemId, { serialUnitIds: ids })}
							/>
							{overLimit ? (
								<p className="mt-1.5 text-xs text-warning-text">
									Warehouse stock is short for this line — the restock will be capped, so scanned units won't be recorded as tracked.
								</p>
							) : line.serialUnitIds.length < line.qtyToRestock ? (
								<p className="mt-1.5 text-xs text-warning-text">
									{line.serialUnitIds.length} of {line.qtyToRestock} units scanned — scan all {line.qtyToRestock} to record this line as tracked, or submit as-is to restock it untracked.
								</p>
							) : null}
						</>
					) : (
						<>
							<ExistingBatchPicker
								itemId={invItem.id}
								vehicleId={vehicleId}
								direction="warehouse_in"
								value={line.batchId}
								onChange={(id) => onTrackingChange(line.stockItemId, { batchId: id })}
							/>
							{overLimit && (
								<p className="mt-1.5 text-xs text-warning-text">
									Warehouse stock is short for this line — the restock will be capped, so the selected batch won't be recorded as tracked.
								</p>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function RestockPanel({
	subTab,
	restockLines,
	notes,
	onNotesChange,
	onApply,
	isPending,
	onChange,
	onTrackingChange,
	vehicleId,
	layout = "desktop",
}: {
	subTab: SubTab;
	restockLines: RestockLine[];
	notes: string;
	onNotesChange: (v: string) => void;
	onApply: () => void;
	isPending: boolean;
	onChange: (stockItemId: string, qty: number) => void;
	onTrackingChange: (stockItemId: string, patch: TrackingPatch) => void;
	vehicleId: string;
	layout?: "desktop" | "mobile";
}) {
	const RESTOCK_GRID_MOBILE = "grid-cols-[1fr_56px_56px_64px]";
	const PREP_GRID_MOBILE = "grid-cols-[1fr_48px_48px_48px_64px]";

	const mobile = layout === "mobile";
	const needs = restockLines.filter((l) => l.qtyToRestock > 0);
	const met = restockLines.filter((l) => l.qtyToRestock === 0);
	const grid = mobile
		? (subTab === "restock" ? RESTOCK_GRID_MOBILE : PREP_GRID_MOBILE)
		: (subTab === "restock" ? RESTOCK_GRID : PREP_GRID);
	const headers = mobile
		? (subTab === "restock" ? ["Item", "Vehicle", "Whse", "Add"] : ["Item", "Vehicle", "Need", "Whse", "Add"])
		: (subTab === "restock"
			? ["Item", "Vehicle", "Standard", "Warehouse", "Qty to Add"]
			: ["Item", "Vehicle", "Standard", "Tomorrow Need", "Warehouse", "Qty to Add"]);
	const totalToRestock = restockLines.reduce((sum, l) => sum + l.qtyToRestock, 0);
	const anyShortfall = restockLines.some((l) => l.qtyToRestock > Number(l.item.inventory_item.quantity));

	const pad = mobile ? "px-3.5" : "px-5";

	return (
		<div>
			{/* Title, column heads and rows share one bounded container so the title
			    reads as this table's title, not another band in a stack. */}
			<div className={`${mobile ? "mx-4" : "mx-0"} mt-3 rounded-lg border border-border overflow-hidden`}>
				{/* Head unit: title and column labels share one surface with no rule
				    between them. */}
				<div className="bg-canvas">
					<div className={`flex items-center gap-2 ${pad} pt-2.5 pb-1.5`}>
						<span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Restock Quantities</span>
						{needs.length > 0 ? (
							<span className="text-[10px] font-bold bg-warning/15 text-warning-text px-1.5 py-0.5 rounded">{needs.length} items</span>
						) : restockLines.length > 0 ? (
							<span className="text-[10px] font-bold bg-success/15 text-success px-1.5 py-0.5 rounded">All stocked</span>
						) : null}
					</div>

					{/* Column headers. No `sticky`: this panel's ancestors don't
					    scroll (the technician shell clips it with overflow-hidden),
					    so the offset never applied and the z-index only invited
					    stacking bugs. */}
					{restockLines.length > 0 && (
						<div className={`grid ${grid} ${pad} pb-2 border-b border-border-strong gap-x-1 bg-base/40`}>
							{headers.map((h) => (
								<div key={h} className="text-[10px] font-semibold text-text-muted uppercase tracking-wider text-center first:text-left">{h}</div>
							))}
						</div>
					)}
				</div>

				{/* Empty state */}
				{restockLines.length === 0 && (
					<div className="flex flex-col items-center justify-center py-12 text-center px-8 border-t border-border-strong">
						<p className="text-sm text-text-muted">No items configured for restocking.</p>
						<p className="text-xs text-text-faint mt-1">Set a standard qty on the Stock tab to include items here.</p>
					</div>
				)}

			{/* Needs restock */}
			{needs.map((l) => (
				<RestockRow
					key={l.stockItemId}
					line={l}
					met={false}
					subTab={subTab}
					grid={grid}
					mobile={mobile}
					vehicleId={vehicleId}
					onChange={onChange}
					onTrackingChange={onTrackingChange}
				/>
			))}

				{/* Already met — a group break between rows, so it stays inside the
				    table rather than reading as a new section. */}
				{needs.length > 0 && met.length > 0 && (
					// Green header and rule: "already met" is the good outcome, and it
					// should read as one at arm's length in sunlight. The rows below
					// keep full-strength text — dimming them made the finished work
					// the hardest part of the table to see.
					<div className={`flex items-center gap-2 ${pad} pt-3 pb-1 text-success-text`}>
						<span className="text-[10px] font-semibold uppercase tracking-wider">Already met</span>
						<span className="text-[10px] font-semibold tabular-nums">{met.length}</span>
						<div className="flex-1 h-px bg-success-text/50" />
					</div>
				)}
				{met.map((l) => (
					<RestockRow
						key={l.stockItemId}
						line={l}
						met={true}
						subTab={subTab}
						grid={grid}
						mobile={mobile}
						vehicleId={vehicleId}
						onChange={onChange}
						onTrackingChange={onTrackingChange}
					/>
				))}
			</div>

			{/* Shortfall warning — outside the table: it speaks about the whole
			    submission, not about one row. */}
			{anyShortfall && (
				<div className={`${mobile ? "mx-4" : "mx-5"} mt-3 flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-md px-3 py-2`}>
					<span className="text-warning-text text-xs font-semibold">⚠</span>
					<span className="text-xs text-warning-text">Some quantities exceed warehouse stock — restock will be capped at available.</span>
				</div>
			)}

			{/* Notes + Apply. Desktop pins this under the table so Apply is reachable
			    without scrolling past every line; the rule marks where rows pass under it. */}
			<div
				className={`${mobile ? "px-4" : "px-5 sticky bottom-0 bg-base border-t border-border"} pt-5 pb-4`}
			>
				<label className="block text-xs text-text-muted mb-1">Notes (optional)</label>
				<textarea
					value={notes}
					onChange={(e) => onNotesChange(e.target.value)}
					rows={2}
					maxLength={500}
					placeholder="e.g. short on filters, will reorder Monday…"
					className="w-full text-sm bg-surface border border-border-input rounded-md px-3 py-2 text-text-primary placeholder:text-faint outline-none focus:border-primary resize-none mb-3"
				/>
				<button
					onClick={onApply}
					disabled={isPending}
					className="w-full px-4 py-2.5 text-sm font-semibold bg-primary hover:enabled:bg-primary-hover text-on-primary rounded-md transition-colors disabled:opacity-50"
				>
					{isPending ? "Applying…"
						: totalToRestock === 0 && !notes.trim() ? "Complete — Nothing to Restock"
						: subTab === "restock" ? "Apply Restock" : "Apply Prep"}
				</button>
			</div>
		</div>
	);
}

// ── ConfirmModal — implemented in Task 4 ─────────────────────────────────────

function ConfirmModal({ subTab, restockLines, notes, isPending, error, onConfirm, onCancel }: {
	subTab: SubTab;
	restockLines: RestockLine[];
	notes: string;
	isPending: boolean;
	error: string | null;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const activeLines = restockLines.filter((l) => l.qtyToRestock > 0);
	const totalUnits = activeLines.reduce((sum, l) => sum + l.qtyToRestock, 0);
	const hasShortfall = activeLines.some((l) => l.qtyToRestock > Number(l.item.inventory_item.quantity));

	return (
		<>
			<div className="fixed inset-0 z-40 bg-overlay" onClick={onCancel} />
			<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
				<div className="bg-base border border-border rounded-xl shadow-xl w-full max-w-md flex flex-col">
					<div className="px-5 pt-5 pb-3 border-b border-border">
						<div className="text-base font-bold text-text-primary">
							{subTab === "restock" ? "Confirm Restock" : "Confirm Prep"}
						</div>
						<div className="text-xs text-text-muted mt-1">
							{activeLines.length > 0
								? `${activeLines.length} item${activeLines.length !== 1 ? "s" : ""} · ${totalUnits} total units moving from warehouse to vehicle.`
								: "No items to move — recording completion."
							}
						</div>
					</div>

					<div className="overflow-y-auto max-h-64 px-5 py-3">
						{activeLines.length > 0 && (
							<>
								<div className="grid grid-cols-[1fr_56px_88px] text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">
									<span>Item</span>
									<span className="text-center">Adding</span>
									<span className="text-center">Warehouse After</span>
								</div>
								<div className="space-y-0.5">
									{activeLines.map((line) => {
										const warehouse = Number(line.item.inventory_item.quantity);
										const after = warehouse - line.qtyToRestock;
										const isShort = after < 0;
										return (
											<div key={line.stockItemId} className={`grid grid-cols-[1fr_56px_88px] items-center py-1.5 px-2 rounded ${isShort ? "bg-warning/5" : ""}`}>
												<span className="text-sm text-text-primary">{line.item.inventory_item.name}</span>
												<span className="text-center text-sm font-semibold text-success">+{line.qtyToRestock}</span>
												<span className={`text-center text-sm font-medium ${isShort ? "text-warning-text" : "text-text-secondary"}`}>
													{isShort ? `0 (−${Math.abs(after)} short)` : after}
												</span>
											</div>
										);
									})}
								</div>
							</>
						)}
						{hasShortfall && (
							<div className="mt-3 flex items-center gap-2 bg-warning/10 border border-warning/30 rounded px-3 py-2">
								<span className="text-warning-text text-xs font-semibold">⚠</span>
								<span className="text-xs text-warning-text">Some quantities exceed warehouse stock — restock will be capped at available.</span>
							</div>
						)}
						{notes.trim() && (
							<p className="mt-3 text-xs text-text-muted italic">"{notes.trim()}"</p>
						)}
					</div>

					{error && (
						<div className="mx-5 mb-2 text-xs text-error-text bg-error/10 border border-error/30 rounded-md px-3 py-2">{error}</div>
					)}

					<div className="px-5 py-4 border-t border-border flex items-center justify-between gap-3">
						<button onClick={onCancel} disabled={isPending} className="px-4 py-2 text-sm font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised transition-colors disabled:opacity-50">
							Cancel
						</button>
						<button onClick={onConfirm} disabled={isPending} className="px-4 py-2 text-sm font-semibold bg-primary hover:enabled:bg-primary-hover text-on-primary rounded-md transition-colors disabled:opacity-50">
							{isPending ? "Applying…" : "Confirm & Apply"}
						</button>
					</div>
				</div>
			</div>
		</>
	);
}

// ── computeRestockLines ───────────────────────────────────────────────────────

function computeRestockLines(
	stockItems: VehicleStockItem[],
	tomorrowNeeds: Map<string, number>,
	mode: SubTab,
): RestockLine[] {
	const eligible = mode === "restock"
		? stockItems.filter((i) => i.qty_standard !== null)
		: stockItems.filter((i) => i.qty_standard !== null || tomorrowNeeds.has(i.inventory_item_id));

	return eligible.map((item) => {
		const onHand = Number(item.qty_on_hand);
		const standard = item.qty_standard !== null ? Number(item.qty_standard) : 0;
		const needed = tomorrowNeeds.get(item.inventory_item_id) ?? 0;
		const target = mode === "prepare" ? Math.max(standard, needed) : standard;
		return {
			stockItemId: item.id,
			item,
			qtyToRestock: Math.max(0, target - onHand),
			tomorrowNeed: needed,
			serialUnitIds: [],
			batchId: null,
		};
	});
}

// ── restock attention-line join ───────────────────────────────────────────────
// Joins the record's restock_lines (qty_restocked/qty_shortfall) with the
// sibling line_details array (reason_code/message/serial_codes/lot_codes) by
// stock_item_id, then filters to lines a tech should acknowledge: a real
// shortfall OR a non-"ok" reason_code (a genuine warehouse/lot shortfall still
// reports reason_code "ok", so both signals matter — see RestockLineDetail).
function computeAttentionLines(record: VehicleRestockRecord, stockItems: VehicleStockItem[]): RestockSummaryLine[] {
	if (!record.line_details) return [];
	return record.line_details
		.map((detail) => {
			const line = record.restock_lines.find((l) => l.stock_item_id === detail.stock_item_id);
			const moved = line?.qty_restocked ?? 0;
			const requested = moved + (line?.qty_shortfall ?? 0);
			const needsAttention = (line?.qty_shortfall ?? 0) > 0 || detail.reason_code !== "ok";
			return { detail, moved, requested, needsAttention };
		})
		.filter((x) => x.needsAttention)
		.map(({ detail, moved, requested }) => ({
			label: stockItems.find((s) => s.id === detail.stock_item_id)?.inventory_item.name ?? detail.stock_item_id,
			requested,
			moved,
			message: detail.message,
			serialCodes: detail.serial_codes,
			lotCodes: detail.lot_codes,
		}));
}

// ── MobileContextAccordion ────────────────────────────────────────────────────

function MobileContextAccordion({ vehicleId, subTab }: { vehicleId: string; subTab: SubTab }) {
	const [open, setOpen] = useState(false);
	const usage = useVehicleUsageTodayQuery(vehicleId);
	const prep = useTomorrowRequirementsQuery(vehicleId);

	const title = subTab === "restock" ? "Usage Since Last Restock" : "Tomorrow's Visits";
	const loading = subTab === "restock" ? usage.isLoading : prep.isLoading;

	let summary: string;
	if (loading) {
		summary = "…";
	} else if (subTab === "restock") {
		const n = (usage.data ?? []).reduce((s, g) => s + g.items.length, 0);
		summary = n === 0 ? "No usage since last restock" : `${n} item${n !== 1 ? "s" : ""} used`;
	} else {
		const n = (prep.data ?? []).length;
		summary = n === 0 ? "No visits tomorrow" : `${n} visit${n !== 1 ? "s" : ""} tomorrow`;
	}

	const count = subTab === "restock"
		? (usage.data ?? []).reduce((s, g) => s + g.items.length, 0)
		: (prep.data ?? []).length;

	return (
		// A filled, bordered card with its own margin — deliberately a different
		// KIND of surface from the page shell's flat "Warehouse Restock" header,
		// which is also a disclosure. Flush and unfilled, this row read as one more
		// header rule stacked against the table below it.
		<div className="mx-4 mt-3 rounded-lg border border-border bg-surface-inset overflow-hidden">
			<button
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="w-full min-h-[52px] flex items-center justify-between gap-3 px-3.5 py-2.5 text-left"
			>
				<span className="min-w-0">
					<span className="flex items-center gap-2">
						<span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
							{title}
						</span>
						{count > 0 && (
							<span className="inline-flex items-center justify-center h-5 min-w-5 rounded-full bg-primary text-on-primary text-xs font-bold px-1.5 shrink-0">
								{count}
							</span>
						)}
					</span>
					{/* Second line says what tapping does. An empty result states the
					    fact instead and doesn't invite a tap that shows nothing. */}
					<span className="block text-xs text-text-muted mt-0.5 truncate">
						{loading ? "Loading…" : count === 0 ? summary : `${summary} — tap to review`}
					</span>
				</span>
				<span className="shrink-0 flex items-center justify-center w-8 h-8 rounded-md border border-border bg-surface">
					<ChevronDown
						size={16}
						className={`text-text-secondary transition-transform ${open ? "rotate-180" : ""}`}
					/>
				</span>
			</button>
			{open && (
				<div className="border-t border-border">
					{subTab === "restock"
						? <RestockContextPanel vehicleId={vehicleId} />
						: <PrepContextPanel vehicleId={vehicleId} />}
				</div>
			)}
		</div>
	);
}

// ── RestockWorkflow ───────────────────────────────────────────────────────────

export default function RestockWorkflow({ vehicleId, stockItems, layout = "desktop" }: { vehicleId: string; stockItems: VehicleStockItem[]; layout?: "desktop" | "mobile" }) {
	const [subTab, setSubTab] = useState<SubTab>("restock");
	const [completedRecord, setCompletedRecord] = useState<VehicleRestockRecord | null>(null);
	const [restockLines, setRestockLines] = useState<RestockLine[]>([]);
	const [notes, setNotes] = useState("");
	const [showConfirm, setShowConfirm] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [summaryDismissed, setSummaryDismissed] = useState(false);

	const { data: tomorrowVisits = [] } = useTomorrowRequirementsQuery(vehicleId);
	const completeMutation = useCompleteRestockMutation(vehicleId);

	const attentionLines = useMemo(
		() => completedRecord ? computeAttentionLines(completedRecord, stockItems) : [],
		[completedRecord, stockItems],
	);

	const tomorrowNeeds = useMemo(() => {
		const map = new Map<string, number>();
		for (const visit of tomorrowVisits) {
			for (const item of visit.items) {
				map.set(item.inventoryItemId, (map.get(item.inventoryItemId) ?? 0) + item.qtyNeeded);
			}
		}
		return map;
	}, [tomorrowVisits]);

	useEffect(() => {
		setRestockLines(computeRestockLines(stockItems, tomorrowNeeds, subTab));
	}, [stockItems, tomorrowNeeds, subTab]);

	const handleSubTabChange = (tab: SubTab) => {
		setSubTab(tab);
		setCompletedRecord(null);
		setNotes("");
		setSubmitError(null);
		setShowConfirm(false);
		setSummaryDismissed(false);
	};

	const handleReset = () => {
		handleSubTabChange(subTab);
		setRestockLines([]);
	};

	const handleComplete = () => {
		setSubmitError(null);
		completeMutation.mutate(
			{
				notes: notes.trim() || null,
				mode: subTab === "restock" ? "restock" : "prepare",
				restock_lines: restockLines
					.filter((l) => l.qtyToRestock > 0)
					.map((l) => {
						// Backend requires an exact serial/batch count match against its
						// own fresh-locked warehouse availability (never the client's
						// stale qtyToRestock) — a short or long array throws and aborts
						// the whole transaction (all lines), it does not degrade to a
						// per-line gap. So tracking fields are only ever sent when (a)
						// the capture exactly matches what was requested, and (b) the
						// warehouse isn't already known (client-side) to be short for
						// this line, since a cap makes even an exact capture mismatch
						// the server's capped `actual`. A depletion landing in the
						// instant between this check and the transaction lock is a
						// residual race that can't be closed client-side — if it happens,
						// the mismatch still throws and aborts the whole submission (the
						// same failure mode this whole check exists to avoid, just in a
						// narrower window); allowUntracked only rescues the case where
						// tracking fields are omitted entirely, not a stale-but-present
						// mismatch. Retrying after the resulting refetch self-heals,
						// since knownShortfall will then correctly reflect the depletion.
						const knownShortfall = l.qtyToRestock > Number(l.item.inventory_item.quantity);
						const serialUnitIds = !knownShortfall && l.serialUnitIds.length === l.qtyToRestock
							? l.serialUnitIds
							: undefined;
						const batchPicks = !knownShortfall && l.batchId
							? [{ batch_id: l.batchId, qty: l.qtyToRestock }]
							: undefined;
						return {
							stock_item_id: l.stockItemId,
							qty_to_restock: l.qtyToRestock,
							serial_unit_ids: serialUnitIds,
							batch_picks: batchPicks,
						};
					}),
			},
			{
				onSuccess: (record) => {
					setCompletedRecord(record);
					setShowConfirm(false);
					setSummaryDismissed(false);
				},
				onError: (e) => {
					setSubmitError(e instanceof Error ? e.message : "Failed to complete restock");
				},
			},
		);
	};

	const handleLineChange = (stockItemId: string, qty: number) => {
		setRestockLines((prev) => prev.map((l) => l.stockItemId === stockItemId ? { ...l, qtyToRestock: qty } : l));
	};

	const handleLineTrackingChange = (stockItemId: string, patch: TrackingPatch) => {
		setRestockLines((prev) => prev.map((l) => l.stockItemId === stockItemId ? { ...l, ...patch } : l));
	};

	return (
		<div className={layout === "mobile" ? "flex flex-col" : "flex flex-col h-full"}>
			{/* Mode switch — which job is being done right now, so on a phone it
			    takes the full width at a thumb-sized height and shares its row with
			    nothing. The reset lives with the completed summary instead, where
			    "start another" is the actual next step. */}
			{/* No rule beneath: the control's own border already closes it off, and a
			    divider here repeated that edge one row down. Matches the Add/Remove
			    switch on the technician vehicle page. */}
			<div className="px-3 py-2 flex-shrink-0">
				<SegmentedToggle<SubTab>
					ariaLabel="Restock mode"
					value={subTab}
					onChange={handleSubTabChange}
					fullWidth={layout === "mobile"}
					variant="flat"
					options={[
						{ id: "restock", label: "Restock" },
						{ id: "prepare", label: "Prep for Tomorrow" },
					]}
				/>
			</div>

			{layout === "mobile" ? (
				<div className="flex flex-col">
					{completedRecord ? (
						<CompleteStep record={completedRecord} stockItems={stockItems} onReset={handleReset} />
					) : (
						<>
							<MobileContextAccordion vehicleId={vehicleId} subTab={subTab} />
							<RestockPanel
								subTab={subTab}
								restockLines={restockLines}
								notes={notes}
								onNotesChange={setNotes}
								onApply={() => setShowConfirm(true)}
								isPending={completeMutation.isPending}
								onChange={handleLineChange}
								onTrackingChange={handleLineTrackingChange}
								vehicleId={vehicleId}
								layout="mobile"
							/>
						</>
					)}
				</div>
			) : (
				<div className="flex flex-row flex-1 overflow-hidden">
					<div className="w-2/5 border-r border-border overflow-y-auto">
						{subTab === "restock"
							? <RestockContextPanel vehicleId={vehicleId} showHeader />
							: <PrepContextPanel vehicleId={vehicleId} />
						}
					</div>
					<div className="flex-1 overflow-y-auto">
						{completedRecord ? (
							<CompleteStep record={completedRecord} stockItems={stockItems} onReset={handleReset} />
						) : (
							<RestockPanel
								subTab={subTab}
								restockLines={restockLines}
								notes={notes}
								onNotesChange={setNotes}
								onApply={() => setShowConfirm(true)}
								isPending={completeMutation.isPending}
								onChange={handleLineChange}
								onTrackingChange={handleLineTrackingChange}
								vehicleId={vehicleId}
							/>
						)}
					</div>
				</div>
			)}

			{showConfirm && (
				<ConfirmModal
					subTab={subTab}
					restockLines={restockLines}
					notes={notes}
					isPending={completeMutation.isPending}
					error={submitError}
					onConfirm={handleComplete}
					onCancel={() => { setShowConfirm(false); setSubmitError(null); }}
				/>
			)}

			{completedRecord && attentionLines.length > 0 && !summaryDismissed && (
				<RestockSummaryModal
					title={completedRecord.mode === "prepare" ? "Prep Summary" : "Restock Summary"}
					lines={attentionLines}
					onAcknowledge={() => setSummaryDismissed(true)}
				/>
			)}
		</div>
	);
}
