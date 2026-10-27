import { useState } from "react";
import type { Client, UpdateClientInput } from "../../types/clients";
import { useUpdateClientMutation } from "../../hooks/useClients";
import AddressForm from "../ui/AddressForm";
import type { GeocodeResult } from "../../types/location";
import type { AddressTaxChoice, AddressTaxChoiceDetails } from "../../types/tax";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import AddressTaxChoicePanel from "../tax/AddressTaxChoicePanel";
import { addressTaxChoiceDetails } from "../tax/addressTaxChoice";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { useToast } from "../ui/useToast";

interface EditClientModalProps {
	isOpen: boolean;
	onClose: () => void;
	client: Client;
}

export default function EditClientModal({ isOpen, onClose, client }: EditClientModalProps) {
	const [formData, setFormData] = useState<UpdateClientInput>({
		name: client.name,
		address: client.address,
		is_active: client.is_active,
	});
	// Set by a 409: the new address would re-tax this client's kept-rate drafts.
	const [taxRefusal, setTaxRefusal] = useState<AddressTaxChoiceDetails | null>(null);
	const [taxChoice, setTaxChoice] = useState<AddressTaxChoice | null>(null);
	const { data: taxGroups = [] } = useTaxGroups();
	const activeGroups = taxGroups.filter((g) => g.is_active);
	const defaultGroup = activeGroups.find((g) => g.is_default) ?? null;
	const toast = useToast();

	// The modal stays mounted while hidden, so an unanswered refusal must not outlive it.
	const close = () => {
		setTaxRefusal(null);
		setTaxChoice(null);
		onClose();
	};

	const updateClient = useUpdateClientMutation();

	const handleSubmit = async () => {
		try {
			await updateClient.mutateAsync({
				id: client.id,
				data: taxRefusal && taxChoice ? { ...formData, address_tax_choice: taxChoice } : formData,
			});
			toast.success("Client updated");
			close();
		} catch (error) {
			const details = addressTaxChoiceDetails(error);
			if (details) {
				setTaxRefusal(details);
				setTaxChoice(null);
				return;
			}
			console.error("Failed to update client:", error);
			toast.error(error instanceof Error ? error.message : "Failed to update Client");
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

	return (
		<FormWizardContainer
			title="Edit Client"
			steps={[]}
			currentStep={1}
			visitedSteps={new Set([1])}
			isLoading={updateClient.isPending}
			isOpen={isOpen}
			onClose={close}
			onSubmit={handleSubmit}
			canSubmit={!!formData.name?.trim() && (!taxRefusal || !!taxChoice)}
			submitLabel="Save Changes"
			isEditMode
		>
			<div className="space-y-4">
				<div>
					<label className="block mb-1">Client Name</label>
					<input
						type="text"
						name="name"
						value={formData.name}
						onChange={handleChange}
						className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
						required
						maxLength={128}
					/>
				</div>

				<div>
					<label className="block mb-1">Address</label>
					<AddressForm handleChange={handleChangeAddress} />
					<p className="text-text-muted text-sm">Current: {client.address}</p>
				</div>

				<div className="flex items-center">
					<input
						type="checkbox"
						id="client-is-active"
						name="is_active"
						checked={formData.is_active}
						onChange={handleChange}
						className="w-4 h-4 accent-primary rounded"
					/>
					<label htmlFor="client-is-active" className="ml-2">Active Client</label>
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
			</div>
		</FormWizardContainer>
	);
}
