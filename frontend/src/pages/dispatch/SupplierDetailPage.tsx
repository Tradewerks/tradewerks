import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
	Ban,
	GitMerge,
	Mail,
	MoreVertical,
	Pencil,
	Phone,
	RotateCcw,
	ShoppingCart,
	Truck,
	type LucideIcon,
} from "lucide-react";
import { useSuppliers, useSupplierQuery, useUpdateSupplier } from "../../hooks/useSuppliers";
import { usePermission } from "../../hooks/usePermission";
import { useToast } from "../../components/ui/useToast";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import SupplierFormModal from "../../components/suppliers/SupplierFormModal";
import SupplierMergeModal from "../../components/suppliers/SupplierMergeModal";
import SupplierPriceList from "../../components/suppliers/SupplierPriceList";
import SupplierMovementList from "../../components/suppliers/SupplierMovementList";
import SupplierBatchesTable from "../../components/suppliers/SupplierBatchesTable";

const MENU_ITEM =
	"w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed";

// Same tile shape as ItemStatRow (inventory item detail page) — the app's one
// headline-KPI pattern, reused rather than reinvented so this page's stats
// carry the same visual weight and read the same way.
function Tile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
	return (
		<div className="flex-1 min-w-[140px] bg-base border border-border-subtle rounded-lg px-4 py-3">
			<div className="flex items-center gap-1.5 text-text-muted">
				<Icon size={13} />
				<span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
			</div>
			<div className="mt-1 text-xl font-bold tabular-nums text-text-primary leading-tight">
				{value}
			</div>
		</div>
	);
}

/**
 * Operational vendor report: what we buy from them, at what price, and every
 * lot/purchase on record. Deliberately stops at the boundary QuickBooks owns —
 * no balance, bills, or payment status here. Those live in QBO; this page
 * answers the reorder-and-receiving questions QBO has no concept of.
 */
