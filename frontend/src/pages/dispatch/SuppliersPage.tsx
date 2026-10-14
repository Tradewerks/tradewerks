import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Ban, GitMerge, Pencil, Plus, RotateCcw, Truck } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import PageControls from "../../components/ui/PageControls";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import AdaptableTable, { type ColumnClamp } from "../../components/AdaptableTable";
import { useToast } from "../../components/ui/useToast";
import { usePermission } from "../../hooks/usePermission";
import { useSuppliers, useUpdateSupplier } from "../../hooks/useSuppliers";
import SupplierFormModal from "../../components/suppliers/SupplierFormModal";
import SupplierMergeModal from "../../components/suppliers/SupplierMergeModal";
import QuickBooksVendorsModal from "../../components/inventory/QuickBooksVendorsModal";
import { useQBStatusQuery } from "../../hooks/useQuickbooks";
import type { Supplier } from "../../types/suppliers";

// Row actions read as buttons at rest, not as text that happens to be clickable.
// Three bare links per row gave no hit target and competed with the row's own
// data for attention; a bordered surface separates "what this vendor is" from
// "what you can do to it".
const ROW_BTN =
	"inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border bg-surface text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-raised hover:border-border-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
// Same silhouette, so the row stays a tidy set — the divergence is on hover,
// where a destructive action should be the only thing that turns red.
const ROW_BTN_DANGER =
	"inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border bg-surface text-xs font-medium text-text-secondary hover:text-error-text hover:bg-error-bg hover:border-error-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

// Status carries tone rather than sitting as plain text, matching how the reorder
// report tints its health column.
const STATUS_CELL_CLASS: Record<string, string> = {
	Active: "text-success-text",
	Inactive: "text-text-muted",
};

// Auto layout means one long value pushes every column right; cap the free-text
// ones so no single column can blow out the table width. Numeric columns are
// left alone — they can't run long. Name gets the largest share on purpose:
// it's the field a dispatcher is actually scanning the list for, so it should
// be the last thing to truncate, not clamped alongside the secondary columns.
const COLUMN_CLAMP: Record<string, ColumnClamp> = {
	name: { maxWidth: "26rem" },
	accountNumber: { maxWidth: "9rem" },
	contact: { maxWidth: "10rem" },
	phone: { maxWidth: "9rem" },
	email: { maxWidth: "14rem" },
};

const HEADER_LABELS: Record<string, string> = {
	name: "Supplier",
	accountNumber: "Account #",
	contact: "Contact",
	phone: "Phone",
	email: "Email",
	purchases: "Purchases",
	lots: "Lots",
	status: "Status",
};

const COLUMN_ALIGN: Record<string, "left" | "right"> = {
	purchases: "right",
	lots: "right",
};

