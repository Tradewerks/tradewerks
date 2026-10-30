import { useParams, useNavigate } from "react-router-dom";
import {
	ChevronLeft,
	Edit2,
	Calendar,
	Clock,
	Plus,
	DollarSign,
	Repeat,
	ExternalLink,
	ChevronRight,
	Briefcase,
	ReceiptText,
} from "lucide-react";
import { useState, useMemo } from "react";
import {
	useRecurringPlanByIdQuery,
	useRecurringTaxEstimateQuery,
	useOccurrencesByJobIdQuery,
	usePauseRecurringPlanMutation,
	useResumeRecurringPlanMutation,
	useCancelRecurringPlanMutation,
	useCompleteRecurringPlanMutation,
	useGenerateOccurrencesMutation,
	useGenerateVisitFromOccurrenceMutation,
} from "../../hooks/useRecurringPlans";
import { useGenerateInvoiceMutation } from "../../hooks/useInvoices";
import Card from "../../components/ui/Card";
import RecurringTaxEstimate from "../../components/recurringPlans/RecurringTaxEstimate";
import { HEADER_BTN_ICON, HEADER_META } from "../../components/ui/headerActions";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ClientDetailsCard from "../../components/clients/ClientDetailsCard";
import RecurringPlanNoteManager from "../../components/recurringPlans/RecurringPlanNoteManager";
import EditRecurringPlan from "../../components/recurringPlans/EditRecurringPlan";
import SkippedDatesCard from "../../components/recurringPlans/SkippedDatesCard";
import BalancedOverviewGrid from "../../components/detail/BalancedOverviewGrid";
import DetailHeader, { type DetailMenuGroup } from "../../components/detail/DetailHeader";
import DetailTabs, { type DetailTabDef } from "../../components/detail/DetailTabs";
import { useDetailTab } from "../../components/detail/useDetailTab";
import DetailStatRow from "../../components/detail/DetailStatRow";
import ActivityPanel from "../../components/detail/ActivityPanel";
import DetailFieldGrid, { type DetailField } from "../../components/detail/DetailFieldGrid";
import RelationCard from "../../components/detail/RelationCard";
import LifecycleBar, { LifecycleActions } from "../../components/lifecycle/LifecycleBar";
import TerminalDetail from "../../components/lifecycle/TerminalDetail";
import { planActions } from "../../components/lifecycle/planActions";
import { placeActions } from "../../components/lifecycle/placement";
import type { LifecycleStage } from "../../components/lifecycle/types";
import {
	RecurringPlanStatusLabels,
	RecurringPlanStatusColors,
	OccurrenceStatusColors,
	OccurrenceStatusLabels,
	BillingModeLabels,
	InvoiceTimingLabels,
	InvoiceScheduleFrequencyLabels,
	InvoiceScheduleBillingBasisLabels,
	WeekdayLabels,
	formatRecurringSchedule,
	formatScheduleConstraints,
	calculateTemplateTotal,
	type RecurringPlanLineItem,
	type RecurringOccurrence,
	type OccurrenceStatus,
} from "../../types/recurringPlans";
import {
	JobStatusLabels,
	JobStatusColors,
	VisitStatusColors,
	VisitStatusLabels,
	type JobStatus,
	type VisitStatus,
} from "../../types/jobs";
import { PriorityColors } from "../../types/common";
import { formatCurrency, formatDate } from "../../util/util";
import { usePermission } from "../../hooks/usePermission";
import ChangeHistory from "../../components/activity/ChangeHistory";

const ITEMS_PER_PAGE = 10;

// The plan's terms live in Overview; the occurrence schedule and the service
// history behind it earn their own tab. Activity is last, as everywhere.
const PLAN_TABS: readonly DetailTabDef<"overview" | "schedule" | "activity">[] = [
	{ id: "overview", label: "Overview" },
	{ id: "schedule", label: "Schedule" },
	{ id: "activity", label: "Activity" },
];

