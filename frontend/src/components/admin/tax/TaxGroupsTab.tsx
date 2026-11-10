import { useState } from "react";
import { Plus, Loader2, X, Check } from "lucide-react";
import {
	useTaxRates,
	useTaxGroups,
	useCreateTaxGroup,
	useUpdateTaxGroup,
	useDeleteTaxGroup,
} from "../../../hooks/useTaxGroups";
import type { TaxRate, TaxGroup } from "../../../types/tax";
import { formatCombinedRate } from "../../../types/tax";
import type { CreateTaxGroupInput, UpdateTaxGroupInput } from "../../../api/tax";
import { formatRatePercent } from "../../../lib/formatTax";
import { DeactivateModal, RowMenu, inputBase, labelBase } from "./taxSettingsUi";
import { useFeedback } from "./taxSettingsHelpers";
import {
	activeDefaultGroup,
	deactivateDefaultWarning,
	defaultCheckboxLabel,
	defaultChipLabel,
	groupsExplainer,
	type TaxMode,
} from "./taxSettingsCopy";

// ============================================================================
// TAX GROUP FORM MODAL
// ============================================================================

interface GroupFormModalProps {
	mode: "create" | "edit";
	taxMode: TaxMode;
	initial?: TaxGroup;
	activeRates: TaxRate[];
	isPending: boolean;
	error: string | null;
	onSubmit: (data: CreateTaxGroupInput | UpdateTaxGroupInput) => void;
	onClose: () => void;
}