export default function SuppliersPage() {
	const canManage = usePermission("manage_inventory");
	const toast = useToast();
	const navigate = useNavigate();

	const [activeFilter, setActiveFilter] = useState<"true" | "all">("true");
	const [search, setSearch] = useState("");
	const [qbOpen, setQbOpen] = useState(false);
	// Probe rather than assume: QuickBooks can be disconnected per org, and is
	// disabled outright server-side today, in which case this answers false.
	const { data: qbStatus } = useQBStatusQuery();

	// Always fetched whole, then filtered below. Two reasons: the segment badges
	// can only be honest if both counts come from the same fetch, and toggling
	// Active/All stops being a round trip.
	const {
		data: suppliers = [],
		isLoading,
		error,
	} = useSuppliers({ active: "all", include_usage: true });

	const activeCount = useMemo(() => suppliers.filter((s) => s.is_active).length, [suppliers]);

	const [editing, setEditing] = useState<Supplier | null>(null);
	const [formOpen, setFormOpen] = useState(false);

	const [deactivating, setDeactivating] = useState<Supplier | null>(null);
	const [merging, setMerging] = useState<Supplier | null>(null);

	const updateMutation = useUpdateSupplier();

	// Filtered here rather than through the endpoint's `search`: the vendor list
	// is org-sized (tens, not thousands) and already cached, so a keystroke costs
	// nothing and the account number stays searchable alongside the name.
	const rows = useMemo(() => {
		const q = search.trim().toLowerCase();
		const visible =
			activeFilter === "true" ? suppliers.filter((s) => s.is_active) : suppliers;
		const filtered = q
			? visible.filter(
					(s) =>
						s.name.toLowerCase().includes(q) ||
						(s.account_number ?? "").toLowerCase().includes(q) ||
						(s.contact_name ?? "").toLowerCase().includes(q),
				)
			: visible;
		return filtered.map((s) => ({
			id: s.id,
			name: s.name,
			accountNumber: s.account_number ?? "—",
			contact: s.contact_name ?? "—",
			phone: s.phone ?? "—",
			email: s.email ?? "—",
			purchases: s._count?.movements ?? 0,
			lots: s._count?.batches ?? 0,
			status: s.is_active ? "Active" : "Inactive",
			_supplier: s,
		}));
	}, [suppliers, search, activeFilter]);

	const openCreate = () => {
		setEditing(null);
		setFormOpen(true);
	};

	const openEdit = (supplier: Supplier) => {
		setEditing(supplier);
		setFormOpen(true);
	};

	const handleToggleActive = async (supplier: Supplier) => {
		try {
			await updateMutation.mutateAsync({
				id: supplier.id,
				data: { is_active: !supplier.is_active },
			});
			toast.success(supplier.is_active ? "Supplier deactivated" : "Supplier reactivated");
			setDeactivating(null);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update supplier");
		}
	};

	const mergeCandidates = useMemo(
		() => suppliers.filter((s) => s.id !== merging?.id && s.is_active),
		[suppliers, merging],
	);

	return (
		<div className="text-text-primary">
			<PageHeader
				title="Suppliers"
				subtitle={
					<p className="text-sm text-text-tertiary">
						Vendors stock is bought from. Named on receipts, and grouped on each item's
						cost history.
					</p>
				}
			>
				{canManage && qbStatus?.connected && (
					<button
						onClick={() => setQbOpen(true)}
						className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-surface-raised border border-border text-sm font-medium text-text-secondary transition-colors"
					>
						QuickBooks
					</button>
				)}
				<button
					onClick={openCreate}
					disabled={!canManage}
					title={
						!canManage ? "You don't have permission to perform this action" : undefined
					}
					className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary-hover hover:enabled:bg-primary-active text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
				>
					<Plus size={14} />
					New Supplier
				</button>
			</PageHeader>

			<PageControls
				className="mb-4"
				left={
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search suppliers…"
						aria-label="Search suppliers"
						className="border border-border px-2.5 h-[34px] w-full sm:w-64 rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors"
					/>
				}
				right={
					// Boxed, not flat: this filters the list below rather than
					// switching a lens on a chart, so it needs the bordered track
					// every other list-level toggle in the app has. Counts ride in
					// the segments — the row count was otherwise unstated.
					<SegmentedToggle
						value={activeFilter}
						onChange={setActiveFilter}
						options={[
							{ id: "true", label: "Active", badge: activeCount },
							{ id: "all", label: "All", badge: suppliers.length },
						]}
						ariaLabel="Supplier status"
					/>
				}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{rows.length === 0 && !isLoading && !error ? (
					<div className="text-center py-16">
						<Truck size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No suppliers yet
						</h3>
						<p className="text-text-muted text-sm">
							{search
								? "No supplier matches that search"
								: "Suppliers are created automatically the first time you name one on a receipt."}
						</p>
					</div>
				) : (
					<AdaptableTable
						data={rows}
						loadListener={isLoading}
						errListener={error}
						formatNums={false}
						headerLabels={HEADER_LABELS}
						columnAlign={COLUMN_ALIGN}
						columnClamp={COLUMN_CLAMP}
						onRowClick={(row) =>
							navigate(`/dispatch/inventory/suppliers/${(row._supplier as Supplier).id}`)
						}
						cellClass={{
							status: (row) => STATUS_CELL_CLASS[row.status as string] ?? "",
						}}
						actionColumn={{
							header: "",
							cell: (row) => {
								if (!canManage) return null;
								const supplier = row._supplier as Supplier;
								const busy = updateMutation.isPending;
								return (
									// Row itself navigates to the detail page — these
									// buttons stay in-place actions, so they stop the
									// click from also firing that navigation.
									<div
										className="flex items-center justify-end gap-1.5"
										onClick={(e) => e.stopPropagation()}
									>
										<button
											type="button"
											onClick={() => openEdit(supplier)}
											className={ROW_BTN}
										>
											<Pencil size={11} />
											Edit
										</button>
										<button
											type="button"
											onClick={() => setMerging(supplier)}
											title="Fold this vendor into another"
											className={ROW_BTN}
										>
											<GitMerge size={11} />
											Merge
										</button>
										{/* Deactivate confirms first; reactivate is harmless
										    and applies straight away. */}
										<button
											type="button"
											disabled={busy}
											onClick={() =>
												supplier.is_active
													? setDeactivating(supplier)
													: handleToggleActive(supplier)
											}
											className={
												supplier.is_active ? ROW_BTN_DANGER : ROW_BTN
											}
										>
											{supplier.is_active ? (
												<>
													<Ban size={11} />
													Deactivate
												</>
											) : (
												<>
													<RotateCcw size={11} />
													Reactivate
												</>
											)}
										</button>
									</div>
								);
							},
						}}
					/>
				)}
			</div>

			<SupplierFormModal
				isOpen={formOpen}
				onClose={() => setFormOpen(false)}
				editing={editing}
			/>
			<SupplierMergeModal
				isOpen={!!merging}
				onClose={() => setMerging(null)}
				source={merging}
				candidates={mergeCandidates}
			/>

			<QuickBooksVendorsModal isOpen={qbOpen} onClose={() => setQbOpen(false)} />

			<ConfirmDialog
				open={!!deactivating}
				title="Deactivate supplier?"
				body={
					<>
						<span className="font-medium text-text-primary">{deactivating?.name}</span>{" "}
						stops appearing in supplier pickers. Purchases already recorded against it
						keep their attribution — nothing is deleted.
					</>
				}
				confirmLabel="Deactivate"
				tone="destructive"
				pending={updateMutation.isPending}
				onConfirm={() => deactivating && handleToggleActive(deactivating)}
				onCancel={() => setDeactivating(null)}
			/>
		</div>
	);
}
