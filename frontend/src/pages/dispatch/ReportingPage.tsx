import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
	Briefcase,
	DollarSign,
	Eye,
	EyeOff,
	Gauge,
	GripVertical,
	HardHat,
	Plus,
	SlidersHorizontal,
	Star,
	Trash2,
	User,
	Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import PageHeader from "../../components/ui/PageHeader";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import NewReportModal from "../../components/reports/NewReportModal";
import FavoritesButton from "../../components/reports/FavoritesButton";
import type { FavoriteLink } from "../../components/reports/FavoritesButton";
import {
	useSavedReportsQuery,
	useReportFavoritesQuery,
	useAddFavoriteMutation,
	useRemoveFavoriteMutation,
	useDeleteSavedReportMutation,
} from "../../hooks/useSavedReports";
import { useDispatcherByIdQuery, useUpdateDispatcherMutation } from "../../hooks/useDispatchers";
import { useAuthStore } from "../../auth/authStore";
import { getReportSource } from "../../reports/reportSources";
import type { ReportCategoryId, ReportFavoriteKind } from "../../types/reports";
import type { ReportLayout } from "../../types/dispatchers";

interface ReportLink {
	title: string;
	description: string;
	to: string;
}

interface HubEntry extends ReportLink {
	kind: ReportFavoriteKind;
	ref: string;
	type: "standard" | "custom";
}

interface ReportCategory {
	id: ReportCategoryId;
	label: string;
	icon: LucideIcon;
	entries: ReportLink[];
}

// Hub Categories
const REPORT_CATEGORIES: ReportCategory[] = [
	{
		id: "financial",
		label: "Financial Reports",
		icon: DollarSign,
		entries: [
			{
				title: "Profit & Loss Statement",
				description: "Profit & Loss from Quickbooks",
				to: "/dispatch/reporting/profit-and-loss",
			},
			{
				title: "Aged Receivables",
				description: "Outstanding invoice balances by age",
				to: "/dispatch/reporting/aged-receivables",
			},
			{
				title: "Tax Liability",
				description: "Tax collected by jurisdiction",
				to: "/dispatch/reporting/tax-liability",
			},
			{
				title: "Payments Collected",
				description: "Payments received by method and recorder",
				to: "/dispatch/reporting/payments",
			},
			{
				title: "Recurring Revenue",
				description: "MRR, ARR, and plan health",
				to: "/dispatch/reporting/recurring-revenue",
			},
			{
				title: "Revenue by Line Item Type",
				description: "Billed revenue grouped by line items",
				to: "/dispatch/reporting/revenue-by-line-item-type",
			},
			{
				title: "Cost of Goods Sold",
				description: "Inventory cost consumed, by job or by item",
				to: "/dispatch/reporting/cogs",
			},
			{
				title: "Balance Sheet",
				description: "Balance Sheet from Quickbooks",
				to: "/dispatch/reporting/qb/BalanceSheet",
			},
			{
				title: "Cash Flow",
				description: "Cash Flow from Quickbooks",
				to: "/dispatch/reporting/qb/CashFlow",
			},
			{
				title: "Trial Balance",
				description: "Trial Balance from Quickbooks",
				to: "/dispatch/reporting/qb/TrialBalance",
			},
			{
				title: "General Ledger",
				description: "General Ledger from Quickbooks",
				to: "/dispatch/reporting/qb/GeneralLedger",
			},
			{
				title: "Job Profitability",
				description: "Revenue, cost, and profit by job",
				to: "/dispatch/reporting/job-profitability",
			}
		],
	},
	{
		id: "operational",
		label: "Operational Reports",
		icon: Gauge,
		entries: [
			{
				title: "Job Backlog",
				description: "Open jobs by age and value",
				to: "/dispatch/reporting/job-backlog",
			},
			{
				title: "Quote Conversion",
				description: "Win rate and quote pipeline conversion",
				to: "/dispatch/reporting/quote-funnel",
			},
			{
				title: "Reorder Forecast",
				description: "Predicted stockouts by usage",
				to: "/dispatch/inventory/reorder-forecast",
			},
			{
				title: "First-Time Fix Rate",
				description: "Jobs finished on the first visit",
				to: "/dispatch/reporting/first-time-fix",
			},
		],
	},
	{
		id: "technician",
		label: "Technician Reports",
		icon: HardHat,
		entries: [
			{
				title: "Timesheets",
				description: "Hours logged per technician",
				to: "/dispatch/timesheets",
			},
			{
				title: "Technician Scorecard",
				description: "Revenue, hours, and on-time rate per technician",
				to: "/dispatch/reporting/technician-scorecard",
			},
			{
				title: "Field-Added Revenue",
				description: "Upsell revenue techs add in the field",
				to: "/dispatch/reporting/field-added-revenue",
			},
		],
	},
	{
		id: "client",
		label: "Client Reports",
		icon: Users,
		entries: [
			{
				title: "Client Retention",
				description: "Active clients with no recent activity",
				to: "/dispatch/reporting/client-retention",
			},
			{
				title: "Client Lifetime Value",
				description: "Clients by total revenue generated",
				to: "/dispatch/reporting/client-lifetime-value",
			},
			{
				title: "Client Discounts",
				description:
					"Clients by total discount received",
				to: "/dispatch/reporting/client-discounts",
			},
		],
	},
];

