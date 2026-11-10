import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
	Barcode,
	MoreHorizontal,
	PackageX,
	Plus,
	Printer,
	RotateCcw,
	Trash2,
	Truck,
	Warehouse,
} from "lucide-react";
import { useSerialsQuery } from "../../../hooks/useTracking";
import { useVehiclesQuery } from "../../../hooks/useVehicles";
import { useSerialActions, type SerialConfirmAction } from "../../../hooks/useSerialActions";
import { useLabelQueueStore } from "../../../stores/labelQueueStore";
import { useToast } from "../../ui/useToast";
import * as trackingApi from "../../../api/tracking";
import { invalidate } from "../../../lib/queryKeys";
import StatusFilter, { type StatusOption } from "../../ui/StatusFilter";
import SearchBar from "../../ui/SearchBar";
import PageControls from "../../ui/PageControls";
import EmptyState from "../../ui/EmptyState";
import ConfirmDialog from "../../ui/ConfirmDialog";
import LoadSvg from "../../../assets/icons/loading.svg?react";
import {
	SERIAL_STATUS_BADGE,
	SERIAL_STATUS_LABEL,
	type SerialUnitRow,
	type SerialUnitStatus,
} from "../../../types/tracking";
import { formatDate } from "../../../util/util";
import { QueueLabelButton } from "./trackingTableShared";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";

// Renders inside a Card in InventoryItemDetailPage's Tracking tab (no page
// chrome of its own).

const STATUS_OPTIONS: StatusOption[] = (
	Object.keys(SERIAL_STATUS_LABEL) as SerialUnitStatus[]
).map((value) => ({
	value,
	label: SERIAL_STATUS_LABEL[value],
}));

const SERIAL_GRID = "grid-cols-[1fr_120px_110px_170px_100px_64px]";
// Same columns as SERIAL_GRID plus a leading checkbox column — only used when
// bulk-select is available (canManage), so non-managers keep the original
// alignment with no empty gutter.
const SERIAL_GRID_SELECTABLE = "grid-cols-[40px_1fr_120px_110px_170px_100px_64px]";

// Copy for the bulk (multi-select) status-change confirm dialog — same shape
// as SERIAL_CONFIRM_COPY but parameterized by count instead of a single
// serial number.
function bulkSerialConfirmCopy(
	action: "lost" | "returned",
	count: number
): { title: string; body: string; cta: string } {
	const unit = count === 1 ? "unit" : "units";
	const pronoun = count === 1 ? "its" : "their";
	if (action === "lost") {
		return {
			title: `Mark ${count} ${unit} as lost`,
			body: `This records a stock movement removing ${count} ${unit} from the warehouse and sets ${pronoun} status to Lost. Marking lost is permanent — a lost unit can't be restored anywhere in the app.`,
			cta: "Mark Lost",
		};
	}
	return {
		title: `Mark ${count} ${unit} as returned`,
		body: `This records a stock movement removing ${count} ${unit} from the warehouse and sets ${pronoun} status to Returned.`,
		cta: "Mark Returned",
	};
}

