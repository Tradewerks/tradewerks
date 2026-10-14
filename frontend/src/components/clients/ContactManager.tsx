import { useState, useEffect, useCallback, memo, useMemo, useRef } from "react";
import {
	Plus,
	Edit2,
	Trash2,
	X,
	Search,
	Link as LinkIcon,
	User,
	Mail,
	Phone,
} from "lucide-react";
import Card from "../ui/Card";
import { HEADER_BTN_PRIMARY, HEADER_BTN_SECONDARY } from "../ui/headerActions";
import type {
	ClientContactLink,
	CreateContactInput,
	UpdateContactInput,
	UpdateClientContactInput,
	Contact,
} from "../../types/clients";
import {
	useClientContactsQuery,
	useCreateContactMutation,
	useUpdateContactMutation,
	useUpdateClientContactMutation,
	useUnlinkContactFromClientMutation,
	useSearchContactsQuery,
	useLinkContactMutation,
} from "../../hooks/useClients";
import { usePermission } from "../../hooks/usePermission";

interface ContactManagerProps {
	clientId: string;
}

type FormMode = "create" | "link" | null;

interface ContactFormData {
	name: string;
	email: string;
	phone: string;
	relationship: string;
}

interface FieldErrors {
	name?: string;
	email?: string;
	phone?: string;
	relationship?: string;
	primary?: string;
	billing?: string;
	general?: string;
}

const EMPTY_FORM_DATA: ContactFormData = {
	name: "",
	email: "",
	phone: "",
	relationship: "",
};

// Extracted ContactForm component
interface ContactFormProps {
	formMode: FormMode;
	editingContactId: string | null;
	formData: ContactFormData;
	fieldErrors: FieldErrors;
	isPrimary: boolean;
	isBilling: boolean;
	shouldDisablePrimary: boolean;
	shouldDisableBilling: boolean;
	searchQuery: string;
	searchResults?: Contact[];
	isSearching: boolean;
	showSearchResults: boolean;
	selectedContact: Contact | null;
	isPending: boolean;
	submitLabel: string;
	onSubmit: (e: React.FormEvent) => void;
	onCancel: () => void;
	onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onSelectContact: (contact: Contact) => void;
	onPrimaryChange: (checked: boolean) => void;
	onBillingChange: (checked: boolean) => void;
	onCloseSearch: () => void;
}