const LEFT_COLUMN_CATEGORIES = REPORT_CATEGORIES.filter((c) => c.id === "financial" || c.id === "technician");
const RIGHT_COLUMN_CATEGORIES = REPORT_CATEGORIES.filter((c) => c.id === "operational" || c.id === "client");

const CATEGORY_IDS: ReportCategoryId[] = REPORT_CATEGORIES.map((c) => c.id);
const BUILTIN_LINKS: ReportLink[] = REPORT_CATEGORIES.flatMap((c) => c.entries);
const CARD_CAP = 5;

const favKey = (kind: ReportFavoriteKind, ref: string) => `${kind}:${ref}`;
const entryKey = (e: HubEntry) => favKey(e.kind, e.ref);




function applyOrder(entries: HubEntry[], order: string[] | undefined): HubEntry[] {
	if (!order || order.length === 0) return entries;
	const rank = new Map(order.map((k, i) => [k, i]));
	return [...entries].sort((a, b) => {
		const ra = rank.get(entryKey(a)) ?? Number.POSITIVE_INFINITY;
		const rb = rank.get(entryKey(b)) ?? Number.POSITIVE_INFINITY;
		return ra - rb;
	});
}

function StarButton({
	active,
	onClick,
}: {
	active: boolean;
	onClick: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			onClick={onClick}
			aria-label={active ? "Remove from favorites" : "Add to favorites"}
			aria-pressed={active}
			className={`shrink-0 p-1 rounded transition-colors hover:cursor-pointer ${
				active
					? "text-warning hover:text-warning"
					: "text-text-faint hover:text-text-secondary"
			}`}
		>
			<Star size={15} fill={active ? "currentColor" : "none"} />
		</button>
	);
}

function TypeBadge({ type }: { type: HubEntry["type"] }) {
	if (type === "custom") {
		return (
			<span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
				<User size={10} />
				Custom
			</span>
		);
	}
	return <Briefcase size={13} className="shrink-0 text-text-faint" aria-label="Standard report" />;
}