// Runs fn over ids with at most `limit` in flight, avoiding e.g. 100
// simultaneous PATCH requests. Returns which ids succeeded vs. failed (not
// just counts) so a partial failure can re-select the ones to retry.
async function runBulk<T>(
	ids: string[],
	limit: number,
	fn: (id: string) => Promise<T>
): Promise<{ succeededIds: string[]; failedIds: string[] }> {
	const succeededIds: string[] = [];
	const failedIds: string[] = [];
	let index = 0;
	const worker = async () => {
		while (index < ids.length) {
			const current = index++;
			const id = ids[current];
			try {
				await fn(id);
				succeededIds.push(id);
			} catch {
				failedIds.push(id);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, () => worker()));
	return { succeededIds, failedIds };
}

// Per-row "More actions" menu. Floats with position:fixed anchored to the
// trigger's rect so it escapes any ancestor overflow (the table lives inside
// an overflow-x-auto strip) — mirrors DateRangeFilter's floating pattern.
function SerialRowActions({
	unit,
	onSelect,
}: {
	unit: SerialUnitRow;
	onSelect: (action: SerialConfirmAction) => void;
}) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(
		null
	);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	// Delete is only offered for warehouse units (no vehicle) — matches the
	// backend guard. Menu height drives the flip-up threshold, so it tracks
	// whether the third item is present.
	const canDelete = !unit.current_vehicle_id;
	const menuHeight = canDelete ? 118 : 84;

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (
				buttonRef.current?.contains(e.target as Node) ||
				menuRef.current?.contains(e.target as Node)
			)
				return;
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		const onScroll = () => setOpen(false);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [open]);

	const toggle = () => {
		if (open) {
			setOpen(false);
			return;
		}
		const rect = buttonRef.current?.getBoundingClientRect();
		if (!rect) return;
		const openAbove = rect.bottom + menuHeight > window.innerHeight - 16;
		setPos({
			right: window.innerWidth - rect.right,
			...(openAbove
				? { bottom: window.innerHeight - rect.top + 4 }
				: { top: rect.bottom + 4 }),
		});
		setOpen(true);
	};

	const pick = (action: SerialConfirmAction) => {
		setOpen(false);
		onSelect(action);
	};

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				onClick={toggle}
				aria-label={`More actions for serial ${unit.serial_number}`}
				aria-haspopup="menu"
				aria-expanded={open}
				className="p-2 -my-1 rounded text-text-faint hover:text-text-primary hover:bg-surface-raised transition-colors"
			>
				<MoreHorizontal size={14} />
			</button>
			{open && pos && (
				<div
					ref={menuRef}
					role="menu"
					style={{
						position: "fixed",
						right: pos.right,
						...(pos.top !== undefined ? { top: pos.top } : {}),
						...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
						zIndex: 60,
					}}
					className="w-44 bg-base border border-border rounded-lg shadow-2xl shadow-black/50 py-1"
				>
					<button
						type="button"
						role="menuitem"
						onClick={() => pick("returned")}
						className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
					>
						<RotateCcw size={13} />
						Mark Returned
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => pick("lost")}
						className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-warning-text hover:bg-surface transition-colors"
					>
						<PackageX size={13} />
						Mark Lost
					</button>
					{canDelete && (
						<button
							type="button"
							role="menuitem"
							onClick={() => pick("delete")}
							className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-error-text hover:bg-surface transition-colors"
						>
							<Trash2 size={13} />
							Delete
						</button>
					)}
				</div>
			)}
		</>
	);
}

