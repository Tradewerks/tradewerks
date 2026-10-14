import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ZodError } from "zod";
import {
	CreateQuoteSchema,
	type CreateQuoteInput,
	type CreateQuoteLineItemInput,
} from "../../types/quotes";
import { useAllClientsQuery } from "../../hooks/useClients";
import { useAllQuotesQuery } from "../../hooks/useQuotes";
import {
	useDraftsByTypeQuery,
	useCreateDraftMutation,
	useUpdateDraftMutation,
	useDeleteDraftMutation,
} from "../../hooks/forms/useDrafts";
import { getDraft } from "../../api/drafts";
import type { DraftSummary, SourceType } from "../../types/drafts";
import type { GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
import DatePicker from "../ui/DatePicker";
import { type BaseLineItem, type Priority, PriorityValues } from "../../types/common";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import FinancialSummary from "../ui/forms/FinancialSummary";
import {
	TemplateSearch,
	type TemplateSearchResult,
	type TemplateSearchClient,
} from "../ui/forms/TemplateSearch";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";
import { useTaxGroups, useDefaultTaxGroup } from "../../hooks/useTaxGroups";
import { QuoteStatusColors } from "../../types/quotes";

type Step = 1 | 2 | 3;

interface CreateQuoteProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	createQuote: (input: CreateQuoteInput) => Promise<string>;
}

const STEPS = [
	{ id: 1 as Step, label: "Basics" },
	{ id: 2 as Step, label: "Line Items" },
	{ id: 3 as Step, label: "Finalize" },
];

