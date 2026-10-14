import { useParams, useNavigate } from "react-router-dom";
import { Edit2, Calendar, DollarSign, Globe } from "lucide-react";
import { useRequestByIdQuery, useUpdateRequestMutation } from "../../hooks/useRequests";
import { useCreateQuoteMutation } from "../../hooks/useQuotes";
import { useCreateJobMutation } from "../../hooks/useJobs";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ClientDetailsCard from "../../components/clients/ClientDetailsCard";
import EditRequest from "../../components/requests/EditRequest";
import ConvertToQuote from "../../components/requests/ConvertToQuote";
import ConvertToJob from "../../components/requests/ConvertToJob";
import NoteManager from "../../components/requests/RequestNoteManager";
import { useState, useEffect } from "react";
import { usePermission } from "../../hooks/usePermission";
import ChangeHistory from "../../components/activity/ChangeHistory";
import LifecycleBar, {
	LifecycleActions,
	LifecycleRule,
} from "../../components/lifecycle/LifecycleBar";
import TerminalDetail from "../../components/lifecycle/TerminalDetail";
import {
	requestActions,
	REQUEST_STEPS,
	isRequestTerminalOffRamp,
	isRequestNonTerminalOffRamp,
} from "../../components/lifecycle/requestActions";
import { placeActions } from "../../components/lifecycle/placement";
import type { LifecycleStage } from "../../components/lifecycle/types";
import BalancedOverviewGrid from "../../components/detail/BalancedOverviewGrid";
import DetailHeader, { type DetailMenuGroup } from "../../components/detail/DetailHeader";
import DetailTabs, { type DetailTabDef } from "../../components/detail/DetailTabs";
import { useDetailTab } from "../../components/detail/useDetailTab";
import DetailStatRow from "../../components/detail/DetailStatRow";
import ActivityPanel from "../../components/detail/ActivityPanel";
import DetailFieldGrid, { type DetailField } from "../../components/detail/DetailFieldGrid";
import RelationCard from "../../components/detail/RelationCard";
import { RequestStatusColors, RequestStatusLabels } from "../../types/requests";
import type { RequestStatus } from "../../types/requests";
import { QuoteStatusColors, QuoteStatusLabels } from "../../types/quotes";
import type { QuoteStatus } from "../../types/quotes";
import { JobStatusColors, JobStatusLabels } from "../../types/jobs";
import type { JobStatus } from "../../types/jobs";
import { PriorityColors } from "../../types/common";
import { formatCurrency, formatDate } from "../../util/util";

// Two tabs: the request's own details and its two relations stay in Overview,
// and Activity takes the notes and change history.
const REQUEST_TABS: readonly DetailTabDef<"overview" | "activity">[] = [
	{ id: "overview", label: "Overview" },
	{ id: "activity", label: "Activity" },
];

// What the terminal stage says for a status that stores no reason. The three
// off-ramps each have an implicit one, so "no reason recorded" would be a lie.
const TERMINAL_COPY: Partial<Record<RequestStatus, string>> = {
	QuoteRejected: "The client rejected the quote raised from this request.",
	ConvertedToJob: "This request became a job — the job is the live record now.",
	Cancelled: "Cancelled before it reached a quote.",
};

