import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
	Boxes,
	Briefcase,
	Check,
	Download,
	Loader2,
	MoreVertical,
	PackagePlus,
	Pencil,
	Printer,
	ShieldAlert,
	ShieldCheck,
	Trash2,
	Truck,
	User,
	X,
} from "lucide-react";
import {
	useBatchImpactQuery,
	useDeleteBatchMutation,
	useSerialsQuery,
	useUpdateBatchMutation,
} from "../../hooks/useTracking";
import { useInventoryItemQuery } from "../../hooks/useInventory";
import { useVehiclesQuery } from "../../hooks/useVehicles";
import SerialDetailDrawer from "../../components/inventory/tracking/SerialDetailDrawer";
import { usePermission } from "../../hooks/usePermission";
import { useLabelQueueStore } from "../../stores/labelQueueStore";
import { exportBatchImpact } from "../../api/tracking";
import ReceiveStockModal from "../../components/inventory/tracking/ReceiveStockModal";
import LabelQueueButton from "../../components/inventory/labels/LabelQueueButton";
import LabelQueueToast from "../../components/inventory/labels/LabelQueueToast";
import { INPUT, LABEL } from "../../components/inventory/tracking/BatchCaptureFields";
import QRLabel from "../../components/inventory/labels/QRLabel";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import Card from "../../components/ui/Card";
import { HEADER_BTN_SECONDARY, HEADER_META } from "../../components/ui/headerActions";
import StatCard from "../../components/ui/StatCard";
import { useToast } from "../../components/ui/useToast";
import {
	SERIAL_STATUS_BADGE,
	SERIAL_STATUS_LABEL,
	type BatchImpactAffectedJob,
	type BatchImpactAffectedSerial,
	type BatchImpactReport,
	type SerialUnitRow,
	type SerialUnitStatus,
} from "../../types/tracking";
import { formatDate, formatDateTime } from "../../util/util";

type Tab = "overview" | "traceability";

// Same kebab item styling as the item detail page's actions menu.
const MENU_ITEM =
	"w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed";

type ConsumptionRow = {
	key: string;
	clientId: string | null;
	clientName: string | null;
	jobId: string | null;
	jobNumber: string | null;
	jobName: string | null;
	date: string | null;
	qty: number;
	status: "active" | "reversed";
};

function jobRowFromAffectedJob(j: BatchImpactAffectedJob): ConsumptionRow {
	return {
		key: `job-${j.visit_line_item_id}`,
		clientId: j.client_id,
		clientName: j.client_name,
		jobId: j.job_id,
		jobNumber: j.job_number,
		jobName: j.job_name,
		date: null,
		qty: j.net_qty,
		status: j.fully_reversed ? "reversed" : "active",
	};
}

function serialRowFromAffectedSerial(s: BatchImpactAffectedSerial): ConsumptionRow {
	return {
		key: `serial-${s.id}`,
		clientId: s.client?.id ?? null,
		clientName: s.client?.name ?? null,
		jobId: s.visit?.job.id ?? null,
		jobNumber: s.visit?.job.job_number ?? null,
		jobName: s.visit?.job.name ?? null,
		date: s.consumed_at,
		qty: 1,
		status: "active",
	};
}

const LOT_STATUS_FILTERS: { id: SerialUnitStatus | "all"; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "in_warehouse", label: "Warehouse" },
	{ id: "on_vehicle", label: "On Vehicle" },
	{ id: "consumed", label: "Used" },
	{ id: "lost", label: "Lost" },
	{ id: "returned", label: "Returned" },
];

