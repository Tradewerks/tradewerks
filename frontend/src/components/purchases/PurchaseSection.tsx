import { useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Plus } from "lucide-react";
import AdaptableTable from "../AdaptableTable";
import { useGetPurchasesQuery, useCreatePurchaseMutation } from "../../hooks/usePurchases";
import type { ListPurchasesParams, } from "../../api/purchases";
import {
	PURCHASE_STATUS_LABELS,
	PURCHASE_STATUS_COLORS,
	type Purchase,
	type PurchaseStatus,
	type PurchaseSort,
} from "../../types/purchases";
import PageControls from "../ui/PageControls";
import SearchBar from "../ui/SearchBar";
import StatusFilter, { DropdownFilter } from "../ui/StatusFilter";
import DateRangeFilter from "../ui/DateRangeFilter";
import FilterChips, { type FilterChip } from "../ui/FilterChips";
import { resolveDateRange, type DateRangeValue } from "../../util/dateRangeUtils";
import { compareString, withDir, type SortDir } from "../../util/sortUtil";
import { usePermission } from "../../hooks/usePermission";
import { useNavigate } from "react-router-dom";
import CreatePurchaseModal from "./CreatePurchaseModal";
import { formatCurrency } from "../../util/util";

type PurchaseRow = {
	id: string;
	purchaseNumber: string;
	vendor: string;
	supplier: string;
	status: string;
	total: string;
	lines: number;
	submitted: string;
	_rawStatus: PurchaseStatus;
	_purchase: Purchase;
};

const HEADER_LABELS: Record<string, string> = {
	purchaseNumber: "Purchase #",
	vendor: "Vendor",
	supplier: "Supplier",
	status: "Status",
	total: "Total",
	lines: "Lines",
	submitted: "Submitted",
};

const COLUMN_ALIGN: Record<string, "left" | "right"> = {
	total: "right",
	lines: "right",
};

const STATUS_OPTIONS = Object.entries(PURCHASE_STATUS_LABELS).map(([value, label]) => ({
	value,
	label,
}));

// "vendor"/"supplier"/"status"/"purchaseNumber" have no server-side PurchaseSort, so they sort client-side.
type ColumnSortKey = "submitted" | "total" | "vendor" | "supplier" | "status" | "purchaseNumber";

const SORT_FIELD_OPTIONS: { value: "submitted" | "total"; label: string }[] = [
	{ value: "submitted", label: "Date" },
	{ value: "total", label: "Amount" },
];

const columnToPurchaseSort = (key: ColumnSortKey, dir: SortDir): PurchaseSort | undefined => {
	if (key === "submitted") return dir === "desc" ? "newest" : "oldest";
	if (key === "total") return dir === "desc" ? "amount_desc" : "amount_asc";
	return undefined;
};

