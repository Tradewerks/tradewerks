import { useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
	Edit2,
	Clock,
	Users,
	Briefcase,
	DollarSign,
	MapPin,
	ArrowUpRight,
	AlertTriangle,
	X,
	Loader2,
} from "lucide-react";
import {
	useJobVisitByIdQuery,
	useJobByIdQuery,
	useVisitTransitionMutation,
	useCompleteJobVisitMutation,
	useCancelJobVisitMutation,
	useDelayJobVisitMutation,
} from "../../hooks/useJobs";
import { useInvoicesByVisitIdQuery } from "../../hooks/useInvoices";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import FullPopup from "../../components/ui/FullPopup";
import ReasonField from "../../components/ui/ReasonField";
import ClientDetailsCard from "../../components/clients/ClientDetailsCard";
import EditJobVisit from "../../components/jobs/EditJobVisit";
import JobNoteManager from "../../components/jobs/JobNoteManager";
import JobFieldPurchases from "../../components/fieldPurchases/JobFieldPurchases";
import CreateInvoice from "../../components/invoices/CreateInvoice";
import LinkedInvoicesCard from "../../components/invoices/LinkedInvoicesCard";
import FinancialSummary from "../../components/pagesections/FinancialSummary";
import DetailHeader, { type DetailMenuGroup } from "../../components/detail/DetailHeader";
import DetailTabs, { type DetailTabDef } from "../../components/detail/DetailTabs";
import { useDetailTab } from "../../components/detail/useDetailTab";
import DetailStatRow from "../../components/detail/DetailStatRow";
import ActivityPanel from "../../components/detail/ActivityPanel";
import DetailFieldGrid, { type DetailField } from "../../components/detail/DetailFieldGrid";
import LifecycleBar, {
	LifecycleActions,
	LifecycleRule,
} from "../../components/lifecycle/LifecycleBar";
import TerminalDetail from "../../components/lifecycle/TerminalDetail";
import {
	visitActions,
	VISIT_STEPS,
	isVisitTerminal,
	isVisitNonTerminalOffRamp,
} from "../../components/lifecycle/visitActions";
import { placeActions } from "../../components/lifecycle/placement";
import type { LifecycleStage } from "../../components/lifecycle/types";
import { HEADER_PILL } from "../../components/documents/DocumentLineage";
import { VisitStatusColors, VisitStatusLabels, type VisitLineItem } from "../../types/jobs";
import {
	formatCurrency,
	formatDate,
	formatDateTime,
	errorMessage,
	FALLBACK_TIMEZONE,
} from "../../util/util";
import { useAuthStore } from "../../auth/authStore";
import { usePermission, useAnyPermission } from "../../hooks/usePermission";
import { useActiveTechCount } from "../../hooks/useRecordMapData";
import RecordMap from "../../components/ui/maps/RecordMap";

// Overview holds what a dispatcher opens a visit to check: when it is, who is
// on it, what happened. Financials is a separate body of work, not context for
// the schedule. Activity is last, as on every detail page.
// Map sits beside Overview: "where is everyone" is the same glance as "who is on it".
const VISIT_TABS: readonly DetailTabDef<"overview" | "map" | "financials" | "activity">[] = [
	{ id: "overview", label: "Overview" },
	{ id: "map", label: "Map" },
	{ id: "financials", label: "Financials" },
	{ id: "activity", label: "Activity" },
];

// The exact set VALID_PAUSE_REASONS accepts in jobVisitsController. pause_reason
// is a strict Prisma enum, so free text vanishes server-side — toPauseReason()
// returns undefined for anything else. VisitActionButtons' technician-side
// picker is missing "Break" and needs reconciling with this list.
const PAUSE_REASONS = [
	{ value: "AwaitingMaterials", label: "Awaiting Materials" },
	{ value: "EquipmentIssue", label: "Equipment Issue" },
	{ value: "Break", label: "Break" },
	{ value: "Other", label: "Other" },
] as const;

interface VisitReasonModalProps {
	open: boolean;
	/** Cancel's reason is a required free string on job_visit. Pause's is the
	 *  enum above, optional and stored per clocked-in tech
	 *  (visit_tech_time_entry). One shell, branching on `mode` below. */
	mode: "pause" | "cancel";
	pending: boolean;
	error: string | null;
	onSubmit: (reason: string) => void;
	onClose: () => void;
}

