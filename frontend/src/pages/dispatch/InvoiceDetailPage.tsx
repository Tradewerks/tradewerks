import { useParams, useNavigate, Link } from "react-router-dom";
import { useState, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
	Edit2,
	Calendar,
	DollarSign,
	Trash2,
	Send,
	CheckCircle,
	CheckCircle2,
	AlertTriangle,
	AlertCircle,
	Plus,
	Clock,
	Download,
	Loader2,
	Mail,
	RefreshCw,
	RotateCcw,
	X,
} from "lucide-react";
import {
	useInvoiceByIdQuery,
	useUpdateInvoiceMutation,
	useDeleteInvoiceMutation,
	useCreateInvoicePaymentMutation,
	useDeleteInvoicePaymentMutation,
	useRecordRefundMutation,
} from "../../hooks/useInvoices";
import { useToast } from "../../components/ui/useToast";
import { useDisputesQuery } from "../../hooks/useDisputes";
import DisputeModal from "../../components/disputes/DisputeModal";
import type { AttributionTarget } from "../../components/disputes/adjustmentDraft";
import DisputeStage, { disputeActions } from "../../components/lifecycle/DisputeStage";
import type { Dispute, DisputeResolution } from "../../types/disputes";
import { downloadInvoicePdf, sendInvoice } from "../../api/invoices";
import SendDocumentModal from "../../components/ui/SendDocumentModal";
import FullPopup from "../../components/ui/FullPopup";
import ReasonField from "../../components/ui/ReasonField";
import LifecycleBar, {
	LifecycleActions,
	LifecycleRule,
} from "../../components/lifecycle/LifecycleBar";
import TerminalDetail from "../../components/lifecycle/TerminalDetail";
import { invoiceActions, INVOICE_STEPS } from "../../components/lifecycle/invoiceActions";
import { placeActions } from "../../components/lifecycle/placement";
import type { LifecycleStage } from "../../components/lifecycle/types";
import DetailHeader, { type DetailMenuGroup } from "../../components/detail/DetailHeader";
import DetailTabs, { type DetailTabDef } from "../../components/detail/DetailTabs";
import DetailStatRow from "../../components/detail/DetailStatRow";
import DocumentLineage, { HEADER_PILL } from "../../components/documents/DocumentLineage";
import { useDetailTab } from "../../components/detail/useDetailTab";
import Card from "../../components/ui/Card";
import { HEADER_BTN_BASE, HEADER_BTN_SECONDARY } from "../../components/ui/headerActions";
import ClientDetailsCard from "../../components/clients/ClientDetailsCard";
import InvoiceNoteManager from "../../components/invoices/InvoiceNoteManager";
import InvoiceOriginCard from "../../components/invoices/InvoiceOriginCard";
import InvoiceLineItems from "../../components/invoices/InvoiceLineItems";
import EditInvoice from "../../components/invoices/EditInvoice";
import {
	InvoiceStatusColors,
	InvoiceStatusLabels,
	PaymentMethodLabels,
	type InvoiceStatus,
	type PaymentMethod,
	isOverdue,
	isEditable,
	isDeletable,
	getPaymentProgress,
	type CreateInvoicePaymentInput,
	type RecordRefundInput,
} from "../../types/invoices";
import { daysUntil, errorMessage, formatCurrency, formatDate } from "../../util/util";
import { usePermission } from "../../hooks/usePermission";
import { useAcknowledgeTaxReview } from "../../hooks/useTaxSettings";
import TaxReviewBanner from "../../components/tax/TaxReviewBanner";
import { isQbTaxReviewError, withTaxReviewGate } from "../../components/tax/taxReviewGate";
import QbTaxZeroPanel from "../../components/tax/QbTaxZeroPanel";
import { useQbTaxZero } from "../../components/tax/useQbTaxZero";
import { isV2Snapshot } from "../../types/tax";
import {
	useQBStatusQuery,
	useQBInvoiceSyncMutation,
	useQBInvoiceEmailMutation,
} from "../../hooks/useQuickbooks";
import ChangeHistory from "../../components/activity/ChangeHistory";
import LifecycleRecord from "../../components/lifecycle/LifecycleRecord";
import ActivityPanel from "../../components/detail/ActivityPanel";
import { isCurrentQbRealm } from "../../lib/qbRealm";

// The same two tabs as QUOTE_TABS, in the same order. Line items stay in
// Overview because they are what a dispatcher opens the document to read;
// Payments rides the Overview rail, where its weight balances that column.
const INVOICE_TABS: readonly DetailTabDef<"overview" | "activity">[] = [
	{ id: "overview", label: "Overview" },
	{ id: "activity", label: "Activity" },
];

// ── Local helpers ─────────────────────────────────────────────────────────────

const formatDateTime = (val: string | Date | null | undefined): string => {
	if (!val) return "─";
	return new Date(val).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
};

// ── Component ─────────────────────────────────────────────────────────────────

const NO_DISPUTES: Dispute[] = [];