const ContactForm = memo(function ContactForm({
	formMode,
	editingContactId,
	formData,
	fieldErrors,
	isPrimary,
	isBilling,
	shouldDisablePrimary,
	shouldDisableBilling,
	searchQuery,
	searchResults,
	isSearching,
	showSearchResults,
	selectedContact,
	isPending,
	submitLabel,
	onSubmit,
	onCancel,
	onChange,
	onSearchChange,
	onSelectContact,
	onPrimaryChange,
	onBillingChange,
	onCloseSearch,
}: ContactFormProps) {
	const searchContainerRef = useRef<HTMLDivElement>(null);

	// Close search results on click outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				searchContainerRef.current &&
				!searchContainerRef.current.contains(event.target as Node)
			) {
				onCloseSearch();
			}
		};
		if (showSearchResults) {
			document.addEventListener("mousedown", handleClickOutside);
		}
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [showSearchResults, onCloseSearch]);

	return (
		<form onSubmit={onSubmit} className="space-y-3 min-w-0" noValidate>
			{fieldErrors.general && (
				<div className="p-2 bg-error/10 border border-error/20 rounded text-xs text-error-text">
					{fieldErrors.general}
				</div>
			)}

			{formMode === "link" && (
				<div ref={searchContainerRef} className="relative z-50">
					<Search
						size={14}
						className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
					/>
					<input
						type="text"
						placeholder="Search contacts..."
						value={searchQuery}
						onChange={onSearchChange}
						aria-autocomplete="list"
						aria-controls="search-results"
						aria-expanded={showSearchResults}
						role="combobox"
						className="w-full pl-9 pr-3 py-2 bg-base border border-border rounded text-sm text-text-primary focus:outline-none focus:border-primary"
						autoComplete="off"
					/>

					{/* Search Results Dropdown - Absolute positioning within relative container */}
					{showSearchResults && (
						<div
							id="search-results"
							role="listbox"
							className="absolute z-50 w-full mt-1 bg-base border border-border rounded shadow-lg max-h-60 overflow-y-auto"
						>
							{isSearching ? (
								<div className="p-3 text-xs text-text-tertiary">
									Searching...
								</div>
							) : searchResults?.length ? (
								searchResults.map((contact) => (
									<button
										key={contact.id}
										type="button"
										role="option"
										onClick={() =>
											onSelectContact(
												contact
											)
										}
										className="w-full px-3 py-2.5 text-left hover:bg-surface border-b border-border-subtle last:border-b-0 transition-colors"
									>
										<div className="text-sm text-text-primary font-medium">
											{
												contact.name
											}
										</div>
										<div className="text-xs text-text-tertiary truncate mt-0.5">
											{[
												contact.email,
												contact.phone,
											]
												.filter(
													Boolean
												)
												.join(
													" • "
												)}
										</div>
									</button>
								))
							) : (
								<div className="p-3 text-xs text-text-tertiary">
									No contacts found
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{(formMode === "create" || editingContactId) && (
				<div className="min-w-0">
					<input
						type="text"
						name="name"
						placeholder="Full name *"
						value={formData.name}
						onChange={onChange}
						className={`w-full px-3 py-2 bg-base border rounded text-sm text-text-primary focus:outline-none ${
							fieldErrors.name
								? "border-error focus:border-error"
								: "border-border focus:border-primary"
						}`}
					/>
					{fieldErrors.name && (
						<p className="mt-1 text-xs text-error-text">
							{fieldErrors.name}
						</p>
					)}
				</div>
			)}

			{((formMode === "link" && selectedContact) ||
				formMode === "create" ||
				editingContactId) && (
				<>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<div className="min-w-0">
							<input
								type="email"
								name="email"
								placeholder="Email"
								value={formData.email}
								onChange={onChange}
								disabled={
									formMode === "link" &&
									!!selectedContact
								}
								className={`w-full px-3 py-2 bg-base border rounded text-sm text-text-primary disabled:opacity-50 focus:outline-none ${
									fieldErrors.email
										? "border-error focus:border-error"
										: "border-border focus:border-primary"
								}`}
							/>
							{fieldErrors.email && (
								<p className="mt-1 text-xs text-error-text">
									{fieldErrors.email}
								</p>
							)}
						</div>
						<div className="min-w-0">
							<input
								type="tel"
								name="phone"
								placeholder="Phone"
								value={formData.phone}
								onChange={onChange}
								disabled={
									formMode === "link" &&
									!!selectedContact
								}
								className={`w-full px-3 py-2 bg-base border rounded text-sm text-text-primary disabled:opacity-50 focus:outline-none ${
									fieldErrors.phone
										? "border-error focus:border-error"
										: "border-border focus:border-primary"
								}`}
							/>
							{fieldErrors.phone && (
								<p className="mt-1 text-xs text-error-text">
									{fieldErrors.phone}
								</p>
							)}
						</div>
					</div>

					<div className="min-w-0">
						<input
							type="text"
							name="relationship"
							placeholder="Relationship * (e.g., Owner)"
							value={formData.relationship}
							onChange={onChange}
							className={`w-full px-3 py-2 bg-base border rounded text-sm text-text-primary focus:outline-none ${
								fieldErrors.relationship
									? "border-error focus:border-error"
									: "border-border focus:border-primary"
							}`}
						/>
						{fieldErrors.relationship && (
							<p className="mt-1 text-xs text-error-text">
								{fieldErrors.relationship}
							</p>
						)}
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<div className="min-w-0">
							<label
								className={`flex items-center gap-2 px-3 py-2 bg-base border rounded text-xs ${
									fieldErrors.primary
										? "border-error"
										: shouldDisablePrimary
											? "border-border-subtle opacity-50"
											: "border-border cursor-pointer hover:border-border-strong"
								}`}
							>
								<input
									type="checkbox"
									checked={isPrimary}
									onChange={(e) =>
										onPrimaryChange(
											e.target
												.checked
										)
									}
									disabled={
										shouldDisablePrimary
									}
									className="w-3.5 h-3.5 rounded bg-surface-inset border-border-strong accent-primary flex-shrink-0"
								/>
								<span
									className={
										shouldDisablePrimary
											? "text-text-faint"
											: "text-text-secondary"
									}
								>
									Primary Contact
								</span>
							</label>
							{fieldErrors.primary && (
								<p className="mt-1 text-xs text-error-text">
									{fieldErrors.primary}
								</p>
							)}
						</div>
						<div className="min-w-0">
							<label
								className={`flex items-center gap-2 px-3 py-2 bg-base border rounded text-xs ${
									fieldErrors.billing
										? "border-error"
										: shouldDisableBilling
											? "border-border-subtle opacity-50"
											: "border-border cursor-pointer hover:border-border-strong"
								}`}
							>
								<input
									type="checkbox"
									checked={isBilling}
									onChange={(e) =>
										onBillingChange(
											e.target
												.checked
										)
									}
									disabled={
										shouldDisableBilling
									}
									className="w-3.5 h-3.5 rounded bg-surface-inset border-border-strong accent-primary flex-shrink-0"
								/>
								<span
									className={
										shouldDisableBilling
											? "text-text-faint"
											: "text-text-secondary"
									}
								>
									Billing Contact
								</span>
							</label>
							{fieldErrors.billing && (
								<p className="mt-1 text-xs text-error-text">
									{fieldErrors.billing}
								</p>
							)}
						</div>
					</div>

					<div className="flex gap-2">
						<button
							type="button"
							onClick={onCancel}
							className="flex-1 py-2 bg-surface-raised hover:bg-surface-raised text-primary rounded text-sm font-medium transition-colors"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={
								isPending ||
								(formMode === "link" &&
									!selectedContact)
							}
							className="flex-1 py-2 bg-primary-hover hover:bg-primary-active disabled:bg-primary-disabled disabled:cursor-not-allowed text-on-primary rounded text-sm font-medium transition-colors"
						>
							{isPending ? "Saving..." : submitLabel}
						</button>
					</div>
				</>
			)}
		</form>
	);
});

export default function ContactManager({ clientId }: ContactManagerProps) {
	const [formMode, setFormMode] = useState<FormMode>(null);
	const [editingContactId, setEditingContactId] = useState<string | null>(null);
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
	const [formData, setFormData] = useState<ContactFormData>(EMPTY_FORM_DATA);
	const [isPrimary, setIsPrimary] = useState(false);
	const [isBilling, setIsBilling] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
	const [showSearchResults, setShowSearchResults] = useState(false);

	const { data: contactLinks, isLoading } = useClientContactsQuery(clientId);
	const { data: searchResults, isLoading: isSearching } = useSearchContactsQuery(
		searchQuery,
		clientId,
		formMode === "link" && searchQuery.length >= 2
	);

	const createContact = useCreateContactMutation();
	const updateContact = useUpdateContactMutation();
	const updateRelationship = useUpdateClientContactMutation();
	const unlinkContact = useUnlinkContactFromClientMutation();
	const linkContact = useLinkContactMutation();

	// permissions
	const EDIT_CONTACTS = usePermission("edit_clients");

	const resetForm = useCallback(() => {
		setFormMode(null);
		setEditingContactId(null);
		setFormData(EMPTY_FORM_DATA);
		setIsPrimary(false);
		setIsBilling(false);
		setFieldErrors({});
		setSearchQuery("");
		setSelectedContact(null);
		setShowSearchResults(false);
		setConfirmingDeleteId(null);
	}, []);

	const openCreateForm = useCallback(() => {
		if (!EDIT_CONTACTS) return;
		resetForm();
		setFormMode("create");
	}, [resetForm, EDIT_CONTACTS]);

	const openLinkForm = useCallback(() => {
		if (!EDIT_CONTACTS) return;
		resetForm();
		setFormMode("link");
	}, [resetForm, EDIT_CONTACTS]);

	const openEditForm = useCallback(
		(contactLink: ClientContactLink) => {
			const contact = contactLink.contact;
			if (!contact) return;

			resetForm();
			setEditingContactId(contact.id);
			setFormMode("create");
			setFormData({
				name: contact.name,
				email: contact.email || "",
				phone: contact.phone || "",
				relationship: contactLink.relationship,
			});
			setIsPrimary(contactLink.is_primary || false);
			setIsBilling(contactLink.is_billing || false);
		},
		[resetForm]
	);

	const closeSearchResults = useCallback(() => {
		setShowSearchResults(false);
	}, []);

	const validateForm = useCallback(
		(existingLinks: ClientContactLink[] | undefined): boolean => {
			const errors: FieldErrors = {};

			if (!formData.name.trim()) {
				errors.name = "Name is required";
			} else if (formData.name.trim().length < 2) {
				errors.name = "Name must be at least 2 characters";
			}

			if (formData.email?.trim()) {
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				if (!emailRegex.test(formData.email)) {
					errors.email = "Please enter a valid email address";
				}
			}

			if (formData.phone?.trim()) {
				const phoneDigits = formData.phone.replace(/\D/g, "");
				if (phoneDigits.length < 10) {
					errors.phone = "Phone number must be at least 10 digits";
				}
			}

			if (!formData.relationship.trim()) {
				errors.relationship = "Relationship is required";
			}

			const otherPrimaryExists = existingLinks?.some(
				(link) => link.is_primary && link.contact?.id !== editingContactId
			);
			const otherBillingExists = existingLinks?.some(
				(link) => link.is_billing && link.contact?.id !== editingContactId
			);

			if (isPrimary && otherPrimaryExists) {
				errors.primary = "Another contact is already set as primary";
			}
			if (isBilling && otherBillingExists) {
				errors.billing = "Another contact is already set as billing";
			}

			setFieldErrors(errors);
			return Object.keys(errors).length === 0;
		},
		[formData, isPrimary, isBilling, editingContactId]
	);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!EDIT_CONTACTS) return;
			if (!validateForm(contactLinks)) {
				return;
			}

			try {
				if (formMode === "link" && selectedContact) {
					await linkContact.mutateAsync({
						clientId,
						data: {
							contact_id: selectedContact.id,
							relationship:
								formData.relationship || "contact",
							is_primary: isPrimary,
							is_billing: isBilling,
						},
					});
				} else if (editingContactId) {
					await updateContact.mutateAsync({
						contactId: editingContactId,
						data: {
							name: formData.name,
							email: formData.email,
							phone: formData.phone,
						} as UpdateContactInput,
					});
					await updateRelationship.mutateAsync({
						clientId,
						contactId: editingContactId,
						data: {
							relationship: formData.relationship,
							is_primary: isPrimary,
							is_billing: isBilling,
						} as UpdateClientContactInput,
					});
				} else {
					await createContact.mutateAsync({
						name: formData.name,
						email: formData.email,
						phone: formData.phone,
						client_id: clientId,
						relationship: formData.relationship || "contact",
						is_primary: isPrimary,
						is_billing: isBilling,
					} as CreateContactInput);
				}
				resetForm();
			} catch (error) {
				const errorMsg =
					error instanceof Error
						? error.message
						: "Failed to save contact";
				setFieldErrors({ general: errorMsg });
			}
		},
		[
			formMode,
			selectedContact,
			editingContactId,
			formData,
			isPrimary,
			isBilling,
			clientId,
			contactLinks,
			validateForm,
			resetForm,
			linkContact,
			updateContact,
			updateRelationship,
			createContact,
			EDIT_CONTACTS,
		]
	);

	const handleUnlink = useCallback(
		async (contactLink: ClientContactLink) => {
			if (!EDIT_CONTACTS) return;
			if (!contactLink.contact) return;
			await unlinkContact.mutateAsync({
				clientId,
				contactId: contactLink.contact.id,
			});
		},
		[clientId, unlinkContact,EDIT_CONTACTS]
	);

	const handleDeleteClick = useCallback(
		(contactId: string, contactLink: ClientContactLink) => {
			if (!EDIT_CONTACTS) return;
			if (confirmingDeleteId === contactId) {
				handleUnlink(contactLink);
				setConfirmingDeleteId(null);
			} else {
				setConfirmingDeleteId(contactId);
				// Auto-clear after 3 seconds
				setTimeout(() => setConfirmingDeleteId(null), 3000);
			}
		},
		[confirmingDeleteId, handleUnlink, EDIT_CONTACTS]
	);

	const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		if (!EDIT_CONTACTS) return;
		const { name, value } = e.target;
		setFormData((prev) => ({ ...prev, [name]: value }));
		setFieldErrors((prev) => ({ ...prev, [name]: undefined }));
	}, [EDIT_CONTACTS]);

	const handleSearchChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = e.target.value;
			setSearchQuery(value);
			setShowSearchResults(value.length >= 2);
			if (selectedContact) {
				setSelectedContact(null);
				setFormData(EMPTY_FORM_DATA);
			}
		},
		[selectedContact]
	);

	const handleSelectContact = useCallback((contact: Contact) => {
		setSelectedContact(contact);
		setSearchQuery(contact.name);
		setShowSearchResults(false);
		setFormData({
			name: contact.name,
			email: contact.email || "",
			phone: contact.phone || "",
			relationship: "",
		});
	}, []);

	const handlePrimaryChange = useCallback((checked: boolean) => {
		setIsPrimary(checked);
		setFieldErrors((prev) => ({ ...prev, primary: undefined }));
	}, []);

	const handleBillingChange = useCallback((checked: boolean) => {
		setIsBilling(checked);
		setFieldErrors((prev) => ({ ...prev, billing: undefined }));
	}, []);

	const shouldDisablePrimary = useMemo(
		() =>
			contactLinks?.some(
				(link) => link.is_primary && link.contact?.id !== editingContactId
			) || false,
		[contactLinks, editingContactId]
	);

	const shouldDisableBilling = useMemo(
		() =>
			contactLinks?.some(
				(link) => link.is_billing && link.contact?.id !== editingContactId
			) || false,
		[contactLinks, editingContactId]
	);

	const sortedContactLinks = useMemo(() => {
		if (!contactLinks) return [];
		return [...contactLinks].sort((a, b) => {
			if (a.is_primary && !b.is_primary) return -1;
			if (!a.is_primary && b.is_primary) return 1;
			if (a.is_billing && !b.is_billing) return -1;
			if (!a.is_billing && b.is_billing) return 1;
			return 0;
		});
	}, [contactLinks]);

	if (isLoading) {
		return (
			<Card title="Contacts">
				<div className="text-text-tertiary text-sm py-4">
					Loading contacts...
				</div>
			</Card>
		);
	}

	return (
		<Card
			title="Contacts"
			className="min-w-0"
			headerAction={
				!formMode && (
					<div className="flex gap-2">
						<button
							disabled={!EDIT_CONTACTS}
							title={!EDIT_CONTACTS ? "You don't have permission to perform this action" : ""}
							onClick={openLinkForm}
							className={HEADER_BTN_SECONDARY}
						>
							<LinkIcon size={12} />
							<span className="hidden sm:inline">
								Link
							</span>
						</button>
						<button
							disabled={!EDIT_CONTACTS}
							title={!EDIT_CONTACTS ? "You don't have permission to perform this action" : ""}
							onClick={openCreateForm}
							className={HEADER_BTN_PRIMARY}
						>
							<Plus size={12} />
							<span className="hidden sm:inline">
								Add
							</span>
						</button>
					</div>
				)
			}
		>
			<div className="space-y-2 min-w-0">
				{/* Add Form - Appears at top when adding new contact */}
				{formMode && !editingContactId && (
					<div className="p-4 bg-surface rounded-lg border border-border relative min-w-0">
						<div className="flex justify-between items-center mb-3">
							<h3 className="text-sm font-semibold text-text-primary">
								{formMode === "link"
									? "Link Contact"
									: "New Contact"}
							</h3>
							<button
								onClick={resetForm}
								className="text-text-tertiary hover:text-text-primary"
							>
								<X size={16} />
							</button>
						</div>
						<ContactForm
							formMode={formMode}
							editingContactId={editingContactId}
							formData={formData}
							fieldErrors={fieldErrors}
							isPrimary={isPrimary}
							isBilling={isBilling}
							shouldDisablePrimary={shouldDisablePrimary}
							shouldDisableBilling={shouldDisableBilling}
							searchQuery={searchQuery}
							searchResults={searchResults}
							isSearching={isSearching}
							showSearchResults={showSearchResults}
							selectedContact={selectedContact}
							isPending={
								createContact.isPending ||
								linkContact.isPending
							}
							submitLabel={
								formMode === "link"
									? "Link Contact"
									: "Add Contact"
							}
							onSubmit={handleSubmit}
							onCancel={resetForm}
							onChange={handleChange}
							onSearchChange={handleSearchChange}
							onSelectContact={handleSelectContact}
							onPrimaryChange={handlePrimaryChange}
							onBillingChange={handleBillingChange}
							onCloseSearch={closeSearchResults}
						/>
					</div>
				)}

				{/* Contact List - CSS Grid for even spacing */}
				{sortedContactLinks.length > 0 ? (
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 xl:flex xl:flex-col xl:gap-3">
						{sortedContactLinks.map((contactLink) => {
							const contact = contactLink.contact;
							if (!contact) return null;

							// Edit form replaces this contact card
							if (editingContactId === contact.id) {
								return (
									<div
										key={contact.id}
										className="p-4 bg-surface rounded-lg border border-border relative min-w-0 xl:w-full"
									>
										<div className="flex justify-between items-center mb-3">
											<h3 className="text-sm font-semibold text-text-primary">
												Edit
												Contact
											</h3>
											<button
												onClick={
													resetForm
												}
												className="text-text-tertiary hover:text-text-primary"
											>
												<X
													size={
														16
													}
												/>
											</button>
										</div>
										<ContactForm
											formMode={
												formMode
											}
											editingContactId={
												editingContactId
											}
											formData={
												formData
											}
											fieldErrors={
												fieldErrors
											}
											isPrimary={
												isPrimary
											}
											isBilling={
												isBilling
											}
											shouldDisablePrimary={
												shouldDisablePrimary
											}
											shouldDisableBilling={
												shouldDisableBilling
											}
											searchQuery={
												searchQuery
											}
											searchResults={
												searchResults
											}
											isSearching={
												isSearching
											}
											showSearchResults={
												showSearchResults
											}
											selectedContact={
												selectedContact
											}
											isPending={
												updateContact.isPending
											}
											submitLabel="Update Contact"
											onSubmit={
												handleSubmit
											}
											onCancel={
												resetForm
											}
											onChange={
												handleChange
											}
											onSearchChange={
												handleSearchChange
											}
											onSelectContact={
												handleSelectContact
											}
											onPrimaryChange={
												handlePrimaryChange
											}
											onBillingChange={
												handleBillingChange
											}
											onCloseSearch={
												closeSearchResults
											}
										/>
									</div>
								);
							}

							// Display contact card - Grid layout for even spacing, flex for sidebar
							return (
								<div
									key={contact.id}
									className="flex items-start gap-3 px-4 py-4 bg-surface hover:bg-surface-raised rounded-lg border border-border-subtle hover:border-border transition-all group min-w-0 xl:w-full"
								>
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 flex-wrap mb-2">
											<span className="text-base font-medium text-text-primary truncate">
												{
													contact.name
												}
											</span>
											{contactLink.is_primary && (
												<span className="text-xs bg-warning-bg text-warning-text border border-warning-border px-2 py-0.5 rounded flex-shrink-0">
													Primary
												</span>
											)}
											{contactLink.is_billing && (
												<span className="text-xs bg-success-bg text-success-text border border-success-border px-2 py-0.5 rounded flex-shrink-0">
													Billing
												</span>
											)}
										</div>
										<div className="flex items-center gap-2 text-sm text-text-muted mb-3 flex-wrap">
											<span className="bg-surface px-2 py-0.5 rounded text-xs">
												{
													contactLink.relationship
												}
											</span>
										</div>
										<div className="space-y-1.5 text-sm">
											{contact.email && (
												<div className="flex items-center gap-2 text-text-tertiary">
													<Mail
														size={
															12
														}
														className="flex-shrink-0"
													/>
													<span className="truncate">
														{
															contact.email
														}
													</span>
												</div>
											)}
											{contact.phone && (
												<div className="flex items-center gap-2 text-text-tertiary">
													<Phone
														size={
															12
														}
														className="flex-shrink-0"
													/>
													<span>
														{
															contact.phone
														}
													</span>
												</div>
											)}
										</div>
									</div>

									<div className="flex flex-col gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0">
										<button
											onClick={() =>
												openEditForm(
													contactLink
												)
											}
											disabled={!EDIT_CONTACTS}
											className="p-2 text-text-tertiary hover:text-primary-text hover:bg-surface-raised rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
											title={!EDIT_CONTACTS ? "You don't have permission to perform this action" : "Edit"}
										>
											<Edit2
												size={
													16
												}
											/>
										</button>
										<button
											onClick={() =>
												handleDeleteClick(
													contact.id,
													contactLink
												)
											}
											disabled={!EDIT_CONTACTS}
											className={`p-2 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
												confirmingDeleteId ===
												contact.id
													? "text-error-text bg-error/10 animate-pulse"
													: "text-text-tertiary hover:text-error-text hover:bg-surface-raised"
											}`}
											title={
												!EDIT_CONTACTS
													? "You don't have permission to perform this action"
													: confirmingDeleteId === contact.id
														? "Click to confirm"
														: "Remove"
											}
										>
											<Trash2
												size={
													16
												}
												className={
													confirmingDeleteId ===
													contact.id
														? "fill-error"
														: ""
												}
											/>
										</button>
									</div>
								</div>
							);
						})}
					</div>
				) : !formMode ? (
					<div className="text-center py-8 text-text-muted">
						<User
							size={32}
							className="mx-auto mb-2 opacity-30"
						/>
						<p className="text-sm">No contacts linked</p>
						<p className="text-xs mt-1">
							Add or link a contact to get started
						</p>
					</div>
				) : null}
			</div>
		</Card>
	);
}
