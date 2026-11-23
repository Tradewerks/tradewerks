import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Barcode as BarcodeIcon, ChevronDown, X } from "lucide-react";
import { useSerialsQuery } from "../../hooks/useTracking";
import { useScanDispatcher } from "../../hooks/useScanDispatcher";
import { BarcodeScanner } from "../inventory/BarcodeScanner";
import type { SerialUnitStatus, SerialUnitRow } from "../../types/tracking";

export interface ExistingUnitPickerProps {
	itemId: string;
	itemName: string;
	/** Omitted → no status constraint (see AdjustStockModal's tracking-step notes on why). */
	statusFilter?: SerialUnitStatus;
	/** Scopes the candidate list to units currently on this vehicle. */
	vehicleId?: string;
	/** Exactly how many units must be selected — abs(delta) for this line. */
	targetCount: number;
	value: string[];
	onChange: (unitIds: string[]) => void;
	/**
	 * Whether the candidate list starts expanded. Picking units IS the task in the
	 * adjust-stock and use-part flows, so those open it. A restock sheet can show
	 * several serialized lines at once, and each one opening its own 200px scroller
	 * made the sheet unreadable — those stay collapsed until asked for.
	 */
	defaultOpen?: boolean;
}

// Page size the API returns per request, used only in the "Show N more" label.
const PAGE_HINT = 25;

// Local and private — the same call this repo's other paged pickers make (see
// UnitLabelPicker, which keeps its own copy for the same reason).
function useDebouncedValue<T>(value: T, delayMs = 300): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(t);
	}, [value, delayMs]);
	return debounced;
}