export default function PurchaseSection() {
    const navigate = useNavigate();
	const [search, setSearch] = useState("");
    const [isCreatePurchaseModelOpen, setIsCreatePurchaseModelOpen] = useState(false);
	// Server's status param only takes one value; 2+ selected filters client-side.
	const [statuses, setStatuses] = useState<PurchaseStatus[]>([]);
	const [columnSort, setColumnSort] = useState<{ key: ColumnSortKey; dir: SortDir }>({
		key: "submitted",
		dir: "desc",
	});
	const [dateRange, setDateRange] = useState<DateRangeValue>({ option: "all" });

	const purchaseSort = columnToPurchaseSort(columnSort.key, columnSort.dir);

    //permissions
    const MANAGE_PURCHASES = usePermission("manage_purchases")

	// Filtering/sorting/paging happen server-side, not fetched whole like Suppliers.
	const purchaseParams = useMemo<ListPurchasesParams>(() => {
		const resolved = resolveDateRange(dateRange);
		return {
			...(search.trim() ? { search: search.trim() } : {}),
			...(statuses.length === 1 ? { status: statuses[0] } : {}),
			...(purchaseSort ? { sort: purchaseSort } : {}),
			...(resolved
				? { date_from: resolved.start.toISOString(), date_to: resolved.end.toISOString() }
				: {}),
		};
	}, [search, statuses, purchaseSort, dateRange]);

	const { data, isLoading, isError } = useGetPurchasesQuery(purchaseParams);
	const { mutateAsync: createPurchaseOrder } = useCreatePurchaseMutation();

	const handleSortChange = (col: string) => {
		if (
			col !== "submitted" &&
			col !== "total" &&
			col !== "vendor" &&
			col !== "supplier" &&
			col !== "status" &&
			col !== "purchaseNumber"
		)
			return;
		setColumnSort((prev) =>
			prev.key === col ? { key: col, dir: prev.dir === "asc" ? "desc" : "asc" } : { key: col, dir: "asc" },
		);
	};

	const toggleStatus = (v: string | null) => {
		if (!v) {
			setStatuses([]);
			return;
		}
		const value = v as PurchaseStatus;
		setStatuses((prev) => (prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value]));
	};

	const rows = useMemo<PurchaseRow[]>(() => {
		let base = (data?.purchases ?? []).map((p) => ({
			id: p.id,
			purchaseNumber: p.purchase_number,
			vendor: p.vendor_name ?? "—",
			supplier: p.supplier?.name ?? "—",
			status: PURCHASE_STATUS_LABELS[p.status],
			total: formatCurrency(Number(p.total)),
			lines: p.lines.length,
			submitted: p.submitted_at ? new Date(p.submitted_at).toLocaleDateString() : "—",
			_rawStatus: p.status,
			_purchase: p,
		}));
		// Server already filtered to one status; only re-filter for 2+.
		if (statuses.length > 1) {
			base = base.filter((r) => statuses.includes(r._rawStatus));
		}
		if (columnSort.key === "submitted" || columnSort.key === "total") return base;
		const cmp = withDir(compareString, columnSort.dir);
		const key = columnSort.key;
		return [...base].sort((a, b) => cmp(a[key], b[key]));
	}, [data, statuses, columnSort]);

	const filterChips: (FilterChip | null)[] = [
		...statuses.map((s) => ({
			label: `Status: ${PURCHASE_STATUS_LABELS[s]}`,
			color: "green" as const,
			onRemove: () => setStatuses((prev) => prev.filter((x) => x !== s)),
		})),
		dateRange.option !== "all"
			? {
					label: "Date filtered",
					color: "cyan" as const,
					onRemove: () => setDateRange({ option: "all" }),
				}
			: null,
	];

	return (
		<div>
			<PageControls
				className="mb-4"
				left={
					<SearchBar
						placeholder="Search orders..."
						value={search}
						onChange={setSearch}
					/>
				}
				middle={
					<div className="flex items-center gap-2">
						<StatusFilter
							placeholder="Status"
							values={statuses}
							onChange={toggleStatus}
							options={STATUS_OPTIONS}
						/>
						<DateRangeFilter value={dateRange} onChange={setDateRange} />
						<div className="flex items-center gap-1">
							<DropdownFilter
								placeholder="Sort"
								hideAll
								values={
									columnSort.key === "submitted" || columnSort.key === "total"
										? [columnSort.key]
										: null
								}
								onChange={(v) => {
									if (!v) return;
									const key = v as "submitted" | "total";
									setColumnSort((prev) => (prev.key === key ? prev : { key, dir: "desc" }));
								}}
								options={SORT_FIELD_OPTIONS}
								exclusive
							/>
							{/* Toggles whichever column is active, from dropdown or header click. */}
							<button
								type="button"
								onClick={() =>
									setColumnSort((prev) => ({ ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }))
								}
								aria-label="Toggle sort direction"
								className="flex items-center justify-center h-9 w-9 rounded-md border border-border bg-base text-text-tertiary hover:text-text-primary transition-colors"
							>
								{columnSort.dir === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
							</button>
						</div>
					</div>
				}
				right={
					MANAGE_PURCHASES && (
						<button
							type="button"
							className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							onClick={() => setIsCreatePurchaseModelOpen(true)}
						>
							<Plus size={16} />
							New order
						</button>
					)
				}
			/>

			<FilterChips
				filters={filterChips}
				resultCount={rows.length}
				onClearAll={() => {
					setSearch("");
					setStatuses([]);
					setDateRange({ option: "all" });
				}}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-hidden text-left">
				<AdaptableTable
					data={rows}
					loadListener={isLoading}
					errListener={isError ? new Error("Failed to load purchases") : null}
					formatNums={false}
					headerLabels={HEADER_LABELS}
					columnAlign={COLUMN_ALIGN}
					columnVisibility={{lines: false}}
					sortableColumns={{ submitted: true, total: true, vendor: true, supplier: true, status: true, purchaseNumber: true }}
					sortKey={columnSort.key}
					sortDir={columnSort.dir}
					onSortChange={handleSortChange}
                    cellRenderers={{
                        status: (row) => {
                            const colors = PURCHASE_STATUS_COLORS[row._rawStatus as PurchaseStatus];
                            return <div className={`w-fit px-2 py-1 rounded-full border text-sm font-medium text-nowrap ${colors}`}>{row.status as string}</div>;
                        },
                    }}
                    onRowClick={(row) => {
                        navigate(`/dispatch/purchases/${row.id}`);
                    }}
				/>
			</div>

			<CreatePurchaseModal
				isModalOpen={isCreatePurchaseModelOpen}
				setIsModalOpen={setIsCreatePurchaseModelOpen}
				createPurchaseOrder={async (input) => {
					const newPurchase = await createPurchaseOrder(input);

					if (!newPurchase?.id)
						throw new Error("Purchase creation failed: no ID returned");

					return newPurchase.id;
				}}
			/>
		</div>
	);
}