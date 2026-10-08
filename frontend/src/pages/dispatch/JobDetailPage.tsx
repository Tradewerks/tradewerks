import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
	Edit2,
	Calendar,
	CalendarCheck,
	Clock,
	Users,
	Plus,
	DollarSign,
	ChevronRight,
	Trash2,
	Repeat,
	AlertTriangle,
	X,
	Loader2,
} from "lucide-react";
import {
	useJobByIdQuery,
	useJobVisitsByJobIdQuery,
	useCreateJobVisitMutation,
	useDeleteJobMutation,
	useCancelJobVisitMutation,
} from "../../hooks/useJobs";
import { useInvoicesByJobIdQuery } from "../../hooks/useInvoices";
import JobMapTab from "../../components/jobs/JobMapTab";
import { isClosedVisit } from "../../lib/jobMapVisits";
import { useActiveTechCount } from "../../hooks/useRecordMapData";
import JobNoteManager from "../../components/jobs/JobNoteManager";
import JobFieldPurchases from "../../components/fieldPurchases/JobFieldPurchases";
import Card from "../../components/ui/Card";
import ClientDetailsCard from "../../components/clients/ClientDetailsCard";
import EditJob from "../../components/jobs/EditJob";
import CreateJobVisit from "../../components/jobs/CreateJobVisit";
import CreateInvoice from "../../components/invoices/CreateInvoice";
import LinkedInvoicesCard from "../../components/invoices/LinkedInvoicesCard";
import FullPopup from "../../components/ui/FullPopup";
import ReasonField from "../../components/ui/ReasonField";
import BalancedOverviewGrid from "../../components/detail/BalancedOverviewGrid";
import DetailHeader, { type DetailMenuGroup } from "../../components/detail/DetailHeader";
import DetailTabs, { type DetailTabDef } from "../../components/detail/DetailTabs";
import { useDetailTab } from "../../components/detail/useDetailTab";
import DetailStatRow from "../../components/detail/DetailStatRow";
import ActivityPanel from "../../components/detail/ActivityPanel";
import DetailFieldGrid from "../../components/detail/DetailFieldGrid";
import RelationCard from "../../components/detail/RelationCard";
import LifecycleBar, {
	LifecycleActions,
	LifecycleRule,
} from "../../components/lifecycle/LifecycleBar";
import TerminalDetail from "../../components/lifecycle/TerminalDetail";
import { jobActions, JOB_STEPS, isJobTerminal } from "../../components/lifecycle/jobActions";
import { placeActions } from "../../components/lifecycle/placement";
import type { LifecycleStage } from "../../components/lifecycle/types";
import {
	JobStatusColors,
	JobStatusLabels,
	VisitStatusColors,
	type VisitStatus,
} from "../../types/jobs";
import { RecurringPlanStatusColors, RecurringPlanStatusLabels } from "../../types/recurringPlans";
import { QuoteStatusColors, QuoteStatusLabels } from "../../types/quotes";
import { RequestStatusColors, RequestStatusLabels } from "../../types/requests";
import { getGenericStatusColor, PriorityColors } from "../../types/common";
import {
	formatCurrency,
	formatDate,
	formatDateTime,
	formatTime,
	errorMessage,
} from "../../util/util";
import FinancialSummary, {
	type FinancialSummaryLineItem,
} from "../../components/pagesections/FinancialSummary";
import { usePermission } from "../../hooks/usePermission";
import ChangeHistory from "../../components/activity/ChangeHistory";

// A tab per body of work someone opens the page to do. Scheduling a crew,
// chasing the money and reading what happened are separate, and none is context
// for the others.
const JOB_TABS: readonly DetailTabDef<
	"overview" | "visits" | "map" | "financials" | "activity"
>[] = [
	{ id: "overview", label: "Overview" },
	{ id: "visits", label: "Visits" },
	{ id: "map", label: "Map" },
	{ id: "financials", label: "Financials" },
	{ id: "activity", label: "Activity" },
];

interface CancelJobModalProps {
	open: boolean;
	/** Visits neither Completed nor Cancelled — the ones "Cancel Job" actually acts on. */
	openVisitCount: number;
	pending: boolean;
	error: string | null;
	onSubmit: (reason: string) => void;
	onClose: () => void;
}

/**
 * "Cancel Job" has no direct status write: jobVisitsController recomputes
 * job.status from its visits, so this modal cancels every open visit with the
 * given reason and lets that recompute carry the job to Cancelled.
 *
 * A job with no visits leaves the recompute nothing to act on, so it is an
 * explicit dead end here rather than a reason that cancels nothing.
 */
