import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, ChevronRight, FileText } from "lucide-react";
import i18n, { dateLocale } from "../../i18n";
import { resolveItemName } from "../../lib/stockUtils";
import {
	useVehicleStockAdjustmentHistoryQuery,
	useVehicleRestockHistoryQuery,
} from "../../hooks/useVehicleStock";
import type {
	VehicleStockItem,
	VehicleStockAdjustment,
	VehicleStockAdjustmentLine,
	VehicleAdjustmentType,
	VehicleRestockRecord,
} from "../../types/vehicles";
import { ADJUSTMENT_TYPE_LABELS } from "../../types/vehicles";
import SegmentedToggle from "../ui/SegmentedToggle";

type HistoryTab = "adjustments" | "restock";
type FilterType = VehicleAdjustmentType | "all";

// Keyed by string, not by VehicleAdjustmentType: `supplier_purchase` is no
// longer an adjustment anyone can make, but rows recorded before it was retired
// still carry it and would otherwise render unlabelled.
const TYPE_BADGE: Record<string, string> = {
	field_loss:         "bg-error/15 text-error-text",
	transfer:           "bg-primary/15 text-primary",
	audit:              "bg-surface-raised border border-border text-text-secondary",
	warehouse_exchange: "bg-success/15 text-success",
	supplier_purchase:  "bg-violet-500/15 text-violet-400",
};

// Short chip label; falls back to the raw type for anything unknown.
const badgeLabel = (type: string) => i18n.t(`history.badge.${type}`, { defaultValue: type });
const typeName = (type: VehicleAdjustmentType) => i18n.t(`history.typeName.${type}`);

const ALL_TYPES = Object.keys(ADJUSTMENT_TYPE_LABELS) as VehicleAdjustmentType[];

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 1)
		return i18n.t("notifications.minsAgo", { count: Math.max(1, Math.floor(ms / 60_000)) });
	if (hours < 24) return i18n.t("notifications.hrsAgo", { count: hours });
	if (hours < 48) return i18n.t("notifications.yesterday");
	return new Date(iso).toLocaleDateString(i18n.language, { month: "short", day: "numeric" });
}

const timeOf = (d: Date) => d.toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" });

function absTime(iso: string): string {
	const d = new Date(iso);
	return `${d.toLocaleDateString(i18n.language, { month: "short", day: "numeric", year: "numeric" })} · ${timeOf(d)}`;
}

function shortStamp(iso: string): string {
	const d = new Date(iso);
	return `${d.toLocaleDateString(i18n.language, { month: "short", day: "numeric" })} · ${timeOf(d)}`;
}

// Desk ledger: one line per entry, every column readable without expanding.
// When | Type | Item | Change | By | expand.
const DESK_GRID =
	"grid grid-cols-[120px_76px_minmax(0,1fr)_104px_minmax(0,140px)_14px] items-center gap-3";

function DeskHeader({ labels }: { labels: [string, string, string, string, string] }) {
	return (
		<div
			className={`${DESK_GRID} sticky top-0 z-10 border-b border-border-subtle bg-base px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted`}
		>
			<span>{labels[0]}</span>
			<span>{labels[1]}</span>
			<span>{labels[2]}</span>
			<span className="text-right">{labels[3]}</span>
			<span>{labels[4]}</span>
			<span />
		</div>
	);
}

