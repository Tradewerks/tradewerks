import { useParams, useNavigate } from "react-router-dom";
import {
	Calendar,
	DollarSign,
	MapPin,
	Edit2,
	Briefcase,
	Trash2,
	Download,
	Loader2,
	AlertTriangle,
	Clock,
} from "lucide-react";
import {
	useQuoteByIdQuery,
	useUpdateQuoteMutation,
	useDeleteQuoteMutation,
	useSendQuoteMutation,
	useReviseQuoteMutation,
} from "../../hooks/useQuotes";
import { useCreateJobMutation } from "../../hooks/useJobs";
import { useDisputesQuery } from "../../hooks/useDisputes";
import { QuoteStatusColors, QuoteStatusLabels, isQuoteEditable } from "../../types/quotes";
import type { QuoteStatus } from "../../types/quotes";
import LifecycleBar, {
	LifecycleActions,
	LifecycleRule,
} from "../../components/lifecycle/LifecycleBar";
import TerminalDetail from "../../components/lifecycle/TerminalDetail";
import { quoteActions, QUOTE_STEPS, isQuoteOffRamp } from "../../components/lifecycle/quoteActions";
import { placeActions } from "../../components/lifecycle/placement";
import type { LifecycleStage } from "../../components/lifecycle/types";
import BalancedOverviewGrid from "../../components/detail/BalancedOverviewGrid";
import RelationCard from "../../components/detail/RelationCard";
import DetailHeader, { type DetailMenuGroup } from "../../components/detail/DetailHeader";
import DetailTabs, { type DetailTabDef } from "../../components/detail/DetailTabs";
import DetailStatRow from "../../components/detail/DetailStatRow";
import DocumentLineage from "../../components/documents/DocumentLineage";
import { useDetailTab } from "../../components/detail/useDetailTab";
import Card from "../../components/ui/Card";
import ClientDetailsCard from "../../components/clients/ClientDetailsCard";
import EditQuote from "../../components/quotes/EditQuote";
import ConvertToJob from "../../components/quotes/ConvertToJob";
import NoteManager from "../../components/quotes/QuoteNoteManager";
import QuoteReasonModal from "../../components/quotes/QuoteReasonModal";
import DisputeModal from "../../components/disputes/DisputeModal";
import DisputeStage, { disputeActions } from "../../components/lifecycle/DisputeStage";
import type { Dispute, DisputeResolution } from "../../types/disputes";
import { useState, useMemo } from "react";
import { daysUntil, errorMessage, formatCurrency, formatDate } from "../../util/util";
import { downloadQuotePdf } from "../../api/quotes";
import FinancialSummary from "../../components/pagesections/FinancialSummary";
import SendDocumentModal from "../../components/ui/SendDocumentModal";
import { usePermission } from "../../hooks/usePermission";
import ChangeHistory from "../../components/activity/ChangeHistory";
import LifecycleRecord from "../../components/lifecycle/LifecycleRecord";
import ActivityPanel from "../../components/detail/ActivityPanel";


// Two tabs: line items are what a dispatcher opens a quote to read, so they
// stay in Overview, and Activity takes the notes, dispute record and change
// history. The invoice page carries the same pair.
const QUOTE_TABS: readonly DetailTabDef<"overview" | "activity">[] = [
	{ id: "overview", label: "Overview" },
	{ id: "activity", label: "Activity" },
];

// What the terminal stage says when no reason was recorded. Here rather than in
// TerminalDetail because only the page knows which end state it is explaining,
// and two of them have an implicit reason.
const NO_REASON_COPY: Record<string, string> = {
	Expired: "Passed its valid-until date with no decision recorded.",
	Revised: "Superseded by a newer version of this quote.",
};

const NO_DISPUTES: Dispute[] = [];

