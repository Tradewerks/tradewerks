import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, Edit2, MoreVertical, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useInventoryItemQuery, useDeleteInventoryItemMutation } from "../../hooks/useInventory";
import { useTrackingEligibilityQuery } from "../../hooks/useTracking";
import { usePermission } from "../../hooks/usePermission";
import { useToast } from "../../components/ui/useToast";
import {
	formatDate,
	getItemStockStatus,
	getStatusBadgeClass,
	getStatusLabel,
} from "../../util/util";
import { unitDef } from "../../lib/units";
import ImageCarousel from "../../components/inventory/ImageCarousel";
import { TrackingBadges } from "../../components/inventory/TrackingBadges";
import LocationValue from "../../components/inventory/LocationValue";
import AddToLabelQueueButton from "../../components/inventory/labels/AddToLabelQueueButton";
import LabelQueueButton from "../../components/inventory/labels/LabelQueueButton";
import LabelQueueToast from "../../components/inventory/labels/LabelQueueToast";
import CreateInventoryItem from "../../components/inventory/CreateInventoryItem";
import ReceiveStockModal from "../../components/inventory/tracking/ReceiveStockModal";
import ItemStatRow from "../../components/inventory/detail/ItemStatRow";
import CostPricingCard from "../../components/inventory/detail/CostPricingCard";
import TrackingSummaryStats from "../../components/inventory/detail/TrackingSummaryStats";
import SerialsTable from "../../components/inventory/detail/SerialsTable";
import SerialDetailDrawer from "../../components/inventory/tracking/SerialDetailDrawer";
import AdjustStockModal from "../../components/inventory/AdjustStockModal";
import BatchesTable from "../../components/inventory/detail/BatchesTable";
import StockMovementList from "../../components/inventory/detail/StockMovementList";
import UsageReport from "../../components/inventory/detail/UsageReport";
import ConsumptionTrendChart from "../../components/inventory/detail/ConsumptionTrendChart";
import StockLevelChart from "../../components/inventory/detail/StockLevelChart";
import ReorderHealthCard from "../../components/inventory/detail/ReorderHealthCard";
import ReorderHealthMini from "../../components/inventory/detail/ReorderHealthMini";
import StockPlacementCard from "../../components/inventory/detail/StockPlacementCard";
import ItemSuppliersCard from "../../components/inventory/detail/ItemSuppliersCard";
import UntrackedAllocationCard from "../../components/inventory/detail/UntrackedAllocationCard";
import UnitTrackingEmptyState from "../../components/inventory/detail/UnitTrackingEmptyState";
import CostPriceTrendChart from "../../components/inventory/detail/CostPriceTrendChart";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import SegmentedToggle from "../../components/ui/SegmentedToggle";

const MENU_ITEM =
	"w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed";

type Tab = "overview" | "tracking" | "history";

const TABS: { id: Tab; label: string }[] = [
	{ id: "overview", label: "Overview" },
	{ id: "tracking", label: "Tracking" },
	// "History" rather than "History & Reports": the tab has no export and
	// nothing report-shaped that the org-wide reporting surfaces own. The id
	// stays `history` so existing deep links and params keep working.
	{ id: "history", label: "History" },
];

// One range control for the whole History tab, driving the stock chart, the
// consumption chart, and the ledger. `bucket` is DERIVED from the range rather
// than being a second control: at 90 days or less weekly buckets read well, and
// past that monthly ones do. `days: null` = the item's whole ledger.
//
// The forecast card deliberately ignores this — its window is pinned at 90 days
// to match the org-wide reorder report, and it labels itself as such.
const HISTORY_RANGES = [
	{ id: "30d", label: "30d", days: 30, bucket: "week" as const },
	{ id: "90d", label: "90d", days: 90, bucket: "week" as const },
	{ id: "6mo", label: "6mo", days: 182, bucket: "month" as const },
	{ id: "1yr", label: "1yr", days: 365, bucket: "month" as const },
	{ id: "all", label: "All", days: null, bucket: "month" as const },
] as const;

type HistoryRangeId = (typeof HISTORY_RANGES)[number]["id"];

const DAY_MS = 24 * 60 * 60 * 1000;