function GroupFormModal({ mode, taxMode, initial, activeRates, isPending, error, onSubmit, onClose }: GroupFormModalProps) {
	const [name, setName] = useState(initial?.name ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [isDefault, setIsDefault] = useState(initial?.is_default ?? false);
	const [selectedRateIds, setSelectedRateIds] = useState<string[]>(
		initial?.rates.map((r) => r.tax_rate.id) ?? []
	);
	const [nameErr, setNameErr] = useState<string | null>(null);

	const combinedRate = activeRates
		.filter((r) => selectedRateIds.includes(r.id))
		.reduce((sum, r) => sum + Number(r.rate), 0);

	const toggleRate = (id: string) => {
		setSelectedRateIds((prev) =>
			prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
		);
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			setNameErr("Name is required.");
			return;
		}
		onSubmit({
			name: name.trim(),
			description: description.trim() || null,
			is_default: isDefault,
			rate_ids: selectedRateIds,
		});
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="group-modal-title"
				className="w-full max-w-md rounded-lg border border-border bg-base shadow-xl"
			>
				<div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
					<h3 id="group-modal-title" className="text-sm font-semibold text-text-primary">
						{mode === "create" ? "Add Tax Group" : "Edit Tax Group"}
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
							placeholder="e.g. Standard Rate"
							autoFocus
						/>
						{nameErr && <p className="mt-1 text-xs text-error-text">{nameErr}</p>}
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

					{/* Tax Rates multi-select */}
					<div>
						<label className={labelBase}>Tax Rates</label>
						{activeRates.length === 0 ? (
							<p className="text-xs text-text-muted">No active tax rates available.</p>
						) : (
							<div className="space-y-1 rounded-md border border-border bg-surface p-2">
								{activeRates.map((rate) => (
									<label
										key={rate.id}
										className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 transition-colors hover:bg-surface-raised"
									>
										<input
											type="checkbox"
											checked={selectedRateIds.includes(rate.id)}
											onChange={() => toggleRate(rate.id)}
											className="sr-only"
										/>
										<div
											aria-hidden="true"
											className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
												selectedRateIds.includes(rate.id)
													? "border-primary bg-primary"
													: "border-border hover:border-border-strong"
											}`}
										>
											{selectedRateIds.includes(rate.id) && (
												<Check size={10} className="text-white" strokeWidth={3} />
											)}
										</div>
										<span className="flex-1 text-xs text-text-primary">{rate.name}</span>
										<span className="text-xs text-text-muted">
											{formatRatePercent(rate.rate)}%
											{rate.jurisdiction && (
												<span className="ml-1 text-text-muted/60">· {rate.jurisdiction}</span>
											)}
										</span>
									</label>
								))}
							</div>
						)}
						{selectedRateIds.length > 0 && (
							<p className="mt-1.5 text-xs text-text-tertiary">
								Combined: <span className="font-medium text-text-primary">{formatCombinedRate(combinedRate)}</span>
							</p>
						)}
					</div>

					{/* Default */}
					<label className="flex cursor-pointer items-center gap-2.5">
						<input
							type="checkbox"
							checked={isDefault}
							onChange={(e) => setIsDefault(e.target.checked)}
							className="sr-only"
						/>
						<div
							aria-hidden="true"
							className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
								isDefault
									? "border-primary bg-primary"
									: "border-border bg-surface hover:border-border-strong"
							}`}
						>
							{isDefault && <Check size={10} className="text-white" strokeWidth={3} />}
						</div>
						<span className="text-xs text-text-secondary">{defaultCheckboxLabel(taxMode)}</span>
					</label>

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
							{isPending ? "Saving…" : mode === "create" ? "Add Group" : "Save Changes"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

// ============================================================================
// TAX GROUPS TAB
// ============================================================================

interface TaxGroupsTabProps {
	showInactive: boolean;
	mode: TaxMode;
	legacyRate: number;
}

export default function TaxGroupsTab({ showInactive, mode, legacyRate }: TaxGroupsTabProps) {
	const { data: groups, isLoading, error } = useTaxGroups(showInactive);
	const { data: activeRates } = useTaxRates(false);
	const createMutation = useCreateTaxGroup();
	const updateMutation = useUpdateTaxGroup();
	const deleteMutation = useDeleteTaxGroup();

	const [showAddModal, setShowAddModal] = useState(false);
	const [editingGroup, setEditingGroup] = useState<TaxGroup | null>(null);
	const [deactivatingGroup, setDeactivatingGroup] = useState<TaxGroup | null>(null);
	const [mutationError, setMutationError] = useState<string | null>(null);
	const { feedback, showFeedback } = useFeedback();

	const handleCreate = async (data: CreateTaxGroupInput | UpdateTaxGroupInput) => {
		setMutationError(null);
		try {
			await createMutation.mutateAsync(data as CreateTaxGroupInput);
			setShowAddModal(false);
			showFeedback("success", "Tax group added.");
		} catch (err) {
			setMutationError(err instanceof Error ? err.message : "Failed to create tax group.");
		}
	};

	const handleUpdate = async (data: CreateTaxGroupInput | UpdateTaxGroupInput) => {
		if (!editingGroup) return;
		setMutationError(null);
		try {
			await updateMutation.mutateAsync({ id: editingGroup.id, data: data as UpdateTaxGroupInput });
			setEditingGroup(null);
			showFeedback("success", "Tax group updated.");
		} catch (err) {
			setMutationError(err instanceof Error ? err.message : "Failed to update tax group.");
		}
	};

	const handleDeactivateConfirm = async () => {
		if (!deactivatingGroup) return;
		try {
			await deleteMutation.mutateAsync(deactivatingGroup.id);
			setDeactivatingGroup(null);
			showFeedback("success", "Tax group deactivated.");
		} catch (err) {
			setMutationError(err instanceof Error ? err.message : "Failed to deactivate tax group.");
			setDeactivatingGroup(null);
			showFeedback("error", err instanceof Error ? err.message : "Failed to deactivate.");
		}
	};

	const displayGroups = groups ?? [];
	const availableRates = activeRates ?? [];
	const defaultId = activeDefaultGroup(displayGroups)?.id;

	return (
		<div>
			{/* Toolbar */}
			<div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-3">
				<p className="min-w-0 text-xs text-text-muted">{groupsExplainer(mode)}</p>
				<button
					type="button"
					onClick={() => { setMutationError(null); setShowAddModal(true); }}
					className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
				>
					<Plus size={12} />
					Add Group
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
			{!isLoading && !error && displayGroups.length === 0 && (
				<div className="px-5 py-10 text-center">
					<p className="text-sm text-text-muted">No tax groups yet. Create a group to bundle rates together.</p>
				</div>
			)}

			{/* Table */}
			{!isLoading && !error && displayGroups.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[520px]">
						<thead>
							<tr className="border-b border-border-subtle">
								<th className="px-5 py-2.5 text-left text-xs font-medium text-text-muted">Name</th>
								<th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Rates</th>
								<th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Total</th>
								<th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Status</th>
								<th className="w-8 px-3 py-2.5" />
							</tr>
						</thead>
						<tbody>
							{displayGroups.map((group, idx) => (
								<tr
									key={group.id}
									className={`border-b border-border-subtle/50 transition-colors hover:bg-surface/40 ${!group.is_active ? "opacity-50" : ""} ${idx === displayGroups.length - 1 ? "border-b-0" : ""}`}
								>
									<td className="px-5 py-3 text-sm font-medium text-text-primary">
										{group.name}
										{group.id === defaultId && (
											<span className="ml-2 inline-flex items-center align-middle rounded-full border border-primary-border bg-primary-bg px-2 py-0.5 text-xs font-medium text-primary-text">
												{defaultChipLabel(mode)}
											</span>
										)}
										{group.description && (
											<p className="mt-0.5 text-xs font-normal text-text-muted">{group.description}</p>
										)}
									</td>
									<td className="px-3 py-3">
										{group.rates.length === 0 ? (
											<span className="text-xs text-text-muted">No rates</span>
										) : (
											<span className="text-xs text-text-secondary">
												{group.rates
													.map((r) => `${r.tax_rate.name} ${formatRatePercent(r.tax_rate.rate)}%`)
													.join(" + ")}
											</span>
										)}
									</td>
									<td className="px-3 py-3 text-sm tabular-nums text-text-primary">
										{formatCombinedRate(group.combined_rate)}
									</td>
									<td className="px-3 py-3">
										{group.is_active ? (
											<span className="text-xs text-text-muted">Active</span>
										) : (
											<span className="text-xs text-text-faint">Inactive</span>
										)}
									</td>
									<td className="px-3 py-3">
										{group.is_active && (
											<RowMenu
												onEdit={() => { setMutationError(null); setEditingGroup(group); }}
												onDeactivate={() => setDeactivatingGroup(group)}
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
				<GroupFormModal
					mode="create"
					taxMode={mode}
					activeRates={availableRates}
					isPending={createMutation.isPending}
					error={mutationError}
					onSubmit={handleCreate}
					onClose={() => { setShowAddModal(false); setMutationError(null); }}
				/>
			)}

			{editingGroup && (
				<GroupFormModal
					mode="edit"
					taxMode={mode}
					initial={editingGroup}
					activeRates={availableRates}
					isPending={updateMutation.isPending}
					error={mutationError}
					onSubmit={handleUpdate}
					onClose={() => { setEditingGroup(null); setMutationError(null); }}
				/>
			)}

			{deactivatingGroup && (
				<DeactivateModal
					title="Deactivate Tax Group"
					body={`Deactivate "${deactivatingGroup.name}"? It will no longer be available for new assignments.`}
					warning={
						deactivatingGroup.id === defaultId
							? deactivateDefaultWarning(mode, legacyRate)
							: undefined
					}
					isPending={deleteMutation.isPending}
					onConfirm={handleDeactivateConfirm}
					onCancel={() => setDeactivatingGroup(null)}
				/>
			)}
		</div>
	);
}