export default function SerialsTable({
	itemId,
	itemName,
	onReceive,
	onOpenSerial,
	canManage,
	readOnly = false,
}: {
	itemId: string;
	itemName: string;
	onReceive?: () => void;
	/**
	 * Opens a unit. The owner puts the id in `?serial=` and shows a drawer,
	 * so this table stays mounted and keeps its filter, cursor, loaded pages
	 * and bulk selection.
	 */
	onOpenSerial: (serialId: string) => void;
	canManage: boolean;
	/**
	 * Archive mode — serialization is off for this item but its units survive as
	 * history. Every mutating affordance already hangs off `canManage` (which the
	 * caller passes as false here), so this only drops the label-queue button:
	 * printing a unit label for a consumed, no-longer-tracked serial is noise.
	 */
	readOnly?: boolean;
}) {
	const navigate = useNavigate();
	const toast = useToast();
	const queryClient = useQueryClient();
	const addToLabelQueue = useLabelQueueStore((s) => s.add);
	const { data: vehicles } = useVehiclesQuery();
	const [statusFilter, setStatusFilter] = useState<SerialUnitStatus | null>(null);
	const [searchInput, setSearchInput] = useState("");
	const search = useDebouncedValue(searchInput, 300);
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [rows, setRows] = useState<SerialUnitRow[]>([]);
	const [confirmTarget, setConfirmTarget] = useState<{
		unit: SerialUnitRow;
		action: SerialConfirmAction;
	} | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [bulkAction, setBulkAction] = useState<"lost" | "returned" | null>(null);
	const [bulkPending, setBulkPending] = useState(false);
	const selectAllRef = useRef<HTMLInputElement>(null);

	const { data, isLoading, isFetching } = useSerialsQuery(itemId, {
		status: statusFilter ?? undefined,
		search: search || undefined,
		cursor,
	});

	const serialActions = useSerialActions(confirmTarget?.unit.id ?? "");

	// Status or search changes restart pagination from the first page — any
	// selection made against the previous page/filter no longer maps to what's
	// loaded, so it's cleared alongside the reset rather than left stale.
	useEffect(() => {
		setCursor(undefined);
		setRows([]);
		setSelectedIds(new Set());
	}, [statusFilter, search]);

	// Only in-warehouse units are eligible for bulk selection — a mixed
	// in-flight/consumed/lost/returned unit can't be marked lost/returned in
	// bulk, so its checkbox is disabled rather than letting it get selected
	// and then silently excluded from the action.
	const eligibleRows = rows.filter((r) => r.status === "in_warehouse");
	const ineligibleCount = rows.length - eligibleRows.length;

	// Native checkboxes don't expose "indeterminate" as a prop — it has to be
	// set imperatively whenever the loaded rows or selection change. Based on
	// eligible rows only, since ineligible ones can never be selected.
	useEffect(() => {
		if (!selectAllRef.current) return;
		const loadedSelected = eligibleRows.filter((r) => selectedIds.has(r.id)).length;
		selectAllRef.current.indeterminate =
			loadedSelected > 0 && loadedSelected < eligibleRows.length;
	}, [eligibleRows, selectedIds]);

	// cursor === undefined means this response is page 1 (replace); otherwise
	// it's a "load more" page (append).
	useEffect(() => {
		if (!data) return;
		setRows((prev) => (cursor ? [...prev, ...data.serials] : data.serials));
	}, [data, cursor]);

	const vehicleName = (vehicleId: string | null): string => {
		if (!vehicleId) return "Warehouse";
		return vehicles?.find((v) => v.id === vehicleId)?.name ?? "Vehicle";
	};

	// Backend re-checks eligibility authoritatively — this only reset local
	// pagination so the table refetches page 1 (delete removes the row; a
	// status change moves it out of the in-warehouse view either way).
	const handleConfirmAction = async () => {
		if (!confirmTarget) return;
		setActionError(null);
		try {
			if (confirmTarget.action === "delete") {
				await serialActions.remove();
				toast.success("Serial deleted");
			} else {
				await serialActions.update(confirmTarget.action);
				toast.success(
					confirmTarget.action === "lost"
						? "Marked lost"
						: "Marked returned"
				);
			}
			setConfirmTarget(null);
			setCursor(undefined);
			setRows([]);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Action failed";
			setActionError(message);
			toast.error(message);
		}
	};

	const toggleRow = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const toggleSelectAll = () => {
		setSelectedIds((prev) => {
			const allEligibleSelected =
				eligibleRows.length > 0 &&
				eligibleRows.every((r) => prev.has(r.id));
			return allEligibleSelected
				? new Set()
				: new Set(eligibleRows.map((r) => r.id));
		});
	};

	const selectedRows = rows.filter((r) => selectedIds.has(r.id));
	const allSelectedInWarehouse =
		selectedRows.length > 0 && selectedRows.every((r) => r.status === "in_warehouse");
	const gridClass = canManage ? SERIAL_GRID_SELECTABLE : SERIAL_GRID;
	// Drives the header row's swap from column labels to bulk actions.
	const isSelecting = canManage && selectedIds.size > 0;

	const handleBulkPrint = () => {
		selectedRows.forEach((r) => {
			addToLabelQueue({
				id: r.id,
				code: r.code,
				kind: "serial",
				primaryLabel: itemName,
				secondaryLabel: r.serial_number,
			});
		});
		const count = selectedRows.length;
		toast.success(`${count} label${count !== 1 ? "s" : ""} queued`);
		setSelectedIds(new Set());
		navigate("/dispatch/inventory/labels/print");
	};

	// Loops the update PATCH across every selected unit (bounded concurrency),
	// then resets pagination exactly like the single-row flow so units that
	// moved out of the current status/search view disappear from `rows`.
	const handleBulkConfirm = async () => {
		if (!bulkAction) return;
		setBulkPending(true);
		const ids = selectedRows.map((r) => r.id);
		const action = bulkAction;
		const { succeededIds, failedIds } = await runBulk(ids, 5, (id) =>
			trackingApi.updateSerial(id, { status: action })
		);
		invalidate.warehouse(queryClient);
		setBulkPending(false);
		setBulkAction(null);
		setCursor(undefined);
		setRows([]);
		if (failedIds.length === 0) {
			setSelectedIds(new Set());
			toast.success(`${succeededIds.length} marked ${action}`);
		} else if (succeededIds.length === 0) {
			// Nothing changed — keep the same selection so the toolbar stays open
			// and the user can retry without re-picking rows.
			setSelectedIds(new Set(failedIds));
			toast.error(
				`Failed to update ${failedIds.length} unit${failedIds.length !== 1 ? "s" : ""}`
			);
		} else {
			// Partial failure — re-select just the failed subset and keep the
			// bulk toolbar open for a retry instead of clearing everything.
			setSelectedIds(new Set(failedIds));
			toast.success(`${succeededIds.length} marked ${action}`);
			toast.error(
				`${failedIds.length} unit${failedIds.length !== 1 ? "s" : ""} failed to update`
			);
		}
	};

	// Computed once per render rather than 3x inline in each ConfirmDialog below.
	const copy = confirmTarget
		? serialActions.confirmCopy(confirmTarget.action, confirmTarget.unit.serial_number)
		: null;
	const bulkCopy = bulkAction ? bulkSerialConfirmCopy(bulkAction, selectedRows.length) : null;

	return (
		<div>
			<PageControls
				className="mb-3"
				left={
					<SearchBar
						value={searchInput}
						onChange={setSearchInput}
						placeholder="Search serial or code..."
					/>
				}
				middle={
					<StatusFilter
						options={STATUS_OPTIONS}
						// One status at a time here — the table filters on a
						// single value, so the multi-select control carries a
						// one-element array and clearing sends null.
						values={statusFilter ? [statusFilter] : null}
						onChange={(v) =>
							setStatusFilter(v as SerialUnitStatus | null)
						}
						placeholder="Status"
						allLabel="All statuses"
						exclusive
					/>
				}
				right={
					<span className="text-sm text-text-tertiary whitespace-nowrap">
						<span className="font-semibold text-text-primary tabular-nums">
							{rows.length}
						</span>{" "}
						unit{rows.length !== 1 ? "s" : ""}
						{canManage && ineligibleCount > 0 && (
							<span className="text-text-muted">
								{" · "}
								{ineligibleCount} ineligible
							</span>
						)}
					</span>
				}
			/>

			{isLoading && rows.length === 0 && (
				<div className="flex justify-center py-16">
					<LoadSvg className="w-8 h-8" />
				</div>
			)}

			{!isLoading && rows.length === 0 && (
				<EmptyState
					icon={<Barcode size={28} />}
					title={
						search || statusFilter
							? "No serial units match your filters"
							: "No serial units yet"
					}
					description={
						search || statusFilter
							? "Try a different search term or status."
							: readOnly
								? "Serial tracking is turned off for this item and no units were recorded."
								: "Receive stock to add serial units for this item."
					}
					action={
						!search && !statusFilter && onReceive
							? {
									label: "Receive Stock",
									onClick: onReceive,
									icon: <Plus size={14} />,
								}
							: undefined
					}
				/>
			)}

			{rows.length > 0 && (
				<div className="border border-border-subtle bg-base rounded-lg overflow-hidden">
					<div className="overflow-x-auto">
						<div className="min-w-[820px]">
							{/* Column labels and bulk actions share one row: the
							    select-all checkbox keeps its column, and the label
							    cells give way to the action bar the moment something
							    is selected. Lighter surface-raised fill marks the
							    row as a live control strip, not headers. */}
							<div
								className={`grid ${gridClass} items-center px-4 py-2.5 border-b border-border-subtle transition-colors ${
									isSelecting ? "bg-surface-raised" : "bg-base"
								}`}
							>
								{canManage && (
									<label className="flex items-center justify-center place-self-center rounded-md p-2 -my-1 border border-transparent cursor-pointer hover:bg-surface-raised/40 hover:border-border-subtle transition-colors">
										<input
											type="checkbox"
											ref={selectAllRef}
											checked={
												eligibleRows.length >
													0 &&
												eligibleRows.every(
													(r) =>
														selectedIds.has(
															r.id
														)
												)
											}
											disabled={
												eligibleRows.length ===
												0
											}
											onChange={
												toggleSelectAll
											}
											aria-label="Select all eligible serial units"
											title={
												eligibleRows.length >
												0
													? `Select all ${eligibleRows.length} eligible loaded unit${eligibleRows.length !== 1 ? "s" : ""}`
													: "No in-warehouse units loaded to select"
											}
											className="h-3.5 w-3.5 rounded border-border bg-base text-primary focus:ring-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
										/>
									</label>
								)}
								{isSelecting ? (
									<div
										role="toolbar"
										aria-label="Bulk actions for selected serial units"
										className="col-span-6 flex items-center justify-between gap-3 flex-wrap"
									>
										<span
											aria-live="polite"
											className="text-xs font-medium text-text-secondary whitespace-nowrap"
										>
											{selectedIds.size}{" "}
											selected
										</span>
										<div className="flex items-center gap-2 flex-wrap">
											<button
												type="button"
												onClick={
													handleBulkPrint
												}
												className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-base hover:text-text-primary transition-colors"
											>
												<Printer
													size={
														13
													}
												/>
												Print labels
											</button>
											<button
												type="button"
												onClick={() =>
													setBulkAction(
														"returned"
													)
												}
												disabled={
													!allSelectedInWarehouse
												}
												title={
													!allSelectedInWarehouse
														? "Only in-warehouse units can be marked returned"
														: undefined
												}
												className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-base hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-surface disabled:hover:text-text-secondary"
											>
												<RotateCcw
													size={
														13
													}
												/>
												Mark Returned
											</button>
											<button
												type="button"
												onClick={() =>
													setBulkAction(
														"lost"
													)
												}
												disabled={
													!allSelectedInWarehouse
												}
												title={
													!allSelectedInWarehouse
														? "Only in-warehouse units can be marked lost"
														: undefined
												}
												className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-surface border border-border rounded-md text-warning-text hover:bg-base transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-surface"
											>
												<PackageX
													size={
														13
													}
												/>
												Mark Lost
											</button>
											<button
												type="button"
												onClick={() =>
													setSelectedIds(
														new Set()
													)
												}
												className="px-2 py-1 text-xs text-text-faint hover:text-text-primary transition-colors"
											>
												Clear
											</button>
										</div>
									</div>
								) : (
									[
										"Serial Number",
										"Code",
										"Status",
										"Location",
										"Received",
										"",
									].map((h) => (
										<div
											key={h}
											className="text-xs font-bold text-text-tertiary"
										>
											{h}
										</div>
									))
								)}
							</div>
							{rows.map((unit) => (
								<div
									key={unit.id}
									role="button"
									tabIndex={0}
									onClick={() => onOpenSerial(unit.id)}
									onKeyDown={(e) => {
										if (
											e.key !== "Enter" &&
											e.key !== " "
										)
											return;
										e.preventDefault();
										onOpenSerial(unit.id);
									}}
									aria-label={`View serial ${unit.serial_number}`}
									className={`grid ${gridClass} items-center px-4 py-2.5 border-t border-border-subtle hover:bg-surface transition-colors cursor-pointer`}
								>
									{canManage && (
										// Small symmetric box hugging the 14px
										// checkbox. onClick stopPropagation means a
										// near-miss toggles (via <label>) or does
										// nothing — never the row's navigate.
										<label
											className={`flex items-center justify-center place-self-center rounded-md p-2 -my-1 border border-transparent transition-colors ${
												unit.status ===
												"in_warehouse"
													? "cursor-pointer hover:bg-surface-raised/40 hover:border-border-subtle"
													: "cursor-default"
											}`}
											onClick={(e) =>
												e.stopPropagation()
											}
										>
											<input
												type="checkbox"
												checked={selectedIds.has(
													unit.id
												)}
												disabled={
													unit.status !==
													"in_warehouse"
												}
												onChange={() =>
													toggleRow(
														unit.id
													)
												}
												aria-label={`Select serial ${unit.serial_number}`}
												title={
													unit.status !==
													"in_warehouse"
														? "Only in-warehouse units are eligible for bulk actions"
														: undefined
												}
												className="h-3.5 w-3.5 rounded border-border bg-base text-primary focus:ring-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
											/>
										</label>
									)}
									<div className="text-sm font-medium text-text-primary break-all pr-2">
										{unit.serial_number}
									</div>
									<div className="text-xs font-mono text-text-muted break-all pr-2">
										{unit.code}
									</div>
									<div>
										<span
											className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${SERIAL_STATUS_BADGE[unit.status]}`}
										>
											{
												SERIAL_STATUS_LABEL[
													unit.status
												]
											}
										</span>
									</div>
									<div className="flex items-center gap-1.5 text-xs text-text-secondary pr-2">
										{unit.current_vehicle_id ? (
											<Truck
												size={12}
												className="shrink-0 text-primary"
											/>
										) : (
											<Warehouse
												size={12}
												className="shrink-0 text-text-faint"
											/>
										)}
										<span className="break-words">
											{vehicleName(
												unit.current_vehicle_id
											)}
										</span>
									</div>
									<div className="text-xs text-text-muted">
										{formatDate(unit.received_at)}
									</div>
									<div
										className="flex justify-end items-center gap-1"
										onClick={(e) =>
											e.stopPropagation()
										}
									>
										{!readOnly && (
											<QueueLabelButton
												id={unit.id}
												code={unit.code}
												kind="serial"
												primaryLabel={itemName}
												secondaryLabel={
													unit.serial_number
												}
											/>
										)}
										{canManage &&
											(unit.status ===
											"in_warehouse" ? (
												<SerialRowActions
													unit={unit}
													onSelect={(
														action
													) =>
														setConfirmTarget(
															{
																unit,
																action,
															}
														)
													}
												/>
											) : (
												<span className="w-[28px] h-[28px]" />
											))}
									</div>
								</div>
							))}
						</div>
					</div>
				</div>
			)}

			{data?.nextCursor && (
				<div className="py-3 flex justify-center">
					<button
						type="button"
						onClick={() =>
							setCursor(data.nextCursor ?? undefined)
						}
						disabled={isFetching}
						className="px-3 py-1.5 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors disabled:opacity-50"
					>
						{isFetching ? "Loading…" : "Load more"}
					</button>
				</div>
			)}

			<ConfirmDialog
				open={confirmTarget !== null}
				title={copy?.title ?? ""}
				body={copy?.body ?? ""}
				confirmLabel={copy?.cta ?? ""}
				tone={confirmTarget?.action === "delete" ? "destructive" : "primary"}
				pending={serialActions.isPending}
				error={actionError}
				onConfirm={handleConfirmAction}
				onCancel={() => {
					setConfirmTarget(null);
					setActionError(null);
				}}
			/>

			<ConfirmDialog
				open={bulkAction !== null}
				title={bulkCopy?.title ?? ""}
				body={bulkCopy?.body ?? ""}
				confirmLabel={bulkCopy?.cta ?? ""}
				tone="primary"
				pending={bulkPending}
				onConfirm={handleBulkConfirm}
				onCancel={() => setBulkAction(null)}
			/>
		</div>
	);
}
