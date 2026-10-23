import { useState, useEffect, useMemo, useCallback } from "react";
import type { ZodError } from "zod";
import {
	UpdateQuoteSchema,
	type Quote,
	type UpdateQuoteInput,
	type UpdateQuoteLineItemInput,
	isQuoteEditable,
} from "../../types/quotes";
import { type EditableLineItem, type Priority, PriorityValues } from "../../types/common";
import type { GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
import DatePicker from "../ui/DatePicker";
import { UndoButton, UndoButtonTop } from "../ui/forms/UndoButton";
import {
	useUpdateQuoteMutation,
	useAddLineItemMutation,
	useUpdateLineItemMutation,
	useDeleteLineItemMutation,
} from "../../hooks/useQuotes";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";
import { rateToPercentInput } from "../../lib/formatTax";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAutoTaxMode } from "../../hooks/useAutoTaxMode";
import {
	lineTaxPayload,
	editorAutoTax,
	flatRateHandler,
	keptRateEstimate,
	keptRateOptionLabel,
} from "../../lib/taxEditorMode";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import FinancialSummary from "../ui/forms/FinancialSummary";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useLineItemsForCalc } from "../../hooks/forms/useLineItemsForCalc";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";
import { roundingFor } from "../../lib/taxRounding";
import { useDirtyTracking } from "../../hooks/forms/useDirtyTracking";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import AddressTaxChoicePanel from "../tax/AddressTaxChoicePanel";
import { useAddressTaxChoice } from "../tax/useAddressTaxChoice";

type Step = 1 | 2 | 3;

interface EditQuoteProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	quote: Quote;
}

const STEPS = [
	{ id: 1 as Step, label: "Basics" },
	{ id: 2 as Step, label: "Line Items" },
	{ id: 3 as Step, label: "Finalize" },
];

const PRIORITY_ENTRIES = (
	<>
		{PriorityValues.map((v) => (
			<option key={v} value={v}>
				{v.charAt(0).toUpperCase() + v.slice(1)}
			</option>
		))}
	</>
);

