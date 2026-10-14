import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import { useToast } from "../ui/useToast";
import { useMergeSuppliers } from "../../hooks/useSuppliers";
import type { Supplier, SupplierMergeResult } from "../../types/suppliers";

const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";
const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors disabled:opacity-60";
const BTN_GHOST =
	"inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-transparent text-sm font-medium text-text-tertiary hover:text-text-primary hover:bg-surface hover:border-border-strong transition-colors whitespace-nowrap";
const BTN_CONFIRM =
	"inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-confirm hover:bg-confirm-hover text-sm font-semibold text-on-primary transition-colors whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Folds `source` into a target the caller picks. Shared between SuppliersPage
 * and SupplierDetailPage — same merge, same repoint-then-deactivate warning,
 * regardless of which surface it's opened from.
 */
export default function SupplierMergeModal({
	isOpen,
	onClose,
	source,
	candidates,
	onMerged,
}: {
	isOpen: boolean;
	onClose: () => void;
	source: Supplier | null;
	/** Active vendors `source` can fold into — caller excludes `source` itself. */
	candidates: Supplier[];
	onMerged?: (result: SupplierMergeResult) => void;
}) {
	const toast = useToast();
	const mergeMutation = useMergeSuppliers();

	const [targetId, setTargetId] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!isOpen) return;
		setTargetId("");
		setError(null);
	}, [isOpen, source?.id]);

	const handleMerge = async () => {
		if (!source || !targetId) return;
		setError(null);
		try {
			const result = await mergeMutation.mutateAsync({ sourceId: source.id, targetId });
			toast.success(
				`Merged into ${result.target.name} — ${result.moved.movements} purchase${
					result.moved.movements === 1 ? "" : "s"
				}, ${result.moved.batches} lot${result.moved.batches === 1 ? "" : "s"}, and ${
					result.moved.supplierItems
				} price list entr${result.moved.supplierItems === 1 ? "y" : "ies"} repointed`,
			);
			onMerged?.(result);
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to merge suppliers");
		}
	};

	const content = (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-border flex-shrink-0">
				<h2 className="text-lg sm:text-xl font-bold text-text-primary whitespace-nowrap">
					Merge Supplier
				</h2>
				<button
					type="button"
					onClick={onClose}
					disabled={mergeMutation.isPending}
					aria-label="Close"
					className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface rounded transition-colors"
				>
					<X size={18} />
				</button>
			</div>

			<div className="px-4 sm:px-5 pt-3 sm:pt-4 pb-4 space-y-4 overflow-y-auto">
				<p className="text-sm text-text-secondary">
					Every purchase and lot recorded against{" "}
					<span className="font-medium text-text-primary">{source?.name}</span> is
					repointed at the supplier you choose. {source?.name} is then deactivated — it
					stays visible on past records, but can't be picked again.
				</p>

				<div>
					<label className={LABEL}>Merge into</label>
					<select
						value={targetId}
						onChange={(e) => setTargetId(e.target.value)}
						aria-label="Merge target"
						className={INPUT}
						disabled={mergeMutation.isPending}
					>
						<option value="">Select a supplier…</option>
						{candidates.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border bg-base flex-shrink-0">
				{error ? <p className="text-xs text-error-text">{error}</p> : <span />}
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onClose}
						disabled={mergeMutation.isPending}
						className={BTN_GHOST}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleMerge}
						disabled={!targetId || mergeMutation.isPending}
						className={BTN_CONFIRM}
					>
						{mergeMutation.isPending && <Loader2 size={12} className="animate-spin" />}
						Merge
					</button>
				</div>
			</div>
		</div>
	);

	return <FullPopup isModalOpen={isOpen} onClose={onClose} content={content} />;
}