function ordinalDay(n: number): string {
	const s = ["th", "st", "nd", "rd"];
	const v = n % 100;
	return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

export default function RecurringPlanDetailPage() {
	const { recurringPlanId } = useParams<{ recurringPlanId: string }>();
	const navigate = useNavigate();

	const {
		data: plan,
		isLoading: planLoading,
		error: planError,
	} = useRecurringPlanByIdQuery(recurringPlanId || "");

	const jobContainerId = plan?.job_container?.id;

	const taxEstimateInput = useMemo(() => {
		if (!plan?.client_id || !plan.address) return null;
		const lines = (plan.line_items || []).filter((li) => Number(li.quantity) > 0);
		return {
			client_id: plan.client_id,
			address: plan.address,
			coords: plan.coords ?? null,
			line_items: lines.map((li) => ({
				quantity: Number(li.quantity),
				unit_price: Number(li.unit_price),
				taxable: li.taxable ?? true,
				tax_group_id: li.tax_group_id ?? null,
			})),
			plan_id: plan.id,
		};
	}, [plan]);
	const { data: taxEstimate } = useRecurringTaxEstimateQuery(taxEstimateInput);

	const { data: occurrences = [], isLoading: occurrencesLoading } =
		useOccurrencesByJobIdQuery(jobContainerId || "");

	const [activeTab, setActiveTab] = useDetailTab(PLAN_TABS);
	const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [daysAhead, setDaysAhead] = useState(30);
	const [pendingConfirm, setPendingConfirm] = useState<"cancel" | "complete" | null>(null);
	const [upcomingPage, setUpcomingPage] = useState(0);
	const [pastPage, setPastPage] = useState(0);

	const pauseMutation = usePauseRecurringPlanMutation();
	const resumeMutation = useResumeRecurringPlanMutation();
	const cancelMutation = useCancelRecurringPlanMutation();
	const completeMutation = useCompleteRecurringPlanMutation();
	const generateMutation = useGenerateOccurrencesMutation();
	const generateVisitMutation = useGenerateVisitFromOccurrenceMutation();
	const generateInvoiceMutation = useGenerateInvoiceMutation();

	// permissions
	const MANAGE_RECURRING_PLANS = usePermission("manage_recurring_plans");
	const CREATE_INVOICE = usePermission("create_invoices");

	const { upcomingOccurrences, serviceHistory } = useMemo(() => {
		if (!occurrences || occurrences.length === 0) {
			return {
				upcomingOccurrences: [],
				serviceHistory: [],
				sortedOccurrences: [],
			};
		}

		const sorted = [...occurrences].sort(
			(a, b) =>
				new Date(a.occurrence_start_at).getTime() -
				new Date(b.occurrence_start_at).getTime()
		);

		const now = new Date();
		const upcoming: RecurringOccurrence[] = [];
		const history: RecurringOccurrence[] = [];

		for (const occ of sorted) {
			const occDate = new Date(occ.occurrence_start_at);
			const isPast =
				occDate <= now ||
				occ.status === "completed" ||
				occ.status === "skipped" ||
				occ.status === "cancelled";

			if (isPast) {
				// Only include occurrences that became actual visits
				if (occ.job_visit_id) {
					history.push(occ);
				}
			} else if (occ.status === "planned" || occ.status === "generated") {
				upcoming.push(occ);
			}
		}

		return {
			upcomingOccurrences: upcoming,
			serviceHistory: history.reverse(),
			sortedOccurrences: sorted,
		};
	}, [occurrences]);

	const isLoading = planLoading || occurrencesLoading;

	if (planError) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">
					Error loading recurring plan: {planError.message}
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">
					Loading recurring plan...
				</div>
			</div>
		);
	}

	if (!plan) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">
					Recurring plan not found
				</div>
			</div>
		);
	}

	const lineItems: RecurringPlanLineItem[] = plan.line_items || [];
	const hasLineItems = lineItems.length > 0;
	const templateTotal = calculateTemplateTotal(lineItems);

	// Frequency as text, for the Cadence stat tile.
	const cadenceLabel =
		plan.rules && plan.rules.length > 0
			? formatRecurringSchedule(plan.rules[0])
			: "No schedule set";

	const upcomingPaginatedOccurrences = upcomingOccurrences.slice(
		upcomingPage * ITEMS_PER_PAGE,
		(upcomingPage + 1) * ITEMS_PER_PAGE
	);
	const historyPaginatedOccurrences = serviceHistory.slice(
		pastPage * ITEMS_PER_PAGE,
		(pastPage + 1) * ITEMS_PER_PAGE
	);
	const upcomingHasNext = (upcomingPage + 1) * ITEMS_PER_PAGE < upcomingOccurrences.length;
	const upcomingHasPrev = upcomingPage > 0;
	const pastHasNext = (pastPage + 1) * ITEMS_PER_PAGE < serviceHistory.length;
	const pastHasPrev = pastPage > 0;

	const handlePause = async () => {
		if (!jobContainerId) return;
		try {
			await pauseMutation.mutateAsync(jobContainerId);
		} catch (error) {
			console.error("Failed to pause plan:", error);
		}
	};

	const handleResume = async () => {
		if (!jobContainerId) return;
		try {
			await resumeMutation.mutateAsync(jobContainerId);
		} catch (error) {
			console.error("Failed to resume plan:", error);
		}
	};

	const handleCancel = () => {
		if (!jobContainerId) return;
		setPendingConfirm("cancel");
	};

	const handleComplete = () => {
		if (!jobContainerId) return;
		setPendingConfirm("complete");
	};

	const confirmPendingAction = async () => {
		if (!jobContainerId) return;
		try {
			if (pendingConfirm === "cancel") {
				await cancelMutation.mutateAsync(jobContainerId);
			} else if (pendingConfirm === "complete") {
				await completeMutation.mutateAsync(jobContainerId);
			}
			setPendingConfirm(null);
		} catch (error) {
			console.error(`Failed to ${pendingConfirm} plan:`, error);
		}
	};

	const handleGenerateOccurrences = async () => {
		if (!jobContainerId) return;
		try {
			await generateMutation.mutateAsync({
				jobId: jobContainerId,
				input: { days_ahead: daysAhead },
			});
			setIsGenerateModalOpen(false);
		} catch (error) {
			console.error("Failed to generate occurrences:", error);
		}
	};

	const handleGenerateInvoice = async () => {
		if (!recurringPlanId) return;
		try {
			const result = await generateInvoiceMutation.mutateAsync({
				source: "recurring_plan",
				plan_id: recurringPlanId,
			});
			navigate(`/dispatch/invoices/${result.invoice.id}`);
		} catch (error) {
			console.error("Failed to generate invoice:", error);
		}
	};

	const handleGenerateVisit = async (occurrenceId: string) => {
		if (!jobContainerId) return;
		try {
			const result = await generateVisitMutation.mutateAsync({
				occurrenceId: occurrenceId,
				jobId: jobContainerId,
			});
			navigate(`/dispatch/jobs/${jobContainerId}/visits/${result.visit_id}`);
		} catch (error) {
			console.error("Failed to generate visit:", error);
		}
	};

	// variant="state", not a stepper: Active, Paused, Completed and Cancelled are
	// modes, not a march, so a step track would sit permanently at one end.
	const stage: LifecycleStage =
		plan.status === "Completed" || plan.status === "Cancelled" ? "terminal" : "normal";

	const actions = planActions({
		status: plan.status,
		canManage: MANAGE_RECURRING_PLANS,
		hasJobContainer: Boolean(jobContainerId),
		handlers: {
			pause: handlePause,
			resume: handleResume,
			generate: () => setIsGenerateModalOpen(true),
			complete: handleComplete,
			cancel: handleCancel,
		},
	});

	const { headerActions, barActions, overflow, showBar } = placeActions(stage, actions);

	const menuGroups: DetailMenuGroup[] = [
		{
			id: "lifecycle",
			label: "Lifecycle",
			items: overflow.map((a) => ({
				id: a.id,
				label: a.label,
				intent: a.intent === "primary" ? "neutral" : a.intent,
				disabled: a.disabled,
				disabledReason: a.disabledReason,
				onSelect: a.onSelect,
			})),
		},
		{
			id: "plan",
			label: "Plan",
			items: [
				{
					id: "edit",
					label: "Edit Plan",
					icon: <Edit2 size={16} />,
					disabled: !MANAGE_RECURRING_PLANS,
					disabledReason: MANAGE_RECURRING_PLANS
						? undefined
						: "You don't have permission to perform this action",
					onSelect: () => setIsEditModalOpen(true),
				},
				...(plan.invoice_schedule?.is_active
					? [
							{
								id: "generate-invoice",
								label: generateInvoiceMutation.isPending
									? "Generating…"
									: "Generate Invoice",
								icon: <ReceiptText size={16} />,
								disabled:
									generateInvoiceMutation.isPending ||
									!CREATE_INVOICE,
								disabledReason: CREATE_INVOICE
									? undefined
									: "You don't have permission to perform this action",
								onSelect: handleGenerateInvoice,
							},
						]
					: []),
			],
		},
	];

	// A terminal plan can still have rows in upcomingOccurrences — nothing goes
	// back and cancels them — but will never generate a visit from them. Both
	// tiles say so together, or a live date beside a count of zero reads as a bug.
	const upcomingCount = stage === "terminal" ? 0 : upcomingOccurrences.length;
	const nextOccurrence = stage === "terminal" ? undefined : upcomingOccurrences[0];

	const statTiles = [
		{
			label: "Next",
			icon: <Calendar size={13} />,
			value: nextOccurrence
				? formatDate(nextOccurrence.occurrence_start_at)
				: "None scheduled",
		},
		{
			label: "Upcoming",
			icon: <Repeat size={13} />,
			value: `${upcomingCount}`,
			hint: upcomingCount === 1 ? "occurrence" : "occurrences",
		},
		{
			label: "Cadence",
			icon: <Repeat size={13} />,
			value: cadenceLabel,
			hint: plan.ends_at != null ? `until ${formatDate(plan.ends_at)}` : "no end date",
		},
		{
			label: "Template Total",
			icon: <DollarSign size={13} />,
			value: formatCurrency(templateTotal),
			hint: "per occurrence",
		},
	];

	const clientCard = <ClientDetailsCard fill client_id={plan.client_id} client={plan.client} />;

	const jobContainerCard = plan.job_container ? (
		<RelationCard
			eyebrow="Linked Job"
			to={`/dispatch/jobs/${plan.job_container.id}`}
			emptyLabel="No linked job yet"
			icon={<Briefcase />}
			title={plan.job_container.job_number}
			subtitle={plan.job_container.name ?? undefined}
			trailing={
				<span
					className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${
						JobStatusColors[plan.job_container.status as JobStatus] ||
						"bg-surface-raised text-text-tertiary border-border-strong"
					}`}
				>
					{JobStatusLabels[plan.job_container.status as JobStatus] ??
						plan.job_container.status}
				</span>
			}
		/>
	) : null;

	const infoFields: DetailField[] = [
		{ label: "Address", value: plan.address },
		{ label: "Started", value: formatDate(plan.starts_at) },
		{ label: "Invoicing", value: BillingModeLabels[plan.billing_mode] },
	];

	if (plan.billing_mode !== "none") {
		infoFields.push(
			{ label: "Trigger", value: InvoiceTimingLabels[plan.invoice_timing] },
			{ label: "Auto Invoice", value: plan.auto_invoice ? "Yes" : "No" }
		);

		if (plan.invoice_schedule) {
			infoFields.push(
				{
					label: "Frequency",
					value: (
						<>
							{
								InvoiceScheduleFrequencyLabels[
									plan.invoice_schedule.frequency
								]
							}
							{(plan.invoice_schedule.frequency === "weekly" ||
								plan.invoice_schedule.frequency === "biweekly") &&
								plan.invoice_schedule.day_of_week && (
									<span className="mt-0.5 block text-xs text-text-tertiary">
										{
											WeekdayLabels[
												plan.invoice_schedule
													.day_of_week
											]
										}
									</span>
								)}
							{(plan.invoice_schedule.frequency === "monthly" ||
								plan.invoice_schedule.frequency === "quarterly") &&
								plan.invoice_schedule.day_of_month != null && (
									<span className="mt-0.5 block text-xs text-text-tertiary">
										{ordinalDay(
											plan.invoice_schedule.day_of_month
										)}{" "}
										of{" "}
										{plan.invoice_schedule.frequency ===
										"monthly"
											? "month"
											: "quarter"}
									</span>
								)}
						</>
					),
				},
				{
					label: "Billing Basis",
					value: (
						<>
							{
								InvoiceScheduleBillingBasisLabels[
									plan.invoice_schedule.billing_basis
								]
							}
							{plan.invoice_schedule.billing_basis === "fixed_amount" &&
								plan.invoice_schedule.fixed_amount != null && (
									<span className="mt-0.5 block text-xs text-text-tertiary">
										{"$" +
											Number(
												plan.invoice_schedule
													.fixed_amount
											).toFixed(2)}
									</span>
								)}
						</>
					),
				},
				{
					label: "Payment Terms",
					value:
						plan.invoice_schedule.payment_terms_days != null
							? "Net " + plan.invoice_schedule.payment_terms_days
							: "—",
				}
			);
		}
	}

	const infoCard = (
		<Card className="flex-1" title="Plan Information">
			<DetailFieldGrid
				fill
				lead={
					<p className="break-words text-text-primary">
						{plan.description || "No description provided"}
					</p>
				}
				fields={infoFields}
			/>
			{plan.rules && plan.rules.length > 0 && (
				<p className="mt-4 border-t border-border-subtle pt-4 text-sm text-text-tertiary">
					{/* The cadence itself is the Cadence tile; what the tile
					    cannot carry is the day-and-time detail. */}
					{formatScheduleConstraints(plan.rules[0])}
				</p>
			)}
		</Card>
	);

	const templatePricingCard = (
		<Card
			title="Template Pricing"
			headerAction={
				hasLineItems ? (
					<span className="text-xs text-text-tertiary tabular-nums">
						{lineItems.length} {lineItems.length === 1 ? "item" : "items"}
					</span>
				) : undefined
			}
		>
			{!hasLineItems ? (
				<div className="text-center py-8">
					<DollarSign
						size={40}
						className="mx-auto text-text-faint mb-3"
					/>
					<h3 className="text-text-tertiary text-sm font-medium mb-1">
						No Line Items
					</h3>
					<p className="text-text-muted text-xs">
						Edit this recurring plan to add template line items.
					</p>
				</div>
			) : (
				<div className="space-y-1">
					<div className="grid grid-cols-12 gap-2 pb-2 border-b border-border text-xs uppercase tracking-wide font-semibold text-text-tertiary">
						<div className="col-span-5">
							Description
						</div>
						<div className="col-span-1 text-center">
							Type
						</div>
						<div className="col-span-2 text-right">
							Qty
						</div>
						<div className="col-span-2 text-right">
							Unit Price
						</div>
						<div className="col-span-2 text-right">
							Amount
						</div>
					</div>

					{lineItems.map((item, index) => (
						<div
							key={item.id || index}
							className="grid grid-cols-12 gap-2 py-3 border-b border-border-subtle hover:bg-surface-raised transition-colors duration-150 ease-out"
						>
							<div className="col-span-5 text-sm">
								<p className="text-text-primary font-medium">
									{item.name}
								</p>
								{item.description && (
									<p className="text-text-tertiary text-xs mt-0.5">
										{
											item.description
										}
									</p>
								)}
							</div>
							<div className="col-span-1 flex items-center justify-center">
								{item.item_type && (
									<span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-surface-raised text-text-secondary border border-border-strong">
										{
											item.item_type
										}
									</span>
								)}
							</div>
							<div className="col-span-2 text-right text-sm text-text-primary tabular-nums flex items-center justify-end">
								{Number(
									item.quantity
								).toLocaleString(
									"en-US",
									{
										minimumFractionDigits: 0,
										maximumFractionDigits: 2,
									}
								)}
							</div>
							<div className="col-span-2 text-right text-sm text-text-primary tabular-nums flex items-center justify-end">
								{formatCurrency(
									Number(
										item.unit_price
									)
								)}
							</div>
							<div className="col-span-2 text-right text-sm text-text-primary font-medium tabular-nums flex items-center justify-end">
								{formatCurrency(
									Number(
										item.quantity
									) *
										Number(
											item.unit_price
										)
								)}
							</div>
						</div>
					))}
					<div className="pt-3">
						<RecurringTaxEstimate estimate={taxEstimate} />
					</div>
				</div>
			)}
		</Card>
	);

	const upcomingOccurrencesCard = (
		<Card
			className="h-full"
			title="Upcoming Occurrences"
			headerAction={
				upcomingOccurrences.length > 0 && (
					<div className="flex items-center gap-1">
						<span className={`${HEADER_META} mr-1`}>
							{upcomingPage * ITEMS_PER_PAGE + 1}-
							{Math.min(
								(upcomingPage + 1) * ITEMS_PER_PAGE,
								upcomingOccurrences.length
							)}{" "}
							of {upcomingOccurrences.length}
						</span>
						<button
							onClick={() =>
								setUpcomingPage(
									Math.max(
										0,
										upcomingPage - 1
									)
								)
							}
							disabled={!upcomingHasPrev}
							className={HEADER_BTN_ICON}
						>
							<ChevronLeft size={16} />
						</button>
						<button
							onClick={() =>
								setUpcomingPage(upcomingPage + 1)
							}
							disabled={!upcomingHasNext}
							className={HEADER_BTN_ICON}
						>
							<ChevronRight size={16} />
						</button>
					</div>
				)
			}
		>
			{upcomingOccurrences.length === 0 ? (
				<div className="text-center py-8">
					<Calendar
						size={40}
						className="mx-auto text-text-faint mb-3"
					/>
					<h3 className="text-text-tertiary text-sm font-medium mb-1">
						No Upcoming Occurrences
					</h3>
					<p className="text-text-muted text-xs">
						Generate occurrences to schedule future visits.
					</p>
				</div>
			) : (
				<div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
					{upcomingPaginatedOccurrences.map((occurrence) => (
						<div
							key={occurrence.id}
							className="p-2 bg-surface border border-border rounded-md hover:border-border-strong transition-colors duration-150 ease-out"
						>
							<div className="flex items-start justify-between gap-2 mb-1">
								<div className="flex-1 min-w-0">
									<p className="text-text-primary text-xs font-medium truncate">
										{new Date(
											occurrence.occurrence_start_at
										).toLocaleDateString(
											"en-US",
											{
												month: "short",
												day: "numeric",
												year: "numeric",
											}
										)}
									</p>
									<p className="text-text-tertiary text-xs">
										{new Date(
											occurrence.occurrence_start_at
										).toLocaleTimeString(
											"en-US",
											{
												hour: "numeric",
												minute: "2-digit",
											}
										)}
									</p>
								</div>
								<span
									className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border flex-shrink-0 ${
										OccurrenceStatusColors[
											occurrence.status as OccurrenceStatus
										] ||
										"bg-surface-raised text-text-tertiary border-border-strong"
									}`}
								>
									{OccurrenceStatusLabels[
										occurrence.status as OccurrenceStatus
									] || occurrence.status}
								</span>
							</div>
							<div className="flex gap-1 mt-2">
								{occurrence.status ===
									"planned" && (
									<button
										title={
											!MANAGE_RECURRING_PLANS
												? "You don't have permission to perform this action"
												: "Generate visit from this occurrence"
										}
										onClick={() => {
											if (
												!MANAGE_RECURRING_PLANS
											)
												return;
											handleGenerateVisit(
												occurrence.id
											);
										}}
										disabled={
											generateVisitMutation.isPending ||
											!MANAGE_RECURRING_PLANS
										}
										className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-primary-hover hover:enabled:bg-primary-active text-on-primary rounded text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-40 disabled:cursor-not-allowed"
									>
										<Plus size={12} />
										Create
									</button>
								)}
								{occurrence.status ===
									"generated" &&
									occurrence.job_visit_id && (
										<button
											onClick={() => {
												if (
													jobContainerId
												) {
													navigate(
														`/dispatch/jobs/${jobContainerId}/visits/${occurrence.job_visit_id}`
													);
												}
											}}
											className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-surface-raised hover:bg-surface-raised rounded text-xs font-medium transition-colors duration-150 ease-out"
										>
											<ExternalLink
												size={
													12
												}
											/>
											View
										</button>
									)}
							</div>
						</div>
					))}
				</div>
			)}
		</Card>
	);

	const serviceHistoryCard = (
		<Card
			className="h-full"
			title="Service History"
			headerAction={
				serviceHistory.length > 0 && (
					<div className="flex items-center gap-1">
						<span className={`${HEADER_META} mr-1`}>
							{pastPage * ITEMS_PER_PAGE + 1}-
							{Math.min(
								(pastPage + 1) * ITEMS_PER_PAGE,
								serviceHistory.length
							)}{" "}
							of {serviceHistory.length}
						</span>
						<button
							onClick={() =>
								setPastPage(
									Math.max(0, pastPage - 1)
								)
							}
							disabled={!pastHasPrev}
							className={HEADER_BTN_ICON}
						>
							<ChevronLeft size={16} />
						</button>
						<button
							onClick={() => setPastPage(pastPage + 1)}
							disabled={!pastHasNext}
							className={HEADER_BTN_ICON}
						>
							<ChevronRight size={16} />
						</button>
					</div>
				)
			}
		>
			{serviceHistory.length === 0 ? (
				<div className="text-center py-8">
					<Clock size={40} className="mx-auto text-text-faint mb-3" />
					<h3 className="text-text-tertiary text-sm font-medium mb-1">
						No visits recorded yet
					</h3>
					<p className="text-text-muted text-xs">
						Past visits generated from this plan will appear
						here.
					</p>
				</div>
			) : (
				<div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
					{historyPaginatedOccurrences.map((occurrence) => {
						const visitDate = occurrence.job_visit
							?.scheduled_start_at
							? new Date(
									occurrence.job_visit
										.scheduled_start_at
								)
							: new Date(occurrence.occurrence_start_at);
						const visitStatus = occurrence.job_visit?.status as
							| VisitStatus
							| undefined;
						return (
							<div
								key={occurrence.id}
								className="p-2 bg-surface border border-border rounded-md opacity-75 hover:opacity-100 transition-opacity duration-150 ease-out"
							>
								<div className="flex items-start justify-between gap-2 mb-1">
									<div className="flex-1 min-w-0">
										<p className="text-text-primary text-xs font-medium truncate">
											{visitDate.toLocaleDateString(
												"en-US",
												{
													month: "short",
													day: "numeric",
													year: "numeric",
												}
											)}
											{" · "}
											{visitDate.toLocaleTimeString(
												"en-US",
												{
													hour: "numeric",
													minute: "2-digit",
												}
											)}
										</p>
										<p className="text-text-tertiary text-xs truncate">
											{occurrence
												.job_visit
												?.name ??
												" "}
										</p>
									</div>
									{visitStatus && (
										<span
											className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border flex-shrink-0 ${
												VisitStatusColors[
													visitStatus
												] ||
												"bg-surface-raised text-text-tertiary border-border-strong"
											}`}
										>
											{VisitStatusLabels[
												visitStatus
											] ||
												visitStatus}
										</span>
									)}
								</div>
								<div className="flex gap-1 mt-2">
									<button
										onClick={() => {
											if (
												jobContainerId
											) {
												navigate(
													`/dispatch/jobs/${jobContainerId}/visits/${occurrence.job_visit_id}`
												);
											}
										}}
										className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-surface-raised hover:bg-surface-raised rounded text-xs font-medium transition-colors duration-150 ease-out"
									>
										<ExternalLink
											size={12}
										/>
										View Visit
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</Card>
	);

	return (
		<div className="text-text-primary">
			<div className="space-y-4">
				<DetailHeader
					title={plan.name}
					meta={plan.client?.name}
					badges={
						<span
							className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PriorityColors[plan.priority]}`}
						>
							{plan.priority}
						</span>
					}
					statusPill={
						<span
							className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${RecurringPlanStatusColors[plan.status]}`}
						>
							{RecurringPlanStatusLabels[plan.status]}
						</span>
					}
					inlineActions={<LifecycleActions actions={headerActions} />}
					menuGroups={menuGroups}
					menuLabel="Plan actions"
				/>

				{showBar && (
					<LifecycleBar
						variant="state"
						stage={stage}
						currentStatus={RecurringPlanStatusLabels[plan.status]}
						tone={plan.status === "Cancelled" ? "error" : undefined}
						actions={barActions}
						detail={
							<TerminalDetail
								reason={null}
								at={null}
								noReasonLabel={
									plan.status === "Completed"
										? "This plan ran to its end date."
										: "Cancelled — no further occurrences will be generated."
								}
							/>
						}
					/>
				)}

				<DetailTabs
					tabs={PLAN_TABS}
					activeTab={activeTab}
					onSelect={setActiveTab}
					label="Plan sections"
				/>
			</div>

			{activeTab === "overview" && (
				<div
					role="tabpanel"
					id="tabpanel-overview"
					aria-labelledby="tab-overview"
					className="mt-6 space-y-4"
				>
					<h2 className="sr-only">Overview</h2>
					<DetailStatRow tiles={statTiles} />

					<BalancedOverviewGrid
						recordId={plan.id}
						infoCard={infoCard}
						block={jobContainerCard}
						railCard={clientCard}
					/>

					{templatePricingCard}
				</div>
			)}

			{activeTab === "schedule" && (
				<div
					role="tabpanel"
					id="tabpanel-schedule"
					aria-labelledby="tab-schedule"
					className="mt-6 space-y-4"
				>
					<h2 className="sr-only">Schedule</h2>
					{/* Stretched: both cards are h-full, so the shorter one carries
					    its slack inside its border and the pair ends on one line. */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
						{upcomingOccurrencesCard}
						{serviceHistoryCard}
					</div>
					<SkippedDatesCard jobId={jobContainerId || undefined} />
				</div>
			)}

			{activeTab === "activity" && (
				<ActivityPanel
					notes={
						jobContainerId ? (
							<RecurringPlanNoteManager
								jobId={jobContainerId}
							/>
						) : (
							/* The note manager is keyed by the plan's job container,
							   which does not exist until the first occurrence is
							   generated. The rail must still render something: an
							   empty column beside a populated history reads as a
							   load failure. */
							<Card title="Notes">
								<p className="rounded-lg border border-dashed border-border-subtle p-6 text-center text-sm text-text-tertiary flex-1 flex items-center justify-center">
									Notes open once this plan
									generates its first
									occurrence.
								</p>
							</Card>
						)
					}
					lifecycle={null}
					history={
						<ChangeHistory
							scope={{
								kind: "entity",
								type: "recurring_plan",
								id: recurringPlanId ?? "",
							}}
						/>
					}
				/>
			)}

			{plan && (
				<EditRecurringPlan
					isModalOpen={isEditModalOpen}
					setIsModalOpen={setIsEditModalOpen}
					plan={plan}
				/>
			)}

			{isGenerateModalOpen && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
					<div className="bg-base border border-border-subtle rounded-lg p-6 max-w-md w-full mx-4">
						<h2 className="text-xl font-bold text-text-primary mb-4">
							Generate Occurrences
						</h2>
						<p className="text-text-tertiary text-sm mb-4">
							Generate future occurrences for this
							recurring plan.
						</p>
						<div className="mb-6">
							<label className="block text-sm font-medium text-text-secondary mb-2">
								Days Ahead
							</label>
							<input
								type="number"
								min="1"
								max="365"
								value={daysAhead}
								onChange={(e) =>
									setDaysAhead(
										parseInt(
											e.target
												.value
										) || 30
									)
								}
								className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
							/>
							<p className="text-xs text-text-muted mt-1">
								Generate occurrences up to{" "}
								{daysAhead} days in the future
							</p>
						</div>
						<div className="flex gap-3">
							<button
								onClick={() =>
									setIsGenerateModalOpen(
										false
									)
								}
								className="flex-1 px-4 py-2 bg-surface-raised hover:bg-surface-raised rounded-md text-sm font-medium transition-colors duration-150 ease-out"
							>
								Cancel
							</button>
							<button
								onClick={handleGenerateOccurrences}
								disabled={
									generateMutation.isPending
								}
								className="flex-1 px-4 py-2 bg-primary-hover hover:bg-primary-active text-on-primary rounded-md text-sm font-medium transition-colors duration-150 ease-out disabled:opacity-50"
							>
								{generateMutation.isPending
									? "Generating..."
									: "Generate"}
							</button>
						</div>
					</div>
				</div>
			)}

			<ConfirmDialog
				open={pendingConfirm !== null}
				title={
					pendingConfirm === "cancel"
						? "Cancel Plan"
						: "Complete Plan"
				}
				body={
					pendingConfirm === "cancel"
						? "Are you sure you want to cancel this recurring plan? All future planned occurrences will be cancelled."
						: "Are you sure you want to mark this recurring plan as completed?"
				}
				confirmLabel={
					pendingConfirm === "cancel" ? "Cancel Plan" : "Complete"
				}
				tone={pendingConfirm === "cancel" ? "destructive" : "primary"}
				pending={cancelMutation.isPending || completeMutation.isPending}
				onConfirm={confirmPendingAction}
				onCancel={() => setPendingConfirm(null)}
			/>
		</div>
	);
}