// Lighter-weight sibling of SerialCaptureList — picks *existing* serial_unit
// rows (rather than capturing brand-new serial numbers) for every adjustment
// type except supplier_purchase. See AdjustStockModal.tsx for how
// statusFilter/vehicleId are derived per adjustment direction.
export default function ExistingUnitPicker({
	itemId,
	itemName,
	statusFilter,
	vehicleId,
	targetCount,
	value,
	onChange,
	defaultOpen = false,
}: ExistingUnitPickerProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(defaultOpen);
	const [searchInput, setSearchInput] = useState("");
	const search = useDebouncedValue(searchInput, 300);
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [rows, setRows] = useState<SerialUnitRow[]>([]);
	const [scannerOpen, setScannerOpen] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);

	const { data, isLoading, isFetching } = useSerialsQuery(itemId, {
		status: statusFilter,
		vehicleId,
		search: search || undefined,
		cursor,
	});

	// A new search restarts paging — page 2 of the previous query says nothing
	// about this one.
	useEffect(() => {
		setCursor(undefined);
		setRows([]);
	}, [search, statusFilter, vehicleId]);

	// cursor === undefined means this response is page 1 (replace); otherwise it's
	// the next page (append). Mirrors SerialsTable's accumulation.
	useEffect(() => {
		if (!data) return;
		setRows((prev) => (cursor ? [...prev, ...data.serials] : data.serials));
	}, [data, cursor]);

	// Labels for the selected ids, remembered even when a unit falls out of the
	// current search or page — otherwise a chip would blank out mid-selection.
	const labelsRef = useRef<Map<string, string>>(new Map());
	for (const row of rows) labelsRef.current.set(row.id, row.serial_number);
	const selected = useMemo(
		() => value.map((id) => ({ id, label: labelsRef.current.get(id) ?? t("unitPicker.selectedUnit") })),
		[value, t],
	);

	const toggle = (id: string) => {
		if (value.includes(id)) onChange(value.filter((v) => v !== id));
		else onChange([...value, id]);
	};

	const { handleScan } = useScanDispatcher({
		onItem: () => setScanError(t("unitPicker.isItem")),
		onBatch: () => setScanError(t("unitPicker.isBatch")),
		onSerial: (serial) => {
			if (serial.item.id !== itemId) {
				setScanError(t("unitPicker.wrongItem", { other: serial.item.name, item: itemName }));
				return;
			}
			const loaded = rows.find((r) => r.id === serial.serialUnitId);
			if (loaded) {
				setScanError(null);
				if (!value.includes(loaded.id)) onChange([...value, loaded.id]);
				return;
			}
			// Not on a loaded page — with paging, that just means page four, not
			// invalid. Only the resolve response's status gets checked here;
			// anything finer is the backend's call at submit.
			if (statusFilter && serial.status !== statusFilter) {
				setScanError(
					t("unitPicker.wrongStatus", {
						status: t(`serialStatus.${serial.status}`, {
							defaultValue: serial.status.replace(/_/g, " "),
						}).toLowerCase(),
					})
				);
				return;
			}
			labelsRef.current.set(serial.serialUnitId, serial.code);
			setScanError(null);
			if (!value.includes(serial.serialUnitId)) onChange([...value, serial.serialUnitId]);
		},
		onNotFound: () => setScanError(t("unitPicker.notFound")),
	});

	const countState: "short" | "exact" | "over" =
		value.length < targetCount ? "short" : value.length === targetCount ? "exact" : "over";
	const countClass =
		countState === "exact"
			? "text-success-text"
			: countState === "over"
				? "text-error-text"
				: "text-text-muted";

	return (
		<div className="space-y-2">
			{/* Summary bar. Scanning is the primary path in the field, so it keeps a
			    button of its own whether or not the list is showing. */}
			<div className="flex items-center gap-2">
				<span className="text-xs font-medium text-text-tertiary uppercase tracking-wider flex-1 min-w-0">
					{t("unitPicker.title")}
				</span>
				<span className={`text-xs font-semibold tabular-nums ${countClass}`}>
					{t("unitPicker.count", { n: value.length, total: targetCount })}
				</span>
				<button
					type="button"
					onClick={() => setScannerOpen(true)}
					aria-label={t("unitPicker.scanFor", { name: itemName })}
					className="h-[26px] w-[26px] shrink-0 flex items-center justify-center rounded border border-border text-text-muted hover:text-primary hover:border-primary transition-colors"
				>
					<BarcodeIcon size={14} />
				</button>
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					className="h-[26px] shrink-0 flex items-center gap-1 rounded border border-border px-2 text-[11px] font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
				>
					{t(open ? "unitPicker.hideList" : "unitPicker.browse")}
					<ChevronDown
						size={12}
						className={`transition-transform ${open ? "rotate-180" : ""}`}
					/>
				</button>
			</div>

			{scanError && (
				<div
					role="alert"
					className="flex items-start gap-1.5 text-xs text-error-text bg-error-bg border border-error-border rounded px-2 py-1"
				>
					<AlertTriangle size={12} className="mt-0.5 shrink-0" />
					<span className="min-w-0">{scanError}</span>
				</div>
			)}

			{/* Selected units stay visible with the list closed — the point of
			    collapsing is that a tech shouldn't have to open a 100-row list to
			    see what they've already picked. */}
			{selected.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{selected.map((unit) => (
						<span
							key={unit.id}
							className="inline-flex items-center gap-1 max-w-full rounded-full border border-primary/40 bg-primary/10 pl-2 pr-1 py-0.5 text-[11px] font-mono text-primary-text"
						>
							<span className="truncate" title={unit.label}>
								{unit.label}
							</span>
							<button
								type="button"
								onClick={() => toggle(unit.id)}
								aria-label={t("shiftEdit.removeAria", { label: unit.label })}
								className="shrink-0 rounded-full p-0.5 text-primary-text/70 hover:text-primary-text hover:bg-primary/20 transition-colors"
							>
								<X size={10} />
							</button>
						</span>
					))}
				</div>
			)}

			{open && (
				<>
					<input
						type="search"
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						placeholder={t("unitPicker.search")}
						aria-label={t("unitPicker.searchAria")}
						className="w-full h-8 rounded border border-border-input bg-base px-2.5 text-sm text-text-primary placeholder:text-text-faint outline-none focus:border-primary"
					/>

					{isLoading && rows.length === 0 && (
						<p className="text-xs text-text-muted">{t("unitPicker.loading")}</p>
					)}

					{!isLoading && rows.length === 0 && (
						<p className="text-xs text-text-muted">
							{search ? t("unitPicker.noMatch", { q: search }) : t("unitPicker.noneAvailable")}
						</p>
					)}

					{rows.length > 0 && (
						<div className="space-y-1 max-h-56 overflow-y-auto">
							{rows.map((unit) => {
								const checked = value.includes(unit.id);
								return (
									<label
										key={unit.id}
										className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-sm cursor-pointer transition-colors ${
											checked
												? "border-primary bg-primary/10"
												: "border-border bg-surface"
										}`}
									>
										<input
											type="checkbox"
											checked={checked}
											onChange={() => toggle(unit.id)}
											aria-label={t("unitPicker.selectUnit", { serial: unit.serial_number })}
											className="shrink-0"
										/>
										<span className="flex-1 min-w-0 truncate font-mono text-text-primary">
											{unit.serial_number}
										</span>
									</label>
								);
							})}
						</div>
					)}

					{/* The response carries no total, so this states what's loaded
					    rather than implying a count it can't know. */}
					{rows.length > 0 && (
						<div className="flex items-center justify-between gap-2">
							<span className="text-[11px] text-text-faint tabular-nums">
								{t("unitPicker.shown", { n: rows.length })}
								{data?.nextCursor ? ` · ${t("unitPicker.moreAvailable")}` : ""}
							</span>
							{data?.nextCursor && (
								<button
									type="button"
									onClick={() => setCursor(data.nextCursor ?? undefined)}
									disabled={isFetching}
									className="text-[11px] font-medium text-primary-text hover:underline disabled:opacity-50"
								>
									{isFetching ? t("common.loading") : t("unitPicker.showMore", { n: PAGE_HINT })}
								</button>
							)}
						</div>
					)}
				</>
			)}

			{scannerOpen && (
				<BarcodeScanner continuous onScan={(code) => handleScan(code)} onClose={() => setScannerOpen(false)} />
			)}
		</div>
	);
}