function VisitReasonModal({
	open,
	mode,
	pending,
	error,
	onSubmit,
	onClose,
}: VisitReasonModalProps) {
	const [reason, setReason] = useState("");

	const handleClose = () => {
		setReason("");
		onClose();
	};

	const title = mode === "cancel" ? "Cancel Visit" : "Pause Visit";
	const submitDisabled = pending || (mode === "cancel" && reason.trim().length === 0);

	const content = (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
				<div className="flex items-center gap-2">
					<AlertTriangle size={18} className="text-warning-text" />
					<h2 className="text-base font-semibold text-text-primary">
						{title}
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
				{mode === "cancel" ? (
					<ReasonField
						value={reason}
						onChange={setReason}
						placeholder="Why is this visit being cancelled?"
					/>
				) : (
					<div>
						<p className="block text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
							Reason (optional)
						</p>
						<div className="grid grid-cols-2 gap-2">
							{PAUSE_REASONS.map((r) => (
								<button
									key={r.value}
									type="button"
									onClick={() =>
										setReason(
											reason ===
												r.value
												? ""
												: r.value
										)
									}
									className={`py-2.5 px-2.5 rounded-lg text-sm font-medium border text-center transition-colors duration-150 ease-out ${
										reason === r.value
											? "border-primary bg-primary/10 text-primary-text"
											: "border-border bg-surface text-text-secondary hover:bg-surface-raised"
									}`}
								>
									{r.label}
								</button>
							))}
						</div>
					</div>
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
					Cancel
				</button>
				<button
					onClick={() => onSubmit(reason)}
					disabled={submitDisabled}
					className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary-hover hover:bg-primary disabled:opacity-50 disabled:cursor-not-allowed text-on-primary rounded-md transition-colors duration-150 ease-out"
				>
					{pending && <Loader2 size={14} className="animate-spin" />}
					{title}
				</button>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={open} onClose={handleClose} size="md" />;
}

export default function JobVisitDetailPage() {
	const { jobId, visitId } = useParams<{ jobId: string; visitId: string }>();
	const navigate = useNavigate();
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
	const { data: visit, isLoading: visitLoading } = useJobVisitByIdQuery(visitId!);
	const { data: job, isLoading: jobLoading } = useJobByIdQuery(jobId!);

	const [activeTab, setActiveTab] = useDetailTab(VISIT_TABS);
	const activeTechCount = useActiveTechCount(visitId ? [visitId] : []);
	// A stale EnRoute/OnSite in the feed must not light a closed visit's Map tab.
	const visitOpen = visit?.status !== "Completed" && visit?.status !== "Cancelled";
	const tabs = useMemo(
		() =>
			VISIT_TABS.map((t) =>
				t.id === "map" ? { ...t, live: visitOpen && activeTechCount > 0 } : t,
			),
		[activeTechCount, visitOpen],
	);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [isCreateInvoiceOpen, setIsCreateInvoiceOpen] = useState(false);
	const [pendingConfirm, setPendingConfirm] = useState<"complete" | "delay" | null>(null);
	const [reasonModal, setReasonModal] = useState<"pause" | "cancel" | null>(null);

	const {
		data: linkedInvoices = [],
		isLoading: invoicesLoading,
	} = useInvoicesByVisitIdQuery(jobId!, visitId!);

	// Drive/arrive/start/resume/pause share the one transition endpoint;
	// complete, delay and cancel have their own dedicated mutations.
	const transitionMutation = useVisitTransitionMutation();
	const completeVisitMutation = useCompleteJobVisitMutation();
	const delayVisitMutation = useDelayJobVisitMutation();
	const cancelVisitMutation = useCancelJobVisitMutation();

	const isLoading = visitLoading || jobLoading;

	// permissions
	const EDIT_VISIT = usePermission("edit_jobs");
	const CREATE_INVOICE = usePermission("create_invoices");
	const UPDATE_VISIT = useAnyPermission(["edit_jobs", "update_visit_status"]);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">
					Loading visit details...
				</div>
			</div>
		);
	}

	if (!visit) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Visit not found</div>
			</div>
		);
	}

	const applyVerb = async (verb: "drive" | "arrive" | "start" | "resume") => {
		try {
			await transitionMutation.mutateAsync({ visitId: visitId!, action: verb });
		} catch (error) {
			console.error(`Failed to ${verb} visit:`, error);
		}
	};

	const handlePauseSubmit = async (reason: string) => {
		try {
			await transitionMutation.mutateAsync({
				visitId: visitId!,
				action: "pause",
				pauseReason: reason.trim() || undefined,
			});
			setReasonModal(null);
		} catch (error) {
			console.error("Failed to pause visit:", error);
		}
	};

	const handleCancelSubmit = async (reason: string) => {
		try {
			await cancelVisitMutation.mutateAsync({
				visitId: visitId!,
				cancellationReason: reason.trim(),
			});
			setReasonModal(null);
		} catch (error) {
			console.error("Failed to cancel visit:", error);
		}
	};

	const confirmPendingAction = async () => {
		try {
			if (pendingConfirm === "complete") {
				await completeVisitMutation.mutateAsync(visitId!);
			} else if (pendingConfirm === "delay") {
				await delayVisitMutation.mutateAsync(visitId!);
			}
			setPendingConfirm(null);
		} catch (error) {
			console.error(`Failed to ${pendingConfirm} visit:`, error);
		}
	};

	const lineItems: VisitLineItem[] = visit.line_items || [];
	const lineItemCount = lineItems.length;

	const formatConstraintTime = (time: string | null | undefined): string => {
		if (!time) return "";
		const [hours, minutes] = time.split(":").map(Number);
		const period = hours >= 12 ? "PM" : "AM";
		const displayHours = hours % 12 || 12;
		const displayMinutes = minutes > 0 ? `:${minutes.toString().padStart(2, "0")}` : "";
		return `${displayHours}${displayMinutes} ${period}`;
	};

	const openEnded = visit.finish_constraint === "when_done";
	const hasActuals = Boolean(visit.actual_start_at && visit.actual_end_at);

	const formatDuration = (minutes: number): string => {
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		if (hours === 0) return `${mins} ${mins === 1 ? "minute" : "minutes"}`;
		if (mins === 0) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
		return `${hours} ${hours === 1 ? "hour" : "hours"} ${mins} ${mins === 1 ? "minute" : "minutes"}`;
	};

	const actualMinutes = hasActuals
		? Math.round(
				(new Date(visit.actual_end_at!).getTime() -
					new Date(visit.actual_start_at!).getTime()) /
					(1000 * 60)
			)
		: null;

	const scheduledMinutes =
		!openEnded && visit.scheduled_start_at && visit.scheduled_end_at
			? Math.round(
					(new Date(visit.scheduled_end_at).getTime() -
						new Date(visit.scheduled_start_at).getTime()) /
						(1000 * 60)
				)
			: null;

	const actions = visitActions({
		status: visit.status,
		canUpdateStatus: UPDATE_VISIT,
		handlers: {
			drive: () => applyVerb("drive"),
			arrive: () => applyVerb("arrive"),
			start: () => applyVerb("start"),
			pause: () => setReasonModal("pause"),
			resume: () => applyVerb("resume"),
			delay: () => setPendingConfirm("delay"),
			complete: () => setPendingConfirm("complete"),
			cancel: () => setReasonModal("cancel"),
		},
	});

	const stage: LifecycleStage = isVisitTerminal(visit.status) ? "terminal" : "normal";
	// Feeds placeActions — the Rule 2 inversion that promotes the one live exit
	// ahead of dead buttons — and the rule's offRamp prop, so the rail claims
	// no position.
	const isOffRamp = isVisitNonTerminalOffRamp(visit.status);
	const { headerActions, barActions, overflow, showBar } = placeActions(stage, actions, {
		offRamp: isOffRamp,
	});

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
			id: "visit",
			label: "Visit",
			items: [
				{
					id: "edit",
					label: "Edit Visit",
					icon: <Edit2 size={16} />,
					disabled: !EDIT_VISIT,
					disabledReason: EDIT_VISIT
						? undefined
						: "You don't have permission to perform this action",
					onSelect: () => setIsEditModalOpen(true),
				},
			],
		},
	];

	// Cancellation is the only visit status with a "terminal" stage — Paused and
	// Delayed stay normal, with live exits — and the only off-ramp whose reason
	// the visit stores itself, so it is the only case `detail` renders.
	const offRampDetail = (
		<TerminalDetail
			reason={visit.cancellation_reason}
			at={null}
			noReasonLabel="Cancelled with no reason recorded."
		/>
	);

	const statTiles = [
		{
			label: "Visit Total",
			icon: <DollarSign size={13} />,
			value: formatCurrency(Number(visit.total ?? 0)),
			hint: `${lineItemCount} ${lineItemCount === 1 ? "line item" : "line items"}`,
		},
		{
			label: "Duration",
			icon: <Clock size={13} />,
			value:
				actualMinutes != null
					? formatDuration(actualMinutes)
					: "Not started",
			hint:
				scheduledMinutes != null
					? `${formatDuration(scheduledMinutes)} scheduled`
					: "no window set",
		},
		{
			label: "Drive",
			icon: <MapPin size={13} />,
			value:
				visit.estimated_drive_miles != null
					? `${visit.estimated_drive_miles.toFixed(1)} mi`
					: "Not recorded",
		},
		{
			label: "Technicians",
			icon: <Users size={13} />,
			value: `${visit.visit_techs?.length ?? 0}`,
		},
	];

	const constraintLines = (
		<div className="space-y-1">
			<p>{formatDate(visit.scheduled_start_at, tz)}</p>
			{visit.arrival_constraint === "at" && visit.arrival_time && (
				<p className="text-xs text-text-tertiary">
					Arrive at {formatConstraintTime(visit.arrival_time)}
				</p>
			)}
			{visit.arrival_constraint === "between" &&
				visit.arrival_window_start &&
				visit.arrival_window_end && (
					<p className="text-xs text-text-tertiary">
						Arrival window{" "}
						{formatConstraintTime(visit.arrival_window_start)} –{" "}
						{formatConstraintTime(visit.arrival_window_end)}
					</p>
				)}
			{visit.arrival_constraint === "by" && visit.arrival_window_end && (
				<p className="text-xs text-text-tertiary">
					Arrive by {formatConstraintTime(visit.arrival_window_end)}
				</p>
			)}
			{visit.finish_constraint === "at" && visit.finish_time && (
				<p className="text-xs text-text-tertiary">
					Finish at {formatConstraintTime(visit.finish_time)}
				</p>
			)}
			{visit.finish_constraint === "by" && visit.finish_time && (
				<p className="text-xs text-text-tertiary">
					Finish by {formatConstraintTime(visit.finish_time)}
				</p>
			)}
		</div>
	);

	const visitClosed = visit.status === "Completed" || visit.status === "Cancelled";

	// Drive distance is a stat tile and the cancellation reason is the lifecycle
	// bar's terminal detail, so neither appears here. Constraints are already
	// carried by constraintLines, which qualifies the Scheduled time.
	const infoFields: DetailField[] = [
		{ label: "Scheduled", value: constraintLines },
		...(visit.actual_start_at
			? [{ label: "Started", value: formatDateTime(visit.actual_start_at, tz) }]
			: []),
		...(visit.actual_end_at
			? [{ label: "Ended", value: formatDateTime(visit.actual_end_at, tz) }]
			: []),
	];

	const infoCard = (
		<Card className="flex-1" title="Visit Information">
			<DetailFieldGrid
				fill
				lead={
					visit.description ? (
						<p className="break-words text-text-primary">
							{visit.description}
						</p>
					) : undefined
				}
				fields={infoFields}
			/>
		</Card>
	);

	const clientCard = job ? (
		<ClientDetailsCard fill client_id={job.client_id} client={job.client} />
	) : (
		<Card className="flex-1" title="Client Details">
			<p className="text-text-muted text-sm">Loading client details...</p>
		</Card>
	);

	const techniciansCard = (
		<Card
			title="Assigned Technicians"
			headerAction={
				visit.visit_techs && visit.visit_techs.length > 0 ? (
					<span className="text-sm text-text-tertiary">
						{visit.visit_techs.length}{" "}
						{visit.visit_techs.length === 1
							? "technician"
							: "technicians"}
					</span>
				) : undefined
			}
		>
			{!visit.visit_techs || visit.visit_techs.length === 0 ? (
				<div className="text-center py-8">
					<Users size={40} className="mx-auto text-text-faint mb-3" />
					<h3 className="text-text-tertiary text-sm font-medium mb-1">
						No Technicians Assigned
					</h3>
					<p className="text-text-muted text-xs">
						Edit this visit to assign technicians.
					</p>
				</div>
			) : (
				<div className="flex flex-wrap gap-3">
					{visit.visit_techs.map((vt) => (
						<button
							key={vt.tech_id}
							onClick={() =>
								navigate(
									`/dispatch/technicians/${vt.tech_id}`
								)
							}
							className="relative bg-surface hover:bg-surface-raised border border-border hover:border-border-strong rounded-lg p-3 transition-colors duration-150 ease-out cursor-pointer text-left group w-52 flex-shrink-0"
						>
							<div
								className={`absolute top-2.5 right-2.5 w-2 h-2 rounded-full ${vt.tech.status === "Available" ? "bg-success" : vt.tech.status === "Busy" ? "bg-error" : vt.tech.status === "Offline" ? "bg-border" : "bg-info"}`}
							/>
							<div className="flex items-center gap-2 mb-2">
								<div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-plan flex items-center justify-center flex-shrink-0 text-on-primary text-xs font-semibold">
									{vt.tech.name
										.split(" ")
										.map((n) => n[0])
										.join("")
										.toUpperCase()
										.slice(0, 2)}
								</div>
								<div className="flex-1 min-w-0 pr-3">
									<h4 className="text-text-primary font-medium text-sm truncate group-hover:text-primary-text transition-colors duration-150 ease-out">
										{vt.tech.name}
									</h4>
									<p className="text-text-tertiary text-xs truncate">
										{vt.tech.title}
									</p>
								</div>
							</div>
							<div className="space-y-1 text-xs">
								{vt.tech.email && (
									<p className="text-text-tertiary truncate">
										{vt.tech.email}
									</p>
								)}
								{vt.tech.phone && (
									<p className="text-text-tertiary">
										{vt.tech.phone}
									</p>
								)}
							</div>
						</button>
					))}
				</div>
			)}
		</Card>
	);

	const visitFinancialBlock = (
		<FinancialSummary
			lineItems={lineItems}
			taxSnapshot={visit.tax_snapshot}
			legacyTaxRate={visit.tax_rate != null ? Number(visit.tax_rate) : null}
			legacyTaxAmount={visit.tax_amount != null ? Number(visit.tax_amount) : null}
			subtotal={visit.subtotal != null ? Number(visit.subtotal) : null}
			discountAmount={
				visit.discount_amount != null ? Number(visit.discount_amount) : null
			}
			discountType={visit.discount_type ?? null}
			discountValue={
				visit.discount_value != null ? Number(visit.discount_value) : null
			}
			metaLabel="Visit Date"
			metaValue={formatDateTime(visit.scheduled_start_at, tz).split(" at ")[0]}
			cardTitle="Visit Financial Summary"
			noLineItemsDescription="No line items have been added to this visit yet."
			totalsContent={
				// A plain ledger line, not the highlighted card the quote and
				// invoice pages use: that would restate the Visit Total tile.
				<div className="flex items-center justify-between text-sm">
					<span className="text-text-primary font-semibold">
						Total:
					</span>
					<span className="text-text-primary font-semibold tabular-nums">
						{formatCurrency(Number(visit.total ?? 0))}
					</span>
				</div>
			}
		/>
	);

	// Denominator for the billing verdict. The card derives everything else
	// from the invoice payload itself.
	const visitTotal = lineItems.reduce(
		(sum, item) => sum + Number(item.total ?? 0),
		0
	);

	const reasonModalPending =
		reasonModal === "cancel"
			? cancelVisitMutation.isPending
			: transitionMutation.isPending;
	const reasonModalError =
		reasonModal === "cancel"
			? cancelVisitMutation.error
				? errorMessage(
						cancelVisitMutation.error,
						"Something went wrong. Please try again."
					)
				: null
			: reasonModal === "pause" && transitionMutation.error
				? errorMessage(
						transitionMutation.error,
						"Something went wrong. Please try again."
					)
				: null;

	return (
		<div className="text-text-primary pb-4 md:pb-6">
			<div className="space-y-4">
				<DetailHeader
					title={visit.name ?? "Job Visit"}
					badges={
						job ? (
							<Link
								to={`/dispatch/jobs/${visit.job_id}`}
								className={`${HEADER_PILL} border-border bg-surface text-primary-text hover:border-border-strong`}
							>
								<Briefcase size={13} />
								{job.job_number} · {job.name}
							</Link>
						) : undefined
					}
					meta={job?.client?.name}
					statusPill={
						<span
							className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${VisitStatusColors[visit.status]}`}
						>
							{VisitStatusLabels[visit.status]}
						</span>
					}
					inlineActions={<LifecycleActions actions={headerActions} />}
					menuGroups={menuGroups}
					menuLabel="Visit actions"
				/>

				{showBar && (
					<LifecycleBar
						steps={VISIT_STEPS}
						stepLabels={VisitStatusLabels}
						tone={
							visit.status === "Cancelled"
								? "error"
								: undefined
						}
						stage={stage}
						currentStatus={visit.status}
						track={false}
						actions={barActions}
						detail={offRampDetail}
					/>
				)}

				<DetailTabs
					tabs={tabs}
					activeTab={activeTab}
					onSelect={setActiveTab}
					label="Visit sections"
					progress={
						<LifecycleRule
							steps={VISIT_STEPS}
							stepLabels={VisitStatusLabels}
							currentStatus={visit.status}
							offRamp={isOffRamp}
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

					{/* Both cells stretched. This page's main column is usually the
					    taller one, so the slack lands in the client card's footer
					    gutter; at four or more technicians the technicians card
					    wraps and the rail ends early, which is the declared
					    extreme case. */}
					<div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
						<div className="lg:col-span-2 flex flex-col gap-4">
							{infoCard}
							{techniciansCard}
						</div>
						<div className="lg:col-span-1 flex flex-col">{clientCard}</div>
					</div>
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
					<RecordMap
						site={{
							coords: job?.coords ?? visit.job?.coords,
							label: job?.client?.name ?? job?.name ?? "Job site",
						}}
						address={job?.address ?? ""}
						techIds={visit.visit_techs.map((vt) => vt.tech_id)}
						focusVisitIds={[visit.id]}
						hideTechs={visitClosed}
						hiddenNote={visitClosed ? "Visit closed — live positions hidden." : undefined}
					/>
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
					{visitFinancialBlock}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
						<LinkedInvoicesCard
							invoices={linkedInvoices}
							isLoading={invoicesLoading}
							scope={{
								kind: "visit",
								visitId: visitId!,
							}}
							scopeTotal={visitTotal}
							canCreate={CREATE_INVOICE}
							onCreate={() =>
								setIsCreateInvoiceOpen(true)
							}
							tz={tz}
						/>
						<JobFieldPurchases
							jobId={jobId!}
							visitId={visitId!}
						/>
					</div>
				</div>
			)}

			{activeTab === "activity" && (
				<ActivityPanel
					notes={
						<JobNoteManager
							jobId={jobId!}
							visits={[visit]}
							visitId={visitId!}
						/>
					}
					lifecycle={null}
					history={
						/* The change log is grouped by job, not by visit — ENTITY_GROUPS
						   in logsController has no job_visit key, so a visit-scoped query
						   has nothing to resolve. Rather than mount a control that can
						   only ever be empty, the column points at the log that does
						   hold this visit's rows. */
						<Card title="Change History">
							<div className="rounded-lg border border-dashed border-border-subtle p-6 text-center">
								<p className="text-sm text-text-tertiary">
									Changes to this visit are
									recorded in the job's
									history.
								</p>
								<Link
									to={`/dispatch/jobs/${visit.job_id}?tab=activity`}
									className="mt-2 inline-flex items-center gap-1 text-sm text-primary-text underline transition-colors duration-150 ease-out hover:text-text-primary"
								>
									Open job history
									<ArrowUpRight size={14} />
								</Link>
							</div>
						</Card>
					}
				/>
			)}

			{visit && job && isEditModalOpen && (
				<EditJobVisit
					isModalOpen={isEditModalOpen}
					setIsModalOpen={setIsEditModalOpen}
					visit={visit}
					jobId={jobId!}
					clientExempt={job?.client?.is_tax_exempt ?? false}
				/>
			)}

			<CreateInvoice
				isModalOpen={isCreateInvoiceOpen}
				setIsModalOpen={setIsCreateInvoiceOpen}
				initialVisitIds={visitId ? [visitId] : []}
				initialJobId={jobId}
				defaultClientId={job?.client_id}
			/>

			<ConfirmDialog
				open={pendingConfirm !== null}
				title={
					pendingConfirm === "complete"
						? "Complete Visit"
						: "Delay Visit"
				}
				body={
					pendingConfirm === "complete"
						? "Are you sure you want to mark this visit as completed? This will record the actual end time."
						: "Mark this visit as Delayed? The technician will remain in their current state until the visit is resumed."
				}
				confirmLabel={pendingConfirm === "complete" ? "Complete" : "Delay"}
				pending={
					completeVisitMutation.isPending ||
					delayVisitMutation.isPending
				}
				onConfirm={confirmPendingAction}
				onCancel={() => setPendingConfirm(null)}
			/>

			<VisitReasonModal
				open={reasonModal !== null}
				mode={reasonModal ?? "pause"}
				pending={reasonModalPending}
				error={reasonModalError}
				onSubmit={(reason) => {
					if (reasonModal === "cancel")
						void handleCancelSubmit(reason);
					else if (reasonModal === "pause")
						void handlePauseSubmit(reason);
				}}
				onClose={() => {
					setReasonModal(null);
					transitionMutation.reset();
					cancelVisitMutation.reset();
				}}
			/>
		</div>
	);
}