const EditQuote = ({ isModalOpen, setIsModalOpen, quote }: EditQuoteProps) => {
	const updateQuote = useUpdateQuoteMutation();
	const addLineItem = useAddLineItemMutation();
	const updateLineItem = useUpdateLineItemMutation();
	const deleteLineItem = useDeleteLineItemMutation();

	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);

	type FormFields = {
		title: string;
		description: string;
		priority: Priority;
	};

	const { updateField, undoField, setOriginals, isDirty, getValue } =
		useDirtyTracking<FormFields>({
			title: "",
			description: "",
			priority: "Medium",
		});

	// Shared hooks
	const { data: taxGroups = [] } = useTaxGroups();
	const autoModeLoaded = useAutoTaxMode();
	const autoMode = autoModeLoaded === true;
	const keptEstimate = keptRateEstimate(quote.tax_snapshot, autoModeLoaded, false);
	const kept = keptEstimate != null;
	const keptRateLabel = keptEstimate ? keptRateOptionLabel(keptEstimate) : null;
	const clientExempt = quote.client?.is_tax_exempt ?? false;
	const clientTaxGroupId = quote.client?.tax_group_id ?? null;
	const taxEditable = isQuoteEditable(quote.status);

	const {
		lineItems,
		activeLineItems,
		addLineItem: addLineItemToState,
		removeLineItem: removeLineItemFromState,
		updateLineItem: updateLineItemInState,
		subtotal,
		setLineItems,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		setLineItemInventoryItem,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
		resetLineItems,
	} = useLineItems({
		minItems: 1,
		mode: "edit",
	});

	const { data: inventoryItems = [] } = useAllInventoryQuery();
	const lineItemsForCalc = useLineItemsForCalc(activeLineItems, clientTaxGroupId);

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
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		setOriginals: setFinancialOriginals,
	} = useFinancialCalculations(subtotal, {
		initialTaxRate: rateToPercentInput(quote.tax_rate),
		initialDiscountType: (quote.discount_type as "percent" | "amount") ?? "amount",
		initialDiscountValue: quote.discount_value ? Number(quote.discount_value) : 0,
		taxGroups,
		lineItemsForCalc,
		clientExempt,
		rounding: roundingFor(quote.tax_snapshot),
	});

	const addressTax = useAddressTaxChoice({
		docNoun: "quote",
		snapshot: quote.tax_snapshot,
		keptEstimate,
		geo: geoData,
		doc: quote,
		lines: lineItemsForCalc,
		discountAmount,
		discountType,
		discountValue,
		taxGroups,
		rounding: roundingFor(quote.tax_snapshot),
	});
	const resetAddressTax = addressTax.reset;

	const [validUntilDate, setValidUntilDate] = useState<Date | null>(null);
	const [expiresAtDate, setExpiresAtDate] = useState<Date | null>(null);

	const validateStep1 = useCallback((): boolean => {
		return !!(
			getValue("title").trim() &&
			getValue("description").trim() &&
			geoData?.address
		);
	}, [getValue, geoData]);

	const validateStep2 = useCallback((): boolean => {
		return activeLineItems.every(
			(item) => item.name.trim() && item.quantity > 0 && item.unit_price >= 0
		);
	}, [activeLineItems]);

	const validateStep = useCallback(
		(step: Step): boolean => {
			switch (step) {
				case 1:
					return validateStep1();
				case 2:
					return validateStep2();
				case 3:
					return true;
				default:
					return true;
			}
		},
		[validateStep1, validateStep2]
	);

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({
		totalSteps: 3 as Step,
		initialStep: 1 as Step,
	});

	const canGoNext = validateStep(currentStep);

	const canGoToStep = useCallback(
		(targetStep: Step): boolean => {
			if (targetStep <= currentStep) return true;

			for (let step = 1; step < targetStep; step++) {
				if (!validateStep(step as Step)) {
					return false;
				}
			}
			return true;
		},
		[currentStep, validateStep]
	);

	useEffect(() => {
		if (isModalOpen && quote) {
			resetWizard();

			// Set originals for dirty tracking
			const initialOriginals: FormFields = {
				title: quote.title ?? "",
				description: quote.description ?? "",
				priority: quote.priority,
			};

			setOriginals(initialOriginals);

			// Initialize line items
			const initialLineItems: EditableLineItem[] =
				quote.line_items?.map((item) => ({
					// Server id, so the tax snapshot's per-line reasons key straight onto the line.
					id: item.id,
					entity_line_item_id: item.id,
					name: item.name,
					description: item.description || "",
					quantity: Number(item.quantity),
					unit_price: Number(item.unit_price),
					item_type: item.item_type || "",
					total: Number(item.total),
					taxable: item.taxable ?? true,
					tax_group_id: item.tax_group_id ?? null,
					inventory_item_id: item.inventory_item_id ?? null,
					isNew: false,
					isDeleted: false,
				})) || [];

			// Ids are stable server ids, so clear the previous session's dirty flags first;
			// setLineItems below rebuilds the originals the reset empties.
			resetLineItems();
			setLineItems(initialLineItems);

			const vud = quote.valid_until ? new Date(quote.valid_until) : null;
			const exd = quote.expires_at ? new Date(quote.expires_at) : null;
			setValidUntilDate(vud);
			setExpiresAtDate(exd);

			if (quote.address) {
				setGeoData({
					address: quote.address,
					coords: quote.coords || undefined,
				} as GeocodeResult);
			} else {
				setGeoData(undefined);
			}

			setErrors(null);
			setSubmitError(null);
			resetAddressTax();

			setFinancialOriginals(
				rateToPercentInput(quote.tax_rate),
				quote.discount_type ?? "amount",
				quote.discount_value ? Number(quote.discount_value) : 0
			);
		}
	}, [
		isModalOpen,
		quote,
		resetWizard,
		resetLineItems,
		setLineItems,
		setOriginals,
		setFinancialOriginals,
		resetAddressTax,
	]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({
			address: result.address,
			coords: result.coords,
		});
		addressTax.onAddressChange();
	};

	const handleClearAddress = () => {
		setGeoData(undefined);
		addressTax.onAddressChange();
	};

	const lineTax = (item: Parameters<typeof lineTaxPayload>[0]) => {
		const tax = lineTaxPayload(item);
		return { ...tax, tax_group_id: addressTax.lineGroup(tax) };
	};

	const invokeUpdate = async () => {
		if (isLoading) return;



		const updates: UpdateQuoteInput = {
			title: getValue("title") !== quote.title ? getValue("title") : undefined,
			description:
				getValue("description") !== quote.description
					? getValue("description")
					: undefined,
			address: geoData?.address !== quote.address ? geoData?.address : undefined,
			coords: geoData?.coords !== quote.coords ? geoData?.coords : undefined,
			priority: getValue("priority") as Priority,
			subtotal,
			tax_rate: resolvedTaxRate / 100,
			tax_amount: resolvedTaxAmount,
			discount_type: discountType,
			discount_value: discountValue,
			discount_amount: discountAmount,
			total: resolvedTotal,
			valid_until: validUntilDate ? validUntilDate.toISOString() : null,
			expires_at: expiresAtDate ? expiresAtDate.toISOString() : null,
			address_tax_choice: addressTax.payloadChoice,
		};

		const parseResult = UpdateQuoteSchema.safeParse(updates);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			console.error("Validation errors:", parseResult.error);
			return;
		}

		setIsLoading(true);

		try {
			await updateQuote.mutateAsync({
				id: quote.id,
				data: updates,
			});

			// Process line item changes
			for (const item of lineItems) {
				const editableItem = item as EditableLineItem;

				if (editableItem.isDeleted && editableItem.entity_line_item_id) {
					await deleteLineItem.mutateAsync({
						quoteId: quote.id,
						lineItemId: editableItem.entity_line_item_id,
					});
				} else if (editableItem.isNew) {
					await addLineItem.mutateAsync({
						quoteId: quote.id,
						data: {
							name: item.name,
							description: item.description || undefined,
							quantity: Number(item.quantity),
							unit_price: Number(item.unit_price),
							total: item.total,
							item_type: item.item_type || undefined,
							...lineTax(item),
							inventory_item_id: item.inventory_item_id ?? undefined,
						},
					});
				} else if (editableItem.entity_line_item_id) {
					const updateData: UpdateQuoteLineItemInput = {
						name: item.name,
						description: item.description || undefined,
						quantity: Number(item.quantity),
						unit_price: Number(item.unit_price),
						total: item.total,
						item_type: item.item_type || undefined,
						...lineTax(item),
						inventory_item_id: item.inventory_item_id ?? undefined,
					};

					await updateLineItem.mutateAsync({
						quoteId: quote.id,
						lineItemId: editableItem.entity_line_item_id,
						data: updateData,
					});
				}
			}

			setIsLoading(false);
			setIsModalOpen(false);
		} catch (error) {
			setIsLoading(false);
			if (addressTax.handleError(error)) return;
			console.error("Failed to update quote:", error);
			setSubmitError(errorMessage(error, "Failed to update quote. Please try again."));
		}
	};

	const ErrorDisplay = ({ path }: { path: string }) => {
		if (!errors) return null;
		const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
		if (fieldErrors.length === 0) return null;
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
		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 min-w-0">
						{/* Title */}
						<div className="min-w-0">
							<label className="block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Title *
							</label>
							<div className="relative">
								<input
									type="text"
									placeholder="Quote Title"
									value={getValue("title")}
									onChange={(e) =>
										updateField(
											"title",
											e.target
												.value
										)
									}
									className="border border-border px-2.5 py-1 w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
									disabled={isLoading}
								/>
								<UndoButton
									show={isDirty("title")}
									onUndo={() =>
										undoField("title")
									}
									disabled={isLoading}
								/>
							</div>
							<ErrorDisplay path="title" />
						</div>

						{/* Client and Priority Row */}
						<div className="grid grid-cols-2 gap-2 min-w-0">
							<div className="min-w-0">
								<label className="block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
									Client
								</label>
								<div className="border border-border px-2.5 pt-1.5 pb-1 w-full rounded bg-surface/50 text-text-tertiary text-sm">
									{quote.client?.name ||
										"Unknown Client"}
								</div>
								<p className="text-[10px] text-text-muted mt-0.5 leading-tight">
									Client cannot be changed
								</p>
							</div>

							<div className="min-w-0">
								<label className="block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
									Priority
								</label>
								<div className="relative">
									<Dropdown
										entries={
											PRIORITY_ENTRIES
										}
										value={getValue(
											"priority"
										)}
										onChange={(
											newValue
										) =>
											updateField(
												"priority",
												newValue as Priority
											)
										}
										disabled={isLoading}
										error={errors?.issues.some(
											(e) =>
												e
													.path[0] ===
												"priority"
										)}
									/>
									<UndoButton
										show={isDirty(
											"priority"
										)}
										onUndo={() =>
											undoField(
												"priority"
											)
										}
										position="right-9"
										disabled={isLoading}
									/>
								</div>
								<ErrorDisplay path="priority" />
							</div>
						</div>

						{/* Description */}
						<div className="min-w-0">
							<label className="block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Description *
							</label>
							<div className="relative">
								<textarea
									placeholder="Quote Description"
									value={getValue(
										"description"
									)}
									onChange={(e) =>
										updateField(
											"description",
											e.target
												.value
										)
									}
									className="border border-border px-2.5 py-1 w-full h-14 rounded bg-base text-text-primary text-sm resize-none focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
									disabled={isLoading}
								/>
								<UndoButtonTop
									show={isDirty(
										"description"
									)}
									onUndo={() =>
										undoField(
											"description"
										)
									}
									disabled={isLoading}
								/>
							</div>
							<ErrorDisplay path="description" />
						</div>

						{/* Address */}
						<div
							className="relative min-w-0"
							style={{ zIndex: 50 }}
						>
							<label className="block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Address *
							</label>
							<div className="relative">
								<AddressForm
									mode="edit"
									originalValue={
										quote.address || ""
									}
									originalCoords={
										geoData?.coords
									}
									dropdownPosition="above"
									handleChange={
										handleChangeAddress
									}
									handleClear={
										handleClearAddress
									}
								/>
							</div>
							<ErrorDisplay path="address" />
							<ErrorDisplay path="coords" />
						</div>
					</div>
				);

			case 2:
				return (
					<div className="min-w-0 flex flex-col">
						<ErrorDisplay path="line_items" />
						<LineItemsSection
							inventoryItems={inventoryItems}
							onLinkInventory={setLineItemInventoryItem}
							lineItems={activeLineItems}
							isLoading={isLoading}
							onAdd={addLineItemToState}
							onRemove={removeLineItemFromState}
							onUpdate={updateLineItemInState}
							subtotal={subtotal}
							required
							minItems={1}
							dirtyFields={dirtyLineItemFields}
							onUndo={undoLineItemField}
							onClear={clearLineItemField}
							taxGroups={taxGroups}
							clientExempt={clientExempt}
							onTaxChange={taxEditable ? setLineItemTaxGroup : undefined}
							autoMode={autoMode}
							keptRateLabel={keptRateLabel}
							onTaxGroupBulkSet={taxEditable ? setAllLineItemsTaxGroup : undefined}
						/>
					</div>
				);

			case 3:
				return (
					<div className="space-y-3 min-w-0">
						{addressTax.ask && <AddressTaxChoicePanel {...addressTax.panelProps} />}
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
							onTaxRateChange={flatRateHandler(autoMode, groupsSummary.length, setTaxRate)}
							onDiscountTypeChange={setDiscountType}
							onDiscountValueChange={setDiscountValue}
							totalLabel="Total"
							autoTax={editorAutoTax(
								autoMode,
								lineItemsForCalc,
								discountAmount,
								quote.tax_snapshot,
								addressTax.addressChangedForSummary,
								kept,
							)}
							keptRate={kept}
							chosenTax={addressTax.summaryChoice}
							isTaxDirty={isTaxDirty}
							isDiscountDirty={isDiscountDirty}
							onTaxUndo={undoTax}
							onDiscountUndo={undoDiscount}
						/>

						<div className="grid grid-cols-2 gap-2">
							<div className="min-w-0">
								<p className="mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
									Valid Until (Optional)
								</p>
								<DatePicker
									portal
									mode="edit"
									originalValue={
										quote.valid_until
											? new Date(
													quote.valid_until
												)
											: null
									}
									value={validUntilDate}
									onChange={setValidUntilDate}
									align="left"
									position="above"
								/>
							</div>

							<div className="min-w-0">
								<p className="mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
									Expires At (Optional)
								</p>
								<DatePicker
									portal
									mode="edit"
									originalValue={
										quote.expires_at
											? new Date(
													quote.expires_at
												)
											: null
									}
									value={expiresAtDate}
									onChange={setExpiresAtDate}
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
		currentStep,
		autoMode,
		getValue,
		updateField,
		undoField,
		isDirty,
		isLoading,
		errors,
		quote,
		geoData,
		activeLineItems,
		lineItemsForCalc,
		addLineItemToState,
		removeLineItemFromState,
		updateLineItemInState,
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
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		taxEditable,
		addressTax.ask,
		addressTax.panelProps,
		addressTax.addressChangedForSummary,
		addressTax.summaryChoice,
	]);

	return (
		<FormWizardContainer<Step>
			title="Edit Quote"
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
			onSubmit={invokeUpdate}
			canSubmit={addressTax.canSubmit}
			canGoNext={canGoNext}
			submitLabel="Save Changes"
			isEditMode={true}
		>
			<>
				<FormErrorBanner message={submitError} className="mb-2" />
				{stepContent}
			</>
		</FormWizardContainer>
	);
};

export default EditQuote;