export default function QuoteDetailPage() {
	const { quoteId } = useParams<{ quoteId: string }>();
	const navigate = useNavigate();
	const { data: quote, isLoading } = useQuoteByIdQuery(quoteId!);
	const { mutateAsync: updateQuote } = useUpdateQuoteMutation();
	const { mutateAsync: sendQuote } = useSendQuoteMutation();
	const { mutateAsync: createJob } = useCreateJobMutation();
	const { mutateAsync: reviseQuoteMutation, isPending: revisePending } =
		useReviseQuoteMutation();
	const deleteQuote = useDeleteQuoteMutation();

	const [activeTab, setActiveTab] = useDetailTab(QUOTE_TABS);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [isConvertToJobModalOpen, setIsConvertToJobModalOpen] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [isPdfLoading, setIsPdfLoading] = useState(false);
	const [isSendModalOpen, setIsSendModalOpen] = useState(false);
	const [disputeModalMode, setDisputeModalMode] = useState<"open" | "resolve" | null>(
		null,
	);
	// The outcome picked in the lifecycle bar, handed to the resolve modal so it
	// opens on that choice instead of asking again.
	const [resolveOutcome, setResolveOutcome] = useState<DisputeResolution | undefined>(
		undefined,
	);
	const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
	const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	// permissions
	const EDIT_QUOTE = usePermission("edit_quotes");
	const DELETE_QUOTE = usePermission("delete_quotes");
	const CREATE_JOB = usePermission("create_jobs");
	const OPEN_DISPUTE = usePermission("open_disputes");
	const SEND_QUOTE = usePermission("send_quotes");

	const { data: disputeList, isError: disputeStateUnknown } = useDisputesQuery(
		"quote",
		quoteId ?? "",
	);
	const disputes = disputeList?.disputes ?? NO_DISPUTES;
	// A failed fetch defaults `disputes` to [], indistinguishable from "no
	// dispute", and every gate below keys off openDispute. Unknown is not absent,
	// so the irreversible paths close until we know.
	const openDispute = disputes.find((d) => d.status === "Open") ?? null;
	// Every dispute, not just the open one: a resolved record still explains what
	// happened to these lines. A Set, not an includes() per row.
	const contestedIds = useMemo(
		() =>
			new Set(
				(disputes ?? []).flatMap(
					(d) => d.contested_line_item_ids?.map((c) => c.id) ?? [],
				),
			),
		[disputes],
	);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Loading quote details...</div>
			</div>
		);
	}

	if (!quote) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Quote not found</div>
			</div>
		);
	}

	const getStatusColor = (status: string) =>
		QuoteStatusColors[status as QuoteStatus] ||
		"bg-neutral/20 text-text-tertiary border-border-strong/30";

	// The expiry sweep runs periodically, so the stored status can lag reality
	// between runs — show the true state regardless of what's persisted.
	const isEffectivelyExpired =
		quote.expires_at != null &&
		new Date(quote.expires_at).getTime() < Date.now() &&
		(quote.status === "Issued" || quote.status === "Sent" || quote.status === "Viewed");

	// One derived status feeds stage, stepper and gating alike: split, an
	// effectively-expired quote sits on the normal stage under the step name
	// Expired, which QUOTE_STEPS has no node for, and nothing lights.
	const lifecycleStatus: QuoteStatus = isEffectivelyExpired ? "Expired" : quote.status;

	const handleEdit = () => {
		if (!EDIT_QUOTE) return;
		setIsEditModalOpen(true);
	};
	const handleSendToClient = () => { // no specific permissions yet
		setIsSendModalOpen(true);
	};

	const handleSendConfirm = async (email: string) => {
		await sendQuote({ id: quote.id, recipientEmail: email });
	};
	const handleMarkAsIssued = async () => {
		if (!EDIT_QUOTE) return;
		setActionError(null);
		try {
			await updateQuote({ id: quote.id, data: { status: "Issued" } });
		} catch (error) {
			// These doors hit real refusals (an open-dispute lock, a terminal
			// quote's immutability), and a swallowed one reads as a dead button.
			setActionError(errorMessage(error, "Couldn't mark this quote as created."));
		}
	};

	const handleMarkAsApproved = async () => {
		if (!EDIT_QUOTE) return;
		setActionError(null);
		try {
			await updateQuote({ id: quote.id, data: { status: "Approved" } });
		} catch (error) {
			setActionError(errorMessage(error, "Couldn't mark this quote as approved."));
		}
	};
	// Both entry points (the lifecycle bar and the Related-Job card) gate on the
	// one `convert` action from quoteActions. jobsController writes the quote to
	// Approved with no transition guard, so that action's sold-work, disputed and
	// dead-quote rules are the whole client-side defence.
	const handleConvertToJob = () => {
		setIsConvertToJobModalOpen(true);
	};

	const handleMarkAsRejected = () => {
		if (!EDIT_QUOTE) return;
		setIsRejectModalOpen(true);
	};

	const handleCancelQuote = () => {
		if (!EDIT_QUOTE) return;
		setIsCancelModalOpen(true);
	};

	const handleCreateRevision = async () => {
		setActionError(null);
		try {
			const replacement = await reviseQuoteMutation({ id: quote.id });
			navigate(`/dispatch/quotes/${replacement.id}`);
		} catch (error) {
			// Surfaced, not swallowed: the server owns which statuses may be
			// revised, and names them on the response envelope.
			setActionError(errorMessage(error, "Failed to create a revision."));
		}
	};

	const handleDownloadPdf = async () => {
		setIsPdfLoading(true);
		try {
			await downloadQuotePdf(quote.id, quote.quote_number);
		} catch (error) {
			console.error("Failed to download PDF:", error);
		} finally {
			setIsPdfLoading(false);
		}
	};

	const handleDelete = async () => {
		if (!DELETE_QUOTE) return;
		if (!deleteConfirm) {
			setDeleteConfirm(true);
			return;
		}
		try {
			await deleteQuote.mutateAsync({ id: quote.id, hardDelete: false });
			navigate("/dispatch/quotes");
		} catch (error) {
			// A quote produced by a dispute resolution is audit trail: the server
			// allows cancelling it, never deleting it.
			setActionError(errorMessage(error, "Couldn't delete this quote."));
		}
	};

	// While a dispute is open its three exits are the bar's actions; the normal
	// quote actions are all gated off anyway.
	const disputeBarActions = openDispute
		? disputeActions(
				"quote",
				openDispute.outcomes ?? [],
				(outcome) => {
					setResolveOutcome(outcome);
					setDisputeModalMode("resolve");
				},
			)
		: null;

	// Dispute list failed to load while the document is still Disputed: neither
	// "terminal" (the bar would claim "No reason recorded.") nor "normal" (the
	// stepper lights nothing) is true, so the page says so.
	const disputeUnknownWhileDisputed =
		disputeStateUnknown && lifecycleStatus === "Disputed";

	// One stage value for the whole page: the bar renders it, and placeActions
	// keys both the slot rule and header-vs-bar off it.
	const lifecycleStage: LifecycleStage =
		openDispute || disputeUnknownWhileDisputed
			? "dispute"
			: isQuoteOffRamp(lifecycleStatus) && lifecycleStatus !== "Viewed"
				? "terminal"
				: "normal";

	const lifecycleActionList =
		disputeBarActions ??
		quoteActions({
			status: lifecycleStatus,
			hasJob: Boolean(quote.job),
			hasOpenDispute: Boolean(openDispute),
			disputeStateUnknown,
			openRefusal: disputeList?.open_refusal ?? null,
			soldRefusal: disputeList?.sold_refusal ?? null,
			canEdit: EDIT_QUOTE,
			canSend: SEND_QUOTE,
			canCreateJob: CREATE_JOB,
			canOpenDispute: OPEN_DISPUTE,
			revisePending,
			handlers: {
				issue: handleMarkAsIssued,
				send: handleSendToClient,
				approve: handleMarkAsApproved,
				convert: handleConvertToJob,
				dispute: () => setDisputeModalMode("open"),
				reject: handleMarkAsRejected,
				withdraw: handleCancelQuote,
				revise: handleCreateRevision,
			},
		});

	// The header or the bar renders the inline share, depending on stage; this is
	// the remainder, and the only reason the kebab has a Lifecycle group.
	const {
		headerActions,
		barActions,
		overflow: lifecycleOverflow,
		showBar,
	} = placeActions(lifecycleStage, lifecycleActionList);

	// The Related-Job card's Convert button is the same action the bar offers,
	// derived rather than re-judged here.
	const convertAction = lifecycleActionList.find((a) => a.id === "convert");

	// Three separate server refusals, each with its own message: the permission
	// check, the terminal-status gate, and the "converted to a job" gate that
	// isQuoteEditable does not model.
	const editBlockedReason = !EDIT_QUOTE
		? "You don't have permission to perform this action"
		: quote.job
			? "A job was created from this quote — it can no longer be edited. Correct the job instead."
			: !isQuoteEditable(quote.status)
				? `A ${(QuoteStatusLabels[quote.status] ?? quote.status).toLowerCase()} quote can't be edited. Create a revision instead.`
				: undefined;

	// One button, two labeled groups: lifecycle above, utility below. The
	// grouping carries the distinction, so there is no second kebab.
	const menuGroups: DetailMenuGroup[] = [
		{
			id: "lifecycle",
			label: "Lifecycle",
			items: lifecycleOverflow.map((a) => ({
				id: a.id,
				label: a.label,
				// `primary` describes a button's fill, which a menu row has
				// none of; warning and destructive still colour their text.
				intent: a.intent === "primary" ? ("neutral" as const) : a.intent,
				disabled: a.disabled,
				disabledReason: a.disabledReason,
				onSelect: a.onSelect,
			})),
		},
		{
			id: "document",
			label: "Document",
			items: [
				{
					id: "edit",
					label: "Edit Quote",
					icon: <Edit2 size={16} />,
					disabled: editBlockedReason != null,
					disabledReason: editBlockedReason,
					onSelect: handleEdit,
				},
				{
					id: "pdf",
					label: isPdfLoading ? "Generating..." : "Download PDF",
					icon: isPdfLoading ? (
						<Loader2 size={16} className="animate-spin" />
					) : (
						<Download size={16} />
					),
					disabled: isPdfLoading,
					onSelect: handleDownloadPdf,
				},
				...(DELETE_QUOTE
					? [
							{
								id: "delete",
								label: deleteQuote.isPending
									? "Deleting..."
									: deleteConfirm
										? "Click Again to Confirm"
										: "Delete Quote",
								icon: <Trash2 size={16} />,
								intent: "destructive" as const,
								disabled: deleteQuote.isPending,
								// The first click only arms the second, so
								// the menu has to survive it.
								keepOpen: !deleteConfirm,
								onSelect: handleDelete,
							},
						]
					: []),
			],
		},
	];

	// Derived readings, not recorded fields; the Details card keeps the record.
	// The total is printed here and nowhere else on the page.
	const validUntil = quote.valid_until ?? quote.expires_at;
	const daysLeft = validUntil != null ? daysUntil(validUntil) : null;
	const lineItemCount = quote.line_items?.length ?? 0;
	const ageDays = -daysUntil(quote.created_at);
	const statTiles = [
		{
			label: "Quote Total",
			icon: <DollarSign size={13} />,
			value: formatCurrency(Number(quote.total)),
			hint: `${lineItemCount} ${lineItemCount === 1 ? "line item" : "line items"}`,
		},
		{
			label: "Expires",
			icon: <Clock size={13} />,
			value:
				daysLeft == null
					? "No expiry"
					: daysLeft >= 0
						? `${daysLeft} ${daysLeft === 1 ? "day" : "days"}`
						: `${-daysLeft} ${daysLeft === -1 ? "day" : "days"} ago`,
			hint: validUntil != null ? formatDate(validUntil) : "None set",
			tone: daysLeft != null && daysLeft < 0 ? ("warning" as const) : undefined,
		},
		{
			label: "Age",
			icon: <Calendar size={13} />,
			value: `${ageDays} ${ageDays === 1 ? "day" : "days"}`,
		},
	];

	const infoCard = (
		<Card className="flex-1" title="Quote Information">
			{/* Field labels are <p>, not <h3>: Card renders its title as an h3,
			    so h3 labels inside it flatten the outline with one-line labels
			    that aren't navigable sections. */}
			{/* Two zones, not three stacked: the description holds the top and
			    the short fields hold the base, so a stretched grid cell turns its
			    slack into the gutter between them. DetailFieldGrid's `fill` does
			    this for the pages that use it; this card is hand-rolled. */}
			<div className="flex flex-1 flex-col justify-between gap-4">
				<div>
					<p className="text-text-tertiary text-sm mb-1">Description</p>
					<p className="text-text-primary break-words whitespace-pre-wrap">
						{quote.description || "No description provided"}
					</p>
				</div>

				<div className="space-y-4">
					{quote.address && (
						<div>
							<p className="text-text-tertiary text-sm mb-1 flex items-center gap-2">
								<MapPin size={14} /> Address
							</p>
							<p className="text-text-primary break-words">
								{quote.address}
							</p>
						</div>
					)}

					<div>
						<p className="text-text-tertiary text-sm mb-1 flex items-center gap-2">
							<Calendar size={14} /> Created
						</p>
						<p className="text-text-primary">{formatDate(quote.created_at)}</p>
					</div>
				</div>
			</div>
		</Card>
	);

	const clientCard = <ClientDetailsCard fill client_id={quote.client_id} client={quote.client} />;

	const relationCards = (
		<>
			<RelationCard
				eyebrow="Related Request"
				to={quote.request ? `/dispatch/requests/${quote.request.id}` : undefined}
				emptyLabel="No request linked"
				title={quote.request?.title}
				meta={
					quote.request && (
						<>
							<Calendar size={12} />
							<span>{formatDate(quote.request.created_at)}</span>
						</>
					)
				}
				trailing={
					quote.request && (
						<span
							className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${getStatusColor(quote.request.status)}`}
						>
							{quote.request.status}
						</span>
					)
				}
			/>

			<RelationCard
				eyebrow="Related Job"
				to={quote.job ? `/dispatch/jobs/${quote.job.id}` : undefined}
				emptyLabel="No job created yet"
				title={quote.job?.job_number}
				subtitle={quote.job?.name}
				meta={
					quote.job && (
						<>
							<Calendar size={12} />
							<span>{formatDate(quote.job.created_at)}</span>
						</>
					)
				}
				trailing={
					quote.job && (
						<>
							{quote.job.estimated_total != null && (
								<span className="whitespace-nowrap text-sm font-semibold tabular-nums text-success-text">
									{formatCurrency(Number(quote.job.estimated_total))}
								</span>
							)}
							<span
								className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${getStatusColor(quote.job.status)}`}
							>
								{quote.job.status}
							</span>
						</>
					)
				}
				emptyAction={
					<button
						title={convertAction?.disabledReason}
						disabled={convertAction?.disabled ?? true}
						onClick={() => convertAction?.onSelect()}
						className="flex items-center gap-2 px-3 py-1.5 bg-primary-hover hover:bg-primary-active rounded-md text-xs font-medium text-on-primary transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
					>
						<Briefcase size={12} /> Convert to Job
					</button>
				}
			/>
		</>
	);

	const financialBlock = (
		<FinancialSummary
			lineItems={quote.line_items ?? []}
			contestedIds={contestedIds}
			taxSnapshot={quote.tax_snapshot}
			legacyTaxRate={quote.tax_rate != null ? Number(quote.tax_rate) : null}
			legacyTaxAmount={quote.tax_amount != null ? Number(quote.tax_amount) : null}
			subtotal={quote.subtotal != null ? Number(quote.subtotal) : null}
			discountAmount={quote.discount_amount != null ? Number(quote.discount_amount) : null}
			discountType={quote.discount_type ?? null}
			discountValue={quote.discount_value != null ? Number(quote.discount_value) : null}
			metaLabel="Quote #"
			metaValue={quote.quote_number}
			noLineItemsDescription="No line items have been added to this quote yet."
			totalsContent={
				<div className="flex items-center justify-between px-4 py-3 bg-surface rounded-lg border border-border">
					<div>
						<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-0.5">
							Quote Total
						</p>
						<p className="text-xs text-text-muted">Final amount</p>
					</div>
					<p className="text-2xl font-bold text-primary-text tabular-nums">
						{formatCurrency(Number(quote.total))}
					</p>
				</div>
			}
		/>
	);

	return (
		<div className="text-text-primary pb-4 md:pb-6">
			{/* Header, lifecycle and the tab strip are one unit: a tight stack
			    closed by the strip's bottom border, rather than cards floating
			    at the same weight as the body below them. */}
			<div className="space-y-4">
				<DetailHeader
					title={quote.quote_number}
					badges={<DocumentLineage kind="quote" lineage={quote.lineage} />}
					meta={quote.title}
					statusPill={
						/* lifecycleStatus, not quote.status. The expiry sweep
						   runs periodically, so a quote past its valid-until
						   date still reads Sent in the database — and the pill
						   printed that while a chip beside it printed Expired,
						   one strip carrying two truths. The pill is now the
						   page's single status word, so it has to be the true
						   one; its title explains the gap that the second chip
						   used to. */
						<span
							title={
								isEffectivelyExpired
									? `Stored as ${QuoteStatusLabels[quote.status] ?? quote.status} until the expiry sweep next runs.`
									: undefined
							}
							className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${getStatusColor(lifecycleStatus)}`}
						>
							{lifecycleStatus}
						</span>
					}
					inlineActions={<LifecycleActions actions={headerActions} />}
					menuGroups={menuGroups}
					menuLabel="Quote actions"
					onMenuClose={() => setDeleteConfirm(false)}
				/>

				{showBar && (
					<LifecycleBar
						steps={QUOTE_STEPS}
						stepLabels={QuoteStatusLabels}
						stage={lifecycleStage}
						currentStatus={lifecycleStatus}
						track={false}
						actions={barActions}
						detail={
							openDispute ? (
								<DisputeStage
									kind="quote"
									dispute={openDispute}
									lineItems={quote.line_items ?? []}
								/>
							) : disputeUnknownWhileDisputed ? (
								<p className="text-sm text-warning-text">
									This quote's dispute couldn't be loaded, so its
									status and exits aren't shown. Reload the page.
								</p>
							) : (
								<TerminalDetail
									reason={quote.rejection_reason}
									at={
										lifecycleStatus === "Rejected"
											? quote.rejected_at
											: null
									}
									noReasonLabel={
										NO_REASON_COPY[lifecycleStatus] ??
										"No reason recorded."
									}
								/>
							)
						}
					/>
				)}

				{actionError && (
					<p className="text-sm text-error-text" role="alert">
						{actionError}
					</p>
				)}

				{/* Directly under the bar, as on the invoice page. */}
				{disputeStateUnknown && (
					<div className="flex items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-text">
						<AlertTriangle size={16} className="flex-shrink-0" />
						<span>
							This quote's dispute status couldn't be loaded, so
							dispute, cancel and convert actions are
							unavailable. Reload the page to try again.
						</span>
					</div>
				)}

				<DetailTabs
					tabs={QUOTE_TABS}
					activeTab={activeTab}
					onSelect={setActiveTab}
					label="Quote sections"
					progress={
						<LifecycleRule
							steps={QUOTE_STEPS}
							stepLabels={QuoteStatusLabels}
							currentStatus={lifecycleStatus}
							haltedAt={openDispute?.status_at_open ?? null}
							tone={
								lifecycleStage === "dispute"
									? "warning"
									: "default"
							}
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
						recordId={quote.id}
						infoCard={infoCard}
						block={relationCards}
						railCard={clientCard}
					/>
					{financialBlock}
				</div>
			)}

			{activeTab === "activity" && (
				<ActivityPanel
					notes={<NoteManager quoteId={quoteId!} />}
					lifecycle={<LifecycleRecord disputes={disputes} />}
					history={
						<ChangeHistory
							scope={{ kind: "entity", type: "quote", id: quoteId ?? "" }}
						/>
					}
				/>
			)}

			{quote && (
				<>
					<EditQuote
						isModalOpen={isEditModalOpen}
						setIsModalOpen={setIsEditModalOpen}
						quote={quote}
					/>
					<ConvertToJob
						isModalOpen={isConvertToJobModalOpen}
						setIsModalOpen={setIsConvertToJobModalOpen}
						quote={quote}
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
					<SendDocumentModal
						isOpen={isSendModalOpen}
						onClose={() => setIsSendModalOpen(false)}
						onSend={handleSendConfirm}
						docType="quote"
						docNumber={quote.quote_number}
						clientName={quote.client?.name ?? ""}
						contactEmail={quote.client?.contacts?.[0]?.contact?.email}
						contactName={quote.client?.contacts?.[0]?.contact?.name}
					/>
					<DisputeModal
						isOpen={disputeModalMode === "open"}
						kind="quote"
						documentId={quote.id}
						documentNumber={quote.quote_number}
						lineItems={quote.line_items ?? []}
						mode="open"
						onClose={() => setDisputeModalMode(null)}
					/>
					{/* Resolve is a separate mount, not a mode flip on the one above:
					    a DisputeModal stays mounted while closed so FullPopup can fade
					    out, and swapping `mode` mid-fade would repaint the body of a
					    modal the dispatcher is still watching close. */}
					<DisputeModal
						isOpen={disputeModalMode === "resolve"}
						kind="quote"
						documentId={quote.id}
						documentNumber={quote.quote_number}
						lineItems={quote.line_items ?? []}
						mode="resolve"
						dispute={openDispute}
						initialResolution={resolveOutcome}
						onResolved={(resolved) => {
							// Follow Revise & Resend to the replacement, the
							// way handleCreateRevision does for a direct revise.
							if (
								resolved.resolution === "ReviseAndResend" &&
								resolved.replacement_quote_id
							) {
								navigate(
									`/dispatch/quotes/${resolved.replacement_quote_id}`,
								);
							}
						}}
						onClose={() => {
							setDisputeModalMode(null);
							setResolveOutcome(undefined);
						}}
					/>
					<QuoteReasonModal
						isOpen={isRejectModalOpen}
						quoteId={quote.id}
						mode="reject"
						onClose={() => setIsRejectModalOpen(false)}
					/>
					<QuoteReasonModal
						isOpen={isCancelModalOpen}
						quoteId={quote.id}
						mode="cancel"
						onClose={() => setIsCancelModalOpen(false)}
					/>
				</>
			)}
		</div>
	);
}
