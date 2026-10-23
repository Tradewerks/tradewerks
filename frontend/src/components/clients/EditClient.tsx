import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Trash2 } from "lucide-react";
import type { Client, UpdateClientInput } from "../../types/clients";
import { useUpdateClientMutation, useDeleteClientMutation } from "../../hooks/useClients";
import AddressForm from "../ui/AddressForm";
import type { GeocodeResult } from "../../types/location";
import type { AddressTaxChoice, AddressTaxChoiceDetails } from "../../types/tax";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import AddressTaxChoicePanel from "../tax/AddressTaxChoicePanel";
import { addressTaxChoiceDetails } from "../tax/addressTaxChoice";

interface EditClientModalProps {
	isOpen: boolean;
	onClose: () => void;
	client: Client;
}

export default function EditClientModal({ isOpen, onClose, client }: EditClientModalProps) {
	const navigate = useNavigate();
	const [formData, setFormData] = useState<UpdateClientInput>({
		name: client.name,
		address: client.address,
		is_active: client.is_active,
	});
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	// Set by a 409: the new address would re-tax this client's kept-rate drafts.
	const [taxRefusal, setTaxRefusal] = useState<AddressTaxChoiceDetails | null>(null);
	const [taxChoice, setTaxChoice] = useState<AddressTaxChoice | null>(null);
	const { data: taxGroups = [] } = useTaxGroups();
	const activeGroups = taxGroups.filter((g) => g.is_active);
	const defaultGroup = activeGroups.find((g) => g.is_default) ?? null;

	// The modal stays mounted while hidden, so an unanswered refusal must not outlive it.
	const close = () => {
		setTaxRefusal(null);
		setTaxChoice(null);
		onClose();
	};

	const updateClient = useUpdateClientMutation();
	const deleteClient = useDeleteClientMutation();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		try {
			await updateClient.mutateAsync({
				id: client.id,
				data: taxRefusal && taxChoice ? { ...formData, address_tax_choice: taxChoice } : formData,
			});
			close();
		} catch (error) {
			const details = addressTaxChoiceDetails(error);
			if (details) {
				setTaxRefusal(details);
				setTaxChoice(null);
				return;
			}
			console.error("Failed to update client:", error);
		}
	};

	const handleDelete = async () => {
		if (!deleteConfirm) {
			setDeleteConfirm(true);
			return;
		}

		try {
			await deleteClient.mutateAsync(client.id);
			onClose();
			navigate("/dispatch/clients");
		} catch (error) {
			console.error("Failed to delete client:", error);
		}
	};

	const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		const { name, value, type } = e.target;
		setFormData((prev) => ({
			...prev,
			[name]:
				type === "checkbox"
					? (e.target as HTMLInputElement).checked
					: value,
		}));
	};

	const handleChangeAddress = (geoData: GeocodeResult) => {
		setFormData((prev) => ({
			...prev,
			address: geoData.address,
			coords: geoData.coords,
		}));
		setTaxRefusal(null);
		setTaxChoice(null);
	};

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
			<div className="bg-base rounded-xl p-6 w-full max-w-md border border-border-subtle max-h-[90vh] overflow-y-auto scrollbar-hide">
				<div className="flex justify-between items-center mb-6">
					<h2 className="text-2xl font-bold text-text-primary">
						Edit Client
					</h2>
					<button
						onClick={close}
						className="text-text-tertiary hover:text-text-primary transition-colors"
					>
						<X size={24} />
					</button>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<label className="mb-1">Client Name</label>
						<input
							type="text"
							name="name"
							value={formData.name}
							onChange={handleChange}
							className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
							required
						/>
					</div>

					<div className="">
						<label className="mb-1">Address</label>
						{/* <textarea
							name="address"
							value={formData.address}
							onChange={handleChange}
							rows={3}
							className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
							required
						/> */}
						<AddressForm handleChange={handleChangeAddress} />
					</div>

					<div className="flex items-center">
						<input
							type="checkbox"
							name="is_active"
							checked={formData.is_active}
							onChange={handleChange}
							className="w-4 h-4 accent-primary rounded"
						/>
						<label className="ml-2 ">Active Client</label>
					</div>

					{taxRefusal && (
						<AddressTaxChoicePanel
							docNoun="client"
							rateLabel={taxRefusal.rate_label}
							rate={taxRefusal.rate}
							newAddress={formData.address ?? ""}
							keepCents={null}
							defaultGroup={
								defaultGroup
									? {
											id: defaultGroup.id,
											name: defaultGroup.name,
											rate: defaultGroup.combined_rate,
										}
									: null
							}
							defaultCents={null}
							taxGroups={activeGroups}
							value={taxChoice}
							onChange={setTaxChoice}
							documents={taxRefusal.documents}
						/>
					)}

					<div className="flex gap-3 pt-4">
						<button
							type="submit"
							disabled={updateClient.isPending || (!!taxRefusal && !taxChoice)}
							className="flex-1 px-4 py-2 bg-primary-hover hover:bg-primary-active disabled:bg-primary-disabled disabled:cursor-not-allowed text-on-primary rounded-md transition-colors"
						>
							{updateClient.isPending
								? "Saving..."
								: "Save Changes"}
						</button>
						<button
							type="button"
							onClick={handleDelete}
							onMouseLeave={() => setDeleteConfirm(false)}
							disabled={deleteClient.isPending}
							className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
								deleteConfirm
									? "bg-error hover:bg-error-strong text-on-primary"
									: "bg-surface hover:bg-surface-raised text-text-secondary"
							} disabled:opacity-50 disabled:cursor-not-allowed`}
						>
							<Trash2 size={16} />
							{deleteClient.isPending
								? "Deleting..."
								: deleteConfirm
									? "Confirm Delete"
									: "Delete"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
