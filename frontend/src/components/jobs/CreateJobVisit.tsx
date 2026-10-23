import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { ZodError } from "zod";
import {
	CreateJobVisitSchema,
	type CreateJobVisitInput,
	type JobVisit,
	VisitStatusColors,
} from "../../types/jobs";
import {
	type LineItemType,
	type BaseLineItem,
	type LineItemDisposition,
} from "../../types/common";
import { useActiveTechniciansQuery } from "../../hooks/useTechnicians";
import { useAllJobVisitsQuery, useJobByIdQuery } from "../../hooks/useJobs";
import { useAllClientsQuery } from "../../hooks/useClients";
import {
	useDraftsByTypeQuery,
	useCreateDraftMutation,
	useUpdateDraftMutation,
	useDeleteDraftMutation,
} from "../../hooks/forms/useDrafts";
import { getDraft } from "../../api/drafts";
import type { DraftSummary, SourceType } from "../../types/drafts";
import DatePicker from "../ui/DatePicker";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import LineItemsSection from "../ui/forms/LineItemsSection";
import { useAutoTaxMode } from "../../hooks/useAutoTaxMode";
import { docKeptEstimate, jobKeptSource, keptRateOptionLabel } from "../../lib/taxEditorMode";
import { useVehiclesQuery } from "../../hooks/useVehicles";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { useLineItemsForCalc } from "../../hooks/forms/useLineItemsForCalc";
import TimeConstraints, { type TimeConstraintsState } from "../ui/forms/TimeConstraints";
import { createStepRouter } from "../../hooks/forms/useZodStepRouting";
import {
	TemplateSearch,
	type TemplateSearchResult,
	type TemplateSearchClient,
	type TemplateSearchScopeToggle,
} from "../ui/forms/TemplateSearch";
import { useTaxGroups } from "../../hooks/useTaxGroups";
import { useFinancialCalculations } from "../../hooks/forms/useFinancialCalculations";

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

interface CreateJobVisitProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	jobId: string;
	createVisit: (input: CreateJobVisitInput) => Promise<JobVisit>;
	preselectedTechId?: string;
	onSuccess?: (visit: JobVisit) => void;
	clientExempt?: boolean;
}