function CategoryCard({
	category,
	entries,
	hidden,
	editing,
	expanded,
	onToggleExpand,
	isFavorited,
	onToggleFavorite,
	onToggleHidden,
	onDeleteReport,
	onDragStartEntry,
	onDropEntry,
}: {
	category: ReportCategory;
	entries: HubEntry[];
	hidden: Set<string>;
	editing: boolean;
	expanded: boolean;
	onToggleExpand: () => void;
	isFavorited: (kind: ReportFavoriteKind, ref: string) => boolean;
	onToggleFavorite: (kind: ReportFavoriteKind, ref: string) => void;
	onToggleHidden: (catId: ReportCategoryId, key: string) => void;
	onDeleteReport: (id: string) => void;
	onDragStartEntry: (catId: ReportCategoryId, key: string) => void;
	onDropEntry: (catId: ReportCategoryId, key: string) => void;
}) {
	const Icon = category.icon;

	// Editing becomes visible
	const visible = editing ? entries : entries.filter((e) => !hidden.has(entryKey(e)));
	const capped = expanded || editing ? visible : visible.slice(0, CARD_CAP);
	const overflow = visible.length - CARD_CAP;

	return (
		<div className="bg-base border border-border-subtle rounded-xl overflow-hidden">
			<div className="flex items-center gap-2 p-4 border-b border-border-subtle">
				<Icon size={16} className="text-text-tertiary" />
				<h3 className="font-semibold text-text-primary">{category.label}</h3>
			</div>
			<div className="p-3 flex flex-wrap gap-2">
				{visible.length === 0 ? (
					<p className="text-sm text-text-muted px-1 py-2.5">No reports yet</p>
				) : (
					capped.map((entry) => {
						const key = entryKey(entry);
						const isHidden = hidden.has(key);
						return (
							<div
								key={key}
								draggable={editing}
								onDragStart={() => editing && onDragStartEntry(category.id, key)}
								onDragOver={(e) => {
									if (editing) e.preventDefault();
								}}
								onDrop={(e) => {
									if (!editing) return;
									e.preventDefault();
									onDropEntry(category.id, key);
								}}
								className={`relative w-[216px] shrink-0 rounded-lg border border-border-subtle p-2.5 transition-all ${
									editing
										? "bg-surface/40 cursor-grab active:cursor-grabbing"
										: "hover:border-border hover:shadow-sm hover:bg-surface"
								} ${isHidden ? "opacity-50" : ""}`}
							>
								<div className="flex items-start justify-between gap-1.5">
									{editing ? (
										<div className="flex-1 min-w-0">
											<p className="flex items-center gap-1 text-[12.5px] font-semibold text-text-primary">
												<GripVertical size={12} className="shrink-0 text-text-faint" />
												<span className="truncate">{entry.title}</span>
												<TypeBadge type={entry.type} />
											</p>
											<p className="text-[11px] text-text-muted mt-0.5 truncate">
												{entry.description}
											</p>
										</div>
									) : (
										<Link to={entry.to} className="block flex-1 min-w-0" title={entry.description}>
											<p className="flex items-center gap-1 text-[12.5px] font-semibold text-text-primary">
												<span className="truncate">{entry.title}</span>
												<TypeBadge type={entry.type} />
											</p>
											<p className="text-[11px] text-text-muted mt-0.5 truncate">
												{entry.description}
											</p>
										</Link>
									)}
									{editing ? (
										<div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
											<button
												onClick={() => onToggleHidden(category.id, key)}
												aria-label={isHidden ? "Show report" : "Hide report"}
												className="p-1 rounded text-text-faint hover:text-text-secondary transition-colors"
											>
												{isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
											</button>
											{entry.type === "custom" && entry.kind === "saved" && (
												<button
													onClick={() => onDeleteReport(entry.ref)}
													aria-label="Delete report"
													className="p-1 rounded text-text-faint hover:text-error-text transition-colors"
												>
													<Trash2 size={13} />
												</button>
											)}
										</div>
									) : (
										<StarButton
											active={isFavorited(entry.kind, entry.ref)}
											onClick={(e) => {
												e.preventDefault();
												onToggleFavorite(entry.kind, entry.ref);
											}}
										/>
									)}
								</div>
							</div>
						);
					})
				)}
				{!editing && overflow > 0 && (
					<button
						onClick={onToggleExpand}
						className="text-left text-xs font-semibold text-primary-text hover:underline px-3 py-2 hover:cursor-pointer"
					>
						{expanded ? "Show less" : `Show all ${visible.length} →`}
					</button>
				)}
			</div>
		</div>
	);
}

function FavoritesCard({
	favorites,
	onRemove,
}: {
	favorites: FavoriteLink[];
	onRemove: (kind: ReportFavoriteKind, ref: string) => void;
}) {
	if (favorites.length === 0) return null;

	return (
		<div className="bg-base border border-border-subtle rounded-xl overflow-hidden mb-4">
			<div className="flex items-center gap-2 p-4 border-b border-border-subtle">
				<Star size={16} className="text-warning" fill="currentColor" />
				<h3 className="font-semibold text-text-primary">Favorites</h3>
			</div>
			<div className="p-3 flex flex-wrap gap-2">
				{favorites.map((fav) => (
					<div
						key={`${fav.kind}:${fav.ref}`}
						className="relative w-[216px] shrink-0 rounded-lg border border-border-subtle p-2.5 transition-all hover:border-border hover:shadow-sm hover:bg-surface"
					>
						<div className="flex items-start justify-between gap-1.5">
							<Link to={fav.to} className="block flex-1 min-w-0">
								<p className="text-[12.5px] font-semibold text-text-primary truncate">
									{fav.title}
								</p>
								<p className="text-[11px] text-text-muted mt-0.5 truncate">
									{fav.description}
								</p>
							</Link>
							<StarButton
								active
								onClick={(e) => {
									e.preventDefault();
									onRemove(fav.kind, fav.ref);
								}}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export default function ReportingPage() {
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [deleteReportId, setDeleteReportId] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Partial<Record<ReportCategoryId, boolean>>>({});

	const { user } = useAuthStore();
	const { data: dispatcher } = useDispatcherByIdQuery(user?.userId);
	const updateDispatcher = useUpdateDispatcherMutation();

	const { data: savedReports = [] } = useSavedReportsQuery();
	const { data: favorites = [] } = useReportFavoritesQuery();
	const addFavorite = useAddFavoriteMutation();
	const removeFavorite = useRemoveFavoriteMutation();
	const deleteSavedReport = useDeleteSavedReportMutation();

	// Per-user reorder/hide preferences, seeded from the dispatcher record.
	const [layout, setLayout] = useState<ReportLayout>({});
	useEffect(() => {
		if (dispatcher?.report_layout) setLayout(dispatcher.report_layout);
	}, [dispatcher?.report_layout]);

	const dragKeyRef = useRef<{ catId: ReportCategoryId; key: string } | null>(null);

	const favByKey = new Map(favorites.map((f) => [favKey(f.kind, f.ref), f]));
	const isFavorited = (kind: ReportFavoriteKind, ref: string) =>
		favByKey.has(favKey(kind, ref));
	const toggleFavorite = (kind: ReportFavoriteKind, ref: string) => {
		const existing = favByKey.get(favKey(kind, ref));
		if (existing) removeFavorite.mutate(existing.id);
		else addFavorite.mutate({ kind, ref });
	};

	const handleDeleteReport = (id: string) => {
		setDeleteReportId(id);
	};

	const confirmDeleteReport = () => {
		if (!deleteReportId) return;
		deleteSavedReport.mutate(deleteReportId, {
			onSuccess: () => setDeleteReportId(null),
		});
	};

	const entriesByCategory = useMemo(() => {
		const map = {} as Record<ReportCategoryId, HubEntry[]>;
		for (const cat of REPORT_CATEGORIES) {
			map[cat.id] = cat.entries.map((e) => ({
				...e,
				kind: "built_in" as const,
				ref: e.to,
				type: "standard" as const,
			}));
		}
		for (const report of savedReports) {
			const source = getReportSource(report.source);
			const catId: ReportCategoryId = source?.category ?? "operational";
			map[catId].push({
				title: report.name,
				description: source?.label ?? "Saved report",
				to: `/dispatch/reporting/builder?reportId=${report.id}`,
				kind: "saved",
				ref: report.id,
				type: "custom",
			});
		}
		for (const catId of CATEGORY_IDS) {
			map[catId] = applyOrder(map[catId], layout[catId]?.order);
		}
		return map;
	}, [savedReports, layout]);

	const hiddenByCategory = useMemo(() => {
		const map = {} as Record<ReportCategoryId, Set<string>>;
		for (const catId of CATEGORY_IDS) {
			map[catId] = new Set(layout[catId]?.hidden ?? []);
		}
		return map;
	}, [layout]);

	const persistLayout = (next: ReportLayout) => {
		setLayout(next);
		if (dispatcher?.id) {
			updateDispatcher.mutate({ id: dispatcher.id, data: { report_layout: next } });
		}
	};

	const updateCategory = (
		catId: ReportCategoryId,
		updater: (cur: { order: string[]; hidden: string[] }) => { order: string[]; hidden: string[] },
	) => {
		const cur = layout[catId] ?? { order: [], hidden: [] };
		persistLayout({ ...layout, [catId]: updater({ order: cur.order ?? [], hidden: cur.hidden ?? [] }) });
	};

	const toggleHidden = (catId: ReportCategoryId, key: string) => {
		updateCategory(catId, (cur) => {
			const hidden = cur.hidden.includes(key)
				? cur.hidden.filter((k) => k !== key)
				: [...cur.hidden, key];
			return { ...cur, hidden };
		});
	};

	const handleDrop = (catId: ReportCategoryId, targetKey: string) => {
		const dragged = dragKeyRef.current;
		dragKeyRef.current = null;
		if (!dragged || dragged.catId !== catId || dragged.key === targetKey) return;
		const keys = entriesByCategory[catId].map(entryKey);
		const from = keys.indexOf(dragged.key);
		const to = keys.indexOf(targetKey);
		if (from < 0 || to < 0) return;
		keys.splice(to, 0, keys.splice(from, 1)[0]);
		updateCategory(catId, (cur) => ({ ...cur, order: keys }));
	};

	const favoriteLinks: FavoriteLink[] = favorites
		.map((f) => {
			if (f.kind === "built_in") {
				const link = BUILTIN_LINKS.find((l) => l.to === f.ref);
				return link ? { ...link, kind: f.kind, ref: f.ref } : null;
			}
			const report = savedReports.find((r) => r.id === f.ref);
			if (!report) return null;
			return {
				title: report.name,
				description: getReportSource(report.source)?.label ?? "Saved report",
				to: `/dispatch/reporting/builder?reportId=${report.id}`,
				kind: f.kind,
				ref: f.ref,
			};
		})
		.filter((l): l is FavoriteLink => l !== null);

	return (
		<div className="text-text-primary">
			<PageHeader title="Reporting">
				<FavoritesButton favorites={favoriteLinks} onRemove={toggleFavorite} />
				<button
					onClick={() => setEditing((v) => !v)}
					aria-pressed={editing}
					className={`flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium transition-colors border ${
						editing
							? "bg-primary-bg border-primary text-primary-text"
							: "border-border text-text-tertiary hover:bg-surface hover:text-text-primary"
					}`}
				>
					<SlidersHorizontal size={15} />
					{editing ? "Done" : "Edit"}
				</button>
				<button
					onClick={() => setIsModalOpen(true)}
					className="flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary hover:bg-primary-hover text-on-primary text-sm font-medium transition-colors"
				>
					<Plus size={15} />
					New Report
				</button>
			</PageHeader>

			{editing && (
				<p className="text-sm text-text-muted mb-4">
					Drag reports to reorder them within a category, or hide ones you don't use. Changes
					save automatically.
				</p>
			)}
			{!editing && <FavoritesCard favorites={favoriteLinks} onRemove={toggleFavorite} />}
			<div className="flex flex-col xl:flex-row gap-4">
				{[LEFT_COLUMN_CATEGORIES, RIGHT_COLUMN_CATEGORIES].map((column, i) => (
					<div key={i} className="flex flex-col gap-4 xl:flex-1">
						{column.map((category) => (
							<CategoryCard
								key={category.id}
								category={category}
								entries={entriesByCategory[category.id]}
								hidden={hiddenByCategory[category.id]}
								editing={editing}
								expanded={!!expanded[category.id]}
								onToggleExpand={() =>
									setExpanded((prev) => ({ ...prev, [category.id]: !prev[category.id] }))
								}
								isFavorited={isFavorited}
								onToggleFavorite={toggleFavorite}
								onToggleHidden={toggleHidden}
								onDeleteReport={handleDeleteReport}
								onDragStartEntry={(catId, key) => {
									dragKeyRef.current = { catId, key };
								}}
								onDropEntry={handleDrop}
							/>
						))}
					</div>
				))}
			</div>
			<NewReportModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
			<ConfirmDialog
				open={deleteReportId !== null}
				title="Delete Report"
				body="Delete this saved report? This cannot be undone."
				confirmLabel="Delete"
				tone="destructive"
				pending={deleteSavedReport.isPending}
				onConfirm={confirmDeleteReport}
				onCancel={() => setDeleteReportId(null)}
			/>
		</div>
	);
}