// Lists a lot's individual units (filterable by status) — aggregate counts alone
// hid which units were live. Opens the same serial drawer as the item detail page.
function LotSerials({
	itemId,
	batchId,
	onOpenSerial,
}: {
	itemId: string;
	batchId: string;
	onOpenSerial: (serialId: string) => void;
}) {
	const [statusFilter, setStatusFilter] = useState<SerialUnitStatus | "all">("all");
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [rows, setRows] = useState<SerialUnitRow[]>([]);
	const { data: vehicles } = useVehiclesQuery();

	const { data, isLoading, isFetching } = useSerialsQuery(itemId, {
		batchId,
		status: statusFilter === "all" ? undefined : statusFilter,
		cursor,
	});

	// Changing the filter restarts pagination — an accumulated page from the
	// previous filter no longer belongs to the list being shown.
	useEffect(() => {
		setCursor(undefined);
		setRows([]);
	}, [statusFilter, batchId]);

	useEffect(() => {
		if (!data) return;
		setRows((prev) => {
			const seen = new Set(prev.map((r) => r.id));
			return [...prev, ...data.serials.filter((s) => !seen.has(s.id))];
		});
	}, [data]);

	const vehicleName = (id: string | null) =>
		id ? (vehicles?.find((v) => v.id === id)?.name ?? "Vehicle") : null;

	return (
		<Card
			title="Units in this Lot"
			headerAction={
				rows.length > 0 && <span className={HEADER_META}>{rows.length} shown</span>
			}
		>

			<div className="flex flex-wrap gap-1.5 mb-3">
				{LOT_STATUS_FILTERS.map((f) => (
					<button
						key={f.id}
						type="button"
						aria-pressed={statusFilter === f.id}
						onClick={() => setStatusFilter(f.id)}
						className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
							statusFilter === f.id
								? "bg-primary-bg border-primary text-primary-text"
								: "bg-base border-border text-text-muted hover:border-border-strong hover:text-text-secondary"
						}`}
					>
						{f.label}
					</button>
				))}
			</div>

			{isLoading && rows.length === 0 ? (
				<div className="space-y-2">
					{[0, 1, 2].map((i) => (
						<div key={i} className="h-9 bg-surface-raised rounded animate-pulse" />
					))}
				</div>
			) : rows.length === 0 ? (
				<p className="text-sm text-text-muted py-4 text-center">
					{statusFilter === "all"
						? "No units recorded for this lot."
						: "No units with that status in this lot."}
				</p>
			) : (
				<div className="border border-border-subtle rounded-lg overflow-hidden">
					{rows.map((unit) => (
						<button
							key={unit.id}
							type="button"
							onClick={() => onOpenSerial(unit.id)}
							aria-label={`View serial ${unit.serial_number}`}
							className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left border-t border-border-subtle first:border-t-0 hover:bg-surface-raised transition-colors"
						>
							<div className="min-w-0">
								<div className="font-mono text-sm text-text-primary truncate">
									{unit.serial_number}
								</div>
								<div className="font-mono text-[11px] text-text-faint truncate">
									{unit.code}
								</div>
							</div>
							<div className="flex items-center gap-2 flex-shrink-0">
								{vehicleName(unit.current_vehicle_id) && (
									<span className="inline-flex items-center gap-1 text-xs text-text-muted">
										<Truck size={12} />
										{vehicleName(unit.current_vehicle_id)}
									</span>
								)}
								<span
									className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${SERIAL_STATUS_BADGE[unit.status]}`}
								>
									{SERIAL_STATUS_LABEL[unit.status]}
								</span>
							</div>
						</button>
					))}
				</div>
			)}

			{data?.nextCursor && (
				<button
					type="button"
					disabled={isFetching}
					onClick={() => setCursor(data.nextCursor ?? undefined)}
					className="mt-3 w-full px-3 py-2 text-xs font-medium bg-surface-raised border border-border rounded-md text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors disabled:opacity-50"
				>
					{isFetching ? "Loading…" : "Load more"}
				</button>
			)}
		</Card>
	);
}

function OverviewTab({
	remaining,
	itemId,
	batchId,
	isSerialized,
	onOpenSerial,
}: {
	remaining: BatchImpactReport["remaining"];
	itemId: string;
	batchId: string;
	isSerialized: boolean;
	onOpenSerial: (serialId: string) => void;
}) {
	const onVehicles = remaining.vehicles.reduce((sum, v) => sum + v.qty_on_hand, 0);

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 gap-3">
				<StatCard label="Warehouse" value={String(remaining.warehouse)} />
				<StatCard
					label="On Vehicles"
					value={String(onVehicles)}
					hint={`${remaining.vehicles.length} vehicle${remaining.vehicles.length !== 1 ? "s" : ""}`}
				/>
			</div>

			{/* Only for serialized items — a batch-only lot has no per-unit
			    identity to show, which is why the counts above are the whole
			    story there. */}
			{isSerialized && (
				<LotSerials itemId={itemId} batchId={batchId} onOpenSerial={onOpenSerial} />
			)}

			<Card title="Per-Vehicle Breakdown">
				{remaining.vehicles.length === 0 ? (
					<p className="text-sm text-text-muted py-4 text-center">
						No units currently on vehicles.
					</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{remaining.vehicles.map((v) => (
							<div
								key={v.vehicle_id}
								className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-raised border border-border text-sm"
							>
								<Truck
									size={13}
									className="text-text-muted"
								/>
								<span className="text-text-primary">
									{v.vehicle_name}
								</span>
								<span className="font-semibold text-text-secondary tabular-nums">
									{v.qty_on_hand}
								</span>
							</div>
						))}
					</div>
				)}
			</Card>
		</div>
	);
}