function Expander({ expanded }: { expanded: boolean }) {
	return (
		<ChevronDown
			size={13}
			aria-hidden="true"
			className={`text-text-muted flex-shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
		/>
	);
}

function AdjRow({
	adj,
	stockItems,
	expanded,
	onToggle,
	desk = false,
}: {
	adj: VehicleStockAdjustment;
	stockItems: VehicleStockItem[];
	expanded: boolean;
	onToggle: () => void;
	desk?: boolean;
}) {
	const { t } = useTranslation();
	const actor = adj.created_by?.name ?? adj.created_by_tech?.name;
	const isWarehouse = adj.type === "warehouse_exchange";
	const hasNote = !!adj.note;
	const singleItem =
		adj.lines.length === 1 ? resolveItemName(adj.lines[0].stock_item_id, stockItems) : null;
	const totalUnits =
		adj.lines.length > 1
			? adj.lines.reduce((sum, l) => sum + Math.abs(l.qty_after - l.qty_before), 0)
			: 0;

	const onlyLine = adj.lines.length === 1 ? adj.lines[0] : null;
	const delta = onlyLine ? onlyLine.qty_after - onlyLine.qty_before : 0;

	return (
		<div>
			{desk ? (
				<button
					onClick={onToggle}
					aria-expanded={expanded}
					className={`${DESK_GRID} w-full px-4 py-2 text-left border-b border-border-subtle/60 hover:bg-surface-raised/40 transition-colors`}
				>
					<span
						className="text-xs tabular-nums whitespace-nowrap text-text-secondary"
						title={absTime(adj.created_at)}
					>
						{shortStamp(adj.created_at)}
					</span>
					<span>
						<span
							className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TYPE_BADGE[adj.type]}`}
							aria-label={typeName(adj.type)}
						>
							{badgeLabel(adj.type)}
						</span>
					</span>
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="truncate text-sm text-text-primary" title={singleItem ?? undefined}>
							{singleItem ?? t("restock.nItems", { count: adj.lines.length })}
						</span>
						{hasNote && (
							<FileText size={12} className="shrink-0 text-text-faint" aria-label={t("history.hasNote")} />
						)}
					</span>
					<span className="text-right tabular-nums whitespace-nowrap">
						{onlyLine ? (
							<>
								<span
									className={`text-sm font-semibold ${
										delta > 0 ? "text-success" : delta < 0 ? "text-error-text" : "text-text-muted"
									}`}
								>
									{delta > 0 ? `+${delta}` : delta}
								</span>
								<span className="ml-1.5 text-[11px] text-text-faint">
									{onlyLine.qty_before}→{onlyLine.qty_after}
								</span>
							</>
						) : (
							<span className="text-xs text-text-muted">{t("history.nUnits", { count: totalUnits })}</span>
						)}
					</span>
					<span className="truncate text-xs text-text-muted">{actor ?? "—"}</span>
					<Expander expanded={expanded} />
				</button>
			) : (
			<button
				onClick={onToggle}
				className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-surface-raised/40 transition-colors text-left border-b border-border-subtle/60"
			>
				<span
					className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${TYPE_BADGE[adj.type]}`}
					aria-label={typeName(adj.type)}
				>
					{badgeLabel(adj.type)}
				</span>
				<div className="flex-1 min-w-0">
					<span className="text-sm text-text-primary">
						{singleItem ??
							`${t("restock.nItems", { count: adj.lines.length })} · ${t("history.nUnits", { count: totalUnits })}`}
					</span>
					{(isWarehouse || hasNote) && (
						<div className="flex items-center gap-1.5 mt-0.5">
							{isWarehouse && (
								<span className="text-[10px] font-medium bg-success/10 text-success px-1 py-0.5 rounded">
									{t("history.warehousePlus")}
								</span>
							)}
							{hasNote && <FileText size={10} className="text-text-faint" />}
						</div>
					)}
				</div>
				<div className="flex items-center gap-2 flex-shrink-0 text-right">
					<div>
						{actor && (
							<div className="text-[10px] text-text-muted whitespace-nowrap">{t("history.by", { name: actor })}</div>
						)}
						<div className="text-[10px] text-text-faint">{relativeTime(adj.created_at)}</div>
					</div>
					<ChevronDown
						size={13}
						className={`text-text-muted flex-shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
					/>
				</div>
			</button>
			)}

			{expanded && (
				<div className="px-4 py-2.5 border-b border-border bg-surface/30">
					<div className="space-y-1 mb-2.5">
						{adj.lines.map((line: VehicleStockAdjustmentLine) => {
							const delta = line.qty_after - line.qty_before;
							const itemName = resolveItemName(line.stock_item_id, stockItems);
							const showItemNames = adj.lines.length > 1;
							return (
								<div key={line.id}>
									<div className={`grid ${showItemNames ? "grid-cols-[1fr_auto_auto]" : "grid-cols-[1fr_auto]"} items-center gap-3 py-0.5`}>
										{showItemNames && (
											<span className="text-sm text-text-primary truncate">{itemName}</span>
										)}
										<span className="text-xs text-text-muted tabular-nums whitespace-nowrap">
											{line.qty_before} → {line.qty_after}
										</span>
										<span
											className={`text-sm font-semibold tabular-nums w-10 text-right ${
												delta > 0 ? "text-success" : delta < 0 ? "text-error-text" : "text-text-muted"
											}`}
										>
											{delta > 0 ? `+${delta}` : `${delta}`}
										</span>
									</div>
									{adj.type === "warehouse_exchange" && line.inventory_impact !== 0 && (
										<div className="text-[11px] text-success pb-1">
											{t("history.warehouseImpact", {
												n: line.inventory_impact > 0 ? `+${line.inventory_impact}` : line.inventory_impact,
											})}
										</div>
									)}
								</div>
							);
						})}
					</div>
					{adj.note && <p className="text-xs text-text-muted italic mb-2">"{adj.note}"</p>}
					<p className="text-[10px] text-text-faint">{absTime(adj.created_at)}</p>
				</div>
			)}
		</div>
	);
}