/** Sources are stored as keys: "phone" → "Phone", "walk_in" → "Walk In". */
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function RequestDetailPage() {
	const { requestId } = useParams<{ requestId: string }>();
	const navigate = useNavigate();
	const { data: request, isLoading } = useRequestByIdQuery(requestId!);
	const { mutateAsync: updateRequest, isPending: isUpdatingRequest } =
		useUpdateRequestMutation();
	const { mutateAsync: createQuote } = useCreateQuoteMutation();
	const { mutateAsync: createJob } = useCreateJobMutation();

	const [activeTab, setActiveTab] = useDetailTab(REQUEST_TABS);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [isConvertToQuoteModalOpen, setIsConvertToQuoteModalOpen] = useState(false);
	const [isConvertToJobModalOpen, setIsConvertToJobModalOpen] = useState(false);
	const [isCancelConfirmOpen, setIsCancelConfirmOpen] = useState(false);
	const [hasManualStatusChange, setHasManualStatusChange] = useState(false);
	const [hasAutoUpdated, setHasAutoUpdated] = useState(false);
	const [autoAdvancePending, setAutoAdvancePending] = useState(false);

	// permissions
	const EDIT_REQUEST = usePermission("edit_requests");
	const CREATE_QUOTE = usePermission("create_quotes");
	const CREATE_JOB = usePermission("create_jobs");

	// Auto-update: New → Reviewing after 5 seconds
	useEffect(() => {
		if (
			!request ||
			request.status !== "New" ||
			hasManualStatusChange ||
			hasAutoUpdated
		) {
			setAutoAdvancePending(false);
			return;
		}

		setAutoAdvancePending(true);
		const timeoutId = setTimeout(() => {
			if (!hasManualStatusChange && !hasAutoUpdated) {
				setHasAutoUpdated(true);
				setAutoAdvancePending(false);
				updateRequest({ id: request.id, data: { status: "Reviewing" } });
			}
		}, 5000);

		return () => {
			clearTimeout(timeoutId);
			setAutoAdvancePending(false);
		};
	}, [request?.id, request?.status, hasManualStatusChange, hasAutoUpdated, updateRequest]);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">
					Loading request details...
				</div>
			</div>
		);
	}

	if (!request) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Request not found</div>
			</div>
		);
	}

	const firstQuote = request.quotes?.[0] ?? null;
	const firstJob = request.jobs?.[0] ?? null;

	const actions = requestActions({
		status: request.status,
		// `quote`/`job` singular fields don't exist on Request — the relation
		// arrives as `quotes`/`jobs`, so presence is read off the same
		// first-element derivation the relation cards use.
		hasQuote: Boolean(firstQuote),
		hasJob: Boolean(firstJob),
		autoAdvancePending,
		canEdit: EDIT_REQUEST,
		canCreateQuote: CREATE_QUOTE,
		canCreateJob: CREATE_JOB,
		handlers: {
			review: () => {
				setHasManualStatusChange(true);
				updateRequest({ id: request.id, data: { status: "Reviewing" } });
			},
			quote: () => setIsConvertToQuoteModalOpen(true),
			job: () => setIsConvertToJobModalOpen(true),
			// The flag is set on open, not on confirm: a New request may have
			// the five-second auto-advance timer armed, and leaving it running
			// while the dialog sits open would write Reviewing mid-decision.
			cancel: () => {
				setHasManualStatusChange(true);
				setIsCancelConfirmOpen(true);
			},
		},
	});

	const confirmCancel = async () => {
		try {
			await updateRequest({
				id: request.id,
				data: { status: "Cancelled" },
			});
			setIsCancelConfirmOpen(false);
		} catch (error) {
			console.error("Failed to cancel request:", error);
		}
	};

	const stage: LifecycleStage = isRequestTerminalOffRamp(request.status)
		? "terminal"
		: "normal";
	// Feeds placeActions — the Rule 2 inversion that promotes the one live exit
	// ahead of dead buttons — and the rule's offRamp prop, so the rail claims
	// no position.
	const isOffRamp = isRequestNonTerminalOffRamp(request.status);
	// One call, two destinations: the inline share is rendered in the header
	// beside the kebab that holds the rest, so the two placements cannot drift.
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
			id: "request",
			label: "Request",
			items: [
				{
					id: "edit",
					label: "Edit Request",
					icon: <Edit2 size={16} />,
					disabled: !EDIT_REQUEST,
					disabledReason: EDIT_REQUEST
						? undefined
						: "You don't have permission to perform this action",
					onSelect: () => setIsEditModalOpen(true),
				},
			],
		},
	];

	const ageDays = Math.floor(
		(Date.now() - new Date(request.created_at).getTime()) / 86_400_000
	);

	const statTiles = [
		{
			label: "Estimated Value",
			icon: <DollarSign size={13} />,
			value:
				request.estimated_value != null
					? formatCurrency(Number(request.estimated_value))
					: "Not estimated",
		},
		{
			label: "Age",
			icon: <Calendar size={13} />,
			value: `${ageDays} ${ageDays === 1 ? "day" : "days"}`,
		},
		{
			label: "Source",
			icon: <Globe size={13} />,
			value: request.source ? titleCase(request.source) : "Unknown",
		},
	];

	// Estimated Value and Source are stat tiles, so they are not repeated here.
	const infoFields: DetailField[] = [
		...(request.address ? [{ label: "Address", value: request.address }] : []),
		{ label: "Created", value: formatDate(request.created_at) },
		...(request.source_reference
			? [{ label: "Source Reference", value: request.source_reference }]
			: []),
		// Only while it is still owed: once a quote exists the requirement is met.
		...(request.requires_quote && !firstQuote
			? [{ label: "Quote", value: "Required", tone: "warning" as const }]
			: []),
	];

	// Cancellation reason and date belong to the lifecycle bar's TerminalDetail
	// below, not to this card.
	const infoCard = (
		<Card className="flex-1" title="Request Information">
			<DetailFieldGrid
				fill
				lead={
					<p className="break-words text-text-primary">
						{request.description || "No description provided"}
					</p>
				}
				fields={infoFields}
			/>
		</Card>
	);

	const clientCard = (
		<ClientDetailsCard fill client_id={request.client_id} client={request.client} />
	);

	const relationCards = (
		<>
			<RelationCard
				eyebrow="Related Quote"
				to={firstQuote ? `/dispatch/quotes/${firstQuote.id}` : undefined}
				emptyLabel="No quote created yet"
				title={firstQuote?.quote_number}
				subtitle={firstQuote?.title || "Quote"}
				meta={
					firstQuote && (
						<>
							<Calendar size={12} />
							<span>{formatDate(firstQuote.created_at)}</span>
						</>
					)
				}
				trailing={
					firstQuote && (
						<>
							<span className="whitespace-nowrap text-sm font-semibold tabular-nums text-success-text">
								{formatCurrency(Number(firstQuote.total))}
							</span>
							<span
								className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${QuoteStatusColors[firstQuote.status as QuoteStatus] ?? ""}`}
							>
								{QuoteStatusLabels[firstQuote.status as QuoteStatus] ?? firstQuote.status}
							</span>
						</>
					)
				}
			/>

			<RelationCard
				eyebrow="Related Job"
				to={firstJob ? `/dispatch/jobs/${firstJob.id}` : undefined}
				emptyLabel="No job created yet"
				title={firstJob?.job_number}
				subtitle={firstJob?.name}
				meta={
					firstJob && (
						<>
							<Calendar size={12} />
							<span>{formatDate(firstJob.created_at)}</span>
						</>
					)
				}
				trailing={
					firstJob && (
						<span
							className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${JobStatusColors[firstJob.status as JobStatus] ?? ""}`}
						>
							{JobStatusLabels[firstJob.status as JobStatus] ?? firstJob.status}
						</span>
					)
				}
			/>
		</>
	);

	return (
		<div className="text-text-primary pb-4 md:pb-6">
			<div className="space-y-4">
				<DetailHeader
					title={request.title}
					meta={request.client?.name}
					statusPill={
						<span
							className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${RequestStatusColors[request.status]}`}
						>
							{RequestStatusLabels[request.status]}
						</span>
					}
					badges={
						<span
							className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PriorityColors[request.priority]}`}
						>
							{request.priority}
						</span>
					}
					inlineActions={<LifecycleActions actions={headerActions} />}
					menuGroups={menuGroups}
					menuLabel="Request actions"
				/>

				{/* The step track moved to the tab strip and the buttons to the
				    header, so the bar survives only for a block of text: the
				    terminal reason here, a dispute reason on other pages. */}
				{showBar && (
					<LifecycleBar
						steps={REQUEST_STEPS}
						stepLabels={RequestStatusLabels}
						stage={stage}
						currentStatus={request.status}
						track={false}
						tone={
							request.status === "Cancelled" ? "error" : undefined
						}
						actions={barActions}
						detail={
							<TerminalDetail
								reason={request.cancellation_reason ?? null}
								at={request.cancelled_at ?? null}
								noReasonLabel={
									TERMINAL_COPY[request.status] ??
									"No reason recorded."
								}
							/>
						}
					/>
				)}

				<DetailTabs
					tabs={REQUEST_TABS}
					activeTab={activeTab}
					onSelect={setActiveTab}
					label="Request sections"
					progress={
						<LifecycleRule
							steps={REQUEST_STEPS}
							stepLabels={RequestStatusLabels}
							currentStatus={request.status}
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

					<BalancedOverviewGrid
						recordId={request.id}
						infoCard={infoCard}
						block={relationCards}
						railCard={clientCard}
					/>
				</div>
			)}

			{activeTab === "activity" && (
				<ActivityPanel
					notes={<NoteManager requestId={requestId!} />}
					lifecycle={null}
					history={
						<ChangeHistory
							scope={{
								kind: "entity",
								type: "request",
								id: requestId ?? "",
							}}
						/>
					}
				/>
			)}

			{request && (
				<>
					<EditRequest
						isModalOpen={isEditModalOpen}
						setIsModalOpen={setIsEditModalOpen}
						request={request}
					/>
					<ConvertToQuote
						isModalOpen={isConvertToQuoteModalOpen}
						setIsModalOpen={setIsConvertToQuoteModalOpen}
						request={request}
						onConvert={async (quoteData) => {
							const newQuote =
								await createQuote(quoteData);
							if (!newQuote?.id)
								throw new Error(
									"Quote creation failed: no ID returned"
								);
							navigate(`/dispatch/quotes/${newQuote.id}`);
							return newQuote.id;
						}}
					/>
					<ConvertToJob
						isModalOpen={isConvertToJobModalOpen}
						setIsModalOpen={setIsConvertToJobModalOpen}
						request={request}
						onConvert={async (jobData) => {
							const newJob = await createJob(jobData);
							if (!newJob?.id)
								throw new Error(
									"Job creation failed: no ID returned"
								);
							navigate(`/dispatch/jobs/${newJob.id}`);
							return newJob.id;
						}}
					/>
				</>
			)}

			<ConfirmDialog
				open={isCancelConfirmOpen}
				title="Cancel Request"
				body="Are you sure you want to cancel this request? A cancelled request can't be quoted or converted to a job."
				confirmLabel="Cancel Request"
				tone="destructive"
				pending={isUpdatingRequest}
				onConfirm={confirmCancel}
				onCancel={() => setIsCancelConfirmOpen(false)}
			/>
		</div>
	);
}