// Alt IDs shown before the list collapses behind "+N more". Four fits one row of
// the Details grid at every layout width.
const ALT_ID_PREVIEW = 4;

// Below this, a description can't fill the 6-line clamp at any layout width, so
// offering "Show more" would toggle nothing.
const DESCRIPTION_CLAMP_CHARS = 400;

// `wide` spans the whole row rather than a hardcoded 3 columns: the Details grid
// is 4-wide in the split layout below, where `sm:col-span-3` left a stray empty
// cell beside Description.
function Field({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
	return (
		<div className={wide ? "col-span-full" : ""}>
			<div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
				{label}
			</div>
			<div className="text-sm text-text-secondary mt-0.5 break-words">
				{value ?? "—"}
			</div>
		</div>
	);
}

export default function InventoryItemDetailPage() {
	const { itemId } = useParams<{ itemId: string }>();
	const navigate = useNavigate();
	const canManage = usePermission("manage_inventory");
	const { data: item, isLoading, isError } = useInventoryItemQuery(itemId);
	// Lifetime serial/lot counts. An item whose tracking was turned off keeps its
	// rows, and this is what tells the Tracking tab to render them as archive
	// rather than claiming the item was never tracked.
	const { data: trackingEligibility } = useTrackingEligibilityQuery(itemId ?? "");

	// Tab lives in the URL, not component state, so deep links (e.g. from the
	// reorder report) can open a specific tab. Unknown/absent values fall back
	// to overview rather than rendering nothing.
	const [searchParams, setSearchParams] = useSearchParams();
	const tabParam = searchParams.get("tab");
	const activeTab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : "overview";
	const setActiveTab = (tab: Tab) => {
		const next = new URLSearchParams(searchParams);
		if (tab === "overview") next.delete("tab");
		else next.set("tab", tab);
		// replace, not push — same reasoning as `?serial=` and `?range=`: tabs are
		// a lens on one page, and pushing buried the page the dispatcher came from
		// behind every tab they had read through.
		setSearchParams(next, { replace: true });
	};

	// Serial drill-in is a drawer over this page, not a route away from it —
	// SerialsTable holds its filter, cursor, loaded rows and bulk selection in
	// component state, all of which a navigation destroyed. The id still lives
	// in the URL so a unit stays linkable and the old standalone route can
	// redirect here (see SerialRedirectPage).
	const openSerialId = searchParams.get("serial");
	const setOpenSerialId = (serialId: string | null) => {
		const next = new URLSearchParams(searchParams);
		if (serialId) next.set("serial", serialId);
		else next.delete("serial");
		// replace, not push — opening and closing units during an audit should
		// not bury the page the dispatcher actually wants to go back to.
		setSearchParams(next, { replace: true });
	};

	// URL-persisted for the same reason `tab` is: the History tab was made
	// deep-linkable so the reorder report could point at an item's history, but
	// the range it was read at didn't survive the link, a refresh, or a back.
	const rangeParam = searchParams.get("range");
	const historyRange: HistoryRangeId = HISTORY_RANGES.some((r) => r.id === rangeParam)
		? (rangeParam as HistoryRangeId)
		: "90d";
	const setHistoryRange = (next: HistoryRangeId) => {
		const params = new URLSearchParams(searchParams);
		if (next === "90d") params.delete("range");
		else params.set("range", next);
		// replace, not push — the range chips are a lens on one page, not
		// navigation. Same reasoning as `?serial=`.
		setSearchParams(params, { replace: true });
	};
	const range = HISTORY_RANGES.find((r) => r.id === historyRange) ?? HISTORY_RANGES[1];
	// Sent to the four range-aware endpoints as `created_after`; undefined = all.
	const historyCreatedAfter =
		range.days != null
			? new Date(Date.now() - range.days * DAY_MS).toISOString()
			: undefined;
	// Shared x-domain so the stock curve and the consumption bars line up. Only
	// meaningful for a bounded range — "All" lets each chart use its own extent.
	const historyXDomain: [number, number] | undefined =
		range.days != null ? [Date.now() - range.days * DAY_MS, Date.now()] : undefined;
	// Bucket count for the consumption endpoint, derived from the same range.
	const consumptionRange =
		range.days != null
			? Math.max(1, Math.ceil(range.days / (range.bucket === "week" ? 7 : 30)))
			: undefined;

	const [editOpen, setEditOpen] = useState(false);
	const [receiveOpen, setReceiveOpen] = useState(false);
	const [adjustOpen, setAdjustOpen] = useState(false);
	const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
	// Deleting an item is irreversible, so it goes through ConfirmDialog like
	// every other destructive action here — not a "click again" menu item.
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	// Description (5000-character cap) and Alt IDs (no cap at all) are the two
	// fields that can own the whole Details card on their own, so both render
	// clamped behind an explicit expander rather than being allowed to.
	const [descExpanded, setDescExpanded] = useState(false);
	const [altIdsExpanded, setAltIdsExpanded] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const del = useDeleteInventoryItemMutation();
	const toast = useToast();

	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
				setIsActionsMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">
					Loading item details...
				</div>
			</div>
		);
	}

	if (isError || !item) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Item not found</div>
			</div>
		);
	}

	const isTracked = item.is_serialized || item.is_batch_tracked;
	// Tracking was turned off but the units/lots survive (consumed serials are
	// never deleted, drained lots keep their recall history). The tab stays
	// populated and read-only instead of pretending the history doesn't exist.
	const archivedSerials = !item.is_serialized
		? (trackingEligibility?.history_serials ?? 0)
		: 0;
	const archivedLots = !item.is_batch_tracked ? (trackingEligibility?.history_lots ?? 0) : 0;
	const hasArchivedTracking = archivedSerials > 0 || archivedLots > 0;
	const stockStatus = getItemStockStatus(item);

	// Overview has two layouts, chosen by how much the rail actually has to say:
	//
	//   "rail"  — Details + Cost stacked in a 2/3 main column, rail beside them.
	//             Anything with images or tracking fills a third of the width.
	//   "split" — an untracked, imageless item's rail is two small cards, which
	//             can't hold a column beside a 550px-tall stack. So Details goes
	//             full width and Cost pairs off against the rail below it.
	//
	// The old thin-rail remedy was to drop the grid to two columns, which made it
	// worse: the underfilled column GREW from a third of the width to half of it.
	const hasImages = item.image_urls.length > 0;
	const overviewLayout: "rail" | "split" =
		!hasImages && !isTracked && !hasArchivedTracking ? "split" : "rail";

	const handleEdit = () => {
		if (!canManage) return;
		setIsActionsMenuOpen(false);
		setEditOpen(true);
	};

	const handleReceiveOrAdjust = () => {
		if (!canManage) return;
		setIsActionsMenuOpen(false);
		if (isTracked) setReceiveOpen(true);
		else setAdjustOpen(true);
	};

	const handleDelete = async () => {
		if (!canManage) return;
		setDeleteError(null);
		try {
			await del.mutateAsync(item.id);
			toast.success("Item deleted");
			navigate("/dispatch/inventory");
		} catch (e) {
			const message = e instanceof Error ? e.message : "Failed to delete item";
			setDeleteError(message);
			toast.error(message);
		}
	};

	// Overview's blocks, built once and only PLACED by `overviewLayout` below. The
	// two layouts differ in arrangement alone, so neither branch gets its own copy
	// of a card to drift out of sync.
	const detailsCard = (
		<Card title="Details">
			<div
				className={`grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 ${
					// Full width in the split layout, so three columns of short
					// fields would leave long gutters.
					overviewLayout === "split" ? "lg:grid-cols-4" : ""
				}`}
			>
				<Field label="Location" value={<LocationValue location={item.location} />} />
				<Field label="Category" value={item.category} />
				{/* The configured value, so this one DOES name the unit — but as
				    its catalog label ("Each", "Feet"), not the stored code. */}
				<Field label="Unit" value={unitDef(item.unit).label} />
				<Field
					label="Low-stock Threshold"
					value={item.low_stock_threshold ?? "Not set"}
				/>
				{/* Chips, not a joined string: twelve 100-character alternates
				    joined with commas is a 1200-character run with barely any break
				    opportunities, which stretched this cell and squeezed every other
				    field in the grid. */}
				<Field
					label="Alt IDs"
					value={
						item.alt_ids?.length ? (
							<div className="flex flex-wrap items-center gap-1.5 mt-0.5">
								{(altIdsExpanded
									? item.alt_ids
									: item.alt_ids.slice(0, ALT_ID_PREVIEW)
								).map((altId) => (
									<span
										key={altId}
										title={altId}
										className="text-[11px] font-mono px-2 py-0.5 rounded bg-surface border border-border-subtle text-text-secondary max-w-[220px] truncate"
									>
										{altId}
									</span>
								))}
								{item.alt_ids.length > ALT_ID_PREVIEW && (
									<button
										type="button"
										onClick={() => setAltIdsExpanded((v) => !v)}
										className="text-[11px] font-medium text-primary hover:underline"
									>
										{altIdsExpanded
											? "Show fewer"
											: `+${item.alt_ids.length - ALT_ID_PREVIEW} more`}
									</button>
								)}
							</div>
						) : (
							"—"
						)
					}
				/>
				<Field
					label="Stock Alerts"
					value={
						item.alert_emails_enabled
							? item.alert_email || "Enabled"
							: "Off"
					}
				/>
				<Field label="Created" value={formatDate(item.created_at)} />
				<Field label="Updated" value={formatDate(item.updated_at)} />
				{item.tags && item.tags.length > 0 && (
					<Field
						label="Tags"
						wide
						value={
							<div className="flex flex-wrap gap-1.5 mt-0.5">
								{item.tags.map((t) => (
									<span
										key={t.id}
										title={t.label}
										className="text-[11px] px-2 py-0.5 rounded-full bg-surface border border-border-subtle text-text-secondary max-w-[220px] truncate"
									>
										{t.label}
									</span>
								))}
							</div>
						}
					/>
				)}
				<Field
					label="Description"
					wide
					value={
						item.description ? (
							<>
								<div className={descExpanded ? "" : "line-clamp-6"}>
									{item.description}
								</div>
								{item.description.length > DESCRIPTION_CLAMP_CHARS && (
									<button
										type="button"
										onClick={() => setDescExpanded((v) => !v)}
										className="mt-1 text-[11px] font-medium text-primary hover:underline"
									>
										{descExpanded ? "Show less" : "Show more"}
									</button>
								)}
							</>
						) : (
							"—"
						)
					}
				/>
			</div>
		</Card>
	);

	const costCard = (
		<CostPricingCard item={item} onViewHistory={() => setActiveTab("history")} />
	);

	// The rail. In "rail" it runs the full height beside the main stack; in "split"
	// it pairs off against Cost & Pricing on one row. Same blocks either way.
	//
	// Reorder health leads the rail, above the carousel: it is the only block on
	// this tab carrying an action implication ("Reorder now"), and behind an image
	// it started roughly 1000px down the page — below the fold on a 900px viewport.
	// The carousel is reference material, so it follows and also lost 64px.
	const railStack = (
		<div className="lg:col-span-1 flex h-full flex-col gap-6">
			{/* `flex-1 grid` with a `max-h` clamp: three short lines of text
			    stretched to match a tall StockPlacementCard just reads as
			    broken, all padding and no content. Capped, it takes a little
			    of the surplus height (clean, bounded) and the flex algorithm
			    hands the rest to StockPlacementCard below automatically once
			    this one freezes at its cap — no manual ratio to keep in sync.
			    The carousel stays a fixed h-56 either way — stretching a
			    photo frame would distort the image, not just add room. */}
			<div className="flex-1 grid max-h-28">
				<ReorderHealthMini
					itemId={item.id}
					onViewHistory={() => setActiveTab("history")}
				/>
			</div>

			{hasImages && (
				<ImageCarousel
					images={item.image_urls}
					objectFit="contain"
					frameClassName="w-full h-56"
				/>
			)}

			{/* Unconditional, and the single answer to "where is this stock" for
			    every tracking state — it absorbed TrackingSummaryCard, which used
			    to sit here restating the same warehouse-vs-vehicle axis from a
			    different source. `archived` = tracking off but units/lots survive,
			    which is the one state where the live split and the historical
			    records are both worth having.

			    Wrapped in `flex-1 grid`, same as the strip above: `flex-1` grows
			    the wrapper to close the gap when the other column runs taller
			    (the grid row is stretched — see the two `grid-cols-3` wrappers
			    below); `grid` then stretches the Card itself to fill that
			    wrapper on BOTH axes, so it stays full column width instead of
			    shrinking to its content width the way a row-flex child would. */}
			<div className="flex-1 grid">
				<StockPlacementCard
					item={item}
					archived={!isTracked && hasArchivedTracking}
					onViewAll={() => setActiveTab("tracking")}
				/>
			</div>
		</div>
	);

	// Full width, below both the main stack and the rail, in either layout. Its
	// row count doesn't track with Details or Cost: an unbounded block in the
	// rail would let a long supplier list end the rail column somewhere the
	// main column never could. Full width, it's the tab's closing element
	// instead: whichever column ran taller above it, the page always finishes
	// on the same wide edge.
	const suppliersBand = <ItemSuppliersCard itemId={item.id} unit={item.unit} />;

	return (
		<div className="text-text-primary space-y-6">
			{/* Header */}
			<div className="grid grid-cols-2 gap-4 mb-6 items-center">
				<div className="min-w-0">
					<div className="flex items-center gap-2.5 flex-wrap mb-1">
						{/* Clamped at two lines: a 255-character name at this size
						    ran five lines deep and pushed the tab strip below the
						    fold. The full name stays in the title. */}
						<h1
							className="text-3xl font-bold text-text-primary break-words line-clamp-2 min-w-0"
							title={item.name}
						>
							{item.name}
						</h1>
						<TrackingBadges
							item={item}
							archived={hasArchivedTracking}
						/>
						{!item.is_active && (
							<span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-surface-raised text-text-tertiary border border-border-strong">
								Inactive
							</span>
						)}
					</div>
					{/* Both codes truncate rather than wrap: they carry no spaces
					    (a 100-character SKU and a 200-character barcode are legal),
					    so unclamped they ran across the actions column and gave the
					    page a horizontal scrollbar. */}
					<div className="flex items-center gap-3 text-text-tertiary text-sm font-mono min-w-0">
						{item.sku && (
							<span className="min-w-0 truncate" title={item.sku}>
								SKU: {item.sku}
							</span>
						)}
						{item.barcode && (
							<span className="min-w-0 truncate" title={item.barcode}>
								· {item.barcode}
							</span>
						)}
					</div>
				</div>

				<div className="justify-self-end flex items-center gap-3">
					{/* Same queue the inventory list header reads — appears here the
					    moment anything is queued, so serials/batches added from the
					    Tracking tab have a visible running total and a way out. */}
					<LabelQueueButton />

					<span
						className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${getStatusBadgeClass(stockStatus)}`}
					>
						{getStatusLabel(stockStatus)}
					</span>

					{canManage && (
						<div className="relative" ref={menuRef}>
							<button
								aria-label="More item actions"
								aria-haspopup="menu"
								aria-expanded={isActionsMenuOpen}
								onClick={() =>
									setIsActionsMenuOpen(
										(v) => !v
									)
								}
								className="p-2 hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong"
							>
								<MoreVertical size={20} />
							</button>

							{isActionsMenuOpen && (
								<div className="absolute right-0 mt-2 w-56 bg-base border border-border-subtle rounded-lg shadow-xl z-50">
									<div className="py-1">
										<button
											onClick={
												handleEdit
											}
											className={
												MENU_ITEM
											}
										>
											<Edit2
												size={
													16
												}
											/>
											Edit Item
										</button>
										<button
											onClick={
												handleReceiveOrAdjust
											}
											className={
												MENU_ITEM
											}
										>
											{isTracked ? (
												<Plus
													size={
														16
													}
												/>
											) : (
												<SlidersHorizontal
													size={
														16
													}
												/>
											)}
											{isTracked
												? "Receive Stock"
												: "Adjust Stock"}
										</button>
										{/* Queues in place rather than
										    navigating: the header's Print
										    Labels button is the way to the
										    print page, so this can join an
										    in-progress queue without
										    abandoning it. */}
										<AddToLabelQueueButton
											item={item}
											onAdded={() =>
												setIsActionsMenuOpen(
													false
												)
											}
											className={
												MENU_ITEM
											}
										>
											Add to Label
											Queue
										</AddToLabelQueueButton>

										<div className="my-1 border-t border-border-subtle" />
										<button
											onClick={() => {
												setIsActionsMenuOpen(
													false
												);
												setDeleteError(
													null
												);
												setDeleteOpen(
													true
												);
											}}
											disabled={
												del.isPending
											}
											className={`${MENU_ITEM} text-error-text hover:enabled:text-error-text`}
										>
											<Trash2
												size={
													16
												}
											/>
											Delete Item
										</button>
									</div>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Tabs. Roving tabindex: only the selected tab is in the tab order,
			    and Left/Right/Home/End move between them — the WAI-ARIA tabs
			    pattern. Without it the strip announced itself as a tablist and
			    then behaved like three unrelated buttons. */}
			<div
				role="tablist"
				aria-label="Inventory item sections"
				className="flex border-b border-border"
			>
				{TABS.map((tab, i) => (
					<button
						key={tab.id}
						id={`tab-${tab.id}`}
						role="tab"
						aria-selected={activeTab === tab.id}
						aria-controls={`tabpanel-${tab.id}`}
						tabIndex={activeTab === tab.id ? 0 : -1}
						onClick={() => setActiveTab(tab.id)}
						onKeyDown={(e) => {
							const last = TABS.length - 1;
							let nextIndex: number | null = null;
							if (e.key === "ArrowRight")
								nextIndex = i === last ? 0 : i + 1;
							else if (e.key === "ArrowLeft")
								nextIndex = i === 0 ? last : i - 1;
							else if (e.key === "Home") nextIndex = 0;
							else if (e.key === "End") nextIndex = last;
							if (nextIndex === null) return;
							e.preventDefault();
							const next = TABS[nextIndex];
							setActiveTab(next.id);
							// Selection follows focus, so the newly selected tab
							// has to actually receive it.
							document.getElementById(
								`tab-${next.id}`
							)?.focus();
						}}
						className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
							activeTab === tab.id
								? "border-primary text-primary"
								: "border-transparent text-text-muted hover:text-text-secondary"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			{activeTab === "overview" && (
				<div
					role="tabpanel"
					id="tabpanel-overview"
					aria-labelledby="tab-overview"
					className="space-y-6"
				>
					<h2 className="sr-only">Overview</h2>
					{/* KPI row */}
					<ItemStatRow item={item} />

					{overviewLayout === "split" ? (
						<>
							{detailsCard}

							{/* Cost & Pricing paired against the rail: ~230px of
							    metrics beside ~260px of placement + reorder, so
							    neither side trails a column of whitespace. Row
							    stretches (no `items-start`) so whichever side is
							    naturally shorter grows to match — Cost fills the
							    whole column here since it's alone in it. `grid`,
							    not `flex`, on the wrapper: a row-flex child sizes
							    to its own content width and leaves the rest of the
							    column blank, where grid's default stretch fills
							    the wrapper on both axes. */}
							<div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
								<div className="grid lg:col-span-2">
									{costCard}
								</div>
								{railStack}
							</div>
						</>
					) : (
						<div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
							{/* Both cards get `flex-1 grid` here, not just Cost:
							    when the rail runs taller, the extra height splits
							    evenly across Details and Cost instead of dumping
							    it all into whichever card happens to be last. */}
							<div className="flex flex-col gap-6 lg:col-span-2">
								<div className="flex-1 grid">
									{detailsCard}
								</div>
								<div className="flex-1 grid">
									{costCard}
								</div>
							</div>
							{railStack}
						</div>
					)}

					{suppliersBand}
				</div>
			)}

			{activeTab === "tracking" && (
				<div
					role="tabpanel"
					id="tabpanel-tracking"
					aria-labelledby="tab-tracking"
					className="space-y-6"
				>
					<h2 className="sr-only">Tracking</h2>
					{!isTracked && !hasArchivedTracking ? (
						// Side by side, not stacked: this item IS tracked, just
						// not the serial/batch way — the split says that at a
						// glance instead of a bare "Not tracked" dead end. Left
						// carries real numbers; right explains and offers the
						// switch, so the contrast reads as "two dimensions of
						// tracking exist" rather than "half this page is broken."
						<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
							<UntrackedAllocationCard item={item} />
							<UnitTrackingEmptyState
								item={item}
								canManage={canManage}
								onEnableTracking={handleEdit}
							/>
						</div>
					) : (
						<>
							{/* Tracking is off but the records remain. Stated up
							    front so nobody reads a stale unit list as the
							    item's live state. */}
							{hasArchivedTracking && (
								<div className="flex items-start gap-2.5 rounded-lg border border-border-strong bg-surface px-4 py-3">
									<Archive
										size={16}
										className="mt-0.5 shrink-0 text-text-muted"
									/>
									<div className="text-sm text-text-secondary">
										<span className="font-medium text-text-primary">
											{isTracked
												? "Some tracking is turned off for this item."
												: "Tracking is turned off for this item."}
										</span>{" "}
										The{" "}
										{archivedSerials >
											0 &&
											`${archivedSerials} unit${archivedSerials === 1 ? "" : "s"}`}
										{archivedSerials >
											0 &&
											archivedLots >
												0 &&
											" and "}
										{archivedLots > 0 &&
											`${archivedLots} lot${archivedLots === 1 ? "" : "s"}`}{" "}
										below{" "}
										{archivedSerials +
											archivedLots ===
										1
											? "is a"
											: "are"}{" "}
										historical record
										{archivedSerials +
											archivedLots ===
										1
											? ""
											: "s"}{" "}
										— read-only, and
										nothing new is being
										tracked. Re-enable
										tracking from Edit
										Item while the item
										is empty.
									</div>
								</div>
							)}

							<TrackingSummaryStats
								item={item}
								archivedSerials={
									archivedSerials > 0
								}
								archivedLots={archivedLots > 0}
							/>

							{(item.is_serialized ||
								archivedSerials > 0) && (
								<Card
									title={
										item.is_serialized
											? "Serials"
											: "Serials (archived)"
									}
								>
									<SerialsTable
										itemId={item.id}
										itemName={item.name}
										onOpenSerial={
											setOpenSerialId
										}
										onReceive={
											canManage &&
											item.is_serialized
												? () =>
														setReceiveOpen(
															true
														)
												: undefined
										}
										canManage={
											canManage &&
											item.is_serialized
										}
										readOnly={
											!item.is_serialized
										}
									/>
								</Card>
							)}

							{(item.is_batch_tracked ||
								archivedLots > 0) && (
								<Card
									title={
										item.is_batch_tracked
											? "Batches"
											: "Batches (archived)"
									}
								>
									<BatchesTable
										itemId={item.id}
										itemName={item.name}
										onReceive={
											canManage &&
											item.is_batch_tracked
												? () =>
														setReceiveOpen(
															true
														)
												: undefined
										}
										readOnly={
											!item.is_batch_tracked
										}
									/>
								</Card>
							)}
						</>
					)}
				</div>
			)}

			{activeTab === "history" && (
				<div
					key={item.id}
					role="tabpanel"
					id="tabpanel-history"
					aria-labelledby="tab-history"
					className="space-y-6"
				>
					<h2 className="sr-only">History</h2>
					{/* One range control for the tab. It drives the two charts,
					    the stock ledger, and the usage-by-job list; the forecast
					    card keeps its own fixed 90d window and says so on its
					    face.
					    Boxed as its own toolbar (mirrors PageReportSection's
					    filter bar), not a bare flex row — unboxed and sitting
					    directly above ReorderHealthCard's bordered Card, it read
					    as that card's header rather than a control for the whole
					    tab. Three columns, not two spans crowded together: the
					    caption stays pinned left so it reads as a label, not
					    part of the sentence, and the resolved value gets its own
					    centered column and real weight — it's the answer to
					    "what am I looking at", so it should be the thing that
					    pops, not a quiet aside next to its own caption. One row
					    throughout; the grid's height is still set by the toggle. */}
					<div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-border-subtle bg-base px-3 py-2">
						<span className="text-sm font-semibold uppercase tracking-wider text-text-primary">
							History range
						</span>
						<span className="text-center text-sm font-semibold text-text-primary">
							{range.label === "All" ? "All history" : `Last ${range.label}`}
						</span>
						<SegmentedToggle<HistoryRangeId>
							ariaLabel="History range"
							value={historyRange}
							onChange={setHistoryRange}
							options={HISTORY_RANGES.map((r) => ({
								id: r.id,
								label: r.label,
							}))}
						/>
					</div>

					<ReorderHealthCard itemId={item.id} />

					{/* Full width: four series (set cost, paid cost, list price,
					    charged price) plus receipt markers need the horizontal
					    room, and its legend doesn't survive a half-width card. */}
					<CostPriceTrendChart
						itemId={item.id}
						createdAfter={historyCreatedAfter}
						bucket={range.bucket}
						range={consumptionRange}
						xDomain={historyXDomain}
					/>

					{/* Two independent COLUMNS, not two grid rows. Each column
					    stacks its chart over the list that reads from the same
					    ledger side — stock series over the stock ledger, consumption
					    series over usage by job. As one grid row, the row height was
					    the taller card's, so expanding one chart's "how this chart is
					    measured" panel opened dead space under the OTHER chart; a
					    column absorbs its own growth by pushing only its own list
					    down. The charts still line up at rest because their at-rest
					    bodies share one fixed height (CHART_BODY_H), and both lists
					    stay at half width — narrow-content rows that stretched a 1fr
					    middle column into dead space at full width. The columns
					    stretch and each list fills what is left of its column, so
					    the two still end on one line.

					    Stacked order on narrow screens follows the columns:
					    stock chart → stock ledger → consumption chart → usage. */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<div className="flex flex-col gap-6">
							<StockLevelChart
								itemId={item.id}
								unit={item.unit}
								lowStockThreshold={item.low_stock_threshold}
								createdAfter={historyCreatedAfter}
								xDomain={historyXDomain}
							/>
							<div className="flex-1 grid">
								<StockMovementList
									itemId={item.id}
									createdAfter={historyCreatedAfter}
								/>
							</div>
						</div>
						<div className="flex flex-col gap-6">
							<ConsumptionTrendChart
								itemId={item.id}
								unit={item.unit}
								bucket={range.bucket}
								range={consumptionRange}
								xDomain={historyXDomain}
							/>
							<div className="flex-1 grid">
								<UsageReport itemId={item.id} createdAfter={historyCreatedAfter} />
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Queue-add confirmation for every add on this page — the kebab
			    action, the Tracking tab's per-row buttons, ReceiveStockModal and
			    the serial drawer all push to labelQueueStore. The ONE watcher on
			    this page; SerialDetailDrawer deliberately doesn't mount its own. */}
			<LabelQueueToast />

			{/* Modals */}
			<CreateInventoryItem
				isOpen={editOpen}
				onClose={() => setEditOpen(false)}
				existingItem={item}
			/>
			{isTracked && (
				<ReceiveStockModal
					isOpen={receiveOpen}
					onClose={() => setReceiveOpen(false)}
					item={item}
				/>
			)}
			{!isTracked && (
				<AdjustStockModal
					item={item}
					isOpen={adjustOpen}
					onClose={() => setAdjustOpen(false)}
				/>
			)}
			{/* Rendered unconditionally — the drawer is driven by ?serial=, which
			    can be present on first paint (the redirect from the old standalone
			    route lands here with it already set). */}
			<SerialDetailDrawer
				serialId={openSerialId}
				onClose={() => setOpenSerialId(null)}
			/>
			<ConfirmDialog
				open={deleteOpen}
				title="Delete item?"
				body={`"${item.name}" will be removed from the inventory list. Its stock history stays on record.`}
				confirmLabel="Delete Item"
				tone="destructive"
				pending={del.isPending}
				error={deleteError}
				onConfirm={handleDelete}
				onCancel={() => {
					setDeleteOpen(false);
					setDeleteError(null);
				}}
			/>
		</div>
	);
}