const CreateJobVisit = ({
	isModalOpen,
	setIsModalOpen,
	jobId,
	createVisit,
	preselectedTechId,
	onSuccess,
	clientExempt = false,
}: CreateJobVisitProps) => {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [startDate, setStartDate] = useState<Date>(new Date());
	const [selectedTechIds, setSelectedTechIds] = useState<string[]>([]);
	const [timeConstraintsState, setTimeConstraintsState] =
		useState<TimeConstraintsState | null>(null);
	const [constraintSeed, setConstraintSeed] = useState<
		Partial<TimeConstraintsState> & { key: number }
	>({ key: 1 });
	const constraintResetKeyRef = useRef(1); // always incrementing — never reuse a value
	const [isLoading, setIsLoading] = useState(false);
	const [errors, setErrors] = useState<ZodError | null>(null);

	const [sourceMode, setSourceMode] = useState<SourceType | null>(null);
	const [sourceClientFilter, setSourceClientFilter] = useState("");
	const [visitScope, setVisitScope] = useState<"this-job" | "any-job">("this-job");

	const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
	const [isDirty, setIsDirty] = useState(false);

	const { data: technicians } = useActiveTechniciansQuery();
	const { data: allVisits = [] } = useAllJobVisitsQuery();
	const { data: clients } = useAllClientsQuery();
	const { data: drafts = [] } = useDraftsByTypeQuery("job_visit", jobId);
	const createDraftMutation = useCreateDraftMutation();
	const updateDraftMutation = useUpdateDraftMutation();
	const deleteDraftMutation = useDeleteDraftMutation();

	const isSourceSearchOpen = sourceMode !== null;

	const markDirty = useCallback(() => setIsDirty(true), []);
	const handleTimeConstraintsChange = useCallback(
		(s: TimeConstraintsState) => {
			setTimeConstraintsState(s);
			markDirty();
		},
		[markDirty]
	);

	const lineItems = useLineItems({ minItems: 1, mode: "create" });

	const { data: inventoryItems = [] } = useAllInventoryQuery();
	// Active only: a retired van is not somewhere stock can arrive.
	const { data: vehicles = [] } = useVehiclesQuery("active");

	const { data: taxGroups = [] } = useTaxGroups();
	const autoModeLoaded = useAutoTaxMode();
	const autoMode = autoModeLoaded === true;
	const { data: job } = useJobByIdQuery(jobId);
	const keptEstimate = docKeptEstimate(null, jobKeptSource(job), autoModeLoaded);
	const keptRateLabel = keptEstimate ? keptRateOptionLabel(keptEstimate) : null;
	const clientTaxGroupId = job?.client?.tax_group_id ?? null;

	const lineItemsForCalc = useLineItemsForCalc(lineItems.activeLineItems, clientTaxGroupId);

	const { groupsSummary, totalTax, resolvedTotal } = useFinancialCalculations(
		lineItems.subtotal,
		{
			taxGroups,
			lineItemsForCalc,
			clientExempt,
			initialDiscountType: "amount",
			initialDiscountValue: 0,
			rounding: "jurisdiction_half_up",
		},
	);

	const dirtyAddLineItem = useCallback(() => {
		lineItems.addLineItem();
		markDirty();
	}, [lineItems, markDirty]);
	const dirtyRemoveLineItem = useCallback(
		(id: string) => {
			lineItems.removeLineItem(id);
			markDirty();
		},
		[lineItems, markDirty]
	);
	const dirtyUpdateLineItem = useCallback(
		(id: string, field: keyof BaseLineItem, value: string | number) => {
			lineItems.updateLineItem(id, field, value);
			markDirty();
		},
		[lineItems, markDirty]
	);
	// Draft-dirty wrapper, same as the other line-item mutators.
	const dirtySetLineItemDisposition = useCallback(
		(id: string, disposition: LineItemDisposition | null, vehicleId?: string | null) => {
			lineItems.setLineItemDisposition(id, disposition, vehicleId);
			markDirty();
		},
		[lineItems, markDirty]
	);
	const wizard = useStepWizard<Step>({ totalSteps: 4 as Step, initialStep: 1 as Step });

	const validateStep1 = useCallback(
		(): boolean => !!(name.trim() && startDate),
		[name, startDate]
	);

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
		const meaningful = lineItems.activeLineItems.filter((item) => {
			const hasText = item.name.trim() || item.description?.trim();
			const hasNumbers = item.unit_price > 0;
			const hasType = item.item_type?.trim();
			return hasText || hasNumbers || hasType;
		});
		if (meaningful.length === 0) return true;
		return meaningful.every(
			(item) => item.name.trim() && item.quantity > 0 && item.unit_price >= 0
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
				default:
					return true;
			}
		},
		[validateStep1, validateStep2, validateStep3]
	);

	const canGoNext = useMemo(
		() => validateStep(wizard.currentStep),
		[validateStep, wizard.currentStep]
	);

	const canGoToStep = useCallback(
		(targetStep: Step): boolean => {
			if (targetStep === wizard.currentStep) return true;
			if (wizard.visitedSteps.has(targetStep)) return true;
			if (
				targetStep === wizard.currentStep + 1 &&
				validateStep(wizard.currentStep)
			)
				return true;
			return false;
		},
		[wizard.currentStep, wizard.visitedSteps, validateStep]
	);

	useEffect(() => {
		if (!isModalOpen) {
			setName("");
			setDescription("");
			setStartDate(new Date());
			setSelectedTechIds([]);
			setTimeConstraintsState(null);
			constraintResetKeyRef.current += 1;
			setConstraintSeed({ key: constraintResetKeyRef.current });
			setErrors(null);
			setSourceMode(null);
			setSourceClientFilter("");
			setVisitScope("this-job");
			setCurrentDraftId(null);
			setIsDirty(false);
			wizard.reset();
			lineItems.resetLineItems();
			setIsLoading(false);
		}
	}, [isModalOpen]);

	useEffect(() => {
		if (isModalOpen && preselectedTechId) {
			setSelectedTechIds([preselectedTechId]);
		}
	}, [isModalOpen, preselectedTechId]);

	const formatTimeString = useCallback((date: Date | null): string | null => {
		if (!date) return null;
		return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
	}, []);

	const handleTechSelection = useCallback(
		(techId: string) => {
			setSelectedTechIds((prev) =>
				prev.includes(techId)
					? prev.filter((id) => id !== techId)
					: [...prev, techId]
			);
			markDirty();
		},
		[markDirty]
	);

	const handleNext = useCallback(() => {
		if (canGoNext) wizard.goNext();
	}, [canGoNext, wizard]);

	const handleGoToStep = useCallback(
		(step: Step) => {
			if (canGoToStep(step)) wizard.goToStep(step);
		},
		[canGoToStep, wizard]
	);

	const handleTemplateSelect = useCallback(
		(visitId: string) => {
			const source = allVisits.find((v) => v.id === visitId);
			if (!source) return;

			setName(source.name ?? "");
			setDescription(source.description ?? "");

			if (source.line_items?.length) {
				lineItems.seedLineItems(
					source.line_items.map((li) => ({
						name: li.name,
						description: li.description ?? "",
						quantity: Number(li.quantity),
						unit_price: Number(li.unit_price),
						item_type: (li.item_type ?? "") as
							| LineItemType
							| "",
						taxable: li.taxable ?? true,
						tax_group_id: li.tax_group_id ?? null,
						inventory_item_id: li.inventory_item_id ?? null,
					}))
				);
			} else {
				lineItems.resetLineItems();
			}
			// Time constraints and tech assignments intentionally NOT copied

			setCurrentDraftId(null);
			setIsDirty(true); // pre-filled — allow saving as draft
			setSourceMode(null);
			constraintResetKeyRef.current += 1;
			setConstraintSeed({ key: constraintResetKeyRef.current }); // clear all initial* props → use defaults
			wizard.goToStep(1 as Step);
		},
		[allVisits, lineItems, wizard]
	);

	const handleSelectDraft = useCallback(
		async (draftId: string) => {
			try {
				const draft = await getDraft(draftId);
				const p = draft.payload as Partial<CreateJobVisitInput> & {
					line_items?: Array<{
						name: string;
						description?: string | null;
						quantity: number;
						unit_price: number;
						item_type?: string | null;
						taxable?: boolean | null;
						tax_group_id?: string | null;
						inventory_item_id?: string | null;
					}>;
					time_constraints?: {
						arrivalConstraint: string;
						finishConstraint: string;
						arrivalTime?: string | null;
						arrivalWindowStart?: string | null;
						arrivalWindowEnd?: string | null;
						finishTime?: string | null;
					};
					tech_ids?: string[];
				};

				setName(p.name || "");
				setDescription(p.description || "");

				if (p.line_items?.length) {
					lineItems.seedLineItems(
						p.line_items.map((li) => ({
							name: li.name,
							description: li.description ?? "",
							quantity: Number(li.quantity),
							unit_price: Number(li.unit_price),
							item_type: (li.item_type ?? "") as
								| LineItemType
								| "",
							taxable: li.taxable ?? true,
							tax_group_id: li.tax_group_id ?? null,
							inventory_item_id: li.inventory_item_id ?? null,
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
				// Tech ids — restore if present, but don't override a preselectedTechId
				if (p.tech_ids?.length && !preselectedTechId) {
					setSelectedTechIds(p.tech_ids);
				}

				setCurrentDraftId(draft.id);
				setIsDirty(false);
				setSourceMode(null);
				wizard.goToStep(1 as Step);
			} catch (err) {
				console.error("Failed to load draft:", err);
			}
		},
		[lineItems, wizard]
	);

	const handleSaveDraft = useCallback(async () => {
		const payload: Record<string, unknown> = {
			name,
			description,
			job_id: jobId,
			line_items: lineItems.activeLineItems.map((item) => ({
				name: item.name,
				description: item.description,
				quantity: item.quantity,
				unit_price: item.unit_price,
				item_type: item.item_type,
				total: item.total,
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
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
			tech_ids: selectedTechIds,
		};
		try {
			if (currentDraftId) {
				await updateDraftMutation.mutateAsync({
					id: currentDraftId,
					input: { payload },
				});
			} else {
				const draft = await createDraftMutation.mutateAsync({
					form_type: "job_visit",
					payload,
					entity_context_id: jobId,
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
		jobId,
		lineItems.activeLineItems,
		timeConstraintsState,
		selectedTechIds,
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

	const templateResults = useMemo((): TemplateSearchResult[] => {
		const source =
			visitScope === "this-job"
				? allVisits.filter((v) => v.job_id === jobId)
				: allVisits;

		return source
			.filter((v) => v.status !== "Cancelled")
			.map((v) => ({
				id: v.id,
				title: v.name ?? "",
				subtitle:
					visitScope === "any-job" && v.job?.job_number
						? v.job.job_number
						: undefined,
				detail: v.description
					? v.description.slice(0, 80) +
						(v.description.length > 80 ? "…" : "")
					: undefined,
				badge: v.status,
				badgeColor: VisitStatusColors[
					v.status as keyof typeof VisitStatusColors
				],
				createdAt:
					v.created_at != null
						? new Date(v.created_at).toISOString()
						: undefined,
			}));
	}, [allVisits, visitScope, jobId]);

	const scopeToggle: TemplateSearchScopeToggle = useMemo(
		() => ({
			thisLabel: "This Job",
			anyLabel: "Any Job",
			isThisScope: visitScope === "this-job",
			onToggle: () =>
				setVisitScope((prev) =>
					prev === "this-job" ? "any-job" : "this-job"
				),
		}),
		[visitScope]
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
			// Visits don't have client — no clientId/clientName needed
		}));
	}, [drafts]);

	const invokeCreate = useCallback(async () => {
		if (isLoading) return;

		const combinedStartDate = new Date(startDate);
		let combinedEndDate = new Date(startDate);

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

		const preparedLineItems = lineItems.activeLineItems
			.filter((li) => li.name.trim())
			.map((item, index) => ({
				name: item.name.trim(),
				description: item.description?.trim() || undefined,
				quantity: Number(item.quantity) || 1,
				unit_price: Number(item.unit_price) || 0,
				item_type: (item.item_type || undefined) as
					| LineItemType
					| undefined,
				sort_order: index,
				taxable: item.taxable ?? true,
				tax_group_id: item.tax_group_id ?? null,
				inventory_item_id: item.inventory_item_id ?? null,
				disposition: item.disposition ?? null,
				disposition_vehicle_id: item.disposition_vehicle_id ?? null,
			}));

		const newVisit: CreateJobVisitInput = {
			job_id: jobId,
			name: name.trim(),
			description: description.trim() || undefined,
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
			status: "Scheduled",
			tech_ids: selectedTechIds,
			line_items: preparedLineItems.length ? preparedLineItems : undefined,
		};

		const parseResult = CreateJobVisitSchema.safeParse(newVisit);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			const errorStep = routeErrorToStep(parseResult.error);
			if (errorStep) wizard.goToStep(errorStep);
			return;
		}

		setErrors(null);
		setIsLoading(true);
		try {
			const created = await createVisit(newVisit);
			if (currentDraftId) {
				await deleteDraftMutation
					.mutateAsync(currentDraftId)
					.catch(() => {});
			}
			if (onSuccess) onSuccess(created);
			else setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to create visit:", error);
		} finally {
			setIsLoading(false);
		}
	}, [
		isLoading,
		startDate,
		timeConstraintsState,
		lineItems.activeLineItems,
		name,
		description,
		jobId,
		selectedTechIds,
		formatTimeString,
		createVisit,
		onSuccess,
		setIsModalOpen,
		wizard,
		currentDraftId,
		deleteDraftMutation,
	]);

	const ErrorDisplay = useCallback(
		({ path }: { path: string }) => {
			if (!errors) return null;
			const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
			if (!fieldErrors.length) return null;
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
		if (isSourceSearchOpen) {
			if (sourceMode === "draft") {
				return (
					<TemplateSearch
						heading="Use Draft"
						placeholder="Search drafts by name..."
						results={draftResults}
						clients={[]}
						onSelect={handleSelectDraft}
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
					heading="Start from existing visit"
					placeholder="Search by name or description..."
					results={templateResults}
					clients={templateClients}
					onSelect={handleTemplateSelect}
					onClose={() => setSourceMode(null)}
					scopeToggle={scopeToggle}
					clientFilter={sourceClientFilter}
					onClientFilterChange={setSourceClientFilter}
				/>
			);
		}

		switch (wizard.currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						{preselectedTechId && (
							<div className="p-3 bg-primary-bg border border-primary-border rounded-md">
								<p className="text-xs font-medium text-primary-text">
									Creating visit with
									pre-selected technician
								</p>
							</div>
						)}
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Visit Name *
							</label>
							<input
								type="text"
								placeholder="e.g., Initial Assessment, Follow-up Visit"
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									markDirty();
								}}
								disabled={isLoading}
								className="border border-border px-2.5 py-1.5 lg:py-2 xl:py-2.5 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0"
							/>
							<ErrorDisplay path="name" />
						</div>
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
								Description (Optional)
							</label>
							<textarea
								placeholder="Describe what will be done during this visit..."
								value={description}
								onChange={(e) => {
									setDescription(
										e.target.value
									);
									markDirty();
								}}
								disabled={isLoading}
								className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
							/>
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
								value={startDate}
								onChange={(d) => {
									setStartDate(
										d || new Date()
									);
									markDirty();
								}}
								position="above"
							/>
						</div>
					</div>
				);

			case 2:
				return (
					<div className="space-y-2 lg:space-y-3 min-w-0 pt-2">
						{/* TimeConstraints rendered outside useMemo — see hoisted instance below */}
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
							onDispositionChange={dirtySetLineItemDisposition}
							lineItems={lineItems.activeLineItems}
							isLoading={isLoading}
							onAdd={dirtyAddLineItem}
							onRemove={dirtyRemoveLineItem}
							onUpdate={dirtyUpdateLineItem}
							subtotal={lineItems.subtotal}
							required={false}
							minItems={0}
							dirtyFields={lineItems.dirtyLineItemFields}
							onUndo={lineItems.undoLineItemField}
							onClear={lineItems.clearLineItemField}
							taxGroups={taxGroups}
							clientExempt={clientExempt}
							onTaxChange={(id, groupId, taxable) => {
								lineItems.setLineItemTaxGroup(id, groupId, taxable);
								markDirty();
							}}
							autoMode={autoMode}
							keptRateLabel={keptRateLabel}
							onTaxGroupBulkSet={(groupId, taxable) => {
								lineItems.setAllLineItemsTaxGroup(groupId, taxable);
								markDirty();
							}}
						/>

						{lineItems.activeLineItems.some((li) => li.name.trim()) && (
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
		isSourceSearchOpen,
		autoMode,
		sourceMode,
		draftResults,
		handleSelectDraft,
		handleDeleteDraft,
		sourceClientFilter,
		templateResults,
		templateClients,
		handleTemplateSelect,
		scopeToggle,
		wizard.currentStep,
		preselectedTechId,
		name,
		description,
		startDate,
		isLoading,
		timeConstraintsState,
		lineItems,
		technicians,
		selectedTechIds,
		handleTechSelection,
		ErrorDisplay,
		markDirty,
		taxGroups,
		clientExempt,
		groupsSummary,
		totalTax,
		resolvedTotal,
	]);

	// ── Hoisted TimeConstraints — stable instance, toggled via display:none ─
	const hoistedTimeConstraints = (
		<div
			className="space-y-2 lg:space-y-3 min-w-0 pt-2"
			style={{
				display:
					!isSourceSearchOpen && wizard.currentStep === 2
						? undefined
						: "none",
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
		<FormWizardContainer
			title="Create Job Visit"
			steps={STEPS}
			currentStep={wizard.currentStep}
			visitedSteps={wizard.visitedSteps}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			canGoToStep={canGoToStep}
			onStepClick={handleGoToStep}
			onNext={handleNext}
			onBack={wizard.goBack}
			onSubmit={invokeCreate}
			canGoNext={canGoNext}
			submitLabel="Create Visit"
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
				isDirty &&
				!!(
					name.trim() ||
					description.trim() ||
					selectedTechIds.length > 0 ||
					lineItems.activeLineItems.some(
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

export default CreateJobVisit;
