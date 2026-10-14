import { useState, useEffect, useMemo, useCallback } from "react";
import type { ZodError } from "zod";
import {
	UpdateJobSchema,
	type Job,
	type UpdateJobInput,
	type UpdateJobLineItemInput,
} from "../../types/jobs";
import { type EditableLineItem, type Priority, PriorityValues } from "../../types/common";
import type { GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
import { useUpdateJobMutation } from "../../hooks/useJobs";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import FinancialSummary from "../ui/forms/FinancialSummary";
import { UndoButton, UndoButtonTop } from "../ui/forms/UndoButton";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";
import { useDirtyTracking } from "../../hooks/forms/useDirtyTracking";

type Step = 1 | 2 | 3;

interface EditJobProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	job: Job;
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

const EditJob = ({ isModalOpen, setIsModalOpen, job }: EditJobProps) => {
	const updateJob = useUpdateJobMutation();
	const { data: taxGroups = [] } = useTaxGroups();
	const clientExempt = job.client?.is_tax_exempt ?? false;
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);

	type FormFields = {
		name: string;
		description: string;
		priority: Priority;
	};

	const { updateField, undoField, setOriginals, isDirty, getValue } =
		useDirtyTracking<FormFields>({
			name: "",
			description: "",
			priority: "Medium",
		});

	const {
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
	} = useLineItems({
		minItems: 1,
		mode: "edit",
	});

	const { data: inventoryItems = [] } = useAllInventoryQuery();
	const lineItemsForCalc = useMemo(
		() =>
			activeLineItems
				.filter((li) => !("isDeleted" in li && li.isDeleted))
				.map((li) => ({
					id: li.id,
					total: Number(li.total),
					taxable: li.taxable ?? true,
					tax_group_id: li.tax_group_id ?? null,
				})),
		[activeLineItems],
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
		total: estimatedTotal,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		setOriginals: setFinancialOriginals,
		groupsSummary,
		totalTax,
		resolvedTaxRate,
		resolvedTaxAmount,
		resolvedTotal,
	} = useFinancialCalculations(subtotal, {
		initialTaxRate: job.tax_rate ? Number(job.tax_rate) * 100 : 0,
		initialDiscountType: job.discount_type || "amount",
		initialDiscountValue: job.discount_value ? Number(job.discount_value) : 0,
		taxGroups,
		lineItemsForCalc,
		clientExempt,
	});

	const validateStep1 = useCallback((): boolean => {
		return !!(
			getValue("name").trim() &&
			getValue("description").trim() &&
			geoData?.address
		);
	}, [getValue, geoData]);

	const validateStep2 = useCallback((): boolean => {
		const hasAnyData = activeLineItems.some(
			(item) => item.name.trim() || item.quantity !== 1 || item.unit_price !== 0
		);
		if (!hasAnyData) return true;
		return activeLineItems.every(
			(item) =>
				!item.name.trim() ||
				(item.name.trim() && item.quantity > 0 && item.unit_price >= 0)
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
				if (!validateStep(step as Step)) return false;
			}
			return true;
		},
		[currentStep, validateStep]
	);

	useEffect(() => {
		if (isModalOpen && job) {
			resetWizard();

			const initialOriginals: FormFields = {
				name: job.name ?? "",
				description: job.description ?? "",
				priority: job.priority as Priority,
			};
			setOriginals(initialOriginals);

			const initialLineItems: EditableLineItem[] =
				job.line_items?.map((item) => ({
					id: crypto.randomUUID(),
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

			if (initialLineItems.length === 0) {
				initialLineItems.push({
					id: crypto.randomUUID(),
					entity_line_item_id: undefined,
					name: "",
					description: "",
					quantity: 1,
					unit_price: 0,
					item_type: "",
					total: 0,
					isNew: true,
					isDeleted: false,
				});
			}

			setLineItems(initialLineItems);

			if (job.address) {
				setGeoData({
					address: job.address,
					coords: job.coords || undefined,
				} as GeocodeResult);
			} else {
				setGeoData(undefined);
			}

			setErrors(null);

			setFinancialOriginals(
				job.tax_rate ? Number(job.tax_rate) * 100 : 0,
				job.discount_type ?? "amount",
				job.discount_value ? Number(job.discount_value) : 0
			);
		}
	}, [isModalOpen, job, resetWizard, setLineItems, setOriginals, setFinancialOriginals]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
	};

	const handleClearAddress = () => setGeoData(undefined);

	const invokeUpdate = async () => {
		if (isLoading) return;

		const nonEmptyLineItems = activeLineItems.filter((item) => {
			return (
				item.name.trim() ||
				item.description?.trim() ||
				item.quantity !== 1 ||
				item.unit_price !== 0 ||
				item.item_type
			);
		});

		const lineItemUpdates: UpdateJobLineItemInput[] = nonEmptyLineItems.map((item) => {
			const li = item as EditableLineItem;
			return {
				id: li.entity_line_item_id,
				name: item.name.trim(),
				description: item.description?.trim() || undefined,
				quantity: Number(item.quantity),
				unit_price: Number(item.unit_price),
				total: Number(item.total),
				item_type: item.item_type || undefined,
				tax_group_id: item.tax_group_id ?? undefined,
				inventory_item_id: item.inventory_item_id ?? undefined,
				taxable: item.taxable,
			};
		});

		const updates: UpdateJobInput = {
			name: getValue("name") !== job.name ? getValue("name") : undefined,
			description:
				getValue("description") !== job.description
					? getValue("description")
					: undefined,
			address: geoData?.address !== job.address ? geoData?.address : undefined,
			coords: geoData?.coords !== job.coords ? geoData?.coords : undefined,
			priority: getValue("priority") as Priority,
			subtotal,
			tax_rate: resolvedTaxRate / 100,
			tax_amount: resolvedTaxAmount,
			discount_type: discountType,
			discount_value: discountValue,
			discount_amount: discountAmount,
			estimated_total: resolvedTotal,
			line_items: lineItemUpdates.length > 0 ? lineItemUpdates : undefined,
		};

		const parseResult = UpdateJobSchema.safeParse(updates);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			console.error("Validation errors:", parseResult.error);
			return;
		}

		setErrors(null);
		setIsLoading(true);

		try {
			await updateJob.mutateAsync({ id: job.id, updates });
			setIsLoading(false);
			setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to update job:", error);
			setIsLoading(false);
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
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						{/* Name */}
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Job Name *
							</label>
							<div className="relative">
								<input
									type="text"
									placeholder="Job Name"
									value={getValue("name")}
									onChange={(e) =>
										updateField(
											"name",
											e.target
												.value
										)
									}
									className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
									disabled={isLoading}
								/>
								<UndoButton
									show={isDirty("name")}
									onUndo={() =>
										undoField("name")
									}
									disabled={isLoading}
								/>
							</div>
							<ErrorDisplay path="name" />
						</div>

						{/* Client and Priority Row */}
						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
									Client
								</label>
								<div className="border border-border px-2.5 pt-1.5 pb-1 w-full rounded bg-surface/50 text-text-tertiary text-sm">
									{job.client?.name ||
										"Unknown Client"}
								</div>
								<p className="text-[10px] text-text-muted mt-0.5 leading-tight">
									Client cannot be changed
								</p>
							</div>

							<div className="min-w-0">
								<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
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
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Description *
							</label>
							<div className="relative">
								<textarea
									placeholder="Job Description"
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
									className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
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
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Address *
							</label>
							<div className="relative">
								<AddressForm
									mode="edit"
									originalValue={
										job.address || ""
									}
									originalCoords={
										job.coords ||
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
							required={false}
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
					<div className="space-y-3 lg:space-y-5 xl:space-y-6 min-w-0">
						<FinancialSummary
							subtotal={subtotal}
							taxRate={taxRate}
							taxAmount={taxAmount}
							discountType={discountType}
							discountValue={discountValue}
							discountAmount={discountAmount}
							total={estimatedTotal}
							isLoading={isLoading}
							onTaxRateChange={setTaxRate}
							onDiscountTypeChange={setDiscountType}
							onDiscountValueChange={setDiscountValue}
							totalLabel="Estimated Total"
							isTaxDirty={isTaxDirty}
							isDiscountDirty={isDiscountDirty}
							onTaxUndo={undoTax}
							onDiscountUndo={undoDiscount}
							groupsSummary={groupsSummary}
							totalTax={totalTax}
						/>

						{job.actual_total !== null &&
							job.actual_total !== undefined && (
								<div className="p-3 lg:p-4 bg-surface rounded-lg border border-border">
									<div className="flex items-center justify-between text-sm lg:text-base">
										<span className="text-text-tertiary">
											Actual
											Total:
										</span>
										<span className="text-primary-text font-semibold tabular-nums">
											$
											{Number(
												job.actual_total
											).toFixed(
												2
											)}
										</span>
									</div>
									<div className="flex items-center justify-between text-sm lg:text-base mt-2 pt-2 border-t border-border">
										<span className="text-text-tertiary">
											Variance:
										</span>
										<span
											className={`font-semibold tabular-nums ${
												Number(
													job.actual_total
												) >
												estimatedTotal
													? "text-error-text"
													: "text-success-text"
											}`}
										>
											{Number(
												job.actual_total
											) >
											estimatedTotal
												? "+"
												: ""}
											$
											{(
												Number(
													job.actual_total
												) -
												estimatedTotal
											).toFixed(
												2
											)}
										</span>
									</div>
								</div>
							)}
					</div>
				);

			default:
				return null;
		}
	}, [
		currentStep,
		getValue,
		updateField,
		undoField,
		isDirty,
		isLoading,
		errors,
		job,
		geoData,
		activeLineItems,
		addLineItemToState,
		removeLineItemFromState,
		updateLineItemInState,
		subtotal,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		setLineItemTaxGroup,
		setAllLineItemsTaxGroup,
		taxGroups,
		clientExempt,
		lineItemsForCalc,
		taxRate,
		taxAmount,
		discountType,
		discountValue,
		discountAmount,
		estimatedTotal,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,
		groupsSummary,
		totalTax,
	]);

	return (
		<FormWizardContainer<Step>
			title="Edit Job"
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
			canGoNext={canGoNext}
			submitLabel="Save Changes"
			isEditMode={true}
		>
			{stepContent}
		</FormWizardContainer>
	);
};

export default EditJob;