export default function SupplierDetailPage() {
	const { supplierId } = useParams<{ supplierId: string }>();
	const navigate = useNavigate();
	const canManage = usePermission("manage_inventory");
	const toast = useToast();
	const { data: supplier, isLoading, isError } = useSupplierQuery(supplierId);
	// Only fetched for the merge modal's candidate list — active vendors this
	// one could fold into, itself excluded.
	const { data: allSuppliers = [] } = useSuppliers({ active: "true" });

	const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [mergeOpen, setMergeOpen] = useState(false);
	const [deactivating, setDeactivating] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const updateMutation = useUpdateSupplier();

	const mergeCandidates = useMemo(
		() => allSuppliers.filter((s) => s.id !== supplier?.id),
		[allSuppliers, supplier?.id],
	);

	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
				setIsActionsMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const handleToggleActive = async () => {
		if (!supplier) return;
		try {
			await updateMutation.mutateAsync({
				id: supplier.id,
				data: { is_active: !supplier.is_active },
			});
			toast.success(supplier.is_active ? "Supplier deactivated" : "Supplier reactivated");
			setDeactivating(false);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update supplier");
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Loading supplier…</div>
			</div>
		);
	}

	if (isError || !supplier) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Supplier not found</div>
			</div>
		);
	}

	return (
		<div className="text-text-primary space-y-6">
			{/* Header. Identity on the left; the actions menu on the right — same
			    grid-cols-2 + justify-self-end shape every other detail page uses
			    (InventoryItemDetailPage, QuoteDetailPage, ProjectDetailPage, ...).
			    No back link: the top nav's own Back button already covers that. */}
			<div className="grid grid-cols-2 gap-4 items-center">
				<div className="min-w-0">
					<div className="flex items-center gap-2.5 flex-wrap mb-1">
						<h1 className="text-3xl font-bold text-text-primary break-words">
							{supplier.name}
						</h1>
						{!supplier.is_active && (
							<span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-surface-raised text-text-tertiary border border-border-strong">
								Inactive
							</span>
						)}
					</div>
					<div className="flex items-center gap-4 text-text-tertiary text-sm flex-wrap">
						{supplier.account_number && <span>Account #{supplier.account_number}</span>}
						{supplier.contact_name && <span>{supplier.contact_name}</span>}
						{supplier.phone && (
							<span className="flex items-center gap-1">
								<Phone size={12} />
								{supplier.phone}
							</span>
						)}
						{supplier.email && (
							<span className="flex items-center gap-1">
								<Mail size={12} />
								{supplier.email}
							</span>
						)}
					</div>
				</div>

				{canManage && (
					<div className="justify-self-end relative" ref={menuRef}>
						<button
							aria-label="More supplier actions"
							aria-haspopup="menu"
							aria-expanded={isActionsMenuOpen}
							onClick={() => setIsActionsMenuOpen((v) => !v)}
							className="p-2 hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong"
						>
							<MoreVertical size={20} />
						</button>

						{isActionsMenuOpen && (
							<div className="absolute right-0 mt-2 w-56 bg-base border border-border-subtle rounded-lg shadow-xl z-50">
								<div className="py-1">
									<button
										onClick={() => {
											setIsActionsMenuOpen(false);
											setEditOpen(true);
										}}
										className={MENU_ITEM}
									>
										<Pencil size={16} />
										Edit Supplier
									</button>
									<button
										onClick={() => {
											setIsActionsMenuOpen(false);
											setMergeOpen(true);
										}}
										title="Fold this vendor into another"
										className={MENU_ITEM}
									>
										<GitMerge size={16} />
										Merge Supplier
									</button>
									<div className="my-1 border-t border-border-subtle" />
									<button
										onClick={() => {
											setIsActionsMenuOpen(false);
											if (supplier.is_active) setDeactivating(true);
											else handleToggleActive();
										}}
										disabled={updateMutation.isPending}
										className={`${MENU_ITEM} ${supplier.is_active ? "text-error-text hover:enabled:text-error-text" : ""}`}
									>
										{supplier.is_active ? (
											<>
												<Ban size={16} />
												Deactivate Supplier
											</>
										) : (
											<>
												<RotateCcw size={16} />
												Reactivate Supplier
											</>
										)}
									</button>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			{supplier.notes && (
				<p className="text-sm text-text-secondary max-w-2xl whitespace-pre-wrap">
					{supplier.notes}
				</p>
			)}

			{/* Purchases / Lots — same headline-KPI tile InventoryItemDetailPage
			    uses (ItemStatRow), placed below the identity/description block so
			    it reads as its own report, not header trim. */}
			<div className="flex flex-wrap gap-3">
				<Tile icon={ShoppingCart} label="Purchases" value={supplier._count.movements} />
				<Tile icon={Truck} label="Lots" value={supplier._count.batches} />
			</div>

			<SupplierPriceList supplierId={supplier.id} />

			<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
				<SupplierMovementList supplierId={supplier.id} />
				<SupplierBatchesTable supplierId={supplier.id} />
			</div>

			<SupplierFormModal isOpen={editOpen} onClose={() => setEditOpen(false)} editing={supplier} />
			<SupplierMergeModal
				isOpen={mergeOpen}
				onClose={() => setMergeOpen(false)}
				source={supplier}
				candidates={mergeCandidates}
				// The source vendor is deactivated and its history repointed —
				// this page's own data is now stale, so follow the record to
				// wherever it actually lives.
				onMerged={(result) => navigate(`/dispatch/inventory/suppliers/${result.target.id}`)}
			/>
			<ConfirmDialog
				open={deactivating}
				title="Deactivate supplier?"
				body={
					<>
						<span className="font-medium text-text-primary">{supplier.name}</span> stops
						appearing in supplier pickers. Purchases already recorded against it keep their
						attribution — nothing is deleted.
					</>
				}
				confirmLabel="Deactivate"
				tone="destructive"
				pending={updateMutation.isPending}
				onConfirm={handleToggleActive}
				onCancel={() => setDeactivating(false)}
			/>
		</div>
	);
}
