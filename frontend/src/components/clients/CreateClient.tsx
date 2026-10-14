import LoadSvg from "../../assets/icons/loading.svg?react";
import { useMemo, useRef, useState } from "react";
import type { ZodError } from "zod";
import FullPopup from "../ui/FullPopup";
import { CreateClientSchema, type CreateClientInput } from "../../types/clients";
import type { GeocodeResult } from "../../types/location";
import AddressForm from "../ui/AddressForm";
import { X } from "lucide-react";
import { useQBCustomerQuery, useQBMappedCustomersQuery, useQBStatusQuery } from "../../hooks/useQuickbooks";
import { useAllClientsQuery } from "../../hooks/useClients";
import { TemplateSearch, type TemplateSearchResult } from "../ui/forms/TemplateSearch";

interface CreateClientProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	createClient: (input: CreateClientInput) => Promise<string>;
}

const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";
const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors";

const CreateClient = ({ isModalOpen, setIsModalOpen, createClient }: CreateClientProps) => {
	const nameRef = useRef<HTMLInputElement>(null);
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [mode, setMode] = useState<"new" | "import">("new");
	const [selectedQBId, setSelectedQBId] = useState("");
	const [submitError, setSubmitError] = useState<string | null>(null);

	const { data: qbStatus } = useQBStatusQuery();
	const { data: customers, isLoading: loadingCustomers } = useQBCustomerQuery(
		qbStatus?.connected,
	);
	const { data: mappedCustomers } = useQBMappedCustomersQuery(qbStatus?.connected);
	const mappedIds = mappedCustomers?.map((m) => m.external_id);
	const { data: existingClients } = useAllClientsQuery();

	const existingNames = useMemo(
		() => new Set(existingClients?.map((c) => c.name.toLowerCase()) ?? []),
		[existingClients],
	);

	const selectedCustomer = customers?.find((c) => c.Id === selectedQBId);

	const templateResults = useMemo((): TemplateSearchResult[] => {
		return (customers ?? [])
			.filter(
				(c) =>
					!mappedIds?.includes(c.Id) &&
					!existingNames.has(c.DisplayName.toLowerCase()),
			)
			.map((c) => ({
				id: c.Id,
				title: c.DisplayName,
				subtitle: c.PrimaryEmailAddr?.Address,
				detail:
					[c.BillAddr?.Line1, c.BillAddr?.City, c.BillAddr?.CountrySubDivisionCode]
						.filter(Boolean)
						.join(", ") || undefined,
			}));
	}, [customers, mappedIds, existingNames]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
	};

	const handleModeChange = (next: "new" | "import") => {
		setMode(next);
		setSelectedQBId("");
		setGeoData(undefined);
		setErrors(null);
		setSubmitError(null);
	};

	const handleCustomerSelect = (id: string) => {
		setSelectedQBId(id);
		setGeoData(undefined);
	};

	// CreateClient is never unmounted between opens (only FullPopup's visibility
	// toggles), so its state — mode, the picked QB customer, geoData — otherwise
	// survives across closes and reappears stale the next time the modal opens.
	const resetForm = () => {
		setMode("new");
		setSelectedQBId("");
		setGeoData(undefined);
		setErrors(null);
		setSubmitError(null);
	};

	const handleClose = () => {
		setIsModalOpen(false);
		resetForm();
	};

	const invokeCreate = async () => {
		if (!nameRef.current || isLoading) return;

		if (!geoData) {
			setSubmitError("Select an address from the suggestions dropdown.");
			return;
		}

		const newClient: CreateClientInput = {
			name: nameRef.current.value.trim(),
			address: geoData.address.trim(),
			coords: geoData.coords,
			is_active: selectedCustomer?.Active ?? true,
			...(mode === "import" && selectedQBId ? { 
				qb_customer_id: selectedQBId,
				qb_contact_email: selectedCustomer?.PrimaryEmailAddr?.Address,
				qb_contact_name: [selectedCustomer?.GivenName, selectedCustomer?.FamilyName].filter(Boolean).join(" ") || selectedCustomer?.DisplayName,
				qb_contact_phone: selectedCustomer?.PrimaryPhone?.FreeFormNumber,
			 } : {}),
		};

		const parseResult = CreateClientSchema.safeParse(newClient);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			return;
		}

		setErrors(null);
		setSubmitError(null);
		setIsLoading(true);
		try {
			await createClient(newClient);
			handleClose();
		} catch (e) {
			setSubmitError(e instanceof Error ? e.message : "Failed to create client.");
		} finally {
			setIsLoading(false);
		}
	};

	const nameErrors = errors?.issues.filter((e) => e.path[0] === "name") ?? [];
	const addressErrors = errors?.issues.filter((e) => e.path[0] === "address") ?? [];

	const qbAddressHint = selectedCustomer?.BillAddr
		? [
				selectedCustomer.BillAddr.Line1,
				selectedCustomer.BillAddr.City,
				selectedCustomer.BillAddr.CountrySubDivisionCode,
				selectedCustomer.BillAddr.PostalCode,
			]
				.filter(Boolean)
				.join(", ")
		: null;

	const content = (
		<div className="flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-border flex-shrink-0">
				<h2 className="text-lg sm:text-xl font-bold text-text-primary whitespace-nowrap">
					New Client
				</h2>
				<button
					onClick={handleClose}
					className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface rounded transition-colors"
					disabled={isLoading}
				>
					<X size={18} />
				</button>
			</div>

			{/* Body */}
			<div className="px-4 sm:px-5 pt-3 sm:pt-4 pb-4 space-y-4">
				{/* Mode toggle ─ only shown when QB is connected */}
				{qbStatus?.connected && (
					<div className="flex rounded-md border border-border overflow-hidden text-sm">
						<button
							type="button"
							onClick={() => handleModeChange("new")}
							className={`flex-1 h-8 font-medium transition-colors ${
								mode === "new"
									? "bg-surface-raised text-text-primary"
									: "bg-transparent text-text-tertiary hover:text-text-secondary"
							}`}
						>
							New Client
						</button>
						<button
							type="button"
							onClick={() => handleModeChange("import")}
							className={`flex-1 h-8 font-medium transition-colors ${
								mode === "import"
									? "bg-surface-raised text-text-primary"
									: "bg-transparent text-text-tertiary hover:text-text-secondary"
							}`}
						>
							Import from QuickBooks
						</button>
					</div>
				)}

				{/* QB customer search ─ import mode, until a customer is picked. Shown
				    on its own (not alongside Name/Address below) so its results list
				    doesn't push the rest of the form off the modal. */}
				{mode === "import" && !selectedQBId && (
					<TemplateSearch
						heading="Import from QuickBooks"
						headingHint="Select a customer to import"
						placeholder="Search QuickBooks customers by name or email..."
						results={templateResults}
						clients={[]}
						isLoading={loadingCustomers}
						onSelect={handleCustomerSelect}
						onClose={() => handleModeChange("new")}
						emptyHint="No unlinked QuickBooks customers available to import"
					/>
				)}

				{/* Picked customer summary ─ import mode, after a pick */}
				{mode === "import" && selectedQBId && selectedCustomer && (
					<div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-3 py-2">
						<div className="min-w-0">
							<p className="truncate text-sm font-medium text-text-primary">
								{selectedCustomer.DisplayName}
							</p>
							{qbAddressHint && (
								<p className="truncate text-xs text-text-tertiary">{qbAddressHint}</p>
							)}
							{selectedCustomer.PrimaryEmailAddr?.Address && (
								<p className="truncate text-xs text-text-tertiary">
									Will create primary contact: &ensp;
									{selectedCustomer.PrimaryEmailAddr.Address}
									{selectedCustomer.PrimaryPhone?.FreeFormNumber && (
										<> · {selectedCustomer.PrimaryPhone.FreeFormNumber}</>
									)}
								</p>
							)}
						</div>
						<button
							type="button"
							onClick={() => handleCustomerSelect("")}
							className="flex-shrink-0 text-xs font-medium text-primary-text hover:text-primary-hover"
						>
							Change
						</button>
					</div>
				)}

				{/* Name + Address ─ "new" mode, or "import" mode once a customer is picked */}
				{(mode === "new" || selectedQBId) && (
					<>
						<div>
							<label className={LABEL}>Client Name *</label>
							<input
								key={selectedQBId || "new"}
								type="text"
								placeholder="e.g. Riverside Properties"
								className={INPUT}
								disabled={isLoading}
								defaultValue={selectedCustomer?.DisplayName ?? ""}
								ref={nameRef}
							/>
							{nameErrors.map((err) => (
								<p className="mt-1 text-xs text-error-text" key={err.message}>
									{err.message}
								</p>
							))}
						</div>

						<div>
							<label className={LABEL}>Address *</label>
							<AddressForm handleChange={handleChangeAddress} />
							{addressErrors.map((err) => (
								<p className="mt-1 text-xs text-error-text" key={err.message}>
									{err.message}
								</p>
							))}
						</div>
					</>
				)}
			</div>

			{/* Footer */}
			<div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border bg-base flex-shrink-0">
				{submitError ? (
					<p className="text-xs text-error-text">{submitError}</p>
				) : (
					<span />
				)}
				{isLoading ? (
					<LoadSvg className="w-8 h-8" />
				) : (
					<div className="flex items-center gap-2">
						<button
							onClick={handleClose}
							className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-transparent text-sm font-medium text-text-tertiary hover:text-text-primary hover:bg-surface hover:border-border-strong transition-colors whitespace-nowrap"
						>
							Cancel
						</button>
						<button
							onClick={invokeCreate}
							className="inline-flex items-center h-8 px-4 rounded-md bg-confirm hover:bg-confirm-hover text-sm font-semibold text-on-primary transition-colors whitespace-nowrap"
						>
							{mode === "import" ? "Import Client" : "Create Client"}
						</button>
					</div>
				)}
			</div>
		</div>
	);

	return (
		<FullPopup
			content={content}
			isModalOpen={isModalOpen}
			onClose={handleClose}
			overflowVisible
		/>
	);
};

export default CreateClient;