function RestockRow({
	record,
	stockItems,
	expanded,
	onToggle,
	desk = false,
}: {
	record: VehicleRestockRecord;
	stockItems: VehicleStockItem[];
	expanded: boolean;
	onToggle: () => void;
	desk?: boolean;
}) {
	const { t } = useTranslation();
	const person = record.completed_by?.name ?? record.completed_by_tech?.name;
	const totalItems = record.restock_lines.length;
	const totalUnits = record.restock_lines.reduce((sum, l) => sum + l.qty_restocked, 0);
	const date = new Date(record.completed_at).toLocaleDateString(i18n.language, {
		month: "short", day: "numeric", year: "numeric",
	});
	const time = timeOf(new Date(record.completed_at));
	const isPrepare = record.mode === "prepare";
	const shortLines = record.restock_lines.filter((l) => l.qty_shortfall > 0).length;
	const modeLabel = t(isPrepare ? "history.prepare" : "restock.modeRestock");
	const itemsLabel = totalItems > 0 ? t("restock.nItems", { count: totalItems }) : t("history.noItems");
	const modeBadge = (
		<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 uppercase tracking-wider ${
			isPrepare ? "bg-primary/15 text-primary" : "bg-surface-raised border border-border text-text-muted"
		}`}>
			{modeLabel}
		</span>
	);

	return (
		<div>
			{desk ? (
				<button
					onClick={onToggle}
					aria-expanded={expanded}
					className={`${DESK_GRID} w-full px-4 py-2 text-left border-b border-border-subtle/60 hover:bg-surface-raised/40 transition-colors`}
				>
					<span
						className="text-xs tabular-nums whitespace-nowrap text-text-secondary"
						title={absTime(record.completed_at)}
					>
						{shortStamp(record.completed_at)}
					</span>
					<span>{modeBadge}</span>
					<span className="flex min-w-0 items-center gap-1.5 text-sm text-text-primary">
						{itemsLabel}
						{shortLines > 0 && (
							<span className="text-xs text-warning-text">· {t("history.shortN", { count: shortLines })}</span>
						)}
					</span>
					<span className="text-right text-sm font-semibold tabular-nums text-success">
						{totalUnits > 0 ? `+${totalUnits}` : "—"}
					</span>
					<span className="truncate text-xs text-text-muted">{person ?? "—"}</span>
					<Expander expanded={expanded} />
				</button>
			) : (
			<button
				onClick={onToggle}
				className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-surface-raised/40 transition-colors text-left border-b border-border-subtle/60"
			>
				<span className="text-sm font-semibold text-text-primary flex-shrink-0">{date}</span>
				{modeBadge}
				<span className="text-xs text-text-muted flex-1 min-w-0 truncate">
					{totalItems > 0 ? `${itemsLabel} · +${totalUnits}` : itemsLabel}
				</span>
				<div className="flex items-center gap-2 flex-shrink-0">
					{person && (
						<span className="text-[10px] text-text-muted whitespace-nowrap">{person} · {time}</span>
					)}
					<ChevronDown
						size={13}
						className={`text-text-muted flex-shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
					/>
				</div>
			</button>
			)}

			{expanded && (
				<div className="px-4 py-2.5 border-b border-border bg-surface/30">
					{record.restock_lines.length > 0 ? (
						<div className="space-y-1.5 mb-2.5">
							{record.restock_lines.map((line) => (
								<div key={line.id} className="flex items-center gap-2.5">
									<span className="text-[10px] font-bold text-success tabular-nums bg-success/10 px-1.5 py-0.5 rounded flex-shrink-0">
										+{line.qty_restocked}
									</span>
									<span
										className="text-sm text-text-primary truncate"
										title={resolveItemName(line.stock_item_id, stockItems)}
									>
										{resolveItemName(line.stock_item_id, stockItems)}
									</span>
									{line.qty_shortfall > 0 && (
										<span className="text-[10px] text-warning-text flex-shrink-0">
											{t("restock.nShort", { count: line.qty_shortfall })}
										</span>
									)}
								</div>
							))}
						</div>
					) : (
						<p className="text-xs text-text-muted mb-2.5">{t("history.noneRestocked")}</p>
					)}
					{record.notes && <p className="text-xs text-text-muted italic mb-2">"{record.notes}"</p>}
					<p className="text-[10px] text-text-faint">{absTime(record.completed_at)}</p>
				</div>
			)}
		</div>
	);
}