function CancelJobModal({
	open,
	openVisitCount,
	pending,
	error,
	onSubmit,
	onClose,
}: CancelJobModalProps) {
	const [reason, setReason] = useState("");

	const handleClose = () => {
		setReason("");
		onClose();
	};

	const nothingToCancel = openVisitCount === 0;
	const submitDisabled = pending || reason.trim().length === 0;

	const content = (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
				<div className="flex items-center gap-2">
					<AlertTriangle size={18} className="text-warning-text" />
					<h2 className="text-base font-semibold text-text-primary">
						Cancel Job
					</h2>
				</div>
				<button
					onClick={handleClose}
					className="p-1.5 hover:bg-surface rounded-md transition-colors duration-150 ease-out text-text-tertiary hover:text-text-primary"
				>
					<X size={16} />
				</button>
			</div>

			<div className="px-6 py-5 space-y-5">
				{nothingToCancel ? (
					<p className="text-sm text-text-tertiary">
						This job has no open visits to cancel. Schedule and
						cancel a visit, or edit the job directly, instead.
					</p>
				) : (
					<>
						<p className="text-sm text-text-secondary">
							Cancels every open visit on this job (
							{openVisitCount}{" "}
							{openVisitCount === 1 ? "visit" : "visits"})
							with the reason below. The job moves to
							Cancelled once none remain open.
						</p>
						<ReasonField
							value={reason}
							onChange={setReason}
							placeholder="Why is this job being cancelled?"
						/>
					</>
				)}
				{error && (
					<div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-md">
						<AlertTriangle
							size={14}
							className="text-error-text flex-shrink-0"
						/>
						<p className="text-sm text-error-text">{error}</p>
					</div>
				)}
			</div>

			<div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle">
				<button
					onClick={handleClose}
					disabled={pending}
					className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface rounded-md transition-colors duration-150 ease-out disabled:opacity-50"
				>
					{nothingToCancel ? "Close" : "Never Mind"}
				</button>
				{!nothingToCancel && (
					<button
						onClick={() => onSubmit(reason)}
						disabled={submitDisabled}
						className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-error hover:enabled:bg-error-strong disabled:opacity-50 disabled:cursor-not-allowed text-on-primary rounded-md transition-colors duration-150 ease-out"
					>
						{pending && (
							<Loader2
								size={14}
								className="animate-spin"
							/>
						)}
						Cancel Job
					</button>
				)}
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={open} onClose={handleClose} size="md" />;
}

export default function JobDetailPage() {
	const { jobId } = useParams<{ jobId: string }>();
	const navigate = useNavigate();
	const { data: job, isLoading } = useJobByIdQuery(jobId!);
	const { data: visits = [] } = useJobVisitsByJobIdQuery(jobId!);
	const {
		data: linkedInvoices = [],
		isLoading: invoicesLoading,
	} = useInvoicesByJobIdQuery(jobId!);

	const [activeTab, setActiveTab] = useDetailTab(JOB_TABS);
	// Ruling B2: closed visits never light the dot (mirrors the visit page's gate).
	const activeTechCount = useActiveTechCount(
		visits
			.filter((v) => !isClosedVisit(v))
			.map((v) => v.id),
	);
	const tabs = useMemo(
		() =>
			JOB_TABS.map((t) =>
				t.id === "map" ? { ...t, live: activeTechCount > 0 } : t,
			),
		[activeTechCount],
	);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [isCreateVisitModalOpen, setIsCreateVisitModalOpen] = useState(false);
	const [isCreateInvoiceOpen, setIsCreateInvoiceOpen] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [cancelJobModalOpen, setCancelJobModalOpen] = useState(false);
	const [isCancellingJob, setIsCancellingJob] = useState(false);
	const [cancelJobError, setCancelJobError] = useState<string | null>(null);

	const { mutateAsync: createJobVisitMutation } = useCreateJobVisitMutation();
	const cancelVisitMutation = useCancelJobVisitMutation();
	const deleteJobMutation = useDeleteJobMutation();

	// permissions
	const CREATE_JOB = usePermission("create_jobs");
	const EDIT_JOB = usePermission("edit_jobs");
	const DELETE_JOB = usePermission("delete_jobs");
	const CREATE_INVOICE = usePermission("create_invoices");

	// Derive per-visit billed totals from job invoices for the 3-state billing badge.
	const visitBilledMap = useMemo(() => {
		const record: Record<string, number> = {};
		for (const inv of linkedInvoices) {
			if (inv.status === "Void" || inv.status === "Draft") continue;
			for (const iv of inv.visits ?? []) {
				record[iv.visit.id] =
					(record[iv.visit.id] ?? 0) + Number(iv.billed_amount ?? 0);
			}
		}
		return record;
	}, [linkedInvoices]);

	const lineItems = useMemo((): FinancialSummaryLineItem[] => {
		const jobItems: FinancialSummaryLineItem[] = (job?.line_items ?? []).map(
			(item) => ({
				...item,
				sourceLabel: "Job Charges",
				isVisitSource: false,
			})
		);
		const visitItems: FinancialSummaryLineItem[] = (visits ?? [])
			.filter((v) => v.status === "Completed")
			.flatMap((v) =>
				(v.line_items ?? []).map((li) => ({
					...li,
					sourceLabel: v.scheduled_start_at
						? `Visit · ${new Date(
								v.scheduled_start_at
							).toLocaleDateString("en-US", {
								month: "short",
								day: "numeric",
							})}`
						: "Visit",
					isVisitSource: true,
				}))
			);
		return [...jobItems, ...visitItems];
	}, [job?.line_items, visits]);

	// Merged subtotal from all line items (job + completed visits).
	// Used instead of job.subtotal so the sidebar reflects the full merged picture.
	const mergedSubtotal = useMemo(() => {
		if (lineItems.length === 0) return null;
		const total = lineItems.reduce((sum, li) => {
			const t =
				li.total != null
					? Number(li.total)
					: Number(li.quantity) * Number(li.unit_price);
			return sum + (isNaN(t) ? 0 : t);
		}, 0);
		return total > 0 ? total : null;
	}, [lineItems]);

	const handleDeleteJob = async () => {
		if (!jobId) return;
		if (!deleteConfirm) {
			setDeleteConfirm(true);
			return;
		}
		try {
			await deleteJobMutation.mutateAsync(jobId);
			navigate("/dispatch/jobs");
		} catch (error) {
			console.error("Failed to delete job:", error);
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">
					Loading job details...
				</div>
			</div>
		);
	}

	if (!job) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Job not found</div>
			</div>
		);
	}

	const sortedVisits = [...visits].sort(
		(a, b) =>
			new Date(a.scheduled_start_at).getTime() -
			new Date(b.scheduled_start_at).getTime()
	);

	const hasLineItems = lineItems.length > 0;
	const recurringPlan = job.recurring_plan ?? null;

	const formatVisitTimeConstraints = (visit: (typeof visits)[0]): string => {
		const {
			arrival_constraint,
			finish_constraint,
			arrival_time,
			arrival_window_start,
			arrival_window_end,
			finish_time,
		} = visit;

		let arrivalStr = "";
		switch (arrival_constraint) {
			case "anytime":
				arrivalStr = "Anytime";
				break;
			case "at":
				arrivalStr = `At ${arrival_time}`;
				break;
			case "between":
				arrivalStr = `${arrival_window_start} - ${arrival_window_end}`;
				break;
			case "by":
				arrivalStr = `By ${arrival_window_end}`;
				break;
		}

		let finishStr = "";
		switch (finish_constraint) {
			case "when_done":
				finishStr = "when done";
				break;
			case "at":
				finishStr = `finish at ${finish_time}`;
				break;
			case "by":
				finishStr = `finish by ${finish_time}`;
				break;
		}

		return `${arrivalStr}, ${finishStr}`;
	};

	const completedVisits = visits.filter((v) => v.status === "Completed").length;
	const openVisitsList = visits.filter(
		(v) => v.status !== "Completed" && v.status !== "Cancelled"
	);
	const openVisitCount = openVisitsList.length;
	const nextVisitAt =
		openVisitsList.length > 0
			? openVisitsList.reduce(
					(earliest, v) =>
						new Date(v.scheduled_start_at).getTime() <
						new Date(earliest).getTime()
							? v.scheduled_start_at
							: earliest,
					openVisitsList[0].scheduled_start_at
				)
			: null;

	const handleCancelJobSubmit = async (reason: string) => {
		setIsCancellingJob(true);
		setCancelJobError(null);
		try {
			// Cancel every open visit; jobVisitsController's derive-from-visits
			// recompute carries the job itself to Cancelled once none remain open.
			await Promise.all(
				openVisitsList.map((v) =>
					cancelVisitMutation.mutateAsync({
						visitId: v.id,
						cancellationReason: reason,
					})
				)
			);
			setCancelJobModalOpen(false);
		} catch (error) {
			setCancelJobError(errorMessage(error, "Couldn't cancel this job."));
		} finally {
			setIsCancellingJob(false);
		}
	};

	const actions = jobActions({
		status: job.status,
		visitCount: visits.length,
		openVisitCount,
		canEdit: EDIT_JOB,
		canCreateVisit: CREATE_JOB,
		canCreateInvoice: CREATE_INVOICE,
		handlers: {
			scheduleVisit: () => setIsCreateVisitModalOpen(true),
			invoice: () => setIsCreateInvoiceOpen(true),
			cancel: () => setCancelJobModalOpen(true),
		},
	});

	// The stepper is a read-out, not a control: the backend recomputes job.status
	// from the visits, so these actions move visits and invoices instead.
	const stage: LifecycleStage = isJobTerminal(job.status) ? "terminal" : "normal";
	const { headerActions, barActions, overflow, showBar } = placeActions(stage, actions);

	// One button, two labeled groups: lifecycle above, utility below. Edit Job is
	// utility only — not a lifecycle transition, so jobActions doesn't offer it
	// and the bar carries no second copy to contradict this one.
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
			id: "job",
			label: "Job",
			items: [
				{
					id: "edit",
					label: "Edit Job",
					icon: <Edit2 size={16} />,
					disabled: !EDIT_JOB,
					disabledReason: EDIT_JOB
						? undefined
						: "You don't have permission to perform this action",
					onSelect: () => setIsEditModalOpen(true),
				},
				...(DELETE_JOB
					? [
							{
								id: "delete",
								label: deleteJobMutation.isPending
									? "Deleting..."
									: deleteConfirm
										? "Click Again to Confirm"
										: "Delete Job",
								icon: <Trash2 size={16} />,
								intent: "destructive" as const,
								disabled: deleteJobMutation.isPending,
								// The first click only arms the second, so the menu has to survive it.
								keepOpen: !deleteConfirm,
								onSelect: handleDeleteJob,
							},
						]
					: []),
			],
		},
	];

	const statTiles = [
		{
			label: "Job Total",
			icon: <DollarSign size={13} />,
			value: formatCurrency(Number(job.actual_total ?? job.estimated_total ?? 0)),
			hint: job.actual_total != null ? "actual" : "estimated",
		},
		{
			label: "Visits",
			icon: <CalendarCheck size={13} />,
			value: visits.length === 0 ? "None yet" : `${completedVisits} of ${visits.length}`,
			hint:
				visits.length === 0
					? undefined
					: openVisitCount > 0
						? `complete, ${openVisitCount} open`
						: "complete",
		},
		{
			label: "Next Visit",
			icon: <Calendar size={13} />,
			value: nextVisitAt != null ? formatDate(nextVisitAt) : "Nothing scheduled",
		},
	];

	const infoCard = (
		<Card className="flex-1" title="Job Information">
			<DetailFieldGrid
				fill
				lead={
					<p className="break-words text-text-primary">
						{job.description || "No description provided"}
					</p>
				}
				fields={[
					{ label: "Address", value: job.address },
					{ label: "Created", value: formatDate(job.created_at) },
				]}
			/>
		</Card>
	);

	const clientCard = <ClientDetailsCard fill client_id={job.client_id} client={job.client} />;

	const relationCards = (
		<>
			<RelationCard
				eyebrow="Related Request"
				to={job.request ? `/dispatch/requests/${job.request.id}` : undefined}
				emptyLabel="No originating request"
				title={job.request?.title}
				meta={
					job.request && (
						<>
							<Calendar size={12} />
							<span>{formatDate(job.request.created_at)}</span>
						</>
					)
				}
				trailing={
					job.request && (
						<span
							className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${
								RequestStatusColors[
									job.request
										.status as keyof typeof RequestStatusColors
								] ||
								getGenericStatusColor(
									job.request.status
								)
							}`}
						>
							{RequestStatusLabels[
								job.request.status as keyof typeof RequestStatusLabels
							] ?? job.request.status}
						</span>
					)
				}
			/>

			<RelationCard
				eyebrow="Related Quote"
				to={job.quote ? `/dispatch/quotes/${job.quote.id}` : undefined}
				emptyLabel="No quote created yet"
				title={job.quote?.quote_number}
				subtitle={job.quote?.title}
				meta={
					job.quote && (
						<>
							<Calendar size={12} />
							<span>{formatDate(job.quote.created_at)}</span>
						</>
					)
				}
				trailing={
					job.quote && (
						<>
							<span className="whitespace-nowrap text-sm font-semibold tabular-nums text-success-text">
								{formatCurrency(Number(job.quote.total))}
							</span>
							<span
								className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${
									QuoteStatusColors[
										job.quote
											.status as keyof typeof QuoteStatusColors
									] ||
									getGenericStatusColor(
										job.quote.status
									)
								}`}
							>
								{QuoteStatusLabels[
									job.quote.status as keyof typeof QuoteStatusLabels
								] ?? job.quote.status}
							</span>
						</>
					)
				}
			/>

			{recurringPlan && (
				<RelationCard
					eyebrow="Recurring Plan"
					to={`/dispatch/recurring-plans/${recurringPlan.id}`}
					emptyLabel="Not part of a recurring plan"
					icon={<Repeat />}
					title={recurringPlan.name}
					meta={
						<>
							<Calendar size={12} />
							<span>Started {formatDate(recurringPlan.starts_at)}</span>
						</>
					}
					trailing={
						<span
							className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${
								RecurringPlanStatusColors[
									recurringPlan.status
								] ||
								"bg-neutral/20 text-text-tertiary border-border-strong/30"
							}`}
						>
							{RecurringPlanStatusLabels[
								recurringPlan.status
							] || recurringPlan.status}
						</span>
					}
				/>
			)}
		</>
	);

	const financialSummaryCard =
		!job.estimated_total && !job.actual_total && !hasLineItems ? (
			<Card title="Financial Summary">
				<div className="text-center py-8">
					<DollarSign
						size={40}
						className="mx-auto text-text-faint mb-3"
					/>
					<h3 className="text-text-tertiary text-sm font-medium mb-1">
						No Financial Data
					</h3>
					<p className="text-text-muted text-xs">
						Edit this job to add estimated costs and line items.
					</p>
				</div>
			</Card>
		) : (
			<FinancialSummary
				lineItems={lineItems}
				taxSnapshot={null}
				legacyTaxRate={job.tax_rate != null ? Number(job.tax_rate) : null}
				legacyTaxAmount={
					job.tax_amount != null ? Number(job.tax_amount) : null
				}
				subtotal={mergedSubtotal}
				discountAmount={
					job.discount_amount != null
						? Number(job.discount_amount)
						: null
				}
				discountType={job.discount_type ?? null}
				discountValue={
					job.discount_value != null
						? Number(job.discount_value)
						: null
				}
				metaLabel="Job Number"
				metaValue={job.job_number}
				noLineItemsDescription="No line items have been added to this job yet."
				totalsContent={
					<>
						{/* Budget Variance — the one figure here the Job Total stat tile
						    above does NOT already say (it's a delta, not the total).
						    Estimated Total / Running Cost / Actual Total used to print here
						    too, each restating exactly what the tile shows in its own
						    active state (the tile always reads actual_total ??
						    estimated_total, regardless of status) — deleted per the
						    dedup rule rather than moved. */}
						{job.estimated_total != null &&
							Number(job.estimated_total) > 0 &&
							job.actual_total != null &&
							Number(job.actual_total) > 0 &&
							job.status === "Completed" && (
								<div
									className={`px-4 py-3 rounded-lg border-2 ${Number(job.actual_total) > Number(job.estimated_total) ? "bg-error/10 border-error/30" : "bg-success/10 border-success/30"}`}
								>
									<div className="flex items-center justify-between">
										<div>
											<p className="text-text-secondary text-xs uppercase tracking-wide font-semibold mb-0.5">
												Budget
												Variance
											</p>
											<p
												className={`text-xs ${Number(job.actual_total) > Number(job.estimated_total) ? "text-error-text" : "text-success-text"}`}
											>
												{Number(
													job.actual_total
												) >
												Number(
													job.estimated_total
												)
													? "Over Budget"
													: "Under Budget"}
											</p>
										</div>
										<div className="text-right">
											<p
												className={`text-xl font-bold tabular-nums ${Number(job.actual_total) > Number(job.estimated_total) ? "text-error-text" : "text-success-text"}`}
											>
												{Number(
													job.actual_total
												) >
												Number(
													job.estimated_total
												)
													? "+"
													: ""}
												{formatCurrency(
													Number(
														job.actual_total
													) -
														Number(
															job.estimated_total
														)
												)}
											</p>
											<p
												className={`text-sm font-semibold tabular-nums ${Number(job.actual_total) > Number(job.estimated_total) ? "text-error-text" : "text-success-text"}`}
											>
												{(
													((Number(
														job.actual_total
													) -
														Number(
															job.estimated_total
														)) /
														Number(
															job.estimated_total
														)) *
													100
												).toFixed(
													1
												)}
												%
											</p>
										</div>
									</div>
								</div>
							)}

						{job.estimated_total != null &&
							(job.actual_total == null ||
								Number(job.actual_total) === 0) &&
							job.status !== "Completed" && (
								<div className="px-4 py-3 bg-primary/10 border border-primary/30 rounded-lg">
									<p className="text-xs text-primary-text italic">
										<span className="font-semibold">
											Note:
										</span>{" "}
										Running cost
										accumulates as
										visits are completed
									</p>
								</div>
							)}
					</>
				}
			/>
		);

	const scheduledVisitsCard = (
		<Card
			title="Scheduled Visits"
			headerAction={
				visits.length > 0 ? (
					<button
						title={
							!CREATE_JOB
								? "You don't have permission to perform this action"
								: undefined
						}
						onClick={() => {
							if (!CREATE_JOB) return;
							setIsCreateVisitModalOpen(true);
						}}
						disabled={!CREATE_JOB}
						className="flex items-center gap-2 px-4 py-2 bg-primary-hover rounded-md text-sm font-medium text-on-primary transition-colors hover:enabled:bg-primary-active disabled:opacity-40 disabled:cursor-not-allowed"
					>
						<Plus size={16} />
						Create Visit
					</button>
				) : undefined
			}
		>
			{visits.length === 0 ? (
				<div className="text-center py-12">
					<Calendar
						size={48}
						className="mx-auto mb-3 opacity-50 text-text-faint"
					/>
					<p className="text-lg font-medium mb-2 text-text-tertiary">
						No visits scheduled
					</p>
					<p className="text-sm text-text-muted mb-4">
						Create a visit to schedule this job
					</p>
					<button
						title={
							!CREATE_JOB
								? "You don't have permission to perform this action"
								: undefined
						}
						onClick={() => {
							if (!CREATE_JOB) return;
							setIsCreateVisitModalOpen(true);
						}}
						disabled={!CREATE_JOB}
						className="inline-flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						<Plus size={16} />
						Create First Visit
					</button>
				</div>
			) : (
				<div className="flex flex-wrap gap-3">
					{sortedVisits.map((visit) => (
						<button
							key={visit.id}
							onClick={() =>
								navigate(
									`/dispatch/jobs/${jobId}/visits/${visit.id}`
								)
							}
							/* flex-col, because a <button> taller than its
							   content vertically centres that content — a UA
							   behaviour, not a class — and flex-wrap stretches
							   every card in a row to the tallest one. Together
							   they floated short cards' content to the middle
							   while the tall one sat at the top. */
							className="group flex w-fit cursor-pointer flex-col rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-surface-raised"
						>
							{visit.name && (
								<h4 className="text-text-primary font-semibold text-base mb-2 group-hover:text-primary-text transition-colors">
									{visit.name}
								</h4>
							)}

							<div className="flex items-start justify-between gap-4 mb-3">
								<div className="flex items-center gap-2 flex-wrap">
									<div
										className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
											VisitStatusColors[
												visit.status as VisitStatus
											] ||
											"bg-neutral/20 text-text-tertiary border-border-strong/30"
										}`}
									>
										{visit.status}
									</div>
									{(() => {
										const count =
											visit._count
												?.invoice_visits ??
											0;
										if (count === 0)
											return null;
										const billed =
											visitBilledMap[
												visit
													.id
											] ?? 0;
										const visitTotal =
											Number(
												visit.total ??
													0
											);
										const isPartial =
											visitTotal >
												0 &&
											billed <
												visitTotal;
										return (
											<span
												className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${
													isPartial
														? "border-warning-border bg-warning-bg text-warning-text"
														: "border-success-border bg-success-bg text-success-text"
												}`}
											>
												{isPartial
													? "Partial"
													: "Billed"}
											</span>
										);
									})()}
									<span className="text-text-muted text-sm">
										•
									</span>
									<span className="text-xs text-text-tertiary">
										{formatVisitTimeConstraints(
											visit
										)}
									</span>
								</div>
								<ChevronRight
									size={16}
									className="flex-shrink-0 text-text-tertiary transition-transform group-hover:translate-x-1 group-hover:text-primary-text"
								/>
							</div>

							{/* pb-3 rather than a margin on the rule below:
							    mt-auto owns that rule's top margin to pin it to
							    the card's bottom edge, so the breathing room
							    above the line has to come from this stack. */}
							<div className="space-y-2 pb-3">
								<div className="flex items-center gap-2 text-sm">
									<Clock
										size={16}
										className="text-text-tertiary flex-shrink-0"
									/>
									<span className="text-text-secondary whitespace-nowrap">
										{
											formatDateTime(
												visit.scheduled_start_at
											).split(
												" at "
											)[0]
										}{" "}
										•{" "}
										{formatTime(
											visit.scheduled_start_at
										)}{" "}
										-{" "}
										{formatTime(
											visit.scheduled_end_at
										)}
									</span>
								</div>

								{visit.visit_techs &&
									visit.visit_techs.length >
										0 && (
										<div className="flex items-center gap-2 text-sm">
											<Users
												size={
													16
												}
												className="text-text-tertiary flex-shrink-0"
											/>
											<span className="text-text-secondary">
												{visit.visit_techs
													.map(
														(
															vt
														) =>
															vt
																.tech
																.name
													)
													.join(
														", "
													)}
											</span>
										</div>
									)}

								{visit.description &&
									!visit.name && (
										<div className="text-xs text-text-tertiary italic mt-2 line-clamp-2">
											{
												visit.description
											}
										</div>
									)}

								</div>

							{/* Always drawn, and pinned to the bottom by
							    mt-auto: it is the card's closing boundary, so
							    a row of stretched cards ends on one line
							    rather than wherever each card's content ran
							    out. A visit that has not run yet says so —
							    an empty rule reads as a rendering fault. */}
							<div className="mt-auto border-t border-border pt-3 text-xs text-text-tertiary">
								{visit.actual_start_at &&
								visit.actual_end_at ? (
									<>
										Actual:{" "}
										{formatTime(
											visit.actual_start_at
										)}{" "}
										-{" "}
										{formatTime(
											visit.actual_end_at
										)}
									</>
								) : visit.actual_start_at ? (
									<>
										Started{" "}
										{formatTime(
											visit.actual_start_at
										)}
									</>
								) : (
									<span className="text-text-faint">
										Not started
									</span>
								)}
							</div>
						</button>
					))}
				</div>
			)}
		</Card>
	);

	const assignedTechniciansCard = (
		<Card
			title="Assigned Technicians"
			headerAction={
				visits.length > 0 &&
				visits.some((v) => v.visit_techs && v.visit_techs.length > 0) ? (
					<span className="text-sm text-text-tertiary">
						{visits.reduce(
							(acc, v) =>
								acc + (v.visit_techs?.length || 0),
							0
						)}{" "}
						assignments
					</span>
				) : undefined
			}
		>
			{visits.length === 0 ? (
				<div className="flex items-center justify-center min-h-[300px]">
					<div className="text-center">
						<Users
							size={48}
							className="mx-auto text-text-faint mb-3"
						/>
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No Visits Created
						</h3>
						<p className="text-text-muted text-sm max-w-sm mx-auto">
							Create a visit to assign technicians to this
							job.
						</p>
					</div>
				</div>
			) : visits.every((v) => !v.visit_techs || v.visit_techs.length === 0) ? (
				<div className="text-center py-12">
					<Users size={48} className="mx-auto text-text-faint mb-3" />
					<h3 className="text-text-tertiary text-lg font-medium mb-2">
						No Technicians Assigned
					</h3>
					<p className="text-text-muted text-sm max-w-sm mx-auto">
						Edit a visit to assign technicians to the job.
					</p>
				</div>
			) : (
				<div className="space-y-3">
					{sortedVisits
						.filter(
							(visit) =>
								visit.visit_techs &&
								visit.visit_techs.length > 0
						)
						.map((visit) => (
							<div key={visit.id} className="space-y-2">
								<button
									onClick={() =>
										navigate(
											`/dispatch/jobs/${jobId}/visits/${visit.id}`
										)
									}
									className="w-full flex items-center gap-2 text-xs text-text-tertiary hover:text-text-secondary mb-2 transition-colors group"
								>
									<Calendar size={12} />
									<span>
										{
											formatDateTime(
												visit.scheduled_start_at
											).split(
												" at "
											)[0]
										}{" "}
										•{" "}
										{formatTime(
											visit.scheduled_start_at
										)}{" "}
										-{" "}
										{formatTime(
											visit.scheduled_end_at
										)}
									</span>
									<span
										className={`ml-auto px-2 py-0.5 rounded text-xs font-medium border ${
											VisitStatusColors[
												visit.status as VisitStatus
											] ||
											"bg-neutral/20 text-text-tertiary border-border-strong/30"
										}`}
									>
										{visit.status}
									</span>
									<ChevronRight
										size={14}
										className="text-text-muted group-hover:text-text-secondary group-hover:translate-x-0.5 transition-all"
									/>
								</button>

								{visit.visit_techs.map((vt) => (
									<button
										key={vt.tech_id}
										onClick={(e) => {
											e.stopPropagation();
											navigate(
												`/dispatch/technicians/${vt.tech_id}`
											);
										}}
										className="w-full bg-surface hover:bg-surface-raised border border-border hover:border-border-strong rounded-lg p-3 transition-all cursor-pointer text-left group"
									>
										<div className="flex items-center gap-3">
											<div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-plan flex items-center justify-center flex-shrink-0 text-on-primary font-semibold text-sm">
												{vt.tech.name
													.split(
														" "
													)
													.map(
														(
															n
														) =>
															n[0]
													)
													.join(
														""
													)
													.toUpperCase()
													.slice(
														0,
														2
													)}
											</div>
											<div className="flex-1 min-w-0">
												<h4 className="text-text-primary font-medium text-sm truncate group-hover:text-primary-text transition-colors mb-1">
													{
														vt
															.tech
															.name
													}
												</h4>
												<div className="flex items-center gap-2 text-xs text-text-tertiary">
													<span className="truncate">
														{
															vt
																.tech
																.title
														}
													</span>
													{vt
														.tech
														.phone && (
														<>
															<span>
																•
															</span>
															<span className="truncate">
																{
																	vt
																		.tech
																		.phone
																}
															</span>
														</>
													)}
												</div>
											</div>
											<div className="flex items-center gap-2 flex-shrink-0">
												<span
													className={`px-2 py-1 rounded text-xs font-medium ${
														vt
															.tech
															.status ===
														"Available"
															? "bg-success/20 text-success-text border border-success/30"
															: vt
																		.tech
																		.status ===
																  "Busy"
																? "bg-error/20 text-error-text border border-error/30"
																: vt
																			.tech
																			.status ===
																	  "Offline"
																	? "bg-neutral/20 text-text-tertiary border border-border-strong/30"
																	: "bg-primary/20 text-primary-text border border-primary/30"
													}`}
												>
													{
														vt
															.tech
															.status
													}
												</span>
												<ChevronRight
													size={
														16
													}
													className="text-text-tertiary group-hover:translate-x-1 transition-transform"
												/>
											</div>
										</div>
									</button>
								))}
							</div>
						))}
				</div>
			)}
		</Card>
	);

	return (
		<div className="text-text-primary pb-4 md:pb-6">
			<div className="space-y-4">
				<DetailHeader
					title={job.name}
					meta={job.client?.name}
					badges={
						<span
							className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PriorityColors[job.priority]}`}
						>
							{job.priority}
						</span>
					}
					statusPill={
						<span
							className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${JobStatusColors[job.status]}`}
						>
							{JobStatusLabels[job.status]}
						</span>
					}
					inlineActions={<LifecycleActions actions={headerActions} />}
					menuGroups={menuGroups}
					menuLabel="Job actions"
					onMenuClose={() => setDeleteConfirm(false)}
				/>

				{showBar && (
					<LifecycleBar
						steps={JOB_STEPS}
						stepLabels={JobStatusLabels}
						tone={job.status === "Cancelled" ? "error" : undefined}
						stage={stage}
						currentStatus={job.status}
						track={false}
						actions={barActions}
						detail={
							<TerminalDetail
								reason={null}
								at={null}
								noReasonLabel="Cancelled — every visit on this job was cancelled."
							/>
						}
					/>
				)}

				<DetailTabs
					tabs={tabs}
					activeTab={activeTab}
					onSelect={setActiveTab}
					label="Job sections"
					progress={
						<LifecycleRule
							steps={JOB_STEPS}
							stepLabels={JobStatusLabels}
							currentStatus={job.status}
						/>
					}
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
						recordId={job.id}
						infoCard={infoCard}
						block={relationCards}
						railCard={clientCard}
					/>
				</div>
			)}

			{activeTab === "visits" && (
				<div
					role="tabpanel"
					id="tabpanel-visits"
					aria-labelledby="tab-visits"
					className="mt-6 space-y-4"
				>
					<h2 className="sr-only">Visits</h2>
					{scheduledVisitsCard}
					{assignedTechniciansCard}
				</div>
			)}

			{activeTab === "map" && (
				<div
					role="tabpanel"
					id="tabpanel-map"
					aria-labelledby="tab-map"
					className="mt-6"
				>
					<h2 className="sr-only">Map</h2>
					<JobMapTab key={job.id} job={job} visits={visits} />
				</div>
			)}

			{activeTab === "financials" && (
				<div
					role="tabpanel"
					id="tabpanel-financials"
					aria-labelledby="tab-financials"
					className="mt-6 space-y-4"
				>
					<h2 className="sr-only">Financials</h2>
					{financialSummaryCard}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
						<LinkedInvoicesCard
							invoices={linkedInvoices}
							isLoading={invoicesLoading}
							scope={{ kind: "job", jobId: jobId! }}
							scopeTotal={mergedSubtotal ?? 0}
							canCreate={CREATE_INVOICE}
							onCreate={() =>
								setIsCreateInvoiceOpen(true)
							}
						/>
						<JobFieldPurchases jobId={jobId!} />
					</div>
				</div>
			)}

			{activeTab === "activity" && (
				<ActivityPanel
					notes={<JobNoteManager jobId={jobId!} visits={visits} />}
					lifecycle={null}
					history={
						<ChangeHistory
							scope={{
								kind: "entity",
								type: "job",
								id: jobId ?? "",
							}}
						/>
					}
				/>
			)}

			{job && isEditModalOpen && (
				<EditJob
					isModalOpen={isEditModalOpen}
					setIsModalOpen={setIsEditModalOpen}
					job={job}
				/>
			)}

			<CreateJobVisit
				isModalOpen={isCreateVisitModalOpen}
				setIsModalOpen={setIsCreateVisitModalOpen}
				jobId={jobId!}
				createVisit={createJobVisitMutation}
				clientExempt={job?.client?.is_tax_exempt ?? false}
			/>

			<CreateInvoice
				isModalOpen={isCreateInvoiceOpen}
				setIsModalOpen={setIsCreateInvoiceOpen}
				initialJobId={jobId}
				defaultClientId={job?.client_id}
			/>

			<CancelJobModal
				open={cancelJobModalOpen}
				openVisitCount={openVisitCount}
				pending={isCancellingJob}
				error={cancelJobError}
				onSubmit={handleCancelJobSubmit}
				onClose={() => {
					setCancelJobModalOpen(false);
					setCancelJobError(null);
				}}
			/>
		</div>
	);
}
