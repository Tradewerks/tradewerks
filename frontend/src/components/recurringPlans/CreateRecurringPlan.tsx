import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { ZodError } from "zod";
import {
	CreateRecurringPlanSchema,
	type CreateRecurringPlanInput,
	type InvoiceScheduleBillingBasis,
	type RecurringFrequency,
	type Weekday,
} from "../../types/recurringPlans";
import {
	type LineItemType,
	type BaseLineItem,
	type LineItemDisposition,
	PriorityValues,
	type Priority,
} from "../../types/common";
import { useAllClientsQuery } from "../../hooks/useClients";
import { useCreateRecurringPlanMutation } from "../../hooks/useRecurringPlans";
import {
	useDraftsByTypeQuery,
	useCreateDraftMutation,
	useUpdateDraftMutation,
	useDeleteDraftMutation,
} from "../../hooks/forms/useDrafts";
import { getDraft } from "../../api/drafts";
import type { DraftSummary } from "../../types/drafts";
import type { GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
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
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { useLineItems } from "../../hooks/forms/useLineItems";
import {
	TemplateSearch,
	type TemplateSearchResult,
	type TemplateSearchClient,
} from "../ui/forms/TemplateSearch";

type Step = 1 | 2 | 3 | 4 | 5;

const STEPS = [
	{ id: 1 as Step, label: "Basics" },
	{ id: 2 as Step, label: "Schedule" },
	{ id: 3 as Step, label: "Constraints" },
	{ id: 4 as Step, label: "Line Items" },
	{ id: 5 as Step, label: "Finalize" },
];

interface CreateRecurringPlanProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
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

const CreateRecurringPlan = ({ isModalOpen, setIsModalOpen }: CreateRecurringPlanProps) => {
	const navigate = useNavigate();

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [clientId, setClientId] = useState("");
	const [priority, setPriority] = useState<Priority>("Medium");
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);
	const [timezone] = useState<string>("America/Chicago");

	const [scheduleState, setScheduleState] = useState<{
		startDate: Date;
		endDate: Date | null;
		generationWindow: number;
		minAdvance: number;
		frequency: RecurringFrequency;
		interval: number;
		selectedWeekdays: Weekday[];
		monthDay: number | "";
		month: number | "";
	}>({
		startDate: new Date(),
		endDate: null,
		generationWindow: 30,
		minAdvance: 1,
		frequency: "daily",
		interval: 1,
		selectedWeekdays: [],
		monthDay: "",
		month: "",
	});

	const [timeConstraintsState, setTimeConstraintsState] =
		useState<TimeConstraintsState | null>(null);
	const [constraintSeed, setConstraintSeed] = useState<
		Partial<TimeConstraintsState> & { key: number }
	>({ key: 1 });
	const constraintResetKeyRef = useRef(1); // always incrementing — never reuse a value
	const [billingConfig, setBillingConfig] = useState<BillingConfigState>(defaultBillingConfigState);

	const [isDraftPanelOpen, setIsDraftPanelOpen] = useState(false);
	const [sourceClientFilter, setSourceClientFilter] = useState("");

	const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
	const [isDirty, setIsDirty] = useState(false);

	const { data: clients } = useAllClientsQuery();
	const createMutation = useCreateRecurringPlanMutation();
	const { data: drafts = [] } = useDraftsByTypeQuery("recurring_plan");
	const createDraftMutation = useCreateDraftMutation();
	const updateDraftMutation = useUpdateDraftMutation();
	const deleteDraftMutation = useDeleteDraftMutation();

	const markDirty = useCallback(() => setIsDirty(true), []);

	const {
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		subtotal,
		resetLineItems,
		dirtyLineItemFields,
		undoLineItemField,
		setLineItemInventoryItem,
		setLineItemDisposition,
		clearLineItemField,
		seedLineItems,
	} = useLineItems({ minItems: 0, mode: "create" });
	const { data: inventoryItems = [] } = useAllInventoryQuery();
	const { data: vehicles = [] } = useVehiclesQuery("active");
	// Draft-dirty wrapper, same as the other line-item mutators.
	const dirtySetLineItemDisposition = useCallback(
		(id: string, disposition: LineItemDisposition | null, vehicleId?: string | null) => {
			setLineItemDisposition(id, disposition, vehicleId);
			markDirty();
		},
		[setLineItemDisposition, markDirty]
	);
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
		(id: string, field: keyof BaseLineItem, value: string | number) => {
			updateLineItem(id, field, value);
			markDirty();
		},
		[updateLineItem, markDirty]
	);

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
	} = useStepWizard<Step>({ totalSteps: 5 as Step, initialStep: 1 as Step });

	const validateStep1 = useCallback(
		(): boolean =>
			!!(
				name.trim() &&
				clientId.trim() &&
				description.trim() &&
				geoData?.address &&
				priority
			),
		[name, clientId, description, geoData, priority]
	);

	const validateStep2 = useCallback((): boolean => {
		if (!scheduleState) return false;
		if (
			scheduleState.frequency === "weekly" &&
			scheduleState.selectedWeekdays.length === 0
		)
			return false;
		if (scheduleState.frequency === "monthly" && scheduleState.monthDay === "")
			return false;
		if (
			scheduleState.frequency === "yearly" &&
			(scheduleState.month === "" || scheduleState.monthDay === "")
		)
			return false;
		return scheduleState.generationWindow > 0 && scheduleState.minAdvance >= 0;
	}, [scheduleState]);

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
		const meaningful = activeLineItems.filter((item) => {
			const hasText =
				item.name.trim() !== "" || (item.description?.trim() ?? "") !== "";
			const hasNumbers = Number(item.unit_price) > 0;
			const hasType = (item.item_type?.trim?.() ?? "") !== "";
			return hasText || hasNumbers || hasType;
		});
		if (meaningful.length === 0) return true;
		return meaningful.every(
			(item) =>
				item.name.trim() &&
				Number(item.quantity) > 0 &&
				Number(item.unit_price) >= 0
		);
	}, [activeLineItems]);

	const isStepValid = useCallback(
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
				default:
					return true;
			}
		},
		[validateStep1, validateStep2, validateStep3, validateStep4]
	);

	const canGoNext = isStepValid(currentStep);

	const canGoToStep = useCallback(
		(step: Step): boolean => {
			if (step === currentStep) return true;
			if (visitedSteps.has(step)) return true;
			if (step === currentStep + 1 && isStepValid(currentStep)) return true;
			return false;
		},
		[currentStep, visitedSteps, isStepValid]
	);

	const resetForm = useCallback(() => {
		resetWizard();
		setName("");
		setDescription("");
		setClientId("");
		setPriority("Medium");
		setGeoData(undefined);
		setScheduleState({
			startDate: new Date(),
			endDate: null,
			generationWindow: 30,
			minAdvance: 1,
			frequency: "daily",
			interval: 1,
			selectedWeekdays: [],
			monthDay: "",
			month: "",
		});
		setTimeConstraintsState(null);
		constraintResetKeyRef.current += 1;
		setConstraintSeed({ key: constraintResetKeyRef.current }); // clear all initial* props → use defaults
		setBillingConfig(defaultBillingConfigState);
		resetLineItems();
		setErrors(null);
		setIsDraftPanelOpen(false);
		setSourceClientFilter("");
		setCurrentDraftId(null);
		setIsDirty(false);
	}, [resetWizard, resetLineItems]);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
		markDirty();
	};
	const handleClearAddress = () => setGeoData(undefined);

	const toggleWeekday = useCallback(
		(weekday: Weekday) => {
			setScheduleState((prev) => ({
				...prev,
				selectedWeekdays: prev.selectedWeekdays.includes(weekday)
					? prev.selectedWeekdays.filter((d) => d !== weekday)
					: [...prev.selectedWeekdays, weekday],
			}));
			markDirty();
		},
		[markDirty]
	);

	const formatTimeString = (date: Date | null): string | null => {
		if (!date) return null;
		return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
	};

	const handleSelectDraft = useCallback(
		async (draftId: string) => {
			try {
				const draft = await getDraft(draftId);
				const p = draft.payload as Partial<CreateRecurringPlanInput> & {
					billing_config?: BillingConfigState;
					schedule?: typeof scheduleState;
					line_items?: Array<{
						name: string;
						description?: string | null;
						quantity: number;
						unit_price: number;
						item_type?: string | null;
						inventory_item_id?: string | null;
						disposition?: LineItemDisposition | null;
						disposition_vehicle_id?: string | null;
					}>;
					time_constraints?: {
						arrivalConstraint: string;
						finishConstraint: string;
						arrivalTime?: string | null;
						arrivalWindowStart?: string | null;
						arrivalWindowEnd?: string | null;
						finishTime?: string | null;
					};
				};

				setName(p.name || "");
				setDescription(p.description || "");
				setClientId(p.client_id || "");
				setPriority((p.priority as Priority) || "Medium");
				if (p.address)
					setGeoData({
						address: p.address,
						coords: p.coords || { lat: 0, lon: 0 },
					});
				if (p.billing_config) setBillingConfig(p.billing_config as BillingConfigState);

				if (p.schedule) {
					setScheduleState({
						...p.schedule,
						startDate: new Date(p.schedule.startDate),
						endDate: p.schedule.endDate
							? new Date(p.schedule.endDate)
							: null,
					});
				}

				if (p.line_items?.length) {
					seedLineItems(
						p.line_items.map((li) => ({
							name: li.name,
							description: li.description ?? "",
							quantity: Number(li.quantity),
							unit_price: Number(li.unit_price),
							item_type: (li.item_type ?? "") as
								| LineItemType
								| "",
							inventory_item_id: li.inventory_item_id ?? null,
							disposition: li.disposition ?? null,
							disposition_vehicle_id:
								li.disposition_vehicle_id ?? null,
						}))
					);
				}

				if (p.time_constraints) {
					const tc = p.time_constraints;
					constraintResetKeyRef.current += 1;
					setConstraintSeed({
						key: constraintResetKeyRef.current,
						arrivalConstraint:
							tc.arrivalConstraint as TimeConstraintsState["arrivalConstraint"],
						finishConstraint:
							tc.finishConstraint as TimeConstraintsState["finishConstraint"],
						arrivalTime: tc.arrivalTime
							? new Date(tc.arrivalTime)
							: null,
						arrivalWindowStart: tc.arrivalWindowStart
							? new Date(tc.arrivalWindowStart)
							: null,
						arrivalWindowEnd: tc.arrivalWindowEnd
							? new Date(tc.arrivalWindowEnd)
							: null,
						finishTime: tc.finishTime
							? new Date(tc.finishTime)
							: null,
					});
				}

				setCurrentDraftId(draft.id);
				setIsDirty(false);
				setIsDraftPanelOpen(false);
				goToStep(1 as Step);
			} catch (err) {
				console.error("Failed to load draft:", err);
			}
		},
		[seedLineItems, goToStep]
	);

	const handleSaveDraft = useCallback(async () => {
		const payload: Record<string, unknown> = {
			name,
			description,
			client_id: clientId,
			priority,
			address: geoData?.address,
			coords: geoData?.coords,
			billing_config: billingConfig,
			schedule: scheduleState,
			line_items: activeLineItems.map((item) => ({
				name: item.name,
				description: item.description,
				quantity: item.quantity,
				unit_price: item.unit_price,
				item_type: item.item_type,
				total: item.total,
				inventory_item_id: item.inventory_item_id ?? null,
				disposition: item.disposition ?? null,
				disposition_vehicle_id: item.disposition_vehicle_id ?? null,
			})),
			time_constraints: timeConstraintsState
				? {
						arrivalConstraint:
							timeConstraintsState.arrivalConstraint,
						finishConstraint:
							timeConstraintsState.finishConstraint,
						arrivalTime:
							timeConstraintsState.arrivalTime?.toISOString() ??
							null,
						arrivalWindowStart:
							timeConstraintsState.arrivalWindowStart?.toISOString() ??
							null,
						arrivalWindowEnd:
							timeConstraintsState.arrivalWindowEnd?.toISOString() ??
							null,
						finishTime:
							timeConstraintsState.finishTime?.toISOString() ??
							null,
					}
				: undefined,
		};
		try {
			if (currentDraftId) {
				await updateDraftMutation.mutateAsync({
					id: currentDraftId,
					input: { payload },
				});
			} else {
				const draft = await createDraftMutation.mutateAsync({
					form_type: "recurring_plan",
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
		name,
		description,
		clientId,
		priority,
		geoData,
		billingConfig,
		scheduleState,
		activeLineItems,
		timeConstraintsState,
		currentDraftId,
		createDraftMutation,
		updateDraftMutation,
	]);

	const handleDeleteDraft = useCallback(
		async (draftId: string) => {
			try {
				await deleteDraftMutation.mutateAsync(draftId);
				if (draftId === currentDraftId) {
					setCurrentDraftId(null);
					setIsDirty(false);
				}
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

		const validLineItems = activeLineItems.filter(
			(item) => item.name.trim() !== "" && item.quantity > 0
		);
		const preparedLineItems = validLineItems.map((item, index) => ({
			name: item.name,
			description: item.description || undefined,
			quantity: Number(item.quantity),
			unit_price: Number(item.unit_price),
			item_type: (item.item_type || undefined) as LineItemType | undefined,
			sort_order: index,
			// Plan lines are the template a generated visit is stamped from —
			// dropping the link here would strand the picker's whole purpose.
			inventory_item_id: item.inventory_item_id ?? null,
			disposition: item.disposition ?? null,
			disposition_vehicle_id: item.disposition_vehicle_id ?? null,
		}));

		const preparedRule = {
			frequency: scheduleState.frequency,
			interval: Number(scheduleState.interval),
			by_weekday:
				scheduleState.selectedWeekdays.length > 0
					? scheduleState.selectedWeekdays
					: undefined,
			by_month_day:
				scheduleState.monthDay !== ""
					? Number(scheduleState.monthDay)
					: undefined,
			by_month:
				scheduleState.month !== ""
					? Number(scheduleState.month)
					: undefined,
			arrival_constraint: timeConstraintsState?.arrivalConstraint || "anytime",
			finish_constraint: timeConstraintsState?.finishConstraint || "when_done",
			arrival_time:
				timeConstraintsState?.arrivalConstraint === "at"
					? formatTimeString(timeConstraintsState?.arrivalTime)
					: null,
			arrival_window_start:
				timeConstraintsState?.arrivalConstraint === "between"
					? formatTimeString(timeConstraintsState?.arrivalWindowStart)
					: null,
			arrival_window_end:
				timeConstraintsState?.arrivalConstraint === "between" ||
				timeConstraintsState?.arrivalConstraint === "by"
					? formatTimeString(timeConstraintsState?.arrivalWindowEnd)
					: null,
			finish_time:
				timeConstraintsState?.finishConstraint === "at" ||
				timeConstraintsState?.finishConstraint === "by"
					? formatTimeString(timeConstraintsState?.finishTime)
					: null,
		};

		const newRecurringPlan: CreateRecurringPlanInput = {
			name: name.trim(),
			client_id: clientId.trim(),
			address: geoData?.address || "",
			coords: geoData?.coords,
			description: description.trim(),
			priority,
			starts_at: scheduleState.startDate.toISOString(),
			ends_at: scheduleState.endDate
				? scheduleState.endDate.toISOString()
				: undefined,
			timezone,
			generation_window_days: Number(scheduleState.generationWindow),
			min_advance_days: Number(scheduleState.minAdvance),
			billing_mode: billingConfig.billingBasis === "none" ? "none" : billingConfig.billingBasis === "fixed_amount" ? "subscription" : "per_visit",
			invoice_timing: billingConfig.invoiceTrigger === "on_completion" ? "on_completion" : billingConfig.invoiceTrigger === "on_schedule" ? "on_schedule_date" : "manual",
			auto_invoice: billingConfig.invoiceTrigger !== "manual" && billingConfig.billingBasis !== "none",
			invoice_schedule: billingConfig.billingBasis !== "none" ? {
				billing_basis: billingConfig.billingBasis as InvoiceScheduleBillingBasis,
				fixed_amount: billingConfig.billingBasis === "fixed_amount" ? Number(billingConfig.fixedAmount) || 0 : undefined,
				frequency: billingConfig.invoiceTrigger === "on_schedule" ? billingConfig.scheduleFrequency : "on_visit_completion",
				day_of_month: ["monthly", "quarterly"].includes(billingConfig.scheduleFrequency) && billingConfig.invoiceTrigger === "on_schedule" ? billingConfig.dayOfMonth : undefined,
				day_of_week: ["weekly", "biweekly"].includes(billingConfig.scheduleFrequency) && billingConfig.invoiceTrigger === "on_schedule" ? billingConfig.dayOfWeek : undefined,
				generate_days_before: billingConfig.generateDaysBefore,
				payment_terms_days: billingConfig.paymentTermsDays,
				memo_template: billingConfig.memoTemplate || undefined,
			auto_send: false,
			} : undefined,
			rule: preparedRule,
			line_items: preparedLineItems,
		};

		const parseResult = CreateRecurringPlanSchema.safeParse(newRecurringPlan);
		if (!parseResult.success) {
			setErrors(parseResult.error);
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
			) {
				goToStep(1 as Step);
			} else if (
				errorPaths.some((p) =>
					[
						"starts_at",
						"ends_at",
						"generation_window_days",
						"min_advance_days",
					].includes(String(p))
				) ||
				errorPaths.includes("rule")
			) {
				goToStep(2 as Step);
			} else if (
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
			) {
				goToStep(3 as Step);
			} else if (errorPaths.includes("line_items")) {
				goToStep(4 as Step);
			} else if (
				errorPaths.some((p) =>
					["billing_mode", "invoice_timing", "auto_invoice"].includes(
						String(p)
					)
				)
			) {
				goToStep(5 as Step);
			}
			return;
		}

		setErrors(null);
		setIsLoading(true);
		try {
			const result = await createMutation.mutateAsync(newRecurringPlan);
			if (currentDraftId) {
				await deleteDraftMutation
					.mutateAsync(currentDraftId)
					.catch(() => {});
			}
			const recurringPlanId = result?.id || result;
			setIsModalOpen(false);
			resetForm();
			navigate(`/dispatch/recurring-plans/${recurringPlanId}`);
		} catch (error) {
			console.error("Failed to create recurring plan:", error);
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
		if (isDraftPanelOpen) {
			return (
				<TemplateSearch
					heading="Use Draft"
					placeholder="Search drafts by name..."
					results={draftResults}
					clients={templateClients}
					onSelect={handleSelectDraft}
					onClose={() => setIsDraftPanelOpen(false)}
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

		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Plan Name *
							</label>
							<input
								type="text"
								placeholder="Plan Name"
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									markDirty();
								}}
								className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary placeholder:text-faint text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0"
								disabled={isLoading}
							/>
							<ErrorDisplay path="name" />
						</div>

						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
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
								<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
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
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Description *
							</label>
							<textarea
								placeholder="Plan Description"
								value={description}
								onChange={(e) => {
									setDescription(
										e.target.value
									);
									markDirty();
								}}
								className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary placeholder:text-faint text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
								disabled={isLoading}
							/>
							<ErrorDisplay path="description" />
						</div>

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
						mode="create"
						startDate={scheduleState.startDate}
						endDate={scheduleState.endDate}
						generationWindow={scheduleState.generationWindow}
						minAdvance={scheduleState.minAdvance}
						frequency={scheduleState.frequency}
						interval={scheduleState.interval}
						selectedWeekdays={scheduleState.selectedWeekdays}
						monthDay={scheduleState.monthDay}
						month={scheduleState.month}
						onStartDateChange={(date) => {
							setScheduleState((p) => ({
								...p,
								startDate: date || new Date(),
							}));
							markDirty();
						}}
						onEndDateChange={(date) => {
							setScheduleState((p) => ({
								...p,
								endDate: date,
							}));
							markDirty();
						}}
						onGenerationWindowChange={(val) => {
							setScheduleState((p) => ({
								...p,
								generationWindow: val,
							}));
							markDirty();
						}}
						onMinAdvanceChange={(val) => {
							setScheduleState((p) => ({
								...p,
								minAdvance: val,
							}));
							markDirty();
						}}
						onFrequencyChange={(val) => {
							setScheduleState((p) => ({
								...p,
								frequency: val,
							}));
							markDirty();
						}}
						onIntervalChange={(val) => {
							setScheduleState((p) => ({
								...p,
								interval: val,
							}));
							markDirty();
						}}
						onToggleWeekday={toggleWeekday}
						onMonthDayChange={(val) => {
							setScheduleState((p) => ({
								...p,
								monthDay: val,
							}));
							markDirty();
						}}
						onMonthChange={(val) => {
							setScheduleState((p) => ({
								...p,
								month: val,
							}));
							markDirty();
						}}
						isLoading={isLoading}
						errors={errors}
					/>
				);

			case 3:
				return null; // Rendered outside useMemo — see hoisted TimeConstraints below

			case 4:
				return (
					<div className="min-w-0 flex flex-col">
						<ErrorDisplay path="line_items" />
						<LineItemsSection
							inventoryItems={inventoryItems}
							onLinkInventory={setLineItemInventoryItem}
							showDisposition
							vehicles={vehicles}
							onDispositionChange={dirtySetLineItemDisposition}
							lineItems={activeLineItems}
							isLoading={isLoading}
							onAdd={dirtyAddLineItem}
							onRemove={dirtyRemoveLineItem}
							onUpdate={dirtyUpdateLineItem}
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
							state={billingConfig}
							onChange={(updates) => {
								setBillingConfig((prev) => ({ ...prev, ...updates }));
								markDirty();
							}}
							isLoading={isLoading}
							errors={errors}
						/>
					</div>
				);

			default:
				return null;
		}
	}, [
		isDraftPanelOpen,
		draftResults,
		templateClients,
		handleSelectDraft,
		handleDeleteDraft,
		sourceClientFilter,
		currentStep,
		name,
		clientId,
		priority,
		description,
		isLoading,
		clientDropdownEntries,
		geoData,
		errors,
		scheduleState,
		toggleWeekday,
		activeLineItems,
		addLineItem,
		removeLineItem,
		updateLineItem,
		subtotal,
		dirtyLineItemFields,
		undoLineItemField,
		clearLineItemField,
		billingConfig,
		markDirty,
	]);

	// ── Hoisted TimeConstraints — must not remount on state change ───────────
	// Rendered outside useMemo with display:none toggling to preserve isMounted ref.
	const handleTimeConstraintsChange = useCallback(
		(s: TimeConstraintsState) => {
			setTimeConstraintsState(s);
			markDirty();
		},
		[markDirty]
	);

	const hoistedTimeConstraints = (
		<div
			className="space-y-2 lg:space-y-3 min-w-0 pt-2"
			style={{
				display:
					!isDraftPanelOpen && currentStep === 3 ? undefined : "none",
			}}
		>
			<TimeConstraints
				mode="create"
				resetKey={constraintSeed.key}
				onStateChange={handleTimeConstraintsChange}
				isLoading={isLoading}
				initialArrivalConstraint={constraintSeed.arrivalConstraint}
				initialFinishConstraint={constraintSeed.finishConstraint}
				initialArrivalTime={constraintSeed.arrivalTime}
				initialArrivalWindowStart={constraintSeed.arrivalWindowStart}
				initialArrivalWindowEnd={constraintSeed.arrivalWindowEnd}
				initialFinishTime={constraintSeed.finishTime}
			/>
		</div>
	);

	return (
		<FormWizardContainer<Step>
			title="Create Recurring Plan"
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
			submitLabel="Create Plan"
			isSourceSearchOpen={isDraftPanelOpen}
			sourceMode="draft"
			onSourceModeChange={() => {}}
			draftsOnly
			draftCount={drafts.length}
			onStartFromExisting={() => setIsDraftPanelOpen(true)}
			startFromExistingLabel="Use Draft"
			hideStartFromExisting={isDraftPanelOpen}
			fullHeightContent={isDraftPanelOpen}
			onCloseSourceSearch={() => setIsDraftPanelOpen(false)}
			onSaveDraft={handleSaveDraft}
			canSaveDraft={
				isDirty &&
				!!(
					name.trim() ||
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
			{stepContent}
			{hoistedTimeConstraints}
		</FormWizardContainer>
	);
};

export default CreateRecurringPlan;
