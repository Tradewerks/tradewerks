import { useState, useEffect, useMemo, useCallback } from "react";
import type { ZodError } from "zod";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAutoTaxMode } from "../../hooks/useAutoTaxMode";
import {
	docKeptEstimate,
	jobKeptSource,
	keptRateOptionLabel,
	lineTaxPayload,
} from "../../lib/taxEditorMode";
import { useVehiclesQuery } from "../../hooks/useVehicles";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import TimeConstraints, { type TimeConstraintsState } from "../ui/forms/TimeConstraints";
import DatePicker from "../ui/DatePicker";
import { UndoButton, UndoButtonTop } from "../ui/forms/UndoButton";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useLineItemsForCalc } from "../../hooks/forms/useLineItemsForCalc";
import { useDirtyTracking } from "../../hooks/forms/useDirtyTracking";
import { createStepRouter } from "../../hooks/forms/useZodStepRouting";
import {
	useUpdateJobVisitMutation,
	useAssignTechniciansToVisitMutation,
	useJobByIdQuery,
} from "../../hooks/useJobs";
import { useActiveTechniciansQuery } from "../../hooks/useTechnicians";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";
import { roundingFor } from "../../lib/taxRounding";
import {
	CreateJobVisitSchema,
	type CreateJobVisitInput,
	type JobVisit,
	type UpdateJobVisitInput,
} from "../../types/jobs";
import type { LineItemType, EditableLineItem } from "../../types/common";

type Step = 1 | 2 | 3 | 4;

const STEPS = [
	{ id: 1 as Step, label: "Details" },
	{ id: 2 as Step, label: "Constraints" },
	{ id: 3 as Step, label: "Line Items" },
	{ id: 4 as Step, label: "Technicians" },
];

const routeErrorToStep = createStepRouter<Step>({
	1: ["name", "description"],
	2: [
		"arrival_constraint",
		"finish_constraint",
		"arrival_time",
		"arrival_window_start",
		"arrival_window_end",
		"finish_time",
	],
	3: ["line_items"],
	4: ["tech_ids"],
});

interface EditJobVisitProps {
	isModalOpen: boolean;
	setIsModalOpen: (isOpen: boolean) => void;
	visit: JobVisit;
	jobId: string;
	clientExempt: boolean;
}

const formatTimeString = (date: Date | null): string | null => {
	if (!date) return null;
	return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
};

const parseHHMMToDate = (hhmm: string | null | undefined, baseDate: Date): Date | null => {
	if (!hhmm) return null;
	const [h, m] = hhmm.split(":").map(Number);
	if (Number.isNaN(h) || Number.isNaN(m)) return null;
	const d = new Date(baseDate);
	d.setHours(h, m, 0, 0);
	return d;
};