const PRIORITY_ENTRIES = (
	<>
		{PriorityValues.map((v) => (
			<option key={v} value={v} className="text-black">
				{v.charAt(0).toUpperCase() + v.slice(1)}
			</option>
		))}
	</>
);

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const CreateQuote = ({ isModalOpen, setIsModalOpen, createQuote }: CreateQuoteProps) => {
	const navigate = useNavigate();

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [clientId, setClientId] = useState("");
	const [priority, setPriority] = useState<Priority>("Medium");
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [validUntilDate, setValidUntilDate] = useState<Date | null>(null);
	const [expiresAtDate, setExpiresAtDate] = useState<Date | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);

	const [sourceMode, setSourceMode] = useState<SourceType | null>(null);
	const [sourceClientFilter, setSourceClientFilter] = useState("");

	const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
	const [isDirty, setIsDirty] = useState(false);

	const { data: clients } = useAllClientsQuery();
	const { data: allQuotes = [] } = useAllQuotesQuery();
	const { data: drafts = [] } = useDraftsByTypeQuery("quote");
	const createDraftMutation = useCreateDraftMutation();
	const updateDraftMutation = useUpdateDraftMutation();
	const deleteDraftMutation = useDeleteDraftMutation();

	const isSourceSearchOpen = sourceMode !== null;

	const { data: taxGroups = [] } = useTaxGroups();
	const { data: defaultTaxGroup } = useDefaultTaxGroup();
	const clientExempt = useMemo(
		() => clients?.find((c) => c.id === clientId)?.is_tax_exempt ?? false,
		[clients, clientId]
	);

	const {
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		seedLineItems,
		subtotal,
		resetLineItems,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		setLineItemInventoryItem,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
	} = useLineItems({ minItems: 1, mode: "create", defaultTaxGroupId: defaultTaxGroup?.id ?? null });

	const { data: inventoryItems = [] } = useAllInventoryQuery();
	const lineItemsForCalc = useMemo(
		() =>
			activeLineItems.map((item) => ({
				id: item.id,
				total: item.total,
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
			})),
		[activeLineItems]
	);

	const {
		taxRate,
		setTaxRate,
		taxAmount,
		discountType,
		setDiscountType,
		discountValue,
		setDiscountValue,
		discountAmount,
		total,
		groupsSummary,
		totalTax,
		resolvedTaxRate,
		resolvedTaxAmount,
		resolvedTotal,
		reset: resetFinancials,
		setOriginals: setFinancialOriginals,
	} = useFinancialCalculations(subtotal, { taxGroups, lineItemsForCalc, clientExempt });

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({ totalSteps: 3 as Step, initialStep: 1 as Step });

	const validateStep1 = useCallback(
		() => !!(title.trim() && clientId.trim() && description.trim() && geoData?.address),
		[title, clientId, description, geoData]
	);

	const validateStep2 = useCallback(
		() =>
			activeLineItems.every(
				(item) =>
					item.name.trim() &&
					item.quantity > 0 &&
					item.unit_price >= 0
			),
		[activeLineItems]
	);

	const validateStep = useCallback(
		(step: Step): boolean => {
			if (step === 1) return validateStep1();
			if (step === 2) return validateStep2();
			return true;
		},
		[validateStep1, validateStep2]
	);

	const canGoNext = validateStep(currentStep);

	const canGoToStep = useCallback(
		(targetStep: Step): boolean => {
			if (targetStep === currentStep) return true;
			if (visitedSteps.has(targetStep)) return true;
			if (targetStep === currentStep + 1 && validateStep(currentStep))
				return true;
			return false;
		},
		[currentStep, visitedSteps, validateStep]
	);

	const resetForm = useCallback(() => {
		resetWizard();
		setTitle("");
		setDescription("");
		setClientId("");
		setPriority("Medium");
		setGeoData(undefined);
		setValidUntilDate(null);
		setExpiresAtDate(null);
		resetLineItems();
		resetFinancials();
		setErrors(null);
		setSubmitError(null);
		setSourceMode(null);
		setSourceClientFilter("");
		setCurrentDraftId(null);
		setIsDirty(false);
	}, [resetWizard, resetLineItems, resetFinancials]);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	// Mark dirty on any field change so Save Draft enables after edits
	const markDirty = useCallback(() => setIsDirty(true), []);
	const dirtyAddLineItem = useCallback(() => {
		addLineItem();
		markDirty();
	}, [addLineItem, markDirty]);
	const dirtyRemoveLineItem = useCallback(
		(id: string) => {
			removeLineItem(id);
			markDirty();
		},
		[removeLineItem, markDirty]
	);
	const dirtyUpdateLineItem = useCallback(
		(id: string, field: keyof BaseLineItem, value: string | number | boolean) => {
			updateLineItem(id, field, value);
			markDirty();
		},
		[updateLineItem, markDirty]
	);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
		markDirty();
	};
	const handleClearAddress = () => setGeoData(undefined);

	const handleSelectTemplate = useCallback(
		(quoteId: string) => {
			const source = allQuotes.find((q) => q.id === quoteId);
			if (!source) return;

			setTitle(source.title);
			setDescription(source.description);
			setPriority(source.priority as Priority);
			if (source.address && source.coords) {
				setGeoData({ address: source.address, coords: source.coords });
			} else if (source.address) {
				setGeoData({ address: source.address, coords: { lat: 0, lon: 0 } });
			}

			if (source.line_items?.length) {
				seedLineItems(
					source.line_items.map((li) => ({
						name: li.name,
						description: li.description ?? "",
						quantity: Number(li.quantity),
						unit_price: Number(li.unit_price),
						item_type: li.item_type ?? "",
						taxable: li.taxable ?? true,
						tax_group_id: li.tax_group_id ?? null,
						inventory_item_id: li.inventory_item_id ?? null,
					}))
				);
			} else {
				resetLineItems();
			}

			setFinancialOriginals(
				(source.tax_rate ?? 0) * 100,
				source.discount_type ?? "amount",
				source.discount_value ?? 0
			);

			setCurrentDraftId(null);
			setIsDirty(true); // pre-filled from template — allow saving as new draft
			setSourceMode(null);
			goToStep(1 as Step);
		},
		[allQuotes, seedLineItems, resetLineItems, setFinancialOriginals, goToStep]
	);

	const templateResults = useMemo((): TemplateSearchResult[] => {
		return allQuotes
			.filter((q) => q.is_active)
			.map((q) => ({
				id: q.id,
				title: q.title,
				subtitle: q.quote_number,
				detail: q.description
					? q.description.slice(0, 80) +
						(q.description.length > 80 ? "…" : "")
					: undefined,
				badge: q.status,
				badgeColor: QuoteStatusColors[
					q.status as keyof typeof QuoteStatusColors
				],
				value:
					q.total != null
						? `$${Number(q.total).toFixed(2)}`
						: undefined,
				createdAt: new Date(q.created_at).toISOString(),
				clientId: q.client_id,
				clientName: q.client?.name,
			}));
	}, [allQuotes]);

	const handleSelectDraft = useCallback(
		async (draftId: string) => {
			try {
				const draft = await getDraft(draftId);
				const payload = draft.payload as Partial<CreateQuoteInput>;

				setTitle(payload.title || "");
				setDescription(payload.description || "");
				setClientId(payload.client_id || "");
				setPriority((payload.priority as Priority) || "Medium");
				if (payload.address) {
					setGeoData({
						address: payload.address,
						coords: payload.coords || { lat: 0, lon: 0 },
					});
				}
				if (payload.line_items?.length) {
					seedLineItems(
						payload.line_items.map((li) => ({
							name: li.name,
							description: li.description ?? "",
							quantity: Number(li.quantity),
							unit_price: Number(li.unit_price),
							item_type: li.item_type ?? "",
							taxable: li.taxable ?? true,
							tax_group_id: li.tax_group_id ?? null,
							inventory_item_id: li.inventory_item_id ?? null,
						}))
					);
				}
				if (payload.tax_rate !== undefined) {
					setFinancialOriginals(
						payload.tax_rate * 100,
						payload.discount_type || "amount",
						payload.discount_value || 0
					);
				}
				setCurrentDraftId(draft.id);
				setIsDirty(false);
				setSourceMode(null);
				goToStep(1 as Step);
			} catch (err) {
				console.error("Failed to load draft:", err);
			}
		},
		[seedLineItems, setFinancialOriginals, goToStep]
	);

	const handleSaveDraft = useCallback(async () => {
		const payload: Record<string, unknown> = {
			title,
			description,
			client_id: clientId,
			priority,
			address: geoData?.address,
			coords: geoData?.coords,
			line_items: activeLineItems.map((item) => ({
				name: item.name,
				description: item.description,
				quantity: item.quantity,
				unit_price: item.unit_price,
				item_type: item.item_type,
				total: item.total,
				// Draft restore above reads this back — without it here a
				// saved-and-reopened quote silently loses every catalog link.
				inventory_item_id: item.inventory_item_id ?? null,
			})),
			tax_rate: taxRate / 100,
			tax_amount: taxAmount,
			discount_type: discountType,
			discount_value: discountValue,
			discount_amount: discountAmount,
			total,
			valid_until: validUntilDate?.toISOString(),
			expires_at: expiresAtDate?.toISOString(),
		};
		try {
			if (currentDraftId) {
				await updateDraftMutation.mutateAsync({
					id: currentDraftId,
					input: { payload },
				});
			} else {
				const draft = await createDraftMutation.mutateAsync({
					form_type: "quote",
					payload,
					entity_context_id: null,
				});
				setCurrentDraftId(draft.id);
			}
			setIsDirty(false);
		} catch (err) {
			console.error("Failed to save draft:", err);
		}
	}, [
		title,
		description,
		clientId,
		priority,
		geoData,
		activeLineItems,
		taxRate,
		taxAmount,
		discountType,
		discountValue,
		discountAmount,
		total,
		validUntilDate,
		expiresAtDate,
		currentDraftId,
		createDraftMutation,
		updateDraftMutation,
	]);

	const handleDeleteDraft = useCallback(
		async (draftId: string) => {
			try {
				await deleteDraftMutation.mutateAsync(draftId);
				// If the user deletes the draft they currently have loaded, clear tracking
				if (draftId === currentDraftId) {
					setCurrentDraftId(null);
					setIsDirty(false);
				}
				// If deleting the only draft while on drafts tab, stay on tab (list will show empty)
			} catch (err) {
				console.error("Failed to delete draft:", err);
			}
		},
		[currentDraftId, deleteDraftMutation]
	);

	const templateClients = useMemo((): TemplateSearchClient[] => {
		if (!clients) return [];
		return clients.map((c) => ({ id: c.id, name: c.name }));
	}, [clients]);

	const draftResults = useMemo((): TemplateSearchResult[] => {
		return drafts.map((d: DraftSummary) => ({
			id: d.id,
			title: d.label || "Untitled Draft",
			subtitle: (() => {
				const diff = Date.now() - new Date(d.updated_at).getTime();
				const mins = Math.floor(diff / 60000);
				const hrs = Math.floor(diff / 3600000);
				const days = Math.floor(diff / 86400000);
				if (mins < 1) return "Updated just now";
				if (mins < 60) return `Updated ${mins}m ago`;
				if (hrs < 24) return `Updated ${hrs}h ago`;
				if (days < 7) return `Updated ${days}d ago`;
				return `Updated ${new Date(d.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
			})(),
			value:
				d.total != null && d.total !== 0
					? `$${Number(d.total).toFixed(2)}`
					: undefined,
			createdAt: d.created_at,
			isDeletable: true,
			clientId: d.client_id ?? undefined,
			clientName: d.client_id
				? templateClients.find((c) => c.id === d.client_id)?.name
				: undefined,
		}));
	}, [drafts, templateClients]);

	const clientDropdownEntries = useMemo(() => {
		if (clients?.length) {
			return clients.map((c) => (
				<option value={c.id} key={c.id}>
					{c.name}
				</option>
			));
		}
		return (
			<option disabled value="">
				No clients found
			</option>
		);
	}, [clients]);

	const invokeCreate = async () => {
		if (isLoading) return;

		const preparedLineItems: CreateQuoteLineItemInput[] = activeLineItems.map(
			(item, index) => ({
				name: item.name,
				description: item.description || undefined,
				quantity: Number(item.quantity),
				unit_price: Number(item.unit_price),
				total: item.total,
				item_type: item.item_type || undefined,
				taxable: item.taxable,
				tax_group_id: item.tax_group_id ?? undefined,
				inventory_item_id: item.inventory_item_id ?? undefined,
				sort_order: index,
			})
		);

		const newQuote: CreateQuoteInput = {
			title: title.trim(),
			client_id: clientId.trim(),
			address: geoData?.address || "",
			coords: geoData?.coords,
			description: description.trim(),
			priority: priority as Priority,
			subtotal,
			tax_rate: resolvedTaxRate / 100,
			tax_amount: resolvedTaxAmount,
			discount_type: discountType,
			discount_value: discountValue,
			discount_amount: discountAmount,
			total: resolvedTotal,
			valid_until: validUntilDate ? validUntilDate.toISOString() : undefined,
			expires_at: expiresAtDate ? expiresAtDate.toISOString() : undefined,
			line_items: preparedLineItems,
		};

		const parseResult = CreateQuoteSchema.safeParse(newQuote);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			const errorPaths = parseResult.error.issues.map((i) => i.path[0]);
			if (
				errorPaths.some((p) =>
					[
						"title",
						"client_id",
						"description",
						"address",
						"coords",
						"priority",
					].includes(String(p))
				)
			) {
				goToStep(1 as Step);
			} else if (errorPaths.includes("line_items")) {
				goToStep(2 as Step);
			}
			return;
		}

		setErrors(null);
		setIsLoading(true);
		try {
			const quoteId = await createQuote(newQuote);
			// Auto-delete draft on successful submission
			if (currentDraftId) {
				await deleteDraftMutation
					.mutateAsync(currentDraftId)
					.catch(() => {});
			}
			setIsModalOpen(false);
			resetForm();
			navigate(`/dispatch/quotes/${quoteId}`);
		} catch (error) {
			console.error("Failed to create quote:", error);
			setSubmitError(errorMessage(error, "Failed to create quote. Please try again."));
		} finally {
			setIsLoading(false);
		}
	};

	const ErrorDisplay = ({ path }: { path: string }) => {
		if (!errors) return null;
		const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
		if (!fieldErrors.length) return null;
		return (
			<div className="mt-0.5">
				{fieldErrors.map((err, idx) => (
					<p key={idx} className="text-error-text text-xs leading-tight">
						{err.message}
					</p>
				))}
			</div>
		);
	};

	const stepContent = useMemo(() => {
		if (isSourceSearchOpen) {
			if (sourceMode === "draft") {
				return (
					<TemplateSearch
						heading="Use Draft"
						placeholder="Search drafts by name..."
						results={draftResults}
						clients={templateClients}
						onSelect={(id) => handleSelectDraft(id)}
						onClose={() => setSourceMode(null)}
						onDelete={handleDeleteDraft}
						isDeletingId={
							deleteDraftMutation.isPending
								? (deleteDraftMutation.variables as string)
								: null
						}
						clientFilter={sourceClientFilter}
						onClientFilterChange={setSourceClientFilter}
					/>
				);
			}
			return (
				<TemplateSearch
					results={templateResults}
					clients={templateClients}
					onSelect={handleSelectTemplate}
					onClose={() => setSourceMode(null)}
					clientFilter={sourceClientFilter}
					onClientFilterChange={setSourceClientFilter}
				/>
			);
		}

		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						<div className="min-w-0">
							<label className={LABEL}>Title *</label>
							<input
								type="text"
								placeholder="Quote Title"
								value={title}
								onChange={(e) => {
									setTitle(e.target.value);
									markDirty();
								}}
								className={INPUT}
								disabled={isLoading}
							/>
							<ErrorDisplay path="title" />
						</div>

						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className={LABEL}>
									Client *
								</label>
								<Dropdown
									entries={
										clientDropdownEntries
									}
									value={clientId}
									onChange={(v) => {
										setClientId(v);
										markDirty();
									}}
									placeholder="Select client"
									disabled={isLoading}
									error={errors?.issues.some(
										(e) =>
											e
												.path[0] ===
											"client_id"
									)}
								/>
								<ErrorDisplay path="client_id" />
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Priority
								</label>
								<Dropdown
									entries={PRIORITY_ENTRIES}
									value={priority}
									onChange={(v) => {
										setPriority(
											v as Priority
										);
										markDirty();
									}}
									defaultValue="Medium"
									disabled={isLoading}
									error={errors?.issues.some(
										(e) =>
											e
												.path[0] ===
											"priority"
									)}
								/>
								<ErrorDisplay path="priority" />
							</div>
						</div>

						<div className="min-w-0">
							<label className={LABEL}>
								Description *
							</label>
							<textarea
								placeholder="Quote Description"
								value={description}
								onChange={(e) => {
									setDescription(
										e.target.value
									);
									markDirty();
								}}
								className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
								disabled={isLoading}
							/>
							<ErrorDisplay path="description" />
						</div>

						<div
							className="relative min-w-0"
							style={{ zIndex: 50 }}
						>
							<label className={LABEL}>Address *</label>
							<AddressForm
								mode={geoData ? "edit" : "create"}
								originalValue={
									geoData?.address || ""
								}
								originalCoords={geoData?.coords}
								dropdownPosition="above"
								handleChange={handleChangeAddress}
								handleClear={handleClearAddress}
							/>
							<ErrorDisplay path="address" />
							<ErrorDisplay path="coords" />
						</div>
					</div>
				);

			case 2:
				return (
					<div className="space-y-2 min-w-0 pt-2">
						<ErrorDisplay path="line_items" />
						<LineItemsSection
							inventoryItems={inventoryItems}
							onLinkInventory={setLineItemInventoryItem}
							lineItems={activeLineItems}
							isLoading={isLoading}
							onAdd={dirtyAddLineItem}
							onRemove={dirtyRemoveLineItem}
							onUpdate={dirtyUpdateLineItem}
							subtotal={subtotal}
							required
							minItems={1}
							dirtyFields={dirtyLineItemFields}
							onUndo={undoLineItemField}
							onClear={clearLineItemField}
							taxGroups={taxGroups}
							clientExempt={clientExempt}
							onTaxChange={setLineItemTaxGroup}
							onTaxGroupBulkSet={setAllLineItemsTaxGroup}
						/>
					</div>
				);

			case 3:
				return (
					<div className="space-y-3 min-w-0 pt-2">
						<FinancialSummary
							subtotal={subtotal}
							taxRate={taxRate}
							taxAmount={taxAmount}
							discountType={discountType}
							discountValue={discountValue}
							discountAmount={discountAmount}
							total={resolvedTotal}
							groupsSummary={groupsSummary}
							totalTax={totalTax}
							clientExempt={clientExempt}
							isLoading={isLoading}
							mode="create"
							onTaxRateChange={groupsSummary.length > 0 ? undefined : (v) => {
								setTaxRate(v);
								markDirty();
							}}
							onDiscountTypeChange={(v) => {
								setDiscountType(v);
								markDirty();
							}}
							onDiscountValueChange={(v) => {
								setDiscountValue(v);
								markDirty();
							}}
							totalLabel="Total"
						/>
						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className={LABEL}>
									Valid Until (Optional)
								</label>
								<DatePicker
									portal
									mode="create"
									value={validUntilDate}
									onChange={(v) => {
										setValidUntilDate(
											v
										);
										markDirty();
									}}
									align="right"
									position="above"
								/>
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Expires At (Optional)
								</label>
								<DatePicker
									portal
									mode="create"
									value={expiresAtDate}
									onChange={(v) => {
										setExpiresAtDate(v);
										markDirty();
									}}
									align="right"
									position="above"
								/>
							</div>
						</div>
					</div>
				);

			default:
				return null;
		}
	}, [
		isSourceSearchOpen,
		sourceMode,
		draftResults,
		handleSelectDraft,
		handleDeleteDraft,
		templateResults,
		templateClients,
		handleSelectTemplate,
		sourceClientFilter,
		currentStep,
		title,
		clientId,
		priority,
		description,
		isLoading,
		clientDropdownEntries,
		geoData,
		errors,
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		subtotal,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		taxRate,
		taxAmount,
		discountType,
		discountValue,
		discountAmount,
		total,
		validUntilDate,
		expiresAtDate,
	]);

	return (
		<FormWizardContainer<Step>
			title="Create Quote"
			steps={STEPS}
			currentStep={currentStep}
			visitedSteps={visitedSteps}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			canGoToStep={canGoToStep}
			onStepClick={goToStep}
			onNext={goNext}
			onBack={goBack}
			onSubmit={invokeCreate}
			canGoNext={canGoNext}
			submitLabel="Create Quote"
			isSourceSearchOpen={isSourceSearchOpen}
			sourceMode={sourceMode || "existing"}
			onSourceModeChange={(mode) => setSourceMode(mode)}
			draftCount={drafts.length}
			onStartFromExisting={() => setSourceMode("existing")}
			hideStartFromExisting={isSourceSearchOpen}
			fullHeightContent={isSourceSearchOpen}
			onCloseSourceSearch={() => setSourceMode(null)}
			onSaveDraft={handleSaveDraft}
			canSaveDraft={
				// Requires both: user has made at least one edit (isDirty)
				// AND the form has actual content worth saving
				isDirty &&
				!!(
					title.trim() ||
					description.trim() ||
					clientId ||
					geoData?.address ||
					activeLineItems.some(
						(i) =>
							i.name.trim() ||
							i.quantity > 0 ||
							i.unit_price > 0
					)
				)
			}
			isSavingDraft={
				createDraftMutation.isPending || updateDraftMutation.isPending
			}
		>
			<>
				<FormErrorBanner message={submitError} className="mb-2" />
				{stepContent}
			</>
		</FormWizardContainer>
	);
};

export default CreateQuote;
