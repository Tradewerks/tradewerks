import { useState, useEffect, useMemo, useCallback } from "react";
import type { ZodError } from "zod";
import {
	UpdateRecurringPlanSchema,
	type UpdateRecurringPlanInput,
	type RecurringFrequency,
	type Weekday,
	type RecurringPlan,
	type ArrivalConstraint,
	type FinishConstraint,
} from "../../types/recurringPlans";
import {
	type LineItemType,
	PriorityValues,
	type Priority,
} from "../../types/common";
import { useAllClientsQuery } from "../../hooks/useClients";
import { useUpdateRecurringPlanMutation } from "../../hooks/useRecurringPlans";
import { normalizeCoords, type GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";

import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import { useVehiclesQuery } from "../../hooks/useVehicles";
import TimeConstraints, { type TimeConstraintsState } from "../ui/forms/TimeConstraints";
import {
	BillingConfiguration,
	type BillingConfigState,
	defaultBillingConfigState,
} from "../ui/forms/BillingConfiguration";
import { ScheduleConfiguration } from "../ui/forms/ScheduleConfiguration";
import { UndoButton, UndoButtonTop } from "../ui/forms/UndoButton";

import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useDirtyTracking } from "../../hooks/forms/useDirtyTracking";

type Step = 1 | 2 | 3 | 4 | 5;

const STEPS = [
	{ id: 1 as Step, label: "Basics" },
	{ id: 2 as Step, label: "Schedule" },
	{ id: 3 as Step, label: "Constraints" },
	{ id: 4 as Step, label: "Line Items" },
	{ id: 5 as Step, label: "Finalize" },
];

interface EditRecurringPlanProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	plan: RecurringPlan;
}

const PRIORITY_ENTRIES = (
	<>
		{PriorityValues.map((v) => (
			<option key={v} value={v}>
				{v.charAt(0).toUpperCase() + v.slice(1)}
			</option>
		))}
	</>
);

const parseHHMMToDate = (hhmm: string | null | undefined): Date | null => {
	if (!hhmm) return null;
	const [h, m] = hhmm.split(":").map(Number);
	if (Number.isNaN(h) || Number.isNaN(m)) return null;
	const d = new Date();
	d.setHours(h, m, 0, 0);
	return d;
};

const toNumberOrEmpty = (val: number | null | undefined): number | "" => {
	if (val === null || val === undefined) return "";
	return val;
};