export default function EditJobVisit({ isModalOpen, setIsModalOpen, visit, jobId, clientExempt }: EditJobVisitProps) {
	const updateVisit = useUpdateJobVisitMutation();
	const assignTechs = useAssignTechniciansToVisitMutation();
	const { data: activeTechnicians } = useActiveTechniciansQuery();
	// A deactivated technician already on this visit stays listed so the visit can be re-saved.
	const technicians = useMemo(() => {
		const active = activeTechnicians ?? [];
		const assigned = visit.visit_techs
			.map((vt) => vt.tech)
			.filter((t) => !active.some((a) => a.id === t.id));
		return [...active, ...assigned];
	}, [activeTechnicians, visit.visit_techs]);

	const isLoading = updateVisit.isPending || assignTechs.isPending;

	type FormFields = {
		name: string;
		description: string;
		startDate: Date;
	};

	const { fields, updateField, undoField, setOriginals, isDirty, getValue } =
		useDirtyTracking<FormFields>({
			name: "",
			description: "",
			startDate: new Date(),
		});

	const [selectedTechIds, setSelectedTechIds] = useState<string[]>([]);
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [timeConstraintsState, setTimeConstraintsState] =
		useState<TimeConstraintsState | null>(null);

	// minItems: 0 — allow all items to be deleted, including recurring plan template items.
	// Dispatchers and techs should be able to freely add, edit, and remove visit line items.
	const lineItems = useLineItems({ minItems: 0, mode: "edit" });

	const { data: job } = useJobByIdQuery(jobId);
	const clientTaxGroupId = job?.client?.tax_group_id ?? null;

	const { data: inventoryItems = [] } = useAllInventoryQuery();
	// Destinations a `receive` can land on. Active only: retired vans are not
	// somewhere stock can arrive.
	const { data: vehicles = [] } = useVehiclesQuery("active");

	const { data: taxGroups = [] } = useTaxGroups();
	const autoModeLoaded = useAutoTaxMode();
	const autoMode = autoModeLoaded === true;
	const keptEstimate = docKeptEstimate(visit.tax_snapshot, jobKeptSource(job), autoModeLoaded);
	const keptRateLabel = keptEstimate ? keptRateOptionLabel(keptEstimate) : null;

	const lineItemsForCalc = useLineItemsForCalc(lineItems.activeLineItems, clientTaxGroupId);

	const { groupsSummary, totalTax, resolvedTotal } = useFinancialCalculations(
		lineItems.subtotal,
		{
			taxGroups,
			lineItemsForCalc,
			clientExempt,
			initialDiscountType: visit.discount_type || "amount",
			initialDiscountValue: visit.discount_value ? Number(visit.discount_value) : 0,
			rounding: roundingFor(visit.tax_snapshot),
		},
	);

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({ totalSteps: 4 as Step, initialStep: 1 as Step });

	const validateStep1 = useCallback((): boolean => {
		return !!(getValue("name").trim() && getValue("startDate"));
	}, [getValue]);

	const validateStep2 = useCallback((): boolean => {
		if (!timeConstraintsState) return true;
		const arrivalOk =
			timeConstraintsState.arrivalConstraint === "anytime" ||
			(timeConstraintsState.arrivalConstraint === "at" &&
				!!timeConstraintsState.arrivalTime) ||
			(timeConstraintsState.arrivalConstraint === "between" &&
				!!timeConstraintsState.arrivalWindowStart &&
				!!timeConstraintsState.arrivalWindowEnd) ||
			(timeConstraintsState.arrivalConstraint === "by" &&
				!!timeConstraintsState.arrivalWindowEnd);
		const finishOk =
			timeConstraintsState.finishConstraint === "when_done" ||
			((timeConstraintsState.finishConstraint === "at" ||
				timeConstraintsState.finishConstraint === "by") &&
				!!timeConstraintsState.finishTime);
		const windowOrderOk =
			timeConstraintsState.arrivalConstraint !== "between" ||
			!timeConstraintsState.arrivalWindowStart ||
			!timeConstraintsState.arrivalWindowEnd ||
			timeConstraintsState.arrivalWindowEnd.getTime() >
				timeConstraintsState.arrivalWindowStart.getTime();
		return arrivalOk && finishOk && windowOrderOk;
	}, [timeConstraintsState]);

	const validateStep3 = useCallback((): boolean => {
		const namedItems = lineItems.activeLineItems.filter((li) => li.name.trim() !== "");
		if (namedItems.length === 0) return true;
		return namedItems.every(
			(li) => Number(li.quantity) > 0 && Number(li.unit_price) >= 0
		);
	}, [lineItems.activeLineItems]);

	const validateStep = useCallback(
		(step: Step): boolean => {
			switch (step) {
				case 1:
					return validateStep1();
				case 2:
					return validateStep2();
				case 3:
					return validateStep3();
				case 4:
					return true;
				default:
					return true;
			}
		},
		[validateStep1, validateStep2, validateStep3]
	);

	const canGoNext = useMemo(() => validateStep(currentStep), [validateStep, currentStep]);

	const canGoToStep = useCallback(
		(targetStep: Step): boolean => {
			if (targetStep === 1) return true;
			for (let step = 1; step < targetStep; step++) {
				if (!validateStep(step as Step)) return false;
			}
			return true;
		},
		[validateStep]
	);

	const { setLineItems, resetLineItems } = lineItems;

	useEffect(() => {
		if (isModalOpen && visit) {
			resetWizard();

			const visitStart = new Date(visit.scheduled_start_at);
			const base = new Date(visitStart);
			const fallbackStart = new Date(base);
			fallbackStart.setHours(9, 0, 0, 0);
			const fallbackEnd = new Date(base);
			fallbackEnd.setHours(17, 0, 0, 0);

			setOriginals({
				name: visit.name ?? "",
				description: visit.description ?? "",
				startDate: new Date(visit.scheduled_start_at),
			});

			// Seed existing items. If none exist, start with an empty list —
			// minItems: 0 means no forced blank row. Dispatchers/techs add items as needed.
			const initialLineItems: EditableLineItem[] = visit.line_items?.length
				? visit.line_items.map((item) => ({
						// Server id, so the tax snapshot's per-line reasons key straight onto the line.
						id: item.id ?? crypto.randomUUID(),
						entity_line_item_id: item.id,
						name: item.name,
						description: item.description || "",
						quantity: Number(item.quantity),
						unit_price: Number(item.unit_price),
						item_type: (item.item_type || "") as
							| LineItemType
							| "",
						total: Number(item.total),
						taxable: item.taxable ?? true,
						tax_group_id: item.tax_group_id ?? null,
						inventory_item_id: item.inventory_item_id ?? null,
						disposition: item.disposition ?? null,
						disposition_vehicle_id: item.disposition_vehicle_id ?? null,
						isNew: false,
						isDeleted: false,
					}))
				: [];

			// Ids are stable server ids, so clear the previous load's dirty flags first;
			// setLineItems below rebuilds the originals the reset empties.
			resetLineItems();
			setLineItems(initialLineItems);

			setTimeConstraintsState({
				arrivalConstraint: visit.arrival_constraint || "anytime",
				finishConstraint: visit.finish_constraint || "when_done",
				arrivalTime:
					parseHHMMToDate(visit.arrival_time, base) ?? fallbackStart,
				arrivalWindowStart:
					parseHHMMToDate(visit.arrival_window_start, base) ??
					fallbackStart,
				arrivalWindowEnd:
					parseHHMMToDate(visit.arrival_window_end, base) ??
					fallbackEnd,
				finishTime: parseHHMMToDate(visit.finish_time, base) ?? fallbackEnd,
			});

			setSelectedTechIds(visit.visit_techs.map((vt) => vt.tech_id));
			setErrors(null);
		}
	}, [isModalOpen, visit, resetWizard, setOriginals, resetLineItems, setLineItems]);

	const handleTechSelection = useCallback((techId: string) => {
		setSelectedTechIds((prev) =>
			prev.includes(techId)
				? prev.filter((id) => id !== techId)
				: [...prev, techId]
		);
	}, []);

	const handleNext = useCallback(() => {
		if (canGoNext) goNext();
	}, [canGoNext, goNext]);

	const handleGoToStep = useCallback(
		(step: Step) => {
			if (canGoToStep(step)) goToStep(step);
		},
		[canGoToStep, goToStep]
	);

	const buildScheduledDates = useCallback(() => {
		const combinedStartDate = new Date(getValue("startDate"));
		let combinedEndDate = new Date(getValue("startDate"));

		if (
			timeConstraintsState?.arrivalConstraint === "at" &&
			timeConstraintsState.arrivalTime
		) {
			combinedStartDate.setHours(
				timeConstraintsState.arrivalTime.getHours(),
				timeConstraintsState.arrivalTime.getMinutes(),
				0,
				0
			);
		} else if (
			timeConstraintsState?.arrivalConstraint === "between" &&
			timeConstraintsState.arrivalWindowStart
		) {
			combinedStartDate.setHours(
				timeConstraintsState.arrivalWindowStart.getHours(),
				timeConstraintsState.arrivalWindowStart.getMinutes(),
				0,
				0
			);
		} else if (
			timeConstraintsState?.arrivalConstraint === "by" &&
			timeConstraintsState.arrivalWindowEnd
		) {
			const deadlineMinutes =
				timeConstraintsState.arrivalWindowEnd.getHours() * 60 +
				timeConstraintsState.arrivalWindowEnd.getMinutes();
			const startMinutes = Math.max(0, deadlineMinutes - 240);
			combinedStartDate.setHours(
				Math.floor(startMinutes / 60),
				startMinutes % 60,
				0,
				0
			);
		} else {
			combinedStartDate.setHours(9, 0, 0, 0);
		}

		if (
			(timeConstraintsState?.finishConstraint === "at" ||
				timeConstraintsState?.finishConstraint === "by") &&
			timeConstraintsState.finishTime
		) {
			combinedEndDate.setHours(
				timeConstraintsState.finishTime.getHours(),
				timeConstraintsState.finishTime.getMinutes(),
				0,
				0
			);
		} else {
			combinedEndDate = new Date(
				combinedStartDate.getTime() + 2 * 60 * 60 * 1000
			);
		}

		return { combinedStartDate, combinedEndDate };
	}, [getValue, timeConstraintsState]);

	const invokeSave = useCallback(async () => {
		if (isLoading) return;

		const { combinedStartDate, combinedEndDate } = buildScheduledDates();

		const preparedLineItems = lineItems.activeLineItems
			.filter((li) => li.name.trim() !== "")
			.map((item, index) => ({
				// Pass entity_line_item_id as id so the backend can match existing items
				id: (item as EditableLineItem).entity_line_item_id,
				name: item.name.trim(),
				description: item.description || undefined,
				quantity: Number(item.quantity),
				unit_price: Number(item.unit_price),
				item_type: (item.item_type || undefined) as
					| LineItemType
					| undefined,
				sort_order: index,
				total: item.total,
				inventory_item_id: item.inventory_item_id ?? undefined,
				disposition: item.disposition ?? null,
				disposition_vehicle_id: item.disposition_vehicle_id ?? null,
				...lineTaxPayload(item),
			}));

		const candidate: CreateJobVisitInput = {
			job_id: visit.job_id,
			name: getValue("name").trim(),
			description: getValue("description").trim() || undefined,
			scheduled_start_at: combinedStartDate.toISOString(),
			scheduled_end_at: combinedEndDate.toISOString(),
			arrival_constraint: timeConstraintsState?.arrivalConstraint || "anytime",
			finish_constraint: timeConstraintsState?.finishConstraint || "when_done",
			arrival_time:
				timeConstraintsState?.arrivalConstraint === "at"
					? formatTimeString(timeConstraintsState.arrivalTime)
					: null,
			arrival_window_start:
				timeConstraintsState?.arrivalConstraint === "between"
					? formatTimeString(timeConstraintsState.arrivalWindowStart)
					: null,
			arrival_window_end:
				timeConstraintsState?.arrivalConstraint === "between" ||
				timeConstraintsState?.arrivalConstraint === "by"
					? formatTimeString(timeConstraintsState.arrivalWindowEnd)
					: null,
			finish_time:
				timeConstraintsState?.finishConstraint === "at" ||
				timeConstraintsState?.finishConstraint === "by"
					? formatTimeString(timeConstraintsState.finishTime)
					: null,
			status: visit.status,
			tech_ids: selectedTechIds,
			line_items: preparedLineItems.length ? preparedLineItems : undefined,
		};

		const parsed = CreateJobVisitSchema.safeParse(candidate);
		if (!parsed.success) {
			setErrors(parsed.error);
			console.error("Validation errors:", parsed.error);
			const errorStep = routeErrorToStep(parsed.error);
			if (errorStep) goToStep(errorStep);
			return;
		}

		setErrors(null);

		const updates: UpdateJobVisitInput = {
			name:
				getValue("name").trim() !== (visit.name || "")
					? getValue("name").trim()
					: undefined,
			description:
				getValue("description").trim() !== (visit.description || "")
					? getValue("description").trim()
					: undefined,
			scheduled_start_at: combinedStartDate.toISOString(),
			scheduled_end_at: combinedEndDate.toISOString(),
			arrival_constraint: timeConstraintsState?.arrivalConstraint || "anytime",
			finish_constraint: timeConstraintsState?.finishConstraint || "when_done",
			arrival_time:
				timeConstraintsState?.arrivalConstraint === "at"
					? formatTimeString(timeConstraintsState.arrivalTime)
					: null,
			arrival_window_start:
				timeConstraintsState?.arrivalConstraint === "between"
					? formatTimeString(timeConstraintsState.arrivalWindowStart)
					: null,
			arrival_window_end:
				timeConstraintsState?.arrivalConstraint === "between" ||
				timeConstraintsState?.arrivalConstraint === "by"
					? formatTimeString(timeConstraintsState.arrivalWindowEnd)
					: null,
			finish_time:
				timeConstraintsState?.finishConstraint === "at" ||
				timeConstraintsState?.finishConstraint === "by"
					? formatTimeString(timeConstraintsState.finishTime)
					: null,
			// Send full line_items array — backend does a full replace
			line_items: preparedLineItems,
		};

		try {
			await updateVisit.mutateAsync({ id: visit.id, data: updates });

			const originalTechIds = [
				...visit.visit_techs.map((vt) => vt.tech_id),
			].sort();
			const nextTechIds = [...selectedTechIds].sort();
			if (JSON.stringify(originalTechIds) !== JSON.stringify(nextTechIds)) {
				await assignTechs.mutateAsync({
					visitId: visit.id,
					techIds: selectedTechIds,
				});
			}

			setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to update visit:", error);
		}
	}, [
		isLoading,
		buildScheduledDates,
		lineItems.activeLineItems,
		getValue,
		timeConstraintsState,
		visit,
		selectedTechIds,
		updateVisit,
		assignTechs,
		setIsModalOpen,
		goToStep,
	]);

	const ErrorDisplay = useCallback(
		({ path }: { path: string }) => {
			if (!errors) return null;
			const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
			if (fieldErrors.length === 0) return null;
			return (
				<div className="mt-0.5">
					{fieldErrors.map((err, idx) => (
						<p
							key={idx}
							className="text-error-text text-xs leading-tight"
						>
							{err.message}
						</p>
					))}
				</div>
			);
		},
		[errors]
	);

	const stepContent = useMemo(() => {
		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Visit Name *
							</label>
							<div className="relative">
								<input
									type="text"
									value={getValue("name")}
									onChange={(e) =>
										updateField(
											"name",
											e.target
												.value
										)
									}
									disabled={isLoading}
									className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
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

						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Description (Optional)
							</label>
							<div className="relative">
								<textarea
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
									disabled={isLoading}
									className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors pr-10 min-w-0"
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

						<div
							className="relative min-w-0"
							style={{ zIndex: 50 }}
						>
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Visit Date *
							</label>
							<DatePicker
								portal
								mode="edit"
								originalValue={
									fields.startDate
										.originalValue
								}
								value={getValue("startDate")}
								position="above"
								required={true}
								disabled={isLoading}
								onChange={(d) =>
									updateField(
										"startDate",
										d ||
											fields
												.startDate
												.originalValue
									)
								}
							/>
						</div>
					</div>
				);

			case 2:
				return (
					<div className="space-y-2 lg:space-y-3 min-w-0">
						<TimeConstraints
							mode="edit"
							initialArrivalConstraint={
								timeConstraintsState?.arrivalConstraint
							}
							initialFinishConstraint={
								timeConstraintsState?.finishConstraint
							}
							initialArrivalTime={
								timeConstraintsState?.arrivalTime ||
								null
							}
							initialArrivalWindowStart={
								timeConstraintsState?.arrivalWindowStart ||
								null
							}
							initialArrivalWindowEnd={
								timeConstraintsState?.arrivalWindowEnd ||
								null
							}
							initialFinishTime={
								timeConstraintsState?.finishTime ||
								null
							}
							onStateChange={setTimeConstraintsState}
							isLoading={isLoading}
						/>
						<ErrorDisplay path="arrival_constraint" />
						<ErrorDisplay path="arrival_time" />
						<ErrorDisplay path="arrival_window_start" />
						<ErrorDisplay path="arrival_window_end" />
						<ErrorDisplay path="finish_constraint" />
						<ErrorDisplay path="finish_time" />
					</div>
				);

			case 3:
				return (
					<div className="min-w-0 flex flex-col gap-3">
						<ErrorDisplay path="line_items" />
						<LineItemsSection
							inventoryItems={inventoryItems}
							onLinkInventory={lineItems.setLineItemInventoryItem}
							showDisposition
							vehicles={vehicles}
							onDispositionChange={lineItems.setLineItemDisposition}
							lineItems={lineItems.activeLineItems}
							isLoading={isLoading}
							onAdd={lineItems.addLineItem}
							onRemove={lineItems.removeLineItem}
							onUpdate={lineItems.updateLineItem}
							subtotal={lineItems.subtotal}
							required={false}
							minItems={0}
							dirtyFields={lineItems.dirtyLineItemFields}
							onUndo={lineItems.undoLineItemField}
							onClear={lineItems.clearLineItemField}
							taxGroups={taxGroups}
							clientExempt={clientExempt}
							onTaxChange={lineItems.setLineItemTaxGroup}
							autoMode={autoMode}
							keptRateLabel={keptRateLabel}
							onTaxGroupBulkSet={lineItems.setAllLineItemsTaxGroup}
						/>

						{lineItems.activeLineItems.some((li) => !("isDeleted" in li && li.isDeleted)) && (
							<div className="p-3 bg-surface rounded-lg border border-border text-sm space-y-1.5">
								<div className="flex justify-between text-text-tertiary">
									<span>Subtotal</span>
									<span className="tabular-nums">${lineItems.subtotal.toFixed(2)}</span>
								</div>

								{groupsSummary.map((gs) => (
									<div key={gs.group.id} className="flex justify-between text-text-tertiary">
										<span>
											{gs.group.name}{" "}
											<span className="text-text-muted text-xs">
												({(gs.group.combined_rate * 100).toFixed(2)}%)
											</span>
										</span>
										<span className="tabular-nums">${gs.tax_amount.toFixed(2)}</span>
									</div>
								))}

								{totalTax > 0 && groupsSummary.length === 0 && (
									<div className="flex justify-between text-text-tertiary">
										<span>Tax</span>
										<span className="tabular-nums">${totalTax.toFixed(2)}</span>
									</div>
								)}

								<div className="flex justify-between font-semibold text-text-primary border-t border-border pt-1.5">
									<span>Total</span>
									<span className="tabular-nums">${resolvedTotal.toFixed(2)}</span>
								</div>
							</div>
						)}
					</div>
				);

			case 4:
				return (
					<div className="space-y-2 lg:space-y-3 min-w-0">
						<div className="p-3 lg:p-4 bg-surface rounded-lg border border-border">
							<h3 className="text-base lg:text-lg font-semibold mb-3 lg:mb-4 text-text-primary">
								Assign Technicians
							</h3>
							<div className="border border-border rounded-md p-3 max-h-56 overflow-y-auto bg-base">
								{technicians?.length ? (
									<div className="space-y-1 lg:space-y-2">
										{technicians.map(
											(tech) => (
												<label
													key={
														tech.id
													}
													className="flex items-center gap-2 cursor-pointer hover:bg-surface p-2 rounded transition-colors"
												>
													<input
														type="checkbox"
														checked={selectedTechIds.includes(
															tech.id
														)}
														onChange={() =>
															handleTechSelection(
																tech.id
															)
														}
														disabled={
															isLoading
														}
														className="w-4 h-4 accent-primary-hover"
													/>
													<span className="text-text-primary text-sm lg:text-base flex-1">
														{
															tech.name
														}{" "}
														-{" "}
														{
															tech.title
														}
													</span>
													<span
														className={`text-xs px-2 py-0.5 rounded ${
															tech.status === "Available"
																? "bg-success/20 text-success-text"
																: "bg-neutral/20 text-text-tertiary"
														}`}
													>
														{
															tech.status
														}
													</span>
												</label>
											)
										)}
									</div>
								) : (
									<p className="text-text-tertiary text-sm">
										No technicians
										available
									</p>
								)}
							</div>
							{selectedTechIds.length > 0 && (
								<p className="text-xs lg:text-sm text-text-tertiary mt-2">
									{selectedTechIds.length}{" "}
									technician
									{selectedTechIds.length > 1
										? "s"
										: ""}{" "}
									selected
								</p>
							)}
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
		fields,
		timeConstraintsState,
		lineItems,
		technicians,
		selectedTechIds,
		handleTechSelection,
		ErrorDisplay,
		taxGroups,
		clientExempt,
		lineItemsForCalc,
		groupsSummary,
		totalTax,
		resolvedTotal,
	]);

	return (
		<FormWizardContainer
			title="Edit Job Visit"
			steps={STEPS}
			currentStep={currentStep}
			visitedSteps={visitedSteps}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			canGoToStep={canGoToStep}
			onStepClick={handleGoToStep}
			onNext={handleNext}
			onBack={goBack}
			onSubmit={invokeSave}
			canGoNext={canGoNext}
			submitLabel="Save Changes"
			isEditMode={true}
		>
			{stepContent}
		</FormWizardContainer>
	);
}