export default function InvoiceDetailPage() {
	const { invoiceId: invoiceIdParam, id: idParam } = useParams<{
		invoiceId?: string;
		id?: string;
	}>();
	const invoiceId = invoiceIdParam ?? idParam;
	const navigate = useNavigate();

	const { data: invoice, isLoading } = useInvoiceByIdQuery(invoiceId!);
	const queryClient = useQueryClient();
	// QB_TAX_REVIEW leaves the invoice flagged for review server-side; refetching is what
	// makes the banner and the acknowledge gate appear.
	const refetchOnQbTaxReview = (error: unknown) => {
		if (isQbTaxReviewError(error)) {
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
		}
	};
	const {
		mutateAsync: updateInvoice,
		isPending: isUpdatingInvoice,
		variables: updateVars,
	} = useUpdateInvoiceMutation();
	const { mutateAsync: deleteInvoice, isPending: isDeleting } = useDeleteInvoiceMutation();
	const toast = useToast();
	const { mutateAsync: recordPayment, isPending: isRecordingPayment } =
		useCreateInvoicePaymentMutation();
	const { mutateAsync: deletePayment } = useDeleteInvoicePaymentMutation();
	const { mutateAsync: recordRefund, isPending: isRecordingRefund } =
		useRecordRefundMutation();

	// A failed fetch defaults `disputes` to [], indistinguishable from "no
	// dispute", and the banner, the Open Dispute entry and the refund
	// affordance all key off openDispute. Unknown is not absent, so the money
	// actions close until we know.
	const { data: disputeList, isError: disputeStateUnknown } = useDisputesQuery(
		"invoice",
		invoiceId ?? ""
	);
	const disputes = disputeList?.disputes ?? NO_DISPUTES;
	const openDispute = disputes.find((d) => d.status === "Open") ?? null;
	// Every dispute, not just the open one: a resolved record still explains what
	// happened to these lines. A Set, not an includes() per row.
	const contestedIds = useMemo(
		() =>
			new Set(
				(disputes ?? []).flatMap(
					(d) => d.contested_line_item_ids?.map((c) => c.id) ?? []
				)
			),
		[disputes]
	);

	const [activeTab, setActiveTab] = useDetailTab(INVOICE_TABS);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	// Refused status/delete/payment-delete writes, rendered under the lifecycle
	// bar instead of reading as dead buttons.
	const [actionError, setActionError] = useState<string | null>(null);
	// The record-payment modal's own refusal line: the modal stays open so the
	// dispatcher can read it and retry.
	const [paymentError, setPaymentError] = useState<string | null>(null);
	const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [isPdfLoading, setIsPdfLoading] = useState(false);
	const [isSendModalOpen, setIsSendModalOpen] = useState(false);
	const [paymentForm, setPaymentForm] = useState<CreateInvoicePaymentInput>({
		amount: 0,
		method: undefined,
		note: "",
	});
	const [disputeModalMode, setDisputeModalMode] = useState<"open" | "resolve" | null>(null);
	// The outcome picked in the lifecycle bar, handed to the resolve modal so it
	// opens on that choice instead of asking again.
	const [resolveOutcome, setResolveOutcome] = useState<DisputeResolution | undefined>(
		undefined
	);
	const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
	const [refundForm, setRefundForm] = useState<RecordRefundInput>({
		amount: 0,
		reason: "",
		method: undefined,
	});
	const [refundError, setRefundError] = useState<string | null>(null);
	const [isVoidModalOpen, setIsVoidModalOpen] = useState(false);
	const [voidReason, setVoidReason] = useState("");
	const [voidError, setVoidError] = useState<string | null>(null);

	//permissions
	const EDIT_INVOICE = usePermission("edit_invoices");
	const SEND_INVOICE = usePermission("send_invoices");
	const ack = useAcknowledgeTaxReview();
	const DELETE_INVOICE = usePermission("delete_invoices");
	const REFUND_INVOICE = usePermission("refund_invoices");
	const OPEN_DISPUTE = usePermission("open_disputes");
	const qbTaxZero = useQbTaxZero();

	const { data: qbStatus } = useQBStatusQuery();
	const { mutate: syncToQB, isPending: isSyncingQB } = useQBInvoiceSyncMutation();

	const sendEmailMutation = useQBInvoiceEmailMutation();
	const primaryEmail = invoice?.client?.contacts?.find((c) => c.is_primary)?.contact?.email;

	// DetailHeader owns the page's one kebab, its click-outside listener and its
	// open state; disarming the two-step delete arrives back through onMenuClose.

	// ── Handlers ──────────────────────────────────────────────────────────────

	const handleDelete = async () => {
		if (!DELETE_INVOICE) return;
		if (!invoiceId || !invoice) return;
		if (!deleteConfirm) {
			setDeleteConfirm(true);
			return;
		}
		setActionError(null);
		try {
			await deleteInvoice({ id: invoiceId, clientId: invoice.client_id });
			navigate("/dispatch/invoices");
		} catch (error) {
			setActionError(errorMessage(error, "Couldn't delete this invoice."));
		}
	};

	const handleStatusTransition = async (newStatus: InvoiceStatus) => {
		if (!EDIT_INVOICE) return;
		if (!invoiceId) return;
		setActionError(null);
		try {
			await updateInvoice({ id: invoiceId, updates: { status: newStatus } });
		} catch (error) {
			// Real refusals land here (the open-dispute lock, the pre-email
			// transition guard), so the server's sentence is shown.
			refetchOnQbTaxReview(error);
			if (qbTaxZero.handleError(error)) return;
			setActionError(errorMessage(error, "Couldn't update this invoice."));
		}
	};

	const openVoidModal = () => {
		if (!EDIT_INVOICE) return;
		setVoidReason("");
		setVoidError(null);
		setIsVoidModalOpen(true);
	};

	const closeVoidModal = () => {
		setVoidReason("");
		setVoidError(null);
		setIsVoidModalOpen(false);
	};

	const handleVoid = async () => {
		if (!EDIT_INVOICE || !invoiceId) return;
		if (!voidReason.trim()) {
			setVoidError("A reason is required to void an invoice.");
			return;
		}
		setVoidError(null);
		try {
			await updateInvoice({
				id: invoiceId,
				updates: { status: "Void", void_reason: voidReason.trim() },
			});
			closeVoidModal();
		} catch (error) {
			// The server owns the money rule (a partially-paid or adjusted
			// invoice is refused), so its sentence — on the response envelope,
			// not AxiosError.message — is what the dispatcher reads.
			setVoidError(errorMessage(error, "Failed to void this invoice."));
		}
	};

	const resetPaymentForm = useCallback(() => {
		setPaymentForm({ amount: 0, method: undefined, note: "" });
	}, []);

	const openPaymentModal = useCallback(() => {
		if (!EDIT_INVOICE) return;
		resetPaymentForm();
		setPaymentError(null);
		setIsPaymentModalOpen(true);
	}, [resetPaymentForm]);

	const closePaymentModal = useCallback(() => {
		resetPaymentForm();
		setPaymentError(null);
		setIsPaymentModalOpen(false);
	}, [resetPaymentForm]);

	const handleRecordPayment = async () => {
		if (!invoiceId || !paymentForm.amount) return;
		setPaymentError(null);
		try {
			await recordPayment({ invoiceId, data: paymentForm });
			closePaymentModal();
		} catch (error) {
			// Kept open on failure: the server owns the ceiling and the status
			// rule, and a swallowed 4xx leaves the day's cash short silently.
			setPaymentError(errorMessage(error, "Couldn't record this payment."));
		}
	};

	const openRefundModal = () => {
		// A refund is cash out: refund_invoices, the same grant the bar's Refund
		// action and the /refund route gate on.
		if (!REFUND_INVOICE) return;
		setRefundForm({ amount: 0, reason: "", method: undefined });
		setRefundError(null);
		setIsRefundModalOpen(true);
	};

	const closeRefundModal = () => {
		setRefundForm({ amount: 0, reason: "", method: undefined });
		setRefundError(null);
		setIsRefundModalOpen(false);
	};

	/**
	 * Recording a refund does not move money — the card or bank action happens
	 * with the payment provider. The ceiling is enforced server-side, so the
	 * 422 message (which names the refundable amount) is surfaced verbatim.
	 */
	const handleRecordRefund = async () => {
		if (!invoiceId) return;
		if (!refundForm.amount || refundForm.reason.trim() === "") return;
		setRefundError(null);
		try {
			await recordRefund({
				invoiceId,
				data: { ...refundForm, reason: refundForm.reason.trim() },
			});
			closeRefundModal();
		} catch (error) {
			setRefundError(errorMessage(error, "Failed to record refund."));
		}
	};

	const handleDeletePayment = async (paymentId: string) => {
		if (!invoiceId) return;
		if (!confirm("Remove this payment? This will recalculate the invoice balance."))
			return;
		setActionError(null);
		try {
			await deletePayment({ invoiceId, paymentId });
		} catch (error) {
			// Deleting a payment needs refund_invoices; surface the 403 rather
			// than leaving a dead button.
			setActionError(errorMessage(error, "Couldn't remove this payment."));
		}
	};

	const handleSendConfirm = async (email: string) => {
		try {
			await sendInvoice(invoiceId!, email);
		} catch (error) {
			// A draft is finalized before the email goes out, so a failed send can still have
			// moved it to Created; a QB_TAX_REVIEW also changes server state.
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			// Left open, a re-click would go straight to send and 409 again; closing hands the
			// user to the acknowledge gate on the bar's Send.
			if (isQbTaxReviewError(error)) {
				setIsSendModalOpen(false);
				setActionError(errorMessage(error, "Couldn't send this invoice."));
			}
			if (qbTaxZero.handleError(error)) {
				setIsSendModalOpen(false);
			}
			throw error;
		}
	};

	const handleDownloadPdf = async () => {
		setIsPdfLoading(true);
		try {
			await downloadInvoicePdf(invoiceId!, invoice!.invoice_number);
		} catch (error) {
			console.error("Failed to download PDF:", error);
		} finally {
			setIsPdfLoading(false);
		}
	};

	// ── Guards ────────────────────────────────────────────────────────────────

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Loading invoice...</div>
			</div>
		);
	}

	if (!invoice) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-text-primary text-lg">Invoice not found</div>
			</div>
		);
	}

	// ── Derived values ────────────────────────────────────────────────────────

	const overdue = isOverdue(invoice);
	const editable = isEditable(invoice.status);
	const deletable = isDeletable(invoice.status);
	const paymentProgress = getPaymentProgress(invoice);

	const lineItems = invoice.line_items ?? [];
	const payments = invoice.payments ?? [];
	const total = Number(invoice.total ?? 0);
	const amountPaid = Number(invoice.amount_paid ?? 0);
	const balanceDue = Number(invoice.balance_due ?? 0);


	// The jobs and visits this invoice bills — where an Issue Adjustment credit
	// can land. The resolve modal picks between them when there is more than one;
	// the server attributes silently for one and refuses for none.
	const adjustmentTargets: AttributionTarget[] = [
		...(invoice.jobs ?? []).map((ij) => ({
			kind: "job" as const,
			id: ij.job_id,
			label: `${ij.job.job_number} · ${ij.job.name}`,
		})),
		...(invoice.visits ?? []).map((iv) => ({
			kind: "visit" as const,
			id: iv.visit_id,
			jobId: iv.visit.job.id,
			label: `Visit ${formatDate(iv.visit.scheduled_start_at)} · ${iv.visit.job.job_number}`,
		})),
	];

	// A refund is bounded by what was actually paid; the exact ceiling is
	// re-checked server-side under a row lock.
	const refundAmountValid = refundForm.amount > 0 && refundForm.amount <= amountPaid;

	// ── QuickBooks sync state (shared by header badge + toolbar action + menu) ──
	const qbConnected = !!qbStatus?.connected;
	const qbInThisRealm = isCurrentQbRealm(invoice.account_id, qbStatus);
	const qbSynced = qbInThisRealm && invoice.qb_sync_status === "synced";
	const qbFailed = qbInThisRealm && invoice.qb_sync_status === "failed";
	const qbTaxMismatch = qbInThisRealm && invoice.qb_sync_status === "tax_mismatch";
	// A credit adjustment lives in QuickBooks as a credit memo, even before it has an id there.
	const qbIsCreditMemo = !!invoice.adjusts_invoice_id && Number(invoice.total) < 0;
	const qbRemoteId = qbIsCreditMemo ? invoice.qb_credit_memo_id : invoice.qb_invoice_id;
	const qbRemoteKind = qbIsCreditMemo ? "credit memo" : "invoice";
	const qbRemoteSuffix = qbRemoteId ? ` #${qbRemoteId}` : "";
	const qbHasRemote = qbInThisRealm && !!qbRemoteId;

	const qbActionLabel = qbFailed
		? "Retry sync"
		: qbHasRemote
			? "Update in QuickBooks"
			: "Sync to QuickBooks";
	const qbActionTitle = qbHasRemote
		? `Sync your latest changes to QuickBooks ${qbRemoteKind}${qbRemoteSuffix}`
		: `Create this ${qbRemoteKind} in QuickBooks Online (one-way sync — nothing is pulled back)`;
	// Not on a Void invoice: a dispute void leaves qb_sync_status "not_synced"
	// and pushInvoice refuses a Void, so the button could only push a dead
	// document. Not on a Draft either: it reaches QuickBooks when it is created or sent.
	const qbShowAction =
		qbConnected && !qbSynced && invoice.status !== "Void" && invoice.status !== "Draft";
	// The server refuses a Draft: emailing from QuickBooks skips the finalize gates.
	// A credit memo has no QuickBooks email action here.
	const qbCanSendVia =
		qbConnected &&
		!qbTaxMismatch &&
		!qbIsCreditMemo &&
		(qbSynced || qbHasRemote) &&
		invoice.status !== "Draft";

	const qbBadge = qbSynced
		? {
				cls: "bg-success-bg text-success-bright-text border-success-border",
				Icon: CheckCircle2,
				text: "In QuickBooks",
				title: `Synced to QuickBooks ${qbRemoteKind}${qbRemoteSuffix}`,
			}
		: qbFailed
			? {
					cls: "bg-error/20 text-error-text border-error/30",
					Icon: AlertCircle,
					text: "Sync failed",
					title: "QuickBooks sync failed — use Retry sync",
				}
			: qbTaxMismatch
				? {
						cls: "bg-warning-bg text-warning-text border-warning-border",
						Icon: AlertCircle,
						text: "Tax differs in QuickBooks",
						title: "QuickBooks calculated a different tax amount — see the note below",
					}
				: qbHasRemote
					? {
							cls: "bg-warning-bg text-warning-text border-warning-border",
							Icon: Clock,
							text: "Changes pending",
							title: `Edited since last sync — sync to update QuickBooks${qbRemoteSuffix}`,
						}
					: {
							cls: "bg-neutral/20 text-text-tertiary border-border-strong/30",
							Icon: Clock,
							text: "Not in QuickBooks",
							title: `This ${qbRemoteKind} has not been pushed to QuickBooks yet`,
						};
	const QbBadgeIcon = qbBadge.Icon;

	// Built once: the bar swaps in dispute outcomes while a dispute is open, but
	// the Payments card reads its Record / Refund buttons off this list in every
	// state, so the two can't disagree about the same money act.
	const invoiceBarActions = withTaxReviewGate(invoiceActions({
		status: invoice.status,
		amountPaid,
		hasOpenDispute: Boolean(openDispute),
		disputeStateUnknown,
		openRefusal: disputeList?.open_refusal ?? null,
		voidRefusal: disputeList?.void_refusal ?? null,
		canEdit: EDIT_INVOICE,
		canSend: SEND_INVOICE,
		canOpenDispute: OPEN_DISPUTE,
		canRefund: REFUND_INVOICE,
		issuing: isUpdatingInvoice && updateVars?.updates.status === "Issued",
		handlers: {
			send: () => setIsSendModalOpen(true),
			issue: () => handleStatusTransition("Issued"),
			recordPayment: openPaymentModal,
			refund: openRefundModal,
			dispute: () => setDisputeModalMode("open"),
			void: openVoidModal,
		},
	}), {
		needsAck: Boolean(invoice.tax_needs_review && !invoice.tax_review_ack_at),
		canAck: SEND_INVOICE,
		pending: ack.isPending,
		acknowledge: () => ack.mutateAsync({ kind: "invoice", id: invoice.id }),
		onError: setActionError,
	});
	const recordPaymentAction = invoiceBarActions.find((a) => a.id === "recordPayment");
	const refundAction = invoiceBarActions.find((a) => a.id === "refund");

	// While a dispute is open its exits are the bar's actions; the normal invoice
	// actions are all gated off anyway. Record Payment rides along in the
	// overflow — a payment against the undisputed portion is allowed.
	const disputeBarActions = openDispute
		? [
				...disputeActions(
					"invoice",
					openDispute.outcomes ?? [],
					(outcome) => {
						setResolveOutcome(outcome);
						setDisputeModalMode("resolve");
					}
				),
				...(recordPaymentAction ? [recordPaymentAction] : []),
			]
		: null;

	// Dispute list failed to load while the invoice is still Disputed: "normal"
	// lights nothing in the stepper and "terminal" would claim a live dispute is
	// finished, so the page says so instead.
	const disputeUnknownWhileDisputed = disputeStateUnknown && invoice.status === "Disputed";

	// One stage value for the whole page: the bar renders it, and placeActions
	// keys both the slot rule and header-vs-bar off it.
	const lifecycleStage: LifecycleStage =
		openDispute || disputeUnknownWhileDisputed
			? "dispute"
			: invoice.status === "Void"
				? "terminal"
				: "normal";

	const lifecycleActionList = disputeBarActions ?? invoiceBarActions;

	// The header or the bar renders the inline share, depending on stage; this is
	// the remainder, and the only reason the kebab has a Lifecycle group.
	const {
		headerActions,
		barActions,
		overflow: lifecycleOverflow,
		showBar,
	} = placeActions(lifecycleStage, lifecycleActionList);

	// isEditable and isDeletable are both "Draft only", so the copy says that
	// rather than naming the current status.
	const editBlockedReason = !EDIT_INVOICE
		? "You don't have permission to perform this action"
		: !editable
			? "Only a draft invoice can be edited. Issue an adjustment to correct a finalized one."
			: undefined;
	const deleteBlockedReason = deletable
		? undefined
		: invoice.status === "Void"
			? "Only a draft invoice can be deleted."
			: "Only a draft invoice can be deleted. Void this one instead to cancel it.";

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
					label: "Edit Invoice",
					icon: <Edit2 size={16} />,
					// Disabled with its reason rather than omitted, so the
					// rule is legible from the menu.
					disabled: editBlockedReason != null,
					disabledReason: editBlockedReason,
					onSelect: () => setIsEditModalOpen(true),
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
				// Absent, not disabled: with no QuickBooks connection this is
				// not a closed door, it is one the org never installed.
				...(qbCanSendVia
					? [
							{
								id: "qb-email",
								label: "Send via QuickBooks",
								icon: sendEmailMutation.isPending ? (
									<Loader2
										size={16}
										className="animate-spin"
									/>
								) : (
									<Mail size={16} />
								),
								disabled:
									sendEmailMutation.isPending ||
									!primaryEmail,
								disabledReason: !primaryEmail
									? "No primary contact email on file for this client."
									: undefined,
								keepOpen: true,
								onSelect: () =>
									sendEmailMutation.mutate(
										{
											invoiceId: invoice.id,
											sendTo: primaryEmail ?? "",
										},
										{
											onSuccess: () => toast.success(`${invoice.invoice_number} sent to ${primaryEmail}`),
											onError: (error) => toast.error(errorMessage(error,"Failed to send via QuickBooks.")),
										}
									),
							},
						]
					: []),
				...(DELETE_INVOICE
					? [
							{
								id: "delete",
								label: isDeleting
									? "Deleting..."
									: deleteConfirm
										? "Click Again to Confirm"
										: "Delete Invoice",
								icon: <Trash2 size={16} />,
								intent: "destructive" as const,
								disabled: isDeleting || !deletable,
								disabledReason: deleteBlockedReason,
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

	// Derived readings, not recorded fields; the Details card keeps the record,
	// and paid-of-total is stated here rather than in a band of its own.
	const lineItemCount = lineItems.length;
	const ageDays = -daysUntil(invoice.issue_date ?? invoice.created_at);
	const paidPct = Math.round(Math.min(1, paymentProgress) * 100);
	const statTiles = [
		{
			label: "Invoice Total",
			icon: <DollarSign size={13} />,
			value: formatCurrency(total),
			hint: `${lineItemCount} ${lineItemCount === 1 ? "line item" : "line items"}`,
		},
		{
			label: "Paid",
			icon: <CheckCircle size={13} />,
			value: formatCurrency(amountPaid),
			hint: (
				<>
					<span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface">
						<span
							className="block h-1.5 rounded-full bg-success transition-all duration-200 ease-out"
							style={{ width: `${paidPct}%` }}
						/>
					</span>
					<span className="mt-1 block">{paidPct}% of total</span>
				</>
			),
		},
		{
			label: "Balance Due",
			icon: <DollarSign size={13} />,
			value: formatCurrency(balanceDue),
			// State, not the due date: the date is a recorded field and the
			// Details card owns it.
			hint: balanceDue <= 0 ? "Settled" : overdue ? "Past due" : "Outstanding",
			tone: overdue && balanceDue > 0 ? ("error" as const) : undefined,
		},
		{
			label: "Age",
			icon: <Clock size={13} />,
			value: `${ageDays} ${ageDays === 1 ? "day" : "days"}`,
			hint: "since created",
		},
	];

	// Overview's blocks, built once and only PLACED by `overviewLayout` below, so
	// neither layout branch gets its own copy of a card to drift out of sync.
	const detailsCard = (
		<Card title="Invoice Details">
			{/* Date/terms ─ inline flex wrap, each field sizes to content */}
			<div className="flex flex-wrap gap-x-6 gap-y-3 mb-6">
				<div className="min-w-0">
					<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-1">
						Created
					</p>
					<p className="text-text-primary text-sm flex items-center gap-1.5 whitespace-nowrap">
						<Calendar
							size={13}
							className="text-text-muted flex-shrink-0"
						/>
						{formatDate(invoice.created_at)}
					</p>
				</div>
				{invoice.status !== "Draft" && invoice.issue_date != null && (
					<div className="min-w-0">
						<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-1">
							Marked Created
						</p>
						<p className="text-text-primary text-sm flex items-center gap-1.5 whitespace-nowrap">
							<Calendar
								size={13}
								className="text-text-muted flex-shrink-0"
							/>
							{formatDate(invoice.issue_date)}
						</p>
					</div>
				)}
				{invoice.due_date != null && (
					<div className="min-w-0">
						<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-1">
							Due Date
						</p>
						<p
							className={`text-sm flex items-center gap-1.5 whitespace-nowrap ${
								overdue
									? "text-error-text"
									: "text-text-primary"
							}`}
						>
							<Clock
								size={13}
								className={
									overdue
										? "text-error flex-shrink-0"
										: "text-text-muted flex-shrink-0"
								}
							/>
							{formatDate(invoice.due_date)}
							{overdue && (
								<span className="text-error-text font-medium ml-1">
									Overdue
								</span>
							)}
						</p>
					</div>
				)}
				{invoice.payment_terms_days != null && (
					<div className="min-w-0">
						<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-1">
							Payment Terms
						</p>
						<p className="text-text-primary text-sm whitespace-nowrap">
							{invoice.payment_terms_days === 0
								? "Due on Receipt"
								: `Net ${invoice.payment_terms_days}`}
						</p>
					</div>
				)}
				{invoice.sent_at != null && (
					<div className="min-w-0">
						<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-1">
							Sent
						</p>
						<p className="text-text-primary text-sm flex items-center gap-1.5 whitespace-nowrap">
							<Send
								size={13}
								className="text-text-muted flex-shrink-0"
							/>
							{formatDateTime(invoice.sent_at)}
						</p>
					</div>
				)}
				{invoice.paid_at != null && (
					<div className="min-w-0">
						<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-1">
							Paid
						</p>
						<p className="text-text-primary text-sm flex items-center gap-1.5 whitespace-nowrap">
							<CheckCircle
								size={13}
								className="text-success flex-shrink-0"
							/>
							{formatDateTime(invoice.paid_at)}
						</p>
					</div>
				)}
				{invoice.void_reason != null && (
					<div className="w-full">
						<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-1">
							Void Reason
						</p>
						<p className="text-text-secondary text-sm italic break-words">
							{invoice.void_reason}
						</p>
					</div>
				)}
			</div>

			{invoice.internal_notes != null && (
				<div className="pt-4 border-t border-border-subtle">
					<p className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-2">
						Internal Notes
					</p>
					<p className="text-text-secondary text-sm break-words whitespace-pre-wrap">
						{invoice.internal_notes}
					</p>
				</div>
			)}
		</Card>
	);

	const lineItemsCard = (
		<>
			<TaxReviewBanner
				kind="invoice"
				id={invoice.id}
				needsReview={invoice.tax_needs_review}
				reason={isV2Snapshot(invoice.tax_snapshot) ? invoice.tax_snapshot.review_reason : null}
				ackAt={invoice.tax_review_ack_at}
				canAcknowledge={SEND_INVOICE}
			/>
			<InvoiceLineItems invoice={invoice} contestedIds={contestedIds} />
		</>
	);

	const clientCard = (
		<ClientDetailsCard client_id={invoice.client_id} client={invoice.client} />
	);

	// Record and Refund read the lifecycle bar's own action objects — the same
	// `disabled`/`disabledReason` — so this card can't offer a money act the bar
	// refuses, or refuse one it offers.
	const paymentsCard = (
		<Card
			title="Payments"
			headerAction={
				recordPaymentAction || refundAction ? (
					<div className="flex items-center gap-2">
						{recordPaymentAction && (
							<button
								title={
									recordPaymentAction.disabledReason
								}
								disabled={
									recordPaymentAction.disabled
								}
								onClick={
									recordPaymentAction.onSelect
								}
								className={`${HEADER_BTN_BASE} cursor-pointer bg-payment text-white hover:enabled:bg-payment-hover disabled:cursor-not-allowed disabled:opacity-40`}
							>
								<Plus size={13} />
								Record
							</button>
						)}
						{refundAction && (
							<button
								title={
									refundAction.disabledReason ??
									"Record a refund against this invoice"
								}
								disabled={refundAction.disabled}
								onClick={refundAction.onSelect}
								className={HEADER_BTN_SECONDARY}
							>
								<RotateCcw size={13} />
								Refund
							</button>
						)}
					</div>
				) : undefined
			}
		>
			{payments.length === 0 ? (
				<div className="text-center py-6">
					<DollarSign
						size={32}
						className="mx-auto text-text-faint mb-2"
					/>
					<p className="text-text-muted text-sm">
						No payments recorded
					</p>
				</div>
			) : (
				<div className="space-y-2">
					{payments.map((payment) => (
						<div
							key={payment.id}
							className="flex items-start justify-between gap-3 p-3 bg-surface/50 rounded-lg border border-border/50 group"
						>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span
										className={`font-semibold text-sm tabular-nums ${
											Number(
												payment.amount
											) < 0
												? "text-error-text"
												: "text-text-primary"
										}`}
									>
										{formatCurrency(
											Number(
												payment.amount
											)
										)}
									</span>
									{Number(payment.amount) <
										0 && (
										<span className="text-xs px-1.5 py-0.5 bg-error/15 text-error-text rounded border border-error/30">
											Refund
										</span>
									)}
									{payment.method != null && (
										<span className="text-xs px-1.5 py-0.5 bg-surface-raised text-text-secondary rounded border border-border-strong">
											{PaymentMethodLabels[
												payment
													.method
											] ??
												payment.method}
										</span>
									)}
								</div>
								<p className="text-text-muted text-xs mt-0.5">
									{formatDate(
										payment.paid_at
									)}
									{payment.recorded_by_dispatcher !=
										null && (
										<>
											{" "}
											·{" "}
											{
												payment
													.recorded_by_dispatcher
													.name
											}
										</>
									)}
									{payment.recorded_by_tech !=
										null && (
										<>
											{" "}
											·{" "}
											{
												payment
													.recorded_by_tech
													.name
											}{" "}
											(tech)
										</>
									)}
								</p>
								{payment.note != null &&
									payment.note !== "" && (
										<p className="text-text-tertiary text-xs mt-1 italic break-words">
											{
												payment.note
											}
										</p>
									)}
							</div>
							<button
								onClick={() =>
									handleDeletePayment(
										payment.id
									)
								}
								className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-error-text transition-all"
								title="Remove payment"
							>
								<Trash2 size={13} />
							</button>
						</div>
					))}
				</div>
			)}
		</Card>
	);

	// Where this invoice came from and what work it bills, from the same source
	// derivation the line items group by, so the two always agree.
	const originCard = <InvoiceOriginCard invoice={invoice} />;

	// Two layouts, chosen by whether the main column has enough to stand beside
	// the client card. Line Items is what carries it: with none, Details alone
	// (~150px, and on a fresh draft a single Created field) is not a column, so
	// it takes the full width and the rail pairs against the stack below.
	const detailFieldCount = [
		invoice.created_at,
		invoice.status !== "Draft" ? invoice.issue_date : null,
		invoice.due_date,
		invoice.payment_terms_days,
		invoice.sent_at,
		invoice.paid_at,
		invoice.void_reason,
		invoice.internal_notes,
	].filter((v) => v != null).length;
	const overviewLayout: "rail" | "split" =
		lineItems.length === 0 && detailFieldCount <= 3 ? "split" : "rail";

	// Origin is always in the main column, under Details and above the money it
	// explains: its job and visit chips carry `whitespace-nowrap` numbers that
	// shred in the ~285px rail, so there is no column choice to make.

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div className="text-text-primary pb-4 md:pb-6">
			{/* Header, lifecycle and the tab strip are one unit: a tight stack
			    closed by the strip's bottom border, rather than cards floating
			    at the same weight as the body below them. */}
			<div className="space-y-4">
				<DetailHeader
					title={invoice.invoice_number}
					badges={
						<>
							<DocumentLineage
								kind="invoice"
								lineage={invoice.lineage}
							/>
							{/* HEADER_PILL, not this badge's old smaller
							    geometry: the version pills beside it and the
							    status pill opposite it are both on the status
							    pill's line, and three heights in one row read
							    as an accident. */}
							{overdue && (
								<span
									className={`${HEADER_PILL} bg-error/20 text-error-text border-error/30`}
								>
									<AlertTriangle size={13} />
									Overdue
								</span>
							)}
							{qbConnected && (
								<span
									className={`${HEADER_PILL} ${qbBadge.cls}`}
									title={qbBadge.title}
								>
									<QbBadgeIcon size={13} />
									{qbBadge.text}
								</span>
							)}
						</>
					}
					meta={
						<>
							<span>
								{`Created ${formatDate(invoice.issue_date ?? invoice.created_at)}`}
								{invoice.due_date &&
									` · Due ${formatDate(invoice.due_date)}`}
							</span>
							{/* Its own line rather than crowding the title
							    row, where a two-line memo pushed the badges
							    onto a third. */}
							{invoice.memo && (
								<span
									className="mt-0.5 block text-text-secondary line-clamp-2 break-words"
									title={invoice.memo}
								>
									{invoice.memo}
								</span>
							)}
						</>
					}
					statusPill={
						/* The page's single status word: the bar never repeats
						   it, and its terminal stage carries the void reason
						   instead. */
						<span
							className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${
								InvoiceStatusColors[invoice.status]
							}`}
						>
							{InvoiceStatusLabels[invoice.status]}
						</span>
					}
					inlineActions={
						<>
							<LifecycleActions actions={headerActions} />
							{qbShowAction && (
								/* Permanent slot, not a menu row:
								   its state is already reported by
								   the badge beside it. Utility, so
								   it sits after the lifecycle
								   buttons behind a divider. */
								<button
									onClick={() =>
										syncToQB(invoiceId!, {
											onError: (e) =>
												setActionError(
													errorMessage(e, "Couldn't sync to QuickBooks.")
												),
										})
									}
									disabled={isSyncingQB}
									title={qbActionTitle}
									className="ml-1 flex items-center gap-2 border-l border-border py-1.5 pl-3 pr-3 rounded-md text-sm font-medium bg-quickbooks hover:enabled:bg-quickbooks-hover text-white transition-colors duration-150 ease-out disabled:opacity-40 disabled:cursor-not-allowed"
								>
									<RefreshCw
										size={14}
										className={
											isSyncingQB
												? "animate-spin"
												: undefined
										}
									/>
									{isSyncingQB
										? "Syncing…"
										: qbActionLabel}
								</button>
							)}
						</>
					}
					menuGroups={menuGroups}
					menuLabel="Invoice actions"
					onMenuClose={() => setDeleteConfirm(false)}
				/>

				{showBar && (
					<LifecycleBar
						steps={INVOICE_STEPS}
						stepLabels={InvoiceStatusLabels}
						tone={
							invoice.status === "Void"
								? "error"
								: undefined
						}
						stage={lifecycleStage}
						currentStatus={invoice.status}
						track={false}
						actions={barActions}
						detail={
							openDispute ? (
								<DisputeStage
									kind="invoice"
									dispute={openDispute}
									lineItems={lineItems}
								/>
							) : disputeUnknownWhileDisputed ? (
								<p className="text-sm text-warning-text">
									This invoice's dispute
									couldn't be loaded, so its
									status and exits aren't
									shown. Reload the page.
								</p>
							) : (
								<TerminalDetail
									reason={invoice.void_reason}
									at={invoice.voided_at}
									noReasonLabel="No reason recorded."
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

				{/* Directly under the bar, as on the quote page. */}
				{disputeStateUnknown && (
					<div className="flex items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-text">
						<AlertTriangle
							size={16}
							className="flex-shrink-0"
						/>
						<span>
							This invoice's dispute status couldn't be
							loaded, so dispute and refund actions are
							unavailable. Reload the page to try again.
						</span>
					</div>
				)}

				{/* The amounts are the whole diagnosis, so they sit in the page
				    rather than only in the badge's hover title. */}
				{qbTaxMismatch && (
					<div
						role="status"
						className="flex items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-text"
					>
						<AlertTriangle size={16} className="flex-shrink-0" />
						<span>
							QuickBooks calculated{" "}
							<span className="font-semibold tabular-nums">
								{formatCurrency(Math.abs(Number(invoice.qb_tax_amount ?? 0)))}
							</span>{" "}
							tax; this {qbIsCreditMemo ? "credit memo credits" : "invoice charges"}{" "}
							<span className="font-semibold tabular-nums">
								{formatCurrency(Math.abs(Number(invoice.tax_amount ?? 0)))}
							</span>
							.
							{qbIsCreditMemo
								? ""
								: " Sending from QuickBooks is blocked until they match."}{" "}
							Check the
							tax code mapping in{" "}
							<Link
								to="/dispatch/admin?tab=integrations"
								className="font-medium underline underline-offset-2 hover:text-text-primary"
							>
								Admin › Integrations
							</Link>
							, then use Update in QuickBooks.
						</span>
					</div>
				)}

				<DetailTabs
					tabs={INVOICE_TABS}
					activeTab={activeTab}
					onSelect={setActiveTab}
					label="Invoice sections"
					progress={
						<LifecycleRule
							steps={INVOICE_STEPS}
							stepLabels={InvoiceStatusLabels}
							currentStatus={invoice.status}
							haltedAt={
								openDispute?.status_at_open ?? null
							}
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

					{overviewLayout === "rail" ? (
						<>
							{/* Details and Line Items share the main
							    column. Details is a single wrap of
							    fields — ~150px against a ~380px client
							    card — so on its own it left a dead
							    quarter of the page; Origin and the line
							    items under it carry the column past the
							    rail. */}
							<div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
								<div className="lg:col-span-2 space-y-4">
									{detailsCard}
									{originCard}
									{lineItemsCard}
								</div>
								<div className="lg:col-span-1 space-y-4">
									{clientCard}
									{paymentsCard}
								</div>
							</div>
						</>
					) : (
						<>
							{/* Nothing substantial for a main column to
							    hold, so Details takes the full width its
							    wrap can fill and the client card pairs
							    against the Origin / line-items stack. */}
							{detailsCard}
							<div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
								<div className="lg:col-span-2 space-y-4">
									{originCard}
									{lineItemsCard}
								</div>
								<div className="lg:col-span-1 space-y-4">
									{clientCard}
									{paymentsCard}
								</div>
							</div>
						</>
					)}
				</div>
			)}

			{activeTab === "activity" && (
				<ActivityPanel
					notes={<InvoiceNoteManager invoiceId={invoiceId!} />}
					lifecycle={<LifecycleRecord disputes={disputes} />}
					history={
						<ChangeHistory
							scope={{
								kind: "entity",
								type: "invoice",
								id: invoiceId ?? "",
							}}
						/>
					}
				/>
			)}

			{/* Record Payment Modal */}
			{isPaymentModalOpen && (
				<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
					<div className="bg-base border border-border-subtle rounded-xl w-full max-w-md shadow-2xl">
						<div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
							<div className="flex flex-col">
								<h3 className="text-text-primary font-semibold text-base">
									Record Payment
								</h3>
								<span className="text-xs text-text-muted mt-0.5">
									Balance due:{" "}
									<span
										className={`font-semibold ${
											overdue
												? "text-error-text"
												: "text-warning-text"
										}`}
									>
										{formatCurrency(
											balanceDue
										)}
									</span>
								</span>
							</div>
							<button
								onClick={closePaymentModal}
								className="text-text-muted hover:text-text-primary transition-colors"
							>
								<X size={16} />
							</button>
						</div>

						<div className="px-5 py-5 space-y-3">
							<div>
								<div className="flex items-center justify-between mb-1">
									<label className="text-xs text-text-tertiary">
										Amount{" "}
										<span className="text-error-text">
											*
										</span>
									</label>
									<button
										type="button"
										onClick={() =>
											setPaymentForm(
												(
													f
												) => ({
													...f,
													amount: balanceDue,
												})
											)
										}
										className="text-xs text-primary-text hover:text-primary-text transition-colors"
									>
										Full
									</button>
								</div>
								<input
									placeholder="$0.00"
									type="number"
									min="0.01"
									step="0.01"
									value={
										paymentForm.amount ||
										""
									}
									onChange={(e) =>
										setPaymentForm(
											(f) => ({
												...f,
												amount:
													parseFloat(
														e
															.target
															.value
													) ||
													0,
											})
										)
									}
									className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
								/>
							</div>

							<div>
								<label className="block text-xs text-text-tertiary mb-1">
									Payment Method
								</label>
								<select
									value={
										paymentForm.method ??
										""
									}
									onChange={(e) => {
										const raw =
											e.target
												.value;
										const typed =
											raw ===
												"cash" ||
											raw ===
												"check" ||
											raw ===
												"card" ||
											raw ===
												"bank_transfer" ||
											raw ===
												"other"
												? (raw as PaymentMethod)
												: undefined;
										setPaymentForm(
											(f) => ({
												...f,
												method: typed,
											})
										);
									}}
									className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
								>
									<option value="">
										─ Select method ─
									</option>
									<option value="cash">
										Cash
									</option>
									<option value="check">
										Check
									</option>
									<option value="card">
										Card
									</option>
									<option value="bank_transfer">
										Bank Transfer
									</option>
									<option value="other">
										Other
									</option>
								</select>
							</div>

							<div>
								<label className="block text-xs text-text-tertiary mb-1">
									Note
								</label>
								<input
									type="text"
									placeholder="e.g. Check #1234"
									value={
										paymentForm.note ??
										""
									}
									onChange={(e) =>
										setPaymentForm(
											(f) => ({
												...f,
												note: e
													.target
													.value,
											})
										)
									}
									className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
								/>
							</div>

							{paymentError != null && (
								<div className="flex items-start gap-2 p-3 bg-error/10 border border-error/20 rounded-md">
									<AlertTriangle
										size={14}
										className="text-error-text flex-shrink-0 mt-0.5"
									/>
									<p className="text-sm text-error-text">
										{paymentError}
									</p>
								</div>
							)}
						</div>

						<div className="flex gap-2 px-5 pb-5 pt-2">
							<button
								onClick={closePaymentModal}
								className="flex-1 px-4 py-2 bg-surface hover:bg-surface-raised border border-border rounded-md text-sm transition-colors"
							>
								Cancel
							</button>
							<button
								onClick={handleRecordPayment}
								disabled={
									!paymentForm.amount ||
									isRecordingPayment
								}
								className="flex-1 px-4 py-2 bg-payment hover:bg-payment-hover text-white rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							>
								{isRecordingPayment
									? "Recording..."
									: "Record"}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Record Refund Modal ─ recording only; the money moves elsewhere.
			    Built on FullPopup like DisputeModal and QuoteReasonModal rather
			    than a hand-rolled fixed overlay: FullPopup portals to body,
			    closes on Escape, and uses the app's z-[4000]/z-[5000] layers,
			    which a local z-50 loses to. */}
			<FullPopup
				isModalOpen={isRefundModalOpen}
				onClose={closeRefundModal}
				size="md"
				content={
					<div className="flex flex-col">
						<div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
							<div className="flex flex-col">
								<h3 className="text-text-primary font-semibold text-base">
									Record a refund
								</h3>
								<span className="text-xs text-text-muted mt-0.5">
									Up to{" "}
									<span className="font-semibold text-text-secondary">
										{formatCurrency(
											amountPaid
										)}
									</span>{" "}
									can be refunded
								</span>
							</div>
							<button
								onClick={closeRefundModal}
								className="text-text-muted hover:text-text-primary transition-colors"
							>
								<X size={16} />
							</button>
						</div>

						<div className="px-5 py-5 space-y-3">
							<div>
								<div className="flex items-center justify-between mb-1">
									<label className="text-xs text-text-tertiary">
										Amount{" "}
										<span className="text-error-text">
											*
										</span>
									</label>
									<button
										type="button"
										onClick={() =>
											setRefundForm(
												(
													f
												) => ({
													...f,
													amount: amountPaid,
												})
											)
										}
										className="text-xs text-primary-text hover:text-primary-text transition-colors"
									>
										Full
									</button>
								</div>
								<input
									placeholder="$0.00"
									type="number"
									min="0.01"
									step="0.01"
									max={amountPaid}
									value={
										refundForm.amount ||
										""
									}
									onChange={(e) =>
										setRefundForm(
											(f) => ({
												...f,
												amount:
													parseFloat(
														e
															.target
															.value
													) ||
													0,
											})
										)
									}
									className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
								/>
								<p className="text-xs text-text-muted mt-1.5">
									This records the refund.
									Returning the money is done
									through your payment
									provider.
								</p>
							</div>

							<div>
								<label className="block text-xs text-text-tertiary mb-1">
									Reason{" "}
									<span className="text-error-text">
										*
									</span>
								</label>
								<textarea
									rows={3}
									placeholder="Why is this being refunded?"
									value={refundForm.reason}
									onChange={(e) =>
										setRefundForm(
											(f) => ({
												...f,
												reason: e
													.target
													.value,
											})
										)
									}
									className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
								/>
							</div>

							<div>
								<label className="block text-xs text-text-tertiary mb-1">
									Method
								</label>
								<select
									value={
										refundForm.method ??
										""
									}
									onChange={(e) => {
										const raw =
											e.target
												.value;
										const typed =
											raw ===
												"cash" ||
											raw ===
												"check" ||
											raw ===
												"card" ||
											raw ===
												"bank_transfer" ||
											raw ===
												"other"
												? (raw as PaymentMethod)
												: undefined;
										setRefundForm(
											(f) => ({
												...f,
												method: typed,
											})
										);
									}}
									className="w-full px-3 py-2 bg-surface border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
								>
									<option value="">
										─ Select method ─
									</option>
									<option value="cash">
										Cash
									</option>
									<option value="check">
										Check
									</option>
									<option value="card">
										Card
									</option>
									<option value="bank_transfer">
										Bank Transfer
									</option>
									<option value="other">
										Other
									</option>
								</select>
							</div>

							{refundError != null && (
								<div className="flex items-start gap-2 p-3 bg-error/10 border border-error/20 rounded-md">
									<AlertTriangle
										size={14}
										className="text-error-text flex-shrink-0 mt-0.5"
									/>
									<p className="text-sm text-error-text">
										{refundError}
									</p>
								</div>
							)}
						</div>

						<div className="flex gap-2 px-5 pb-5 pt-2">
							<button
								onClick={closeRefundModal}
								className="flex-1 px-4 py-2 bg-surface hover:bg-surface-raised border border-border rounded-md text-sm transition-colors"
							>
								Cancel
							</button>
							<button
								onClick={handleRecordRefund}
								disabled={
									!refundAmountValid ||
									refundForm.reason.trim() ===
										"" ||
									isRecordingRefund
								}
								className="flex-1 px-4 py-2 bg-error hover:bg-error-strong text-on-primary rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							>
								{isRecordingRefund
									? "Recording..."
									: "Record Refund"}
							</button>
						</div>
					</div>
				}
			/>

			{/* Void Invoice Modal ─ the reason is required by the server and is
			    stamped on the invoice. On FullPopup for the same reason the
			    refund modal is, and it replaced a window.prompt() whose
			    refusal went to console.error and nowhere the dispatcher could
			    see it, so a blocked void looked like nothing happening. */}
			<FullPopup
				isModalOpen={isVoidModalOpen}
				onClose={closeVoidModal}
				size="md"
				content={
					<div className="flex flex-col">
						<div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
							<div className="flex flex-col">
								<h3 className="text-text-primary font-semibold text-base">
									Void this invoice
								</h3>
								<span className="text-xs text-text-muted mt-0.5">
									{invoice.invoice_number}{" "}
									stays on record, marked void
									with this reason.
								</span>
							</div>
							<button
								onClick={closeVoidModal}
								className="text-text-muted hover:text-text-primary transition-colors"
							>
								<X size={16} />
							</button>
						</div>

						<div className="px-5 py-5 space-y-3">
							<ReasonField
								value={voidReason}
								onChange={setVoidReason}
								placeholder="Why is this invoice being voided?"
								rows={3}
							/>

							{voidError != null && (
								<div className="flex items-start gap-2 p-3 bg-error/10 border border-error/20 rounded-md">
									<AlertTriangle
										size={14}
										className="text-error-text flex-shrink-0 mt-0.5"
									/>
									<p className="text-sm text-error-text">
										{voidError}
									</p>
								</div>
							)}
						</div>

						<div className="flex gap-2 px-5 pb-5 pt-2">
							<button
								onClick={closeVoidModal}
								className="flex-1 px-4 py-2 bg-surface hover:bg-surface-raised border border-border rounded-md text-sm transition-colors"
							>
								Cancel
							</button>
							<button
								onClick={handleVoid}
								disabled={isUpdatingInvoice}
								className="flex-1 px-4 py-2 bg-error hover:bg-error-strong text-on-primary rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							>
								{isUpdatingInvoice
									? "Voiding..."
									: "Void Invoice"}
							</button>
						</div>
					</div>
				}
			/>

			{/* Edit Invoice Modal */}
			{editable && isEditModalOpen && (
				<EditInvoice
					isModalOpen={isEditModalOpen}
					setIsModalOpen={setIsEditModalOpen}
					invoice={invoice}
				/>
			)}

			{qbTaxZero.qbZero && (
				<QbTaxZeroPanel zero={qbTaxZero.qbZero} onClose={qbTaxZero.clear} />
			)}

			<SendDocumentModal
				isOpen={isSendModalOpen}
				onClose={() => setIsSendModalOpen(false)}
				onSend={handleSendConfirm}
				docType="invoice"
				docNumber={invoice.invoice_number}
				clientName={invoice.client?.name ?? ""}
				contactEmail={invoice.client?.contacts?.[0]?.contact?.email}
				contactName={invoice.client?.contacts?.[0]?.contact?.name}
			/>

			{/* Always mounted so FullPopup's close fade can play — matching
			    every other FullPopup consumer in the app. */}
			<DisputeModal
				isOpen={disputeModalMode === "open"}
				kind="invoice"
				documentId={invoice.id}
				documentNumber={invoice.invoice_number}
				lineItems={lineItems}
				mode="open"
				onClose={() => setDisputeModalMode(null)}
			/>
			{/* Resolve is a separate mount, not a mode flip on the one above: a
			    DisputeModal stays mounted while closed so FullPopup can fade out,
			    and swapping `mode` mid-fade would repaint the body of a modal the
			    dispatcher is still watching close. */}
			<DisputeModal
				isOpen={disputeModalMode === "resolve"}
				kind="invoice"
				documentId={invoice.id}
				documentNumber={invoice.invoice_number}
				lineItems={lineItems}
				mode="resolve"
				dispute={openDispute}
				initialResolution={resolveOutcome}
				attributionTargets={adjustmentTargets}
				onClose={() => {
					setDisputeModalMode(null);
					setResolveOutcome(undefined);
				}}
			/>
		</div>
	);
}