export default function StockHistorySection({
	vehicleId,
	stockItems,
	density = "touch",
}: {
	vehicleId: string;
	stockItems: VehicleStockItem[];
	/** "touch" (technician sheet): full-width thumb-sized switch. "desk"
	 *  (dispatch vehicle page): the compact boxed switch every other
	 *  dispatch panel uses — full width there read as a page-wide banner. */
	density?: "touch" | "desk";
}) {
	const { t } = useTranslation();
	const [activeTab, setActiveTab] = useState<HistoryTab>("adjustments");
	const [typeFilter, setTypeFilter] = useState<FilterType>("all");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [expandedRestockId, setExpandedRestockId] = useState<string | null>(null);

	const filterScrollRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);

	const checkFilterScroll = useCallback(() => {
		const el = filterScrollRef.current;
		if (!el) return;
		setCanScrollLeft(el.scrollLeft > 0);
		setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
	}, []);

	useEffect(() => {
		const el = filterScrollRef.current;
		if (!el) return;
		checkFilterScroll();
		const ro = new ResizeObserver(checkFilterScroll);
		ro.observe(el);
		el.addEventListener("scroll", checkFilterScroll, { passive: true });
		return () => {
			ro.disconnect();
			el.removeEventListener("scroll", checkFilterScroll);
		};
	}, [checkFilterScroll]);

	const scrollFilterBy = (dir: -1 | 1) =>
		filterScrollRef.current?.scrollBy({ left: dir * 120, behavior: "smooth" });

	const { data: adjustments = [], isLoading: adjLoading } =
		useVehicleStockAdjustmentHistoryQuery(vehicleId, true);
	const { data: restockRecords = [], isLoading: restockLoading } =
		useVehicleRestockHistoryQuery(vehicleId, true);

	const filtered =
		typeFilter === "all" ? adjustments : adjustments.filter((a) => a.type === typeFilter);

	const handleToggle = (id: string) => setExpandedId((prev) => (prev === id ? null : id));
	const handleRestockToggle = (id: string) => setExpandedRestockId((prev) => (prev === id ? null : id));

	const desk = density === "desk";

	const typeChip = (type: FilterType) => (
		<button
			key={type}
			onClick={() => setTypeFilter(type)}
			title={type === "all" ? t("history.allTypes") : typeName(type)}
			aria-pressed={typeFilter === type}
			className={`whitespace-nowrap text-[11px] px-2.5 py-1 rounded-full border transition-colors flex-shrink-0 ${
				typeFilter === type
					? "bg-primary/15 border-primary/30 text-primary font-medium"
					: "bg-surface border-border text-text-tertiary hover:border-border-strong hover:text-text-secondary"
			}`}
		>
			{type === "all" ? t("history.all") : badgeLabel(type)}
		</button>
	);

	const noTypeMsg = typeFilter !== "all" ? t("history.noTypeAdj", { type: typeName(typeFilter) }) : "";

	const modeToggle = (
		<SegmentedToggle<HistoryTab>
			ariaLabel={t("history.historyType")}
			value={activeTab}
			onChange={setActiveTab}
			fullWidth={!desk}
			variant={desk ? "boxed" : "flat"}
			options={[
				{ id: "adjustments", label: t("history.adjustments"), badge: adjustments.length },
				{ id: "restock", label: t("restock.modeRestock"), badge: restockRecords.length },
			]}
		/>
	);

	const skeleton = (
		<div className="space-y-0">
			{[0, 1, 2].map((i) => (
				<div key={i} className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle/60 animate-pulse">
					<div className="w-24 h-4 bg-surface rounded" />
					<div className="flex-1 h-4 bg-surface/60 rounded" />
					<div className="w-16 h-4 bg-surface/40 rounded" />
				</div>
			))}
		</div>
	);

	if (desk) {
		// One control row (mode switch left, type filters right), then a ledger
		// with sticky column headings that scrolls inside a cap instead of
		// growing the page. The selected chip already says what is filtered, so
		// the touch sheet's "Filtered: … Clear" bar is not repeated here.
		return (
			<div>
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-subtle px-4 py-3">
					{modeToggle}
					{activeTab === "adjustments" && (
						<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("history.adjType")}>
							{(["all", ...ALL_TYPES] as FilterType[]).map(typeChip)}
						</div>
					)}
				</div>

				{activeTab === "adjustments" &&
					(adjLoading ? (
						skeleton
					) : filtered.length === 0 ? (
						<div className="py-8 text-center">
							<p className="text-sm text-text-muted">
								{noTypeMsg || t("history.noAdj")}
							</p>
						</div>
					) : (
						<div className="max-h-[min(520px,50vh)] overflow-y-auto">
							<DeskHeader
								labels={[
									t("history.col.when"),
									t("history.col.type"),
									t("history.col.item"),
									t("history.col.change"),
									t("history.col.by"),
								]}
							/>
							{filtered.map((adj) => (
								<AdjRow
									key={adj.id}
									adj={adj}
									stockItems={stockItems}
									expanded={expandedId === adj.id}
									onToggle={() => handleToggle(adj.id)}
									desk
								/>
							))}
							{adjustments.length >= 50 && (
								<p className="text-center text-[11px] text-text-faint py-3">
									{t("history.recentAdj")}
								</p>
							)}
						</div>
					))}

				{activeTab === "restock" &&
					(restockLoading ? (
						skeleton
					) : restockRecords.length === 0 ? (
						<p className="text-sm text-text-muted text-center py-8">{t("history.noRestock")}</p>
					) : (
						<div className="max-h-[min(520px,50vh)] overflow-y-auto">
							<DeskHeader
								labels={[
									t("history.col.when"),
									t("history.col.mode"),
									t("history.col.items"),
									t("history.col.restocked"),
									t("history.col.by"),
								]}
							/>
							{restockRecords.map((record) => (
								<RestockRow
									key={record.id}
									record={record}
									stockItems={stockItems}
									expanded={expandedRestockId === record.id}
									onToggle={() => handleRestockToggle(record.id)}
									desk
								/>
							))}
							{restockRecords.length >= 50 && (
								<p className="text-center text-[11px] text-text-faint py-3">
									{t("history.recentRec")}
								</p>
							)}
						</div>
					))}
			</div>
		);
	}

	return (
		<div>
			{/* Same control as the Warehouse Restock and Add/Remove switches — this
			    was the third hand-rolled mode switch on the technician sheet, and
			    underline tabs read as page-level navigation rather than a filter on
			    the list below. Counts ride along as badges. No rule beneath: the
			    control's own border closes it. */}
			<div className="px-3 py-2">{modeToggle}</div>

			{activeTab === "adjustments" && (
				<>
					{/* Type filter chips with overflow arrows */}
					<div className="relative flex items-center border-b border-border-subtle/60">
						{canScrollLeft && (
							<button
								onClick={() => scrollFilterBy(-1)}
								className="absolute left-0 z-10 flex items-center justify-center w-7 h-full bg-gradient-to-r from-canvas via-canvas/90 to-transparent text-text-muted hover:text-text-secondary transition-colors flex-shrink-0"
								aria-label={t("history.scrollLeft")}
							>
								<ChevronLeft size={13} />
							</button>
						)}
						<div
							ref={filterScrollRef}
							className="flex items-center gap-1.5 px-4 py-2 overflow-x-auto scrollbar-none flex-1 min-w-0"
						>
							{(["all", ...ALL_TYPES] as FilterType[]).map(typeChip)}
						</div>
						{canScrollRight && (
							<button
								onClick={() => scrollFilterBy(1)}
								className="absolute right-0 z-10 flex items-center justify-center w-7 h-full bg-gradient-to-l from-canvas via-canvas/90 to-transparent text-text-muted hover:text-text-secondary transition-colors flex-shrink-0"
								aria-label={t("history.scrollRight")}
							>
								<ChevronRight size={13} />
							</button>
						)}
					</div>
					{typeFilter !== "all" && (
						<div className="flex items-center gap-2 px-4 py-1.5 border-b border-border-subtle/40 bg-primary/5">
							<span className="text-[11px] text-text-muted">
								{t("history.filtered")} <span className="text-primary font-medium">{typeName(typeFilter)}</span>
							</span>
							<button
								onClick={() => setTypeFilter("all")}
								className="text-[11px] text-text-faint hover:text-primary ml-auto transition-colors"
							>
								{t("history.clearX")}
							</button>
						</div>
					)}

					{adjLoading ? (
						<div className="space-y-0">
							{[0, 1, 2].map((i) => (
								<div key={i} className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle/60 animate-pulse">
									<div className="w-24 h-4 bg-surface rounded" />
									<div className="flex-1 h-4 bg-surface/60 rounded" />
									<div className="w-16 h-4 bg-surface/40 rounded" />
								</div>
							))}
						</div>
					) : filtered.length === 0 ? (
						<div className="py-8 text-center">
							{typeFilter !== "all" ? (
								<>
									<p className="text-sm text-text-muted">
										{noTypeMsg}
									</p>
									<button
										onClick={() => setTypeFilter("all")}
										className="text-xs text-primary mt-2 hover:underline"
									>
										{t("history.clearFilter")}
									</button>
								</>
							) : (
								<p className="text-sm text-text-muted">{t("history.noAdj")}</p>
							)}
						</div>
					) : (
						<div>
							{filtered.map((adj) => (
								<AdjRow
									key={adj.id}
									adj={adj}
									stockItems={stockItems}
									expanded={expandedId === adj.id}
									onToggle={() => handleToggle(adj.id)}
								/>
							))}
							{adjustments.length >= 50 && (
								<p className="text-center text-[11px] text-text-faint py-3">
									{t("history.recentAdj")}
								</p>
							)}
						</div>
					)}
				</>
			)}

			{activeTab === "restock" && (
				<>
					{restockLoading ? (
						<div className="space-y-0">
							{[0, 1, 2].map((i) => (
								<div key={i} className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle/60 animate-pulse">
									<div className="w-24 h-4 bg-surface rounded" />
									<div className="flex-1 h-4 bg-surface/60 rounded" />
									<div className="w-16 h-4 bg-surface/40 rounded" />
								</div>
							))}
						</div>
					) : restockRecords.length === 0 ? (
						<p className="text-sm text-text-muted text-center py-8">{t("history.noRestock")}</p>
					) : (
						<div>
							{restockRecords.map((record) => (
								<RestockRow
									key={record.id}
									record={record}
									stockItems={stockItems}
									expanded={expandedRestockId === record.id}
									onToggle={() => handleRestockToggle(record.id)}
								/>
							))}
							{restockRecords.length >= 50 && (
								<p className="text-center text-[11px] text-text-faint py-3">
									{t("history.recentRec")}
								</p>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