const EditRecurringPlan = ({ isModalOpen, setIsModalOpen, plan }: EditRecurringPlanProps) => {
	const updateMutation = useUpdateRecurringPlanMutation();
	const { data: clients } = useAllClientsQuery();

	const isLoading = updateMutation.isPending;

	type FormFields = {
		name: string;
		description: string;
		priority: Priority;
		startDate: Date;
		endDate: Date | null;
		generationWindow: number;
		minAdvance: number;
		frequency: RecurringFrequency;
		interval: number;
		selectedWeekdays: Weekday[];
		monthDay: number | "";
		month: number | "";
		billingConfig: BillingConfigState;
	};

	const { fields, updateField, undoField, setOriginals, isDirty, getValue } =
		useDirtyTracking<FormFields>({
			name: "",
			description: "",
			priority: "Medium",
			startDate: new Date(),
			endDate: null,
			generationWindow: 30,
			minAdvance: 1,
			frequency: "daily",
			interval: 1,
			selectedWeekdays: [],
			monthDay: "",
			month: "",
			billingConfig: defaultBillingConfigState,
		});

	const [clientId, setClientId] = useState("");
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [timezone] = useState<string>("America/Chicago");
	const [timeConstraintsState, setTimeConstraintsState] =
		useState<TimeConstraintsState | null>(null);

	const {
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		subtotal,
		setLineItems,
		dirtyLineItemFields,
		undoLineItemField,
		setLineItemInventoryItem,
		setLineItemDisposition,
		clearLineItemField,
	} = useLineItems({ minItems: 0, mode: "edit" });

	const { data: inventoryItems = [] } = useAllInventoryQuery();
	const { data: vehicles = [] } = useVehiclesQuery("active");
	const validateStep1 = useCallback((): boolean => {
		return !!(
			getValue("name").trim() &&
			clientId.trim() &&
			getValue("description").trim() &&
			geoData?.address &&
			getValue("priority")
		);
	}, [getValue, clientId, geoData]);

	const validateStep2 = useCallback((): boolean => {
		const frequency = getValue("frequency");
		const selectedWeekdays = getValue("selectedWeekdays");
		const monthDay = getValue("monthDay");
		const month = getValue("month");
		if (frequency === "weekly" && selectedWeekdays.length === 0) return false;
		if (frequency === "monthly" && monthDay === "") return false;
		if (frequency === "yearly" && (month === "" || monthDay === "")) return false;
		return getValue("generationWindow") > 0 && getValue("minAdvance") >= 0;
	}, [getValue]);

	const validateStep3 = useCallback((): boolean => {
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

	const validateStep4 = useCallback((): boolean => {
		const meaningfulItems = activeLineItems.filter((item) => {
			const hasAnyText =
				item.name.trim() !== "" || (item.description?.trim() ?? "") !== "";
			const hasAnyNumbers = Number(item.unit_price) > 0;
			const hasType = (item.item_type?.trim?.() ?? "") !== "";
			return hasAnyText || hasAnyNumbers || hasType;
		});
		if (meaningfulItems.length === 0) return true;
		return meaningfulItems.every(
			(item) =>
				item.name.trim() &&
				Number(item.quantity) > 0 &&
				Number(item.unit_price) >= 0
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
					return validateStep3();
				case 4:
					return validateStep4();
				case 5:
					return true;
				default:
					return true;
			}
		},
		[validateStep1, validateStep2, validateStep3, validateStep4]
	);

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({ totalSteps: 5 as Step, initialStep: 1 as Step });

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

	const isDirtyString = useCallback(
		(field: string): boolean => isDirty(field as keyof FormFields),
		[isDirty]
	);

	const undoFieldString = useCallback(
		(field: string): void => undoField(field as keyof FormFields),
		[undoField]
	);

	useEffect(() => {
		if (isModalOpen && plan) {
			resetWizard();

			const ruleData = plan.rules?.length
				? plan.rules[0]
				: {
						frequency: "daily" as RecurringFrequency,
						interval: 1,
						by_weekday: [],
						by_month_day: null,
						by_month: null,
					};

			setOriginals({
				name: plan.name ?? "",
				description: plan.description ?? "",
				priority: plan.priority as Priority,
				startDate: new Date(plan.starts_at),
				endDate: plan.ends_at ? new Date(plan.ends_at) : null,
				generationWindow: plan.generation_window_days || 30,
				minAdvance: plan.min_advance_days || 1,
				frequency: (ruleData.frequency as RecurringFrequency) || "daily",
				interval: ruleData.interval || 1,
				selectedWeekdays:
					(ruleData.by_weekday?.map(
						(wd) => wd.weekday
					) as Weekday[]) || [],
				monthDay: toNumberOrEmpty(ruleData.by_month_day),
				month: toNumberOrEmpty(ruleData.by_month),
				billingConfig: (() => {
					const sched = plan.invoice_schedule;
					return {
						...defaultBillingConfigState,
						billingBasis: plan.billing_mode === "none" ? "none" : ((sched?.billing_basis ?? "visit_actuals") as BillingConfigState["billingBasis"]),
						fixedAmount: sched?.fixed_amount != null ? String(sched.fixed_amount) : "",
						invoiceTrigger: plan.invoice_timing === "manual" ? "manual" : plan.invoice_timing === "on_schedule_date" ? "on_schedule" : "on_completion",
						scheduleFrequency: (sched?.frequency && sched.frequency !== "on_visit_completion" ? sched.frequency : "monthly") as BillingConfigState["scheduleFrequency"],
						dayOfMonth: sched?.day_of_month ?? 1,
						dayOfWeek: (sched?.day_of_week ?? "MO") as BillingConfigState["dayOfWeek"],
						generateDaysBefore: sched?.generate_days_before ?? 0,
						paymentTermsDays: sched?.payment_terms_days ?? 30,
						memoTemplate: sched?.memo_template ?? "",
					};
				})(),
			});

			setClientId(plan.client_id);
			const normalizedCoords = normalizeCoords(plan.coords);
			setGeoData(
				plan.address
					? ({ address: plan.address, coords: normalizedCoords } as GeocodeResult)
					: undefined
			);

			setLineItems(
				plan.line_items?.map((item) => ({
					id: crypto.randomUUID(),
					entity_line_item_id: item.id,
					name: item.name,
					description: item.description || "",
					quantity: Number(item.quantity),
					unit_price: Number(item.unit_price),
					item_type: (item.item_type || "") as LineItemType | "",
					total: Number(item.quantity) * Number(item.unit_price),
					inventory_item_id: item.inventory_item_id ?? null,
					disposition: item.disposition ?? null,
					disposition_vehicle_id: item.disposition_vehicle_id ?? null,
					isNew: false,
					isDeleted: false,
				})) || []
			);

			const rule = plan.rules?.[0];
			setTimeConstraintsState({
				arrivalConstraint: (rule?.arrival_constraint ||
					"anytime") as ArrivalConstraint,
				finishConstraint: (rule?.finish_constraint ||
					"when_done") as FinishConstraint,
				arrivalTime: parseHHMMToDate(rule?.arrival_time),
				arrivalWindowStart: parseHHMMToDate(rule?.arrival_window_start),
				arrivalWindowEnd: parseHHMMToDate(rule?.arrival_window_end),
				finishTime: parseHHMMToDate(rule?.finish_time),
			});

			setErrors(null);
		}
	}, [isModalOpen, plan, resetWizard, setLineItems, setOriginals]);

	const handleChangeAddress = (result: GeocodeResult) =>
		setGeoData({ address: result.address, coords: result.coords });

	const handleClearAddress = () => setGeoData(undefined);

	const toggleWeekday = useCallback(
		(weekday: Weekday) => {
			const current = getValue("selectedWeekdays");
			updateField(
				"selectedWeekdays",
				current.includes(weekday)
					? current.filter((d) => d !== weekday)
					: [...current, weekday]
			);
		},
		[getValue, updateField]
	);

	const formatTimeString = (date: Date | null): string | null => {
		if (!date) return null;
		return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
	};

	const invokeUpdate = async () => {
		if (isLoading) return;

		const preparedLineItems = activeLineItems
			.filter((item) => item.name.trim() !== "" && item.quantity > 0)
			.map((item, index) => ({
				name: item.name,
				description: item.description || undefined,
				quantity: Number(item.quantity),
				unit_price: Number(item.unit_price),
				item_type: (item.item_type || undefined) as
					| LineItemType
					| undefined,
				sort_order: index,
				// Update replaces the template wholesale; omitting these NULLs
				// out what the plan already had.
				inventory_item_id: item.inventory_item_id ?? null,
				disposition: item.disposition ?? null,
				disposition_vehicle_id: item.disposition_vehicle_id ?? null,
			}));

		const preparedRule = {
			frequency: getValue("frequency"),
			interval: Number(getValue("interval")),
			by_weekday:
				getValue("selectedWeekdays").length > 0
					? getValue("selectedWeekdays")
					: undefined,
			by_month_day:
				getValue("monthDay") !== ""
					? Number(getValue("monthDay"))
					: undefined,
			by_month: getValue("month") !== "" ? Number(getValue("month")) : undefined,
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
		};

		const updatedPlan: UpdateRecurringPlanInput = {
			name: getValue("name").trim(),
			address: geoData?.address || "",
			coords: geoData?.coords,
			description: getValue("description").trim(),
			priority: getValue("priority"),
			starts_at: getValue("startDate").toISOString(),
			ends_at: getValue("endDate")
				? getValue("endDate")!.toISOString()
				: undefined,
			timezone,
			generation_window_days: Number(getValue("generationWindow")),
			min_advance_days: Number(getValue("minAdvance")),
			billing_mode: getValue("billingConfig").billingBasis === "none" ? "none" : getValue("billingConfig").billingBasis === "fixed_amount" ? "subscription" : "per_visit",
			invoice_timing: getValue("billingConfig").invoiceTrigger === "on_completion" ? "on_completion" : getValue("billingConfig").invoiceTrigger === "on_schedule" ? "on_schedule_date" : "manual",
			auto_invoice: getValue("billingConfig").invoiceTrigger !== "manual" && getValue("billingConfig").billingBasis !== "none",
			invoice_schedule: getValue("billingConfig").billingBasis !== "none" ? {
				billing_basis: getValue("billingConfig").billingBasis as "visit_actuals" | "fixed_amount",
				fixed_amount: getValue("billingConfig").billingBasis === "fixed_amount" ? Number(getValue("billingConfig").fixedAmount) || 0 : undefined,
				frequency: getValue("billingConfig").invoiceTrigger === "on_schedule" ? getValue("billingConfig").scheduleFrequency : "on_visit_completion",
				day_of_month: ["monthly", "quarterly"].includes(getValue("billingConfig").scheduleFrequency) && getValue("billingConfig").invoiceTrigger === "on_schedule" ? getValue("billingConfig").dayOfMonth : undefined,
				day_of_week: ["weekly", "biweekly"].includes(getValue("billingConfig").scheduleFrequency) && getValue("billingConfig").invoiceTrigger === "on_schedule" ? getValue("billingConfig").dayOfWeek : undefined,
				generate_days_before: getValue("billingConfig").generateDaysBefore,
				payment_terms_days: getValue("billingConfig").paymentTermsDays,
				auto_send: false,
				memo_template: getValue("billingConfig").memoTemplate || undefined,
			} : undefined,
			rule: preparedRule,
			line_items: preparedLineItems,
		};

		const parseResult = UpdateRecurringPlanSchema.safeParse(updatedPlan);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			console.error("Validation errors:", parseResult.error);
			const errorPaths = parseResult.error.issues.map((i) => i.path[0]);
			if (
				errorPaths.some((p) =>
					[
						"name",
						"client_id",
						"description",
						"address",
						"coords",
						"priority",
					].includes(String(p))
				)
			)
				goToStep(1 as Step);
			else if (
				errorPaths.some((p) =>
					[
						"starts_at",
						"ends_at",
						"generation_window_days",
						"min_advance_days",
					].includes(String(p))
				) ||
				errorPaths.includes("rule")
			)
				goToStep(2 as Step);
			else if (
				errorPaths.some((p) =>
					[
						"arrival_constraint",
						"finish_constraint",
						"arrival_time",
						"arrival_window_start",
						"arrival_window_end",
						"finish_time",
					].includes(String(p))
				)
			)
				goToStep(3 as Step);
			else if (errorPaths.includes("line_items")) goToStep(4 as Step);
			else if (
				errorPaths.some((p) =>
					["billing_mode", "invoice_timing", "auto_invoice"].includes(
						String(p)
					)
				)
			)
				goToStep(5 as Step);
			return;
		}

		setErrors(null);
		try {
			await updateMutation.mutateAsync({
				jobId: plan.job_container?.id || plan.id,
				updates: updatedPlan,
			});
			setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to update recurring plan:", error);
		}
	};

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
						{/* Name */}
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Plan Name *
							</label>
							<div className="relative min-w-0">
								<input
									type="text"
									placeholder="Plan Name"
									value={getValue("name")}
									onChange={(e) =>
										updateField(
											"name",
											e.target
												.value
										)
									}
									className="border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary placeholder:text-faint text-sm lg:text-base focus:border-primary focus:outline-none transition-colors pr-8 min-w-0"
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

						{/* Client + Priority */}
						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
									Client
								</label>
								<div className="border border-border px-2.5 h-[34px] w-full rounded bg-surface/50 text-text-tertiary text-sm flex items-center min-w-0 truncate">
									{plan.client?.name ||
										clients?.find(
											(c) =>
												c.id ===
												clientId
										)?.name ||
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
								<div className="relative min-w-0">
									<Dropdown
										entries={
											PRIORITY_ENTRIES
										}
										value={getValue(
											"priority"
										)}
										onChange={(v) =>
											updateField(
												"priority",
												v as Priority
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
							<div className="relative min-w-0">
								<textarea
									placeholder="Plan Description"
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
									className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary placeholder:text-faint text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors pr-8 min-w-0"
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
					<ScheduleConfiguration
						mode="edit"
						startDate={getValue("startDate")}
						endDate={getValue("endDate")}
						generationWindow={getValue("generationWindow")}
						minAdvance={getValue("minAdvance")}
						frequency={getValue("frequency")}
						interval={getValue("interval")}
						selectedWeekdays={getValue("selectedWeekdays")}
						monthDay={getValue("monthDay")}
						month={getValue("month")}
						originalStartDate={fields.startDate.originalValue}
						originalEndDate={fields.endDate.originalValue}
						onStartDateChange={(date) =>
							updateField("startDate", date || new Date())
						}
						onEndDateChange={(date) =>
							updateField("endDate", date)
						}
						onGenerationWindowChange={(val) =>
							updateField("generationWindow", val)
						}
						onMinAdvanceChange={(val) =>
							updateField("minAdvance", val)
						}
						onFrequencyChange={(val) =>
							updateField("frequency", val)
						}
						onIntervalChange={(val) =>
							updateField("interval", val)
						}
						onToggleWeekday={toggleWeekday}
						onMonthDayChange={(val) =>
							updateField("monthDay", val)
						}
						onMonthChange={(val) => updateField("month", val)}
						isDirty={isDirtyString}
						onUndo={undoFieldString}
						isLoading={isLoading}
						errors={errors}
					/>
				);

			case 3:
				return (
					<div className="space-y-2 lg:space-y-3 min-w-0 pt-2">
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
					</div>
				);

			case 4:
				return (
					<div className="min-w-0 flex flex-col">
						<ErrorDisplay path="line_items" />
						<LineItemsSection
							inventoryItems={inventoryItems}
							onLinkInventory={setLineItemInventoryItem}
							showDisposition
							vehicles={vehicles}
							onDispositionChange={setLineItemDisposition}
							lineItems={activeLineItems}
							isLoading={isLoading}
							onAdd={addLineItem}
							onRemove={removeLineItem}
							onUpdate={updateLineItem}
							subtotal={subtotal}
							required={false}
							minItems={0}
							dirtyFields={dirtyLineItemFields}
							onUndo={undoLineItemField}
							onClear={clearLineItemField}
						/>
					</div>
				);

			case 5:
				return (
					<div className="space-y-2 min-w-0">
						<BillingConfiguration
							state={getValue("billingConfig")}
							onChange={(updates) =>
								updateField("billingConfig", { ...getValue("billingConfig"), ...updates })
							}
							isLoading={isLoading}
							errors={errors}
						/>
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
		isDirtyString,
		undoFieldString,
		isLoading,
		errors,
		plan,
		clients,
		clientId,
		geoData,
		fields,
		toggleWeekday,
		timeConstraintsState,
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		subtotal,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		inventoryItems,
		setLineItemInventoryItem,
		vehicles,
		setLineItemDisposition,
		ErrorDisplay,
	]);

	return (
		<FormWizardContainer<Step>
			title="Edit Recurring Plan"
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

export default EditRecurringPlan;
