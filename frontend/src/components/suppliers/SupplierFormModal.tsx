import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import { useToast } from "../ui/useToast";
import { useCreateSupplier, useUpdateSupplier } from "../../hooks/useSuppliers";
import { SupplierConflictError, type CreateSupplierInput } from "../../api/suppliers";
import type { Supplier } from "../../types/suppliers";

// Same primitives as CreateClient.tsx and the followups modals — the house form
// pattern, kept identical rather than approximated so a supplier form doesn't
// read as a different product than a client form.
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";
const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors disabled:opacity-60";
const TEXTAREA =
	"border border-border px-2.5 py-2 w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors resize-none disabled:opacity-60";
const BTN_GHOST =
	"inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-transparent text-sm font-medium text-text-tertiary hover:text-text-primary hover:bg-surface hover:border-border-strong transition-colors whitespace-nowrap";
const BTN_CONFIRM =
	"inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-confirm hover:bg-confirm-hover text-sm font-semibold text-on-primary transition-colors whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50";

interface FormState {
	name: string;
	account_number: string;
	contact_name: string;
	phone: string;
	email: string;
	notes: string;
}

const EMPTY_FORM: FormState = {
	name: "",
	account_number: "",
	contact_name: "",
	phone: "",
	email: "",
	notes: "",
};

function toForm(supplier: Supplier): FormState {
	return {
		name: supplier.name,
		account_number: supplier.account_number ?? "",
		contact_name: supplier.contact_name ?? "",
		phone: supplier.phone ?? "",
		email: supplier.email ?? "",
		notes: supplier.notes ?? "",
	};
}

/**
 * Create/edit supplier form, shared between SuppliersPage's row action and
 * SupplierDetailPage's header menu — one form, so the two surfaces can never
 * drift into asking for the vendor's name two different ways.
 */
export default function SupplierFormModal({
	isOpen,
	onClose,
	editing,
	onSaved,
	initialName,
}: {
	isOpen: boolean;
	onClose: () => void;
	/** null = creating a new vendor; a Supplier = editing that one. */
	editing: Supplier | null;
	onSaved?: (supplier: Supplier) => void;
	/** Seeds the name field on a fresh create — e.g. text a caller's own picker already typed. Ignored while editing. */
	initialName?: string;
}) {
	const toast = useToast();
	const createMutation = useCreateSupplier();
	const updateMutation = useUpdateSupplier();

	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [formError, setFormError] = useState<string | null>(null);

	// Reseeds whenever the modal opens on a (possibly different) supplier —
	// closing without saving must not leave a stale edit sitting in state for
	// the next open.
	useEffect(() => {
		if (!isOpen) return;
		setForm(editing ? toForm(editing) : { ...EMPTY_FORM, name: initialName ?? "" });
		setFormError(null);
	}, [isOpen, editing, initialName]);

	const isSaving = createMutation.isPending || updateMutation.isPending;

	const handleSave = async () => {
		if (!form.name.trim()) {
			setFormError("Name is required.");
			return;
		}
		setFormError(null);
		const data: CreateSupplierInput = {
			name: form.name,
			account_number: form.account_number,
			contact_name: form.contact_name,
			phone: form.phone,
			email: form.email,
			notes: form.notes,
		};
		try {
			const saved = editing
				? await updateMutation.mutateAsync({ id: editing.id, data })
				: await createMutation.mutateAsync(data);
			toast.success(editing ? "Supplier updated" : "Supplier created");
			onSaved?.(saved);
			onClose();
		} catch (e) {
			// A name collision is recoverable by hand — name the vendor that owns
			// it instead of just saying "already exists".
			const message =
				e instanceof SupplierConflictError
					? `${e.existing?.name ?? form.name.trim()} already exists. Merge into it instead of creating a duplicate.`
					: e instanceof Error
						? e.message
						: "Failed to save supplier";
			setFormError(message);
		}
	};

	const content = (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-border flex-shrink-0">
				<h2 className="text-lg sm:text-xl font-bold text-text-primary whitespace-nowrap">
					{editing ? "Edit Supplier" : "New Supplier"}
				</h2>
				<button
					type="button"
					onClick={onClose}
					disabled={isSaving}
					aria-label="Close"
					className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface rounded transition-colors"
				>
					<X size={18} />
				</button>
			</div>

			<div className="px-4 sm:px-5 pt-3 sm:pt-4 pb-4 space-y-4 overflow-y-auto">
				{/* Name alone on its row: it's the only required field and the one
				    the dedupe key is built from, so it gets the full width rather
				    than sharing a row with optional metadata. */}
				<div>
					<label className={LABEL}>Name *</label>
					<input
						type="text"
						value={form.name}
						onChange={(e) => setForm({ ...form, name: e.target.value })}
						placeholder="e.g. Ferguson"
						aria-label="Supplier name"
						className={INPUT}
						disabled={isSaving}
						autoFocus
					/>
				</div>

				{/* Paired by how they're used: the two identifiers you quote on the
				    phone, then the two ways to reach them. */}
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label className={LABEL}>Account #</label>
						<input
							type="text"
							value={form.account_number}
							onChange={(e) => setForm({ ...form, account_number: e.target.value })}
							aria-label="Account number"
							className={INPUT}
							disabled={isSaving}
						/>
					</div>
					<div>
						<label className={LABEL}>Contact</label>
						<input
							type="text"
							value={form.contact_name}
							onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
							aria-label="Contact name"
							className={INPUT}
							disabled={isSaving}
						/>
					</div>
					<div>
						<label className={LABEL}>Phone</label>
						<input
							type="tel"
							value={form.phone}
							onChange={(e) => setForm({ ...form, phone: e.target.value })}
							aria-label="Phone"
							className={INPUT}
							disabled={isSaving}
						/>
					</div>
					<div>
						<label className={LABEL}>Email</label>
						<input
							type="email"
							value={form.email}
							onChange={(e) => setForm({ ...form, email: e.target.value })}
							aria-label="Email"
							className={INPUT}
							disabled={isSaving}
						/>
					</div>
				</div>

				<div>
					<label className={LABEL}>Notes</label>
					<textarea
						value={form.notes}
						onChange={(e) => setForm({ ...form, notes: e.target.value })}
						rows={3}
						aria-label="Notes"
						className={TEXTAREA}
						disabled={isSaving}
					/>
				</div>
			</div>

			{/* Error sits with the action that caused it, not above the fields —
			    the footer is where the eye already is when a save fails. */}
			<div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border bg-base flex-shrink-0">
				{formError ? <p className="text-xs text-error-text">{formError}</p> : <span />}
				<div className="flex items-center gap-2">
					<button type="button" onClick={onClose} disabled={isSaving} className={BTN_GHOST}>
						Cancel
					</button>
					<button type="button" onClick={handleSave} disabled={isSaving} className={BTN_CONFIRM}>
						{isSaving && <Loader2 size={12} className="animate-spin" />}
						{editing ? "Save Changes" : "Create Supplier"}
					</button>
				</div>
			</div>
		</div>
	);

	return <FullPopup isModalOpen={isOpen} onClose={onClose} content={content} />;
}
