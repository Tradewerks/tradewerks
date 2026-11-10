import { useState } from "react";
import { Plus, Loader2, X } from "lucide-react";
import {
	useTaxRates,
	useTaxGroups,
	useCreateTaxRate,
	useUpdateTaxRate,
	useDeleteTaxRate,
} from "../../../hooks/useTaxGroups";
import type { TaxRate } from "../../../types/tax";
import type { CreateTaxRateInput, UpdateTaxRateInput } from "../../../api/tax";
import { formatRatePercent } from "../../../lib/formatTax";
import { DeactivateModal, RowMenu, inputBase, labelBase } from "./taxSettingsUi";
import { percentToRate, rateToPercent, useFeedback } from "./taxSettingsHelpers";
import { RATES_EXPLAINER, ratesOutsideActiveGroups } from "./taxSettingsCopy";

// ============================================================================
// TAX RATE FORM MODAL
// ============================================================================

interface RateFormModalProps {
	mode: "create" | "edit";
	initial?: TaxRate;
	isPending: boolean;
	error: string | null;
	onSubmit: (data: CreateTaxRateInput | UpdateTaxRateInput) => void;
	onClose: () => void;
}

function RateFormModal({ mode, initial, isPending, error, onSubmit, onClose }: RateFormModalProps) {
	const [name, setName] = useState(initial?.name ?? "");
	const [pct, setPct] = useState(initial ? rateToPercent(initial.rate) : "");
	const [jurisdiction, setJurisdiction] = useState(initial?.jurisdiction ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [nameErr, setNameErr] = useState<string | null>(null);
	const [pctErr, setPctErr] = useState<string | null>(null);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		let valid = true;
		if (!name.trim()) {
			setNameErr("Name is required.");
			valid = false;
		}
		const rateVal = parseFloat(pct);
		if (isNaN(rateVal) || rateVal < 0 || rateVal > 100) {
			setPctErr("Enter a rate between 0 and 100.");
			valid = false;
		}
		if (!valid) return;

		onSubmit({
			name: name.trim(),
			rate: percentToRate(pct),
			jurisdiction: jurisdiction.trim() || null,
			description: description.trim() || null,
		});
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="rate-modal-title"
				className="w-full max-w-md rounded-lg border border-border bg-base shadow-xl"
			>
				<div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
					<h3 id="rate-modal-title" className="text-sm font-semibold text-text-primary">
						{mode === "create" ? "Add Tax Rate" : "Edit Tax Rate"}
					</h3>
					<button
						type="button"
						aria-label="Close"
						onClick={onClose}
						className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-primary"
					>
						<X size={14} />
					</button>
				</div>
				<form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
					{/* Name */}
					<div>
						<label className={labelBase}>Name <span className="text-error-text">*</span></label>
						<input
							type="text"
							value={name}
							onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameErr(null); }}
							className={`${inputBase} ${nameErr ? "!border-error focus:!border-error focus:!ring-error" : ""}`}
							placeholder="e.g. Sales Tax"
							autoFocus
						/>
						{nameErr && <p className="mt-1 text-xs text-error-text">{nameErr}</p>}
					</div>

					{/* Rate % */}
					<div>
						<label className={labelBase}>Rate % <span className="text-error-text">*</span></label>
						<div className="relative">
							<input
								type="number"
								step="any"
								min="0"
								max="100"
								value={pct}
								onChange={(e) => { setPct(e.target.value); setPctErr(null); }}
								className={`${inputBase} pr-7 ${pctErr ? "!border-error focus:!border-error focus:!ring-error" : ""}`}
								placeholder="6.5"
							/>
							<span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-text-muted">%</span>
						</div>
						{pctErr && <p className="mt-1 text-xs text-error-text">{pctErr}</p>}
					</div>

					{/* Jurisdiction */}
					<div>
						<label className={labelBase}>Jurisdiction</label>
						<input
							type="text"
							value={jurisdiction}
							onChange={(e) => setJurisdiction(e.target.value)}
							className={inputBase}
							placeholder="e.g. State, County, City"
						/>
					</div>

					{/* Description */}
					<div>
						<label className={labelBase}>Description</label>
						<input
							type="text"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							className={inputBase}
							placeholder="Optional note"
						/>
					</div>

					{error && (
						<div className="rounded-md border border-error-border bg-error-bg px-3 py-2">
							<p className="text-xs text-error-text">{error}</p>
						</div>
					)}

					<div className="flex items-center justify-end gap-2 pt-1">
						<button
							type="button"
							onClick={onClose}
							disabled={isPending}
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised disabled:opacity-50"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={isPending}
							className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isPending && <Loader2 size={12} className="animate-spin" />}
							{isPending ? "Saving…" : mode === "create" ? "Add Rate" : "Save Changes"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

// ============================================================================
// TAX RATES TAB
// ============================================================================

interface TaxRatesTabProps {
	showInactive: boolean;
}

export default function TaxRatesTab({ showInactive }: TaxRatesTabProps) {
	const { data: rates, isLoading, error } = useTaxRates(showInactive);
	const { data: activeGroups } = useTaxGroups(false);
	// Until groups load, show no note rather than flag every rate.
	const outsideGroups = activeGroups ? ratesOutsideActiveGroups(activeGroups) : () => false;
	const createMutation = useCreateTaxRate();
	const updateMutation = useUpdateTaxRate();
	const deleteMutation = useDeleteTaxRate();

	const [showAddModal, setShowAddModal] = useState(false);
	const [editingRate, setEditingRate] = useState<TaxRate | null>(null);
	const [deactivatingRate, setDeactivatingRate] = useState<TaxRate | null>(null);
	const [deactivateWarning, setDeactivateWarning] = useState<string | null>(null);
	const [mutationError, setMutationError] = useState<string | null>(null);
	const { feedback, showFeedback } = useFeedback();

	const handleCreate = async (data: CreateTaxRateInput | UpdateTaxRateInput) => {
		setMutationError(null);
		try {
			await createMutation.mutateAsync(data as CreateTaxRateInput);
			setShowAddModal(false);
			showFeedback("success", "Tax rate added.");
		} catch (err) {
			setMutationError(err instanceof Error ? err.message : "Failed to create tax rate.");
		}
	};

	const handleUpdate = async (data: CreateTaxRateInput | UpdateTaxRateInput) => {
		if (!editingRate) return;
		setMutationError(null);
		try {
			await updateMutation.mutateAsync({ id: editingRate.id, data: data as UpdateTaxRateInput });
			setEditingRate(null);
			showFeedback("success", "Tax rate updated.");
		} catch (err) {
			setMutationError(err instanceof Error ? err.message : "Failed to update tax rate.");
		}
	};

	const handleDeactivateClick = (rate: TaxRate) => {
		setDeactivateWarning(null);
		setDeactivatingRate(rate);
	};

	const handleDeactivateConfirm = async () => {
		if (!deactivatingRate) return;
		try {
			await deleteMutation.mutateAsync(deactivatingRate.id);
			setDeactivatingRate(null);
			setDeactivateWarning(null);
			showFeedback("success", "Tax rate deactivated.");
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to deactivate.";
			// 409 conflict — rate is in use by a group
			setDeactivateWarning(msg);
		}
	};

	const displayRates = rates ?? [];

	return (
		<div>
			{/* Toolbar */}
			<div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-3">
				<p className="min-w-0 text-xs text-text-muted">{RATES_EXPLAINER}</p>
				<button
					type="button"
					onClick={() => { setMutationError(null); setShowAddModal(true); }}
					className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
				>
					<Plus size={12} />
					Add Rate
				</button>
			</div>

			{/* Inline feedback */}
			{feedback && (
				<div className={`border-b border-border-subtle px-5 py-2 text-xs ${feedback.type === "success" ? "text-success-text" : "text-error-text"}`}>
					{feedback.message}
				</div>
			)}

			{/* Loading */}
			{isLoading && (
				<div className="flex items-center justify-center px-5 py-10">
					<Loader2 size={20} className="animate-spin text-text-muted" />
				</div>
			)}

			{/* Error */}
			{error && !isLoading && (
				<div className="px-5 py-6">
					<p className="text-sm text-error-text">{error.message}</p>
				</div>
			)}

			{/* Empty */}
			{!isLoading && !error && displayRates.length === 0 && (
				<div className="px-5 py-10 text-center">
					<p className="text-sm text-text-muted">No tax rates yet. Add your first tax rate to get started.</p>
				</div>
			)}

			{/* Table */}
			{!isLoading && !error && displayRates.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[420px]">
						<thead>
							<tr className="border-b border-border-subtle">
								<th className="px-5 py-2.5 text-left text-xs font-medium text-text-muted">Name</th>
								<th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Jurisdiction</th>
								<th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Rate</th>
								<th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Status</th>
								<th className="w-8 px-3 py-2.5" />
							</tr>
						</thead>
						<tbody>
							{displayRates.map((rate, idx) => (
								<tr
									key={rate.id}
									className={`border-b border-border-subtle/50 transition-colors hover:bg-surface/40 ${!rate.is_active ? "opacity-50" : ""} ${idx === displayRates.length - 1 ? "border-b-0" : ""}`}
								>
									<td className="px-5 py-3 text-sm font-medium text-text-primary">
										{rate.name}
										{rate.description && (
											<p className="mt-0.5 text-xs font-normal text-text-muted">{rate.description}</p>
										)}
										{rate.is_active && outsideGroups(rate.id) && (
											<p className="mt-0.5 text-xs font-normal text-text-faint">Not in any group</p>
										)}
									</td>
									<td className="px-3 py-3 text-xs text-text-secondary">
										{rate.jurisdiction ?? <span className="text-text-muted">—</span>}
									</td>
									<td className="px-3 py-3 text-sm tabular-nums text-text-primary">
										{formatRatePercent(rate.rate)}%
									</td>
									<td className="px-3 py-3">
										{rate.is_active ? (
											<span className="text-xs text-text-muted">Active</span>
										) : (
											<span className="text-xs text-text-faint">Inactive</span>
										)}
									</td>
									<td className="px-3 py-3">
										{rate.is_active && (
											<RowMenu
												onEdit={() => { setMutationError(null); setEditingRate(rate); }}
												onDeactivate={() => handleDeactivateClick(rate)}
											/>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{/* Modals */}
			{showAddModal && (
				<RateFormModal
					mode="create"
					isPending={createMutation.isPending}
					error={mutationError}
					onSubmit={handleCreate}
					onClose={() => { setShowAddModal(false); setMutationError(null); }}
				/>
			)}

			{editingRate && (
				<RateFormModal
					mode="edit"
					initial={editingRate}
					isPending={updateMutation.isPending}
					error={mutationError}
					onSubmit={handleUpdate}
					onClose={() => { setEditingRate(null); setMutationError(null); }}
				/>
			)}

			{deactivatingRate && (
				<DeactivateModal
					title="Deactivate Tax Rate"
					body={`Deactivate "${deactivatingRate.name}"? It will no longer be available for new assignments.`}
					warning={deactivateWarning ?? undefined}
					isPending={deleteMutation.isPending}
					onConfirm={handleDeactivateConfirm}
					onCancel={() => { setDeactivatingRate(null); setDeactivateWarning(null); }}
				/>
			)}
		</div>
	);
}