function TraceabilityTab({
	affectedJobs,
	affectedSerials,
	onExport,
	isExporting,
	exportError,
}: {
	affectedJobs: BatchImpactAffectedJob[];
	affectedSerials: BatchImpactAffectedSerial[];
	onExport: () => void;
	isExporting: boolean;
	exportError: string | null;
}) {
	const rows = useMemo(() => {
		const serialRows = affectedSerials.map(serialRowFromAffectedSerial);
		const jobRows = affectedJobs.map(jobRowFromAffectedJob);
		return [...serialRows, ...jobRows].sort((a, b) => {
			if (a.date && b.date)
				return new Date(b.date).getTime() - new Date(a.date).getTime();
			if (a.date) return -1;
			if (b.date) return 1;
			return 0;
		});
	}, [affectedJobs, affectedSerials]);

	const distinctClients = new Set(
		rows.map((r) => r.clientId).filter((id): id is string => !!id)
	).size;
	const distinctJobs = new Set(rows.map((r) => r.jobId).filter((id): id is string => !!id))
		.size;
	const activeCount = rows.filter((r) => r.status === "active").length;
	const reversedCount = rows.filter((r) => r.status === "reversed").length;
	const totalQtyOut =
		affectedJobs.reduce((sum, j) => sum + j.consumed_qty, 0) + affectedSerials.length;

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
				<StatCard label="Total Units Out" value={String(totalQtyOut)} />
				<StatCard
					label="Clients Affected"
					value={String(distinctClients)}
				/>
				<StatCard label="Jobs Affected" value={String(distinctJobs)} />
				<StatCard
					label="Active / Reversed"
					value={`${activeCount} / ${reversedCount}`}
					tone={activeCount > 0 ? "warning" : undefined}
				/>
			</div>

			<Card
				title="Consumption Trace"
				flush
				headerAction={
				<div className="relative">
					<button
						type="button"
						onClick={onExport}
						disabled={isExporting}
						className={HEADER_BTN_SECONDARY}
					>
						{isExporting ? (
							<Loader2
								size={14}
								className="animate-spin"
							/>
						) : (
							<Download size={14} />
						)}
						{isExporting ? "Exporting…" : "Export XLSX"}
					</button>
					{exportError && (
						<div className="absolute right-0 top-full mt-1 z-10 whitespace-nowrap rounded-md border border-error-border bg-error-bg px-2 py-1 text-xs text-error-text">
							{exportError}
						</div>
					)}
				</div>
				}
			>
				{rows.length === 0 ? (
					<EmptyState
						icon={<Boxes size={28} />}
						title="No consumption recorded"
						description="Nothing has been consumed from this batch yet."
					/>
				) : (
					<div className="overflow-x-auto">
						<div className="min-w-[640px]">
							<div className="grid grid-cols-[1fr_1fr_110px_70px_100px] px-4 py-2 border-b border-border-subtle">
								{[
									"Client",
									"Job",
									"Date",
									"Qty",
									"Status",
								].map((h) => (
									<div
										key={h}
										className="text-[10px] font-semibold text-text-muted uppercase tracking-wider"
									>
										{h}
									</div>
								))}
							</div>
							{rows.map((r) => (
								<div
									key={r.key}
									className="grid grid-cols-[1fr_1fr_110px_70px_100px] items-center px-4 py-2.5 border-b border-border-subtle/50 last:border-b-0 text-sm hover:bg-surface-raised/40 transition-colors"
								>
									<div className="truncate pr-2">
										{r.clientId ? (
											<Link
												to={`/dispatch/clients/${r.clientId}`}
												className="inline-flex items-center gap-1.5 text-text-link hover:underline truncate"
											>
												<User
													size={
														12
													}
													className="flex-shrink-0"
												/>
												<span className="truncate">
													{
														r.clientName
													}
												</span>
											</Link>
										) : (
											<span className="text-text-faint">
												—
											</span>
										)}
									</div>
									<div className="truncate pr-2">
										{r.jobId ? (
											<Link
												to={`/dispatch/jobs/${r.jobId}`}
												className="inline-flex items-center gap-1.5 text-text-link hover:underline truncate"
											>
												<Briefcase
													size={
														12
													}
													className="flex-shrink-0"
												/>
												<span className="truncate">
													{
														r.jobNumber
													}{" "}
													·{" "}
													{
														r.jobName
													}
												</span>
											</Link>
										) : (
											<span className="text-text-faint">
												—
											</span>
										)}
									</div>
									<div className="text-text-muted text-xs">
										{r.date
											? formatDateTime(
													r.date
												)
											: "—"}
									</div>
									<div className="font-semibold text-text-primary tabular-nums">
										{r.qty}
									</div>
									<div>
										<span
											className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
												r.status ===
												"active"
													? "bg-warning-bg text-warning-text border border-warning-border"
													: "bg-surface-raised text-text-tertiary border border-border-strong"
											}`}
										>
											{r.status ===
											"active"
												? "Active"
												: "Reversed"}
										</span>
									</div>
								</div>
							))}
						</div>
					</div>
				)}
			</Card>
		</div>
	);
}

interface BatchEditDraft {
	batch_number: string;
	expires_at: string;
	supplier: string;
}

export default function BatchDetailPage() {
	const { batchId } = useParams<{ batchId: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const [activeTab, setActiveTab] = useState<Tab>("overview");
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [confirmError, setConfirmError] = useState<string | null>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	const [receiveOpen, setReceiveOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editDraft, setEditDraft] = useState<BatchEditDraft>({
		batch_number: "",
		expires_at: "",
		supplier: "",
	});
	const [editError, setEditError] = useState<string | null>(null);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	// Kebab holds secondary actions (Edit, Delete, Print Label); Receive Stock and
	// the recall toggle stay in the header — same pattern as the item detail page.
	const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	// Same `?serial=` contract as the item detail page, so a unit stays linkable
	// across a refresh. replace, not push, so opening one doesn't bury this page.
	const [searchParams, setSearchParams] = useSearchParams();
	const openSerialId = searchParams.get("serial");
	const setOpenSerialId = (serialId: string | null) => {
		const next = new URLSearchParams(searchParams);
		if (serialId) next.set("serial", serialId);
		else next.delete("serial");
		setSearchParams(next, { replace: true });
	};

	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
				setIsActionsMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const { data: report, isLoading, error } = useBatchImpactQuery(batchId ?? "");
	const updateBatchMutation = useUpdateBatchMutation();
	const deleteBatchMutation = useDeleteBatchMutation();
	const canManage = usePermission("manage_inventory");
	const addToLabelQueue = useLabelQueueStore((s) => s.add);
	// Needs the parent item's tracking flags to know if the lot also requires
	// serials; the impact report already names the item, so no extra fetch.
	const { data: item } = useInventoryItemQuery(report?.batch.item_id);

	if (!batchId) return null;

	if (isLoading) {
		return (
			<div className="space-y-4 animate-pulse">
				<div className="h-6 w-56 bg-surface-raised rounded" />
				<div className="h-16 bg-surface-raised rounded-xl" />
				<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
					{[0, 1, 2, 3].map((i) => (
						<div
							key={i}
							className="h-20 bg-surface-raised rounded-lg"
						/>
					))}
				</div>
				<div className="h-64 bg-surface-raised rounded-xl" />
			</div>
		);
	}

	if (error || !report) {
		return (
			<div className="flex flex-col items-center justify-center h-64 gap-3">
				<div className="text-text-primary text-lg">Batch not found</div>
			</div>
		);
	}

	const { batch, remaining, affected_jobs, affected_serials } = report;
	const isRecalled = !!batch.recalled_at;
	// Empty-lot-only: nothing left in the warehouse or on any vehicle. The
	// backend re-checks this plus serials/consumption history authoritatively.
	const canDeleteBatch = remaining.total === 0;

	const expiresAtMs = batch.expires_at ? new Date(batch.expires_at).getTime() : null;
	const daysUntilExpiry =
		expiresAtMs !== null ? Math.ceil((expiresAtMs - Date.now()) / 86_400_000) : null;
	const isExpired = daysUntilExpiry !== null && daysUntilExpiry < 0;
	const isExpiringSoon =
		daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilExpiry < 30;

	const handlePrint = () => {
		addToLabelQueue({
			id: batch.id,
			code: batch.code,
			kind: "batch",
			primaryLabel: batch.item_name,
			secondaryLabel: batch.batch_number,
		});
		navigate("/dispatch/inventory/labels/print");
	};

	const handleToggleRecall = async () => {
		try {
			await updateBatchMutation.mutateAsync({
				batchId: batch.id,
				input: { recalled: !isRecalled },
			});
			setConfirmOpen(false);
			setConfirmError(null);
		} catch (e) {
			setConfirmError(e instanceof Error ? e.message : "Failed to update batch");
		}
	};

	const startEdit = () => {
		setEditDraft({
			batch_number: batch.batch_number,
			expires_at: batch.expires_at ? batch.expires_at.slice(0, 10) : "",
			supplier: batch.supplier ?? "",
		});
		setEditError(null);
		setEditing(true);
	};

	const cancelEdit = () => {
		setEditing(false);
		setEditError(null);
	};

	const saveEdit = async () => {
		const trimmedNumber = editDraft.batch_number.trim();
		if (!trimmedNumber) {
			setEditError("Batch number is required");
			return;
		}
		setEditError(null);
		try {
			await updateBatchMutation.mutateAsync({
				batchId: batch.id,
				input: {
					batch_number: trimmedNumber,
					expires_at: editDraft.expires_at || null,
					supplier: editDraft.supplier.trim() || null,
				},
			});
			toast.success("Batch updated");
			setEditing(false);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Failed to update batch";
			setEditError(message);
			toast.error(message);
		}
	};

	const handleDelete = async () => {
		setDeleteError(null);
		try {
			await deleteBatchMutation.mutateAsync(batch.id);
			toast.success("Batch deleted");
			navigate(`/dispatch/inventory/items/${batch.item_id}`);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Failed to delete batch";
			setDeleteError(message);
			toast.error(message);
		}
	};

	const handleExport = async () => {
		setIsExporting(true);
		setExportError(null);
		try {
			await exportBatchImpact(batch.id, batch.batch_number);
		} catch (e) {
			setExportError(
				e instanceof Error ? e.message : "Export failed. Please try again."
			);
			setTimeout(() => setExportError(null), 5000);
		} finally {
			setIsExporting(false);
		}
	};

	return (
		<div className="space-y-4">
			<div>
				<div className="text-[11px] font-semibold uppercase tracking-wide text-text-faint mb-1.5">
					{batch.item_name}
				</div>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<div className="flex items-center gap-2.5 flex-wrap">
							<h2 className="text-2xl font-semibold text-text-primary">
								Batch {batch.batch_number}
							</h2>
							<span
								className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full ${
									isRecalled
										? "bg-error-bg text-error-text border border-error-border"
										: "bg-success-bg text-success-text border border-success-border"
								}`}
							>
								{isRecalled ? (
									<ShieldAlert size={12} />
								) : (
									<ShieldCheck size={12} />
								)}
								{isRecalled ? "RECALLED" : "ACTIVE"}
							</span>
						</div>
						<div className="flex items-center gap-3 mt-1 text-sm text-text-muted flex-wrap">
							<span className="font-mono text-xs">
								{batch.code}
							</span>
							{batch.expires_at && (
								<>
									<span className="text-text-faint">
										·
									</span>
									<span
										className={`text-xs font-medium px-2 py-0.5 rounded ${
											isExpired
												? "bg-error-bg text-error-text border border-error-border"
												: isExpiringSoon
													? "bg-warning-bg text-warning-text border border-warning-border"
													: "text-text-muted"
										}`}
									>
										{isExpired
											? "Expired "
											: "Expires "}
										{formatDate(
											batch.expires_at
										)}
									</span>
								</>
							)}
							{isRecalled && batch.recalled_at && (
								<>
									<span className="text-text-faint">
										·
									</span>
									<span className="text-xs text-error-text">
										Recalled{" "}
										{formatDate(
											batch.recalled_at
										)}
									</span>
								</>
							)}
						</div>
					</div>
					<div className="flex items-center gap-2 flex-wrap">
						{/* Shared queue read — this page's Print Label button
						    queues the lot and leaves, so a dispatcher arriving
						    mid-queue needs the running count here too. */}
						<LabelQueueButton className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-surface border border-border-input rounded-md text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors" />
						{canManage && item && (
							<button
								type="button"
								onClick={() => setReceiveOpen(true)}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary-hover hover:bg-primary-active text-on-primary rounded-md transition-colors"
							>
								<PackagePlus size={14} />
								Receive Stock
							</button>
						)}
						<button
							type="button"
							onClick={() => setConfirmOpen(true)}
							className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-md transition-colors ${
								isRecalled
									? "bg-surface border border-border text-text-secondary hover:bg-surface-raised hover:text-text-primary"
									: "bg-error hover:bg-error-strong text-on-primary"
							}`}
						>
							{isRecalled ? (
								<ShieldCheck size={14} />
							) : (
								<ShieldAlert size={14} />
							)}
							{isRecalled
								? "Clear Recall"
								: "Mark Recalled"}
						</button>

						<div className="relative" ref={menuRef}>
							<button
								type="button"
								aria-label="More batch actions"
								aria-haspopup="menu"
								aria-expanded={isActionsMenuOpen}
								onClick={() =>
									setIsActionsMenuOpen((v) => !v)
								}
								className="p-2 hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong text-text-secondary"
							>
								<MoreVertical size={18} />
							</button>

							{isActionsMenuOpen && (
								<div
									role="menu"
									className="absolute right-0 mt-2 w-56 bg-base border border-border-subtle rounded-lg shadow-xl z-50 py-1"
								>
									{canManage && (
										<button
											type="button"
											role="menuitem"
											onClick={() => {
												setIsActionsMenuOpen(
													false
												);
												if (editing)
													cancelEdit();
												else
													startEdit();
											}}
											className={MENU_ITEM}
										>
											<Pencil size={16} />
											{editing
												? "Cancel Edit"
												: "Edit Batch"}
										</button>
									)}
									<button
										type="button"
										role="menuitem"
										onClick={() => {
											setIsActionsMenuOpen(
												false
											);
											handlePrint();
										}}
										className={MENU_ITEM}
									>
										<Printer size={16} />
										Print Label
									</button>
									{canManage && canDeleteBatch && (
										<>
											<div className="my-1 border-t border-border-subtle" />
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setIsActionsMenuOpen(
														false
													);
													setDeleteConfirmOpen(
														true
													);
												}}
												className={`${MENU_ITEM} text-error-text hover:enabled:text-error-text`}
											>
												<Trash2 size={16} />
												Delete Batch
											</button>
										</>
									)}
								</div>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* Unlike SerialDetailBody's equivalent block, the batch impact payload
			carries no `received_at` and no note field, so this shows Supplier and
			Expires instead of Received/Note. */}
			<div className="bg-base border border-border-subtle rounded-xl p-4 flex flex-col sm:flex-row items-stretch gap-4">
				<div className="flex items-center justify-center sm:justify-start flex-shrink-0">
					<QRLabel
						code={batch.code}
						kind="batch"
						primaryLabel={batch.item_name}
						secondaryLabel={batch.batch_number}
						widthIn={1.75}
						heightIn={0.7}
					/>
				</div>
				<div className="hidden sm:block w-px bg-border-subtle self-stretch" aria-hidden />
				<div className="flex-1 min-w-[180px] flex flex-col justify-center gap-2.5">
					<div>
						<div className="text-xs text-text-muted">Supplier</div>
						<div className="text-sm text-text-primary">
							{batch.supplier ?? "—"}
						</div>
					</div>
					<div className="pt-2 border-t border-border-subtle/60">
						<div className="text-xs text-text-muted">Expires</div>
						<div className="text-sm text-text-primary">
							{batch.expires_at ? formatDate(batch.expires_at) : "—"}
						</div>
					</div>
				</div>
			</div>

			{editing && (
				<Card title="Edit Batch">
				<div className="space-y-3">
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
						<div>
							<label className={LABEL}>
								Batch / Lot Number
							</label>
							<input
								type="text"
								value={editDraft.batch_number}
								onChange={(e) =>
									setEditDraft((d) => ({
										...d,
										batch_number:
											e.target
												.value,
									}))
								}
								aria-label="Batch or lot number"
								className={INPUT}
							/>
						</div>
						<div>
							<label className={LABEL}>
								Expires
							</label>
							<input
								type="date"
								value={editDraft.expires_at}
								onChange={(e) =>
									setEditDraft((d) => ({
										...d,
										expires_at: e.target
											.value,
									}))
								}
								aria-label="Expiry date"
								className={INPUT}
							/>
						</div>
						<div>
							<label className={LABEL}>
								Supplier
							</label>
							<input
								type="text"
								value={editDraft.supplier}
								onChange={(e) =>
									setEditDraft((d) => ({
										...d,
										supplier: e.target
											.value,
									}))
								}
								placeholder="Optional"
								aria-label="Supplier"
								className={INPUT}
							/>
						</div>
					</div>
					{editError && (
						<p className="text-sm text-error-text">
							{editError}
						</p>
					)}
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={saveEdit}
							disabled={updateBatchMutation.isPending}
							className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary-hover hover:bg-primary-active text-on-primary rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							<Check size={14} />
							{updateBatchMutation.isPending
								? "Saving…"
								: "Save"}
						</button>
						<button
							type="button"
							onClick={cancelEdit}
							className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
						>
							<X size={14} />
							Cancel
						</button>
					</div>
				</div>
				</Card>
			)}

			{/* Tabs */}
			<div className="flex gap-0 border-b border-border -mt-1">
				{(["overview", "traceability"] as Tab[]).map((t) => (
					<button
						key={t}
						onClick={() => setActiveTab(t)}
						className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
							activeTab === t
								? "border-primary text-primary"
								: "border-transparent text-text-muted hover:text-text-secondary"
						}`}
					>
						{t === "overview" ? "Overview" : "Traceability"}
					</button>
				))}
			</div>

			{activeTab === "overview" && (
				<OverviewTab
					remaining={remaining}
					itemId={batch.item_id}
					batchId={batch.id}
					isSerialized={!!item?.is_serialized}
					onOpenSerial={setOpenSerialId}
				/>
			)}
			{activeTab === "traceability" && (
				<TraceabilityTab
					affectedJobs={affected_jobs}
					affectedSerials={affected_serials}
					onExport={handleExport}
					isExporting={isExporting}
					exportError={exportError}
				/>
			)}

			{/* Recall confirmation */}
			<ConfirmDialog
				open={confirmOpen}
				title={isRecalled ? "Clear Recall" : "Mark Batch as Recalled"}
				body={
					isRecalled
						? `This clears the recall flag on batch ${batch.batch_number}. It will no longer be flagged in traceability reports.`
						: `This flags batch ${batch.batch_number} as recalled — visible org-wide, including the ${remaining.total} unit(s) still in the warehouse or on vehicles and everything traced in the affected jobs/serials below.`
				}
				confirmLabel={isRecalled ? "Clear Recall" : "Mark Recalled"}
				tone={isRecalled ? "primary" : "destructive"}
				pending={updateBatchMutation.isPending}
				error={confirmError}
				onConfirm={handleToggleRecall}
				onCancel={() => {
					setConfirmOpen(false);
					setConfirmError(null);
				}}
			/>

			{item && (
				<ReceiveStockModal
					isOpen={receiveOpen}
					onClose={() => setReceiveOpen(false)}
					item={item}
				/>
			)}

			<ConfirmDialog
				open={deleteConfirmOpen}
				title="Delete Batch"
				body={`This permanently deletes batch ${batch.batch_number}. Only empty lots — no stock in the warehouse or on any vehicle, no serials, and no consumption history — can be deleted, and this cannot be undone.`}
				confirmLabel="Delete Batch"
				tone="destructive"
				pending={deleteBatchMutation.isPending}
				error={deleteError}
				onConfirm={handleDelete}
				onCancel={() => {
					setDeleteConfirmOpen(false);
					setDeleteError(null);
				}}
			/>

			{/* Feedback for adds made here (Print Label, ReceiveStockModal's
			    per-serial queueing), so they don't happen silently on this page. */}
			<LabelQueueToast />

			{/* Driven by ?serial=, so it can already be open on first paint. */}
			<SerialDetailDrawer serialId={openSerialId} onClose={() => setOpenSerialId(null)} />
		</div>
	);
}
