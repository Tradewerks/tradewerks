import { useMemo, useState } from "react";
import { Check, Link2, Download, X } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import { useToast } from "../ui/useToast";
import {
	useQBVendorsQuery,
	useLinkQBVendorMutation,
	useImportQBVendorMutation,
} from "../../hooks/useQuickbooks";
import type { QBVendorLite } from "../../types/quickbooks";

/**
 * Reconcile the QuickBooks vendor list against ours.
 *
 * Link is offered ahead of Import wherever a same-named supplier already exists:
 * two vendor lists drifting apart is the failure this mapping exists to prevent,
 * and pressing "Import" on a vendor you already have is how the drift starts.
 */
export default function QuickBooksVendorsModal({
	isOpen,
	onClose,
}: {
	isOpen: boolean;
	onClose: () => void;
}) {
	const toast = useToast();
	const [search, setSearch] = useState("");
	const { data: vendors = [], isLoading, error } = useQBVendorsQuery(isOpen);
	const link = useLinkQBVendorMutation();
	const importVendor = useImportQBVendorMutation();

	const rows = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return vendors;
		return vendors.filter(
			(v) =>
				v.DisplayName?.toLowerCase().includes(q) ||
				(v.CompanyName ?? "").toLowerCase().includes(q) ||
				(v.AcctNum ?? "").toLowerCase().includes(q),
		);
	}, [vendors, search]);

	const handleLink = async (v: QBVendorLite) => {
		if (!v.suggestedSupplierId) return;
		try {
			await link.mutateAsync({ supplier_id: v.suggestedSupplierId, qb_vendor_id: v.Id });
			toast.success(`Linked ${v.DisplayName}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to link vendor");
		}
	};

	const handleImport = async (v: QBVendorLite) => {
		try {
			const result = await importVendor.mutateAsync(v.Id);
			toast.success(
				result.linkedExisting
					? `Linked to existing supplier ${result.supplier.name}`
					: `Imported ${result.supplier.name}`,
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to import vendor");
		}
	};

	const busy = link.isPending || importVendor.isPending;

	const content = (
		<div className="flex flex-col min-h-0">
			<div className="flex items-center justify-between p-5 pb-3">
				<div>
					<h2 className="text-lg font-semibold text-text-primary">QuickBooks Vendors</h2>
					<p className="text-xs text-text-tertiary mt-0.5">
						Link a QuickBooks vendor to the supplier you already have, or import it as
						a new one.
					</p>
				</div>
				<button
					onClick={onClose}
					aria-label="Close"
					className="text-text-tertiary hover:text-text-primary transition-colors"
				>
					<X size={20} />
				</button>
			</div>

			<div className="px-5 pb-3">
				<input
					type="text"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search QuickBooks vendors…"
					aria-label="Search QuickBooks vendors"
					className="border border-border-input px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors"
				/>
			</div>

			<div className="px-5 pb-5 overflow-y-auto">
				{isLoading ? (
					<p className="text-sm text-text-muted py-6 text-center">Loading vendors…</p>
				) : error ? (
					<p className="text-sm text-error-text py-6 text-center">
						{error instanceof Error ? error.message : "Failed to load vendors"}
					</p>
				) : rows.length === 0 ? (
					<p className="text-sm text-text-muted py-6 text-center">
						{search
							? "No vendor matches that search"
							: "No active vendors in QuickBooks"}
					</p>
				) : (
					<div className="divide-y divide-border-subtle">
						{rows.map((v) => (
							<div key={v.Id} className="flex items-center justify-between gap-3 py-2">
								<div className="min-w-0">
									<div className="text-sm text-text-primary truncate">
										{v.DisplayName}
									</div>
									<div className="text-[11px] text-text-muted truncate">
										{v.AcctNum ? `Acct ${v.AcctNum}` : "No account #"}
										{v.PrimaryEmailAddr?.Address &&
											` · ${v.PrimaryEmailAddr.Address}`}
									</div>
								</div>

								<div className="shrink-0">
									{v.linkedSupplierId ? (
										<span className="inline-flex items-center gap-1 text-xs text-success-text">
											<Check size={12} />
											Linked
										</span>
									) : v.suggestedSupplierId ? (
										// Matched on the same normalized name the supplier table
										// dedupes by, so this is the safe default action.
										<button
											onClick={() => handleLink(v)}
											disabled={busy}
											className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-primary-hover hover:enabled:bg-primary-active text-xs font-medium text-on-primary transition-colors disabled:opacity-40"
										>
											<Link2 size={12} />
											Link to {v.suggestedSupplierName}
										</button>
									) : (
										<button
											onClick={() => handleImport(v)}
											disabled={busy}
											className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-surface hover:enabled:bg-surface-raised border border-border text-xs font-medium text-text-secondary transition-colors disabled:opacity-40"
										>
											<Download size={12} />
											Import
										</button>
									)}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);

	return <FullPopup isModalOpen={isOpen} onClose={onClose} content={content} size="lg" />;
}
