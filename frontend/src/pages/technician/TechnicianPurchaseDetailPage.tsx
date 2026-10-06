import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
	AlertTriangle,
	CalendarOff,
	ChevronRight,
	Flag,
	Loader2,
	MessageSquare,
	RefreshCw,
	Send,
	ShieldQuestion,
	Trash2,
	Undo2,
	WifiOff,
	X,
} from "lucide-react";
import {
	useCreateRefund,
	useDeleteFieldPurchase,
	useFieldPurchase,
	usePurchaseLimitGate,
	usePurchaseExtraction,
	useRequestPreauth,
	useSubmitFieldPurchase,
} from "../../hooks/useFieldPurchases";
import { useMyJobsQuery } from "../../hooks/useJobs";
import { useTechnicianByIdQuery } from "../../hooks/useTechnicians";
import { useAuthStore } from "../../auth/authStore";
import ReceiptCaptureCard from "../../components/technician/procurement/ReceiptCaptureCard";
import PurchaseLineEditor from "../../components/technician/procurement/PurchaseLineEditor";
import ReceiptValueDiff from "../../components/technician/procurement/ReceiptValueDiff";
import LimitBreachNotice from "../../components/technician/procurement/LimitBreachNotice";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import SheetNotice from "../../components/technician/procurement/SheetNotice";
import {
	clampDestinations,
	toDrafts,
	type LineDraft,
} from "../../components/technician/procurement/lineDrafts";
import { useToast } from "../../components/ui/useToast";
import { FOCUS_RING, money } from "../../components/fieldPurchases/fieldPurchaseFormat";
import { partsSummary, refundLedger } from "../../components/technician/procurement/refundParts";
import { errorMessage } from "../../util/util";
import TechPage from "../../components/technician/TechPage";
import { useModule } from "../../hooks/useEntitlements";
import {
	pendingRefundsLine,
	refundStateLabel,
	refundStateTone,
	sheetCopy,
	sheetTitle,
} from "../../components/technician/procurement/sheetCopy";
import {
	isTechEditable,
	type FieldPurchase,
	type FieldPurchaseRefundParent,
	type FieldPurchaseRefundSummary,
} from "../../types/fieldPurchases";

/**
 * One job the receipt covers. No amount: the share is the sum of the lines tagged
 * to this job, so it is read off them rather than typed twice. A row added here
 * has no server id until the submit that creates it, so the key is its own.
 */
interface AllocDraft {
	key: string;
	job_id: string;
	job_visit_id: string | null;
	label: string;
	/** The visit the row opens, said the way the visits list says it. */
	visit_name: string | null;
	visit_start: string | null;
}

/** A job by name, else by number — never by its id, which means nothing to anybody. */
const jobLabel = (name: string | null | undefined, number: string | null | undefined) =>
	name || (number ? `Job ${number}` : "Job");

/**
 * Where every exit from this screen leads. Deliberately one place: this sheet is
 * reachable from a visit, from the vehicle page's Adjust Stock doorway, from the
 * list and from a notification, and guessing a destination from the purchase's
 * own data sent people somewhere they had never been.
 */
const PURCHASES = "/technician/purchases";

// datetime-local reads and writes wall clock. Seeding it from toISOString()
// would show the UTC instant and then re-submit it as local, shifting the
// timestamp by the offset on every save.
function toLocalInputValue(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** A receipt amount in the form the money fields hold, so a diff compares like with like. */
const money2 = (v: number | null | undefined): string | null => (v == null ? null : v.toFixed(2));

/**
 * One purchase, one screen, one button. The three separate saves this replaced were
 * three chances to lose a receipt at a counter, and one silently dropped the
 * confirmations it had just been given. The over-limit path lives here too, because
 * a technician finds out they are over at the counter, not before.
 */
export default function TechnicianPurchaseDetailPage() {
	const { purchaseId } = useParams<{ purchaseId: string }>();
	const { data, isLoading, isError, isFetching, refetch } = useFieldPurchase(purchaseId);

	if (isLoading) {
		return (
			<TechPage>
				<p className="text-sm text-text-muted">Loading…</p>
			</TechPage>
		);
	}

	// A failed request must not render the loading line forever, which at a supply
	// counter would read as a phone that has hung rather than one that needs a retry.
	if (isError || !data) {
		return (
			<TechPage className="flex items-start gap-3 rounded-xl border border-border bg-base p-4">
				<WifiOff
					size={18}
					aria-hidden
					className="mt-0.5 flex-shrink-0 text-warning-text"
				/>
				<div className="min-w-0">
					<h1 className="text-sm font-semibold text-text-primary">
						Could not open this purchase
					</h1>
					<p className="mt-1 text-xs text-text-muted">
						Check your signal and try again. Nothing you sent
						has been lost.
					</p>
					<div className="mt-2 flex flex-wrap items-center gap-3">
						<button
							type="button"
							disabled={isFetching}
							onClick={() => void refetch()}
							className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs font-medium text-text-primary hover:enabled:bg-surface-raised disabled:opacity-40"
						>
							<RefreshCw
								size={12}
								aria-hidden
								className={
									isFetching
										? "animate-spin"
										: ""
								}
							/>
							{isFetching ? "Retrying…" : "Try again"}
						</button>
						<Link
							to={PURCHASES}
							className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-2 hover:underline"
						>
							Back to your purchases
						</Link>
					</div>
				</div>
			</TechPage>
		);
	}
	return <PurchaseSheet purchase={data.purchase} />;
}

function PurchaseSheet({ purchase }: { purchase: FieldPurchase }) {
	const navigate = useNavigate();
	// The truck the technician is signed onto, and the only vehicle a line may
	// stock. Read from the profile, not a `?vehicleId=` query param: a URL the
	// technician can edit could name a truck they've since handed over, and the
	// profile is the one answer the server will also accept.
	const { user } = useAuthStore();
	const { data: techProfile } = useTechnicianByIdQuery(user?.userId ?? null);
	// With Vehicle Stock off the truck is not a stock location; the server would
	// land the parts in the warehouse anyway, so the form does not offer it.
	const vehicleStockOn = useModule("vehicle_stock") === "on";
	const myVehicle = vehicleStockOn && techProfile?.current_vehicle
		? { id: techProfile.current_vehicle.id, name: techProfile.current_vehicle.name }
		: null;
	const submit = useSubmitFieldPurchase();
	const preauth = useRequestPreauth();
	const remove = useDeleteFieldPurchase();
	const refund = useCreateRefund();
	const toast = useToast();

	const [vendor, setVendor] = useState("");
	// The ask, before there is a receipt. Kept apart from `total` on purpose: an
	// estimate is not a price paid, and the two must never be the same field.
	const [estimate, setEstimate] = useState("");
	const [reason, setReason] = useState("");
	const [total, setTotal] = useState("");
	const [tax, setTax] = useState("");
	const [purchasedAt, setPurchasedAt] = useState("");
	const [lines, setLines] = useState<LineDraft[]>(() => toDrafts(purchase));
	// One receipt can serve more than one job — the counter trip that fixes two
	// call-outs is the ordinary case, not an exotic one. A single-job purchase
	// follows its own total server-side and never needs touching.
	const [allocs, setAllocs] = useState<AllocDraft[]>([]);
	// Anything the technician has touched and not yet sent. The detail query polls
	// while OCR runs, so without this a result landing mid-sentence would overwrite
	// whatever they were typing.
	const [dirty, setDirty] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	// Where a tap on a job row was headed, held while the technician decides
	// whether to walk away from edits this sheet has not sent.
	const [leavingTo, setLeavingTo] = useState<string | null>(null);

	// What the receipt read, which the purchase may well not hold: extraction stands
	// down from every field the technician filled and from the lines entirely once
	// there is one. Asked for separately so a landing extraction reaches an open
	// sheet as an offer rather than as a rewrite of what they were typing.
	const { data: extraction } = usePurchaseExtraction(
		purchase.id,
		purchase.ocr_status === "succeeded"
	);
	const receipt = extraction?.header ?? null;
	const scoreOf = (field: string) => extraction?.field_confidence?.[field] ?? null;

	const serverShape = `${purchase.updated_at}|${purchase.lines.map((l) => l.id).join(",")}`;
	useEffect(() => {
		if (dirty) return;
		setVendor(purchase.vendor_name ?? "");
		setEstimate(Number(purchase.estimated_amount ?? purchase.total).toFixed(2));
		setReason(purchase.reason ?? "");
		setTotal(Number(purchase.total).toFixed(2));
		setTax(Number(purchase.tax_amount).toFixed(2));
		setPurchasedAt(toLocalInputValue(purchase.purchased_at));
		// The roster keys a server-known job by its allocation id, which is what
		// `toDrafts` then matches each line's own allocation against.
		setLines(toDrafts(purchase));
		setAllocs(
			purchase.allocations.map((a) => ({
				key: a.id,
				job_id: a.job_id,
				job_visit_id: a.job_visit_id,
				label: jobLabel(a.job?.name, a.job?.job_number),
				visit_name: a.job_visit?.name ?? null,
				visit_start: a.job_visit?.scheduled_start_at ?? null,
			}))
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [serverShape, dirty]);

	// Runs after the profile lands, and after every re-seed that brings a stored
	// destination back. Deliberately does not mark the sheet dirty: nothing the
	// technician typed changed, and a false "unsaved changes" on open would be
	// worse than re-clamping on the next poll. The submit sends what is here.
	useEffect(() => {
		if (!techProfile) return;
		setLines((prev) => clampDestinations(prev, myVehicle?.id ?? null));
	}, [techProfile, myVehicle?.id]);

	const editable = isTechEditable(purchase.status);
	// Asked for but not yet bought — the receipt half of this screen has nothing
	// to hold. `preauth_approved` is deliberately not here: dispatch said yes, so
	// the technician is at the counter and the receipt flow is exactly right.
	const awaitingPurchase =
		purchase.status === "pending_preauth" || purchase.status === "preauth_denied";
	const totalNum = Number(total) || 0;
	const estimateNum = Number(estimate) || 0;
	const isSplit = allocs.length > 1;
	const unconfirmed = lines.filter((l) => !l.acknowledged).length;
	// A line nobody claimed bills no customer and counts towards no job's share,
	// which is the one thing a split receipt can get wrong. With a single job the
	// server assigns it, so there is nothing to be missing.
	const unassigned = isSplit ? lines.filter((l) => !l.allocationKey).length : 0;
	// Whether the receipt bills a visit, which is a fact about the money. It used
	// to double as a back destination, which sent a technician who arrived from
	// the vehicle page to a visit they had never been on.
	const billsAVisit = purchase.allocations.some((a) => a.job_visit_id);
	const canRefund = purchase.kind === "purchase" && purchase.status === "approved";
	const isRefund = purchase.kind === "refund";
	// Only a queried or rejected purchase leaves the technician something to do
	// about dispatch's note; on any other it is a remark.
	const dispatchAsks = purchase.status === "queried" || purchase.status === "rejected";
	// `refund_unsettled` is written for the reviewer and says what the title
	// already says ("Credit on its way") in dispatcher's words.
	const shownFlags = purchase.flags.filter((f) => f.code !== "refund_unsettled");
	const copy = sheetCopy(purchase.kind);
	const refundParent = isRefund ? (purchase.parent ?? null) : null;

	// Asked of the server against the real total, which is only known once the
	// receipt is in hand. A breach turns the submit into a pre-approval request
	// rather than sending the technician to another screen.
	const checkedAmount = awaitingPurchase ? estimateNum : totalNum;
	// Every job's ceiling, not just the first one's — and measured against the
	// lines on screen rather than the shares the server last derived, because the
	// lines being edited are what the technician is deciding on.
	const shares = useMemo(() => {
		if (allocs.length <= 1) {
			return allocs.map((a) => ({ job_id: a.job_id, amount: checkedAmount }));
		}
		const lineTotal = (d: LineDraft) =>
			(Number(d.quantity) || 0) * (Number(d.unit_price) || 0);
		const subtotals = new Map(allocs.map((a) => [a.key, 0]));
		for (const d of lines) {
			if (subtotals.has(d.allocationKey)) {
				subtotals.set(
					d.allocationKey,
					subtotals.get(d.allocationKey)! + lineTotal(d)
				);
			}
		}
		// Tax pro-rata by line subtotal, the same rule the server derives with —
		// a ceiling answered on a different figure is not an answer.
		const assigned = [...subtotals.values()].reduce((n, v) => n + v, 0);
		const taxNum = Number(tax) || 0;
		return allocs.map((a) => ({
			job_id: a.job_id,
			amount:
				subtotals.get(a.key)! +
				(assigned > 0
					? (subtotals.get(a.key)! / assigned) * taxNum
					: taxNum / allocs.length),
		}));
	}, [allocs, lines, tax, checkedAmount]);
	// The roster, read three ways: what the server calls a row, what to label it,
	// and what it came to. Declared here because the submit payload below needs
	// the first of them.
	const jobOfKey = useMemo(() => new Map(allocs.map((a) => [a.key, a.job_id])), [allocs]);
	const jobOptions = useMemo(
		() => allocs.map((a) => ({ key: a.key, label: a.label })),
		[allocs]
	);
	const shareOfKey = useMemo(
		() => new Map(allocs.map((a, i) => [a.key, shares[i]?.amount ?? 0])),
		[allocs, shares]
	);

	const { breaches, assumeBreach } = usePurchaseLimitGate({
		scopeKey: purchase.id,
		total: checkedAmount,
		allocations: shares,
		enabled: editable && purchase.kind === "purchase",
	});
	// Never the more permissive button on an unverified figure: while a check is
	// in flight for an amount larger than the last one the server answered for,
	// this routes through dispatch and says so rather than offering the submit.
	// Two statuses are past the point where permission is worth asking for:
	// dispatch already said yes to one, and a queried receipt was already
	// submitted once, so the money is spent. On those the breach is information
	// for the reviewer, not a gate on the technician.
	const spentAlready =
		purchase.status === "preauth_approved" || purchase.status === "queried";
	const needsPreauth =
		(breaches.length > 0 || assumeBreach) &&
		!spentAlready &&
		purchase.kind === "purchase";

	const sheet = useMemo(
		() => ({
			vendor_name: vendor.trim() || null,
			total: totalNum,
			tax_amount: Number(tax) || 0,
			...(purchasedAt
				? { purchased_at: new Date(purchasedAt).toISOString() }
				: {}),
			// Always sent once the roster is known, so removing a job here actually
			// removes it. Shares are not sent at all — the server derives them from
			// the lines below, which is the same split.
			...(allocs.length > 0
				? {
						allocations: allocs.map((a) => ({
							job_id: a.job_id,
							job_visit_id: a.job_visit_id,
						})),
					}
				: {}),
			lines: lines.map((d, i) => ({
				description: d.description.trim(),
				quantity: Number(d.quantity),
				unit_price: Number(d.unit_price),
				inventory_item_id: d.inventory_item_id || null,
				// A refund's stock leaves wherever its purchase put it, so a
				// disposition here would be a claim nothing reads.
				disposition: isRefund ? null : d.disposition || null,
				disposition_vehicle_id:
					!isRefund && d.disposition === "receive" && d.disposition_vehicle_id
						? d.disposition_vehicle_id
						: null,
				// `allocationKey` is the sheet's own handle on a roster row and means
				// nothing to the server, so the job is named here deliberately rather
				// than by spreading the draft.
				job_id: jobOfKey.get(d.allocationKey) ?? null,
				acknowledged: d.acknowledged,
				ocr_confidence: d.ocrConfidence,
				sort_order: i,
			})),
		}),
		[vendor, totalNum, tax, purchasedAt, lines, allocs, jobOfKey, isRefund]
	);

	// `Number("")` is 0 and `Number("abc")` is NaN, so neither a blank nor a
	// typo is a number anybody chose. NaN also serializes as null and fails at
	// the server, which tells the technician nothing they can act on here.
	const notANumber = (v: string) => !v.trim() || !Number.isFinite(Number(v));

	const incomplete =
		lines.length === 0 ||
		unconfirmed > 0 ||
		!purchase.receipt_image_url ||
		unassigned > 0 ||
		lines.some((l) => !l.description.trim()) ||
		lines.some((l) => notANumber(l.quantity) || notANumber(l.unit_price));

	// Why the submit is dead, said in the button rather than under it: a line of
	// its own cost 24px of a 390x844 screen at all times, and a technician staring
	// at a disabled button is asking exactly this question.
	// Measured the way the server measures it — the larger of the total and the
	// lines plus tax — so the button never offers a submit the server refuses.
	const refundClaim = Math.max(
		totalNum,
		lines.reduce((n, d) => n + (Number(d.quantity) || 0) * (Number(d.unit_price) || 0), 0) +
			(Number(tax) || 0)
	);
	const refundRemaining = refundParent ? Number(refundParent.remaining) : null;
	const overRefund = refundRemaining != null && refundClaim > refundRemaining + 0.005;

	const blockedReason = !incomplete
		? overRefund
			? `More than the ${money(refundRemaining ?? 0)} left to refund`
			: null
		: !purchase.receipt_image_url
			? copy.blockedNoPhoto
			: lines.length === 0
				? copy.blockedNoLines
				: unconfirmed > 0
					? `Check ${unconfirmed} line${unconfirmed === 1 ? "" : "s"} against the paper`
					: unassigned > 0
						? `Say which job ${unassigned === 1 ? "one line was" : `${unassigned} lines were`} for`
						: lines.some((l) => !l.description.trim())
							? "Every line needs a description"
							: "Enter a number for quantity and price on every line";

	// A job the technician can add the receipt to. Their own jobs only, and never
	// one the receipt already covers.
	const { data: myJobs = [] } = useMyJobsQuery(editable);
	const addableJobs = myJobs.filter((j) => !allocs.some((a) => a.job_id === j.job_id));

	function addJob(id: string) {
		const job = myJobs.find((j) => j.job_id === id);
		if (!job) return;
		setDirty(true);
		// Every line was the lone job's by definition; say so explicitly before a
		// second job exists, or they all read as unclaimed the moment it does.
		if (allocs.length === 1) {
			const only = allocs[0]!.key;
			setLines((prev) =>
				prev.map((d) =>
					d.allocationKey ? d : { ...d, allocationKey: only }
				)
			);
		}
		setAllocs((prev) => [
			...prev,
			{
				key: `new-${id}`,
				job_id: id,
				job_visit_id: job.visit_id ?? null,
				label: jobLabel(job.job_name, job.job_number),
				visit_name: job.visit_name,
				visit_start: job.scheduled_start_at,
			},
		]);
	}

	// A job leaving takes its claim on the lines with it, rather than leaving them
	// pointing at a row that is gone.
	function removeJob(key: string) {
		setDirty(true);
		setLines((prev) =>
			prev.map((d) => (d.allocationKey === key ? { ...d, allocationKey: "" } : d))
		);
		setAllocs((prev) => prev.filter((a) => a.key !== key));
	}

	function touch(set: (v: string) => void) {
		return (v: string) => {
			setDirty(true);
			set(v);
		};
	}

	async function onDiscard() {
		try {
			await remove.mutateAsync(purchase.id);
			navigate(PURCHASES);
		} catch (err) {
			toast.error(errorMessage(err, copy.discardFailed));
		}
	}

	async function onSubmit() {
		try {
			const result = await submit.mutateAsync({ id: purchase.id, sheet });
			setDirty(false);
			toast.success(
				result.flags.length > 0
					? `Submitted with ${result.flags.length} note${result.flags.length === 1 ? "" : "s"} for dispatch`
					: copy.submitted
			);
			navigate(PURCHASES);
		} catch (err) {
			toast.error(errorMessage(err, "Failed to submit"));
		}
	}

	async function onRequestPreauth() {
		try {
			// The pre-approval button is deliberately not gated on a finished sheet —
			// a technician asks permission before they have typed everything. Sending
			// a half-typed line would fail validation and lose the request, so the
			// header goes on its own and the lines wait for submit.
			const linesReady = lines.every(
				(l) => l.description.trim() && !notANumber(l.quantity) && !notANumber(l.unit_price)
			);
			const preauthSheet = linesReady ? sheet : { ...sheet, lines: undefined };
			await preauth.mutateAsync({
				id: purchase.id,
				estimatedAmount: awaitingPurchase
					? estimateNum
					: totalNum || Number(purchase.estimated_amount) || 0,
				reason: reason.trim() || null,
				// Sent for the same reason submit sends it: clearing `dirty` below
				// re-arms the re-seed effect, which would overwrite the sheet with
				// whatever the server last knew.
				sheet: preauthSheet,
			});
			// Only cleared when the whole sheet went. Otherwise the lines the
			// technician is still typing were never persisted, and re-arming the
			// re-seed effect would overwrite them with the server's stale copy —
			// the original bug, reintroduced through the back door.
			if (linesReady) setDirty(false);
			toast.success("Sent to dispatch for pre-approval");
		} catch (err) {
			toast.error(errorMessage(err, "Failed to request pre-approval"));
		}
	}

	async function startRefund() {
		// The server would hand the same draft back, but there is no reason to
		// ask when the answer is already on screen.
		const openDraft = purchase.refund_summary?.draft_id;
		if (openDraft) {
			navigate(`/technician/purchases/${openDraft}`);
			return;
		}
		try {
			const created = await refund.mutateAsync({ parentPurchaseId: purchase.id });
			navigate(`/technician/purchases/${created.id}`);
			toast.success("Refund started — attach the credit slip");
		} catch (err) {
			toast.error(errorMessage(err, "Could not start the refund"));
		}
	}

	return (
		// No page padding: the technician layout already supplies it, including its
		// own pb-20. `pb` adds what the fixed action bar needs on top of the equally
		// fixed bottom nav — 65px + 64px against the layout's 80, plus slack.
		<TechPage className="space-y-4 pb-16">
			{/* Status and total stay put: the line list is long enough that a
			    technician scrolling it loses both, and both decide what to do next.
			    Discard rides up here rather than under the submit — it is
			    irreversible, and the top corner is the one place on a phone a thumb
			    does not reach by accident. */}
			<header className="sticky top-0 z-10 -mx-4 flex items-center gap-2 border-b border-border bg-canvas px-4 py-2.5">
				<div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
					<h1 className="min-w-0 truncate text-base font-semibold text-text-primary">
						{sheetTitle(purchase)}
					</h1>
					<span className="flex-shrink-0 text-base font-semibold tabular-nums text-text-primary">
						{/* Money coming back, so it reads as coming back. */}
						{isRefund ? "−" : ""}
						{money(awaitingPurchase ? estimateNum : totalNum)}
					</span>
				</div>
				{editable && purchase.status === "draft" && (
					// The negative margin keeps a 44px target inside a 44px header
					// rather than growing the one bar that is always on screen.
					<button
						type="button"
						aria-label={copy.discardLabel}
						onClick={() => setConfirmingDiscard(true)}
						className="-my-2.5 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-surface hover:text-error-text"
					>
						<Trash2 aria-hidden size={16} />
					</button>
				)}
			</header>

			{/* ConfirmDialog is z-50, and so is the technician bottom nav — which
			    renders after the page, so at equal z-index the nav paints over the
			    dialog and stays tappable behind a destructive confirm. A positioned
			    ancestor gives the fixed dialog a stacking context of its own, which
			    lifts it without touching the component every dispatch page shares. */}
			<div className="relative z-[60]">
				<ConfirmDialog
					open={confirmingDiscard}
					title={copy.discardTitle}
					body={copy.discardBody}
					confirmLabel="Discard"
					tone="destructive"
					pending={remove.isPending}
					onConfirm={() => void onDiscard()}
					onCancel={() => setConfirmingDiscard(false)}
				/>
				<ConfirmDialog
					open={leavingTo != null}
					title="Leave without sending?"
					body="What you've changed here isn't saved yet."
					confirmLabel="Leave"
					onConfirm={() => leavingTo && navigate(leavingTo)}
					onCancel={() => setLeavingTo(null)}
				/>
			</div>

			{refundParent && <RefundOf parent={refundParent} editable={editable} />}

			{(purchase.review_note || purchase.preauth_note) && (
				<div className="space-y-2">
					{purchase.review_note && (
						<SheetNotice
							tone={dispatchAsks ? "warning" : "neutral"}
							icon={dispatchAsks ? AlertTriangle : MessageSquare}
							title={
								purchase.status === "queried"
									? "Dispatch asked for a change"
									: purchase.status === "rejected"
										? "Dispatch turned this down"
										: "Note from dispatch"
							}
						>
							{purchase.review_note}
						</SheetNotice>
					)}
					{purchase.preauth_note && (
						<SheetNotice
							tone={purchase.status === "preauth_denied" ? "warning" : "neutral"}
							icon={ShieldQuestion}
							title={
								purchase.status === "preauth_denied"
									? "Dispatch said no"
									: "Pre-approval note"
							}
						>
							{purchase.preauth_note}
						</SheetNotice>
					)}
				</div>
			)}

			{purchase.refund_summary && <RefundsOnPurchase summary={purchase.refund_summary} paid={totalNum} />}

			{shownFlags.length > 0 && (
				// Advisory: flags route a reviewer's attention and never block, so
				// they read as information rather than as something owed.
				<SheetNotice tone="info" icon={Flag} title="Dispatch will check">
					<ul className="space-y-0.5">
						{shownFlags.map((f, i) => (
							<li key={`${f.code}-${i}`}>{f.message}</li>
						))}
					</ul>
				</SheetNotice>
			)}

			{awaitingPurchase ? (
				// Nothing has been bought, so a receipt card, a priced "Total paid" field
				// and an empty line editor are three forms for work that cannot be done
				// yet. What matters at this point is the ask itself.
				<section className="rounded-xl border border-border bg-base p-4">
					<h2 className="mb-1 text-sm font-semibold text-text-primary">
						What you asked for
					</h2>
					<p className="mb-3 text-xs text-text-muted">
						There is no receipt to photograph and no lines to
						check until dispatch says yes and you have paid.
					</p>
					<label className="block">
						<span className="mb-1 block text-xs text-text-muted">
							Estimated cost
						</span>
						<input
							value={estimate}
							disabled={!editable}
							inputMode="decimal"
							onChange={(e) =>
								touch(setEstimate)(e.target.value)
							}
							className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm tabular-nums text-text-primary disabled:opacity-60"
						/>
					</label>
					<label className="mt-3 block">
						<span className="mb-1 block text-xs text-text-muted">
							Reason
						</span>
						<input
							value={reason}
							disabled={!editable}
							onChange={(e) =>
								touch(setReason)(e.target.value)
							}
							placeholder="Part not on the truck, job is down"
							className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary placeholder:text-text-muted disabled:opacity-60"
						/>
					</label>
					{purchase.status === "pending_preauth" && (
						<p className="mt-3 text-xs text-text-secondary">
							Waiting on dispatch. You get a notification
							either way — do not pay for it until then.
						</p>
					)}
				</section>
			) : (
				<>
					<ReceiptCaptureCard
						purchase={purchase}
						editable={editable}
					/>

					<section className="rounded-xl border border-border bg-base p-4">
						<h2 className="mb-3 text-sm font-semibold text-text-primary">
							{copy.detailsTitle}
						</h2>
						{/* Label and diff are siblings, not both inside the <label>:
						    a <label> may hold only the one control it names, and a
						    nested button gets double-activated by implicit
						    click-forwarding. */}
						<div>
							<div className="mb-1 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
								<label htmlFor="fp-vendor">
									{isRefund ? "Returned to" : "Vendor"}
								</label>
								<ReceiptValueDiff
									label="Vendor"
									entered={vendor}
									receipt={
										receipt?.vendor_name ??
										null
									}
									confidence={scoreOf(
										"vendor_name"
									)}
									editable={editable && !isRefund}
									controlId="fp-vendor"
									onUse={touch(setVendor)}
								/>
							</div>
							<input
								id="fp-vendor"
								value={vendor}
								// The store the part went back to is the store it came
								// from; the refund copies it from the purchase.
								disabled={!editable || isRefund}
								onChange={(e) =>
									touch(setVendor)(
										e.target.value
									)
								}
								placeholder="As printed on the receipt"
								className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary placeholder:text-text-muted disabled:opacity-60"
							/>
						</div>
						<div className="mt-3 flex gap-2">
							<div className="flex-1">
								<div className="mb-1 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
									<label htmlFor="fp-total">
										{copy.totalLabel}
									</label>
									<ReceiptValueDiff
										label="total"
										entered={total}
										receipt={money2(
											receipt?.total
										)}
										confidence={scoreOf(
											"total"
										)}
										numeric
										editable={editable}
										controlId="fp-total"
										onUse={touch(
											setTotal
										)}
									/>
								</div>
								<input
									id="fp-total"
									value={total}
									disabled={!editable}
									inputMode="decimal"
									onChange={(e) =>
										touch(setTotal)(
											e.target
												.value
										)
									}
									className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm tabular-nums text-text-primary disabled:opacity-60"
								/>
							</div>
							<div className="flex-1">
								<div className="mb-1 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
									<label htmlFor="fp-tax">
										Tax
									</label>
									<ReceiptValueDiff
										label="tax"
										entered={tax}
										receipt={money2(
											receipt?.tax_amount
										)}
										confidence={scoreOf(
											"tax_amount"
										)}
										numeric
										editable={editable}
										controlId="fp-tax"
										onUse={touch(
											setTax
										)}
									/>
								</div>
								<input
									id="fp-tax"
									value={tax}
									disabled={!editable}
									inputMode="decimal"
									onChange={(e) =>
										touch(setTax)(
											e.target
												.value
										)
									}
									className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm tabular-nums text-text-primary disabled:opacity-60"
								/>
							</div>
						</div>
						<div className="mt-3">
							<div className="mb-1 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
								<label htmlFor="fp-purchased-at">
									{copy.dateLabel}
								</label>
								<ReceiptValueDiff
									label="purchase time"
									entered={purchasedAt}
									receipt={
										receipt?.purchased_at
											? toLocalInputValue(
													receipt.purchased_at
												)
											: null
									}
									confidence={scoreOf(
										"purchased_at"
									)}
									editable={editable}
									controlId="fp-purchased-at"
									onUse={touch(
										setPurchasedAt
									)}
								/>
							</div>
							<input
								id="fp-purchased-at"
								type="datetime-local"
								value={purchasedAt}
								disabled={!editable}
								onChange={(e) =>
									touch(setPurchasedAt)(
										e.target.value
									)
								}
								className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary disabled:opacity-60"
							/>
						</div>
					</section>

					<PurchaseLineEditor
						purchase={purchase}
						editable={editable}
						extractedLines={extraction?.lines ?? []}
						totalPaid={totalNum}
						taxAmount={Number(tax) || 0}
						myVehicle={myVehicle}
						jobs={jobOptions}
						lines={lines}
						onChange={(next) => {
							setDirty(true);
							setLines(next);
						}}
					/>
				</>
			)}

			<section className="rounded-xl border border-border bg-base p-4">
				<div className="mb-3 flex items-baseline justify-between gap-2">
					<h2 className="text-sm font-semibold text-text-primary">
						{copy.jobsTitle}
					</h2>
					{allocs.some((a) => a.job_visit_id) && (
						<span className="text-xs text-text-muted">Tap to open the visit</span>
					)}
				</div>
				<ul className="space-y-2">
					{allocs.map((a) => {
						// Read off the lines, never typed. A lone job carries the whole
						// receipt, and before the receipt exists that is the estimate
						// rather than the zero total.
						const amount = isSplit
							? (shareOfKey.get(a.key) ?? 0)
							: awaitingPurchase
								? estimateNum
								: totalNum;
						const to = a.job_visit_id
							? `/technician/visits/${a.job_visit_id}`
							: null;
						const start = a.visit_start ? new Date(a.visit_start) : null;
						const body = (
							<>
								{/* The visit's day as a calendar chip: the one fact a
								    truncated subtitle kept cutting off at phone width. */}
								{to && start ? (
									<span className="flex h-10 w-10 flex-shrink-0 flex-col items-center justify-center rounded-md border border-border bg-base leading-none">
										<span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
											{start.toLocaleDateString(undefined, {
												month: "short",
											})}
										</span>
										<span className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">
											{start.getDate()}
										</span>
									</span>
								) : (
									<span
										aria-hidden
										className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-text-faint"
									>
										<CalendarOff size={16} />
									</span>
								)}
								<span className="min-w-0 flex-1">
									<span className="line-clamp-2 text-sm font-medium text-text-primary">
										{a.label}
									</span>
									<span className="block truncate text-xs text-text-muted">
										{to
											? (a.visit_name ?? "Visit")
											: "No visit to open"}
										{/* The chip is visual; say the date once for a reader. */}
										{to && start && (
											<span className="sr-only">
												{`, ${start.toLocaleDateString()}`}
											</span>
										)}
									</span>
								</span>
								<span className="flex-shrink-0 text-sm font-medium tabular-nums text-text-primary">
									{isRefund ? "−" : ""}
									{money(amount)}
								</span>
							</>
						);
						return (
							<li key={a.key} className="flex items-stretch gap-2">
								{to ? (
									// The visit, not the job: a technician has no job
									// page, and the visit keeps its history once it is
									// in the past. A bordered tile with a chevron, so a
									// lone job still reads as somewhere to go.
									<Link
										to={to}
										onClick={(e) => {
											if (!dirty) return;
											e.preventDefault();
											setLeavingTo(to);
										}}
										className={`group flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg border border-border bg-surface py-2 pl-2 pr-1.5 transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-raised active:bg-surface-raised ${FOCUS_RING}`}
									>
										{body}
										<ChevronRight
											aria-hidden
											size={16}
											className="flex-shrink-0 text-text-muted transition-colors duration-150 ease-out group-hover:text-text-primary"
										/>
									</Link>
								) : (
									// Dashed and flat: the same shape, plainly not a button.
									<div className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg border border-dashed border-border py-2 pl-2 pr-3">
										{body}
									</div>
								)}
								{/* A sibling of the tile, never inside it: two actions
								    in one target is a tap that does the wrong one. */}
								{isSplit && editable && (
									<button
										type="button"
										aria-label={`Remove ${a.label}`}
										onClick={() => removeJob(a.key)}
										className={`flex w-11 flex-shrink-0 items-center justify-center rounded-lg border border-border text-text-secondary transition-colors duration-150 ease-out hover:border-error-border hover:text-error-text ${FOCUS_RING}`}
									>
										<X aria-hidden size={14} />
									</button>
								)}
							</li>
						);
					})}
				</ul>

				{/* One counter trip can serve two call-outs. Adding the job here is what
				    lets each line say which of them it was for. */}
				{/* A refund credits the jobs its purchase charged, and no others. */}
				{editable && !isRefund && addableJobs.length > 0 && (
					<label className="mt-2 block">
						<span className="mb-1 block text-xs text-text-muted">
							Also bought for another job?
						</span>
						<select
							value=""
							onChange={(e) => addJob(e.target.value)}
							className="h-11 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary"
						>
							<option value="">
								Add a job to split this receipt…
							</option>
							{addableJobs.map((j) => (
								<option
									key={j.job_id}
									value={j.job_id}
								>
									{j.job_name ||
										`Job ${j.job_number ?? ""}`.trim()}
								</option>
							))}
						</select>
					</label>
				)}
				{unassigned > 0 && (
					<p className="mt-2 text-xs text-warning-text">
						{unassigned} line{unassigned === 1 ? "" : "s"} do
						not say which job they were for — tag them above
						before you can submit.
					</p>
				)}
				{isRefund ? (
					// Refunds never write to a visit — approval flags dispatch to
					// adjust the invoice by hand.
					<p className="mt-2 text-xs text-text-muted">
						Dispatch takes this off the customer's bill.
					</p>
				) : (
					!billsAVisit && (
						<p className="mt-2 text-xs text-text-muted">
							Not attached to a visit, so nothing is added to
							the customer's bill — dispatch will handle the
							charge.
						</p>
					)
				)}
			</section>

			{editable && (
				// Clear of the layout's bottom nav (fixed, h-16, z-50) — at bottom-0
				// it painted over the button. One row at rest: both notices below
				// render nothing until a ceiling is actually crossed, so a breach
				// grows the bar rather than reserving room for one that never comes.
				<div className="fixed inset-x-0 bottom-16 z-40 border-t border-border bg-base px-4 py-2.5">
					{/* The reason the numbers changed, above the button that acts on them. */}
					<LimitBreachNotice
						breaches={breaches}
						amount={checkedAmount}
						shares={shares}
					/>
					{/* Which ceiling is crossed is not known yet, but the button
					    already had to choose. Say so, rather than letting a
					    notice-less warning button imply the figure has been cleared. */}
					{!awaitingPurchase && needsPreauth && assumeBreach && (
						<p
							role="status"
							aria-live="polite"
							className="rounded-lg border border-warning-border bg-warning-bg p-3 text-xs text-warning-text"
						>
							Checking this against your limits…
						</p>
					)}
					{(breaches.length > 0 ||
						(!awaitingPurchase &&
							needsPreauth &&
							assumeBreach)) && <div className="h-2.5" />}

					{awaitingPurchase ? (
						// Live whenever a preauth request was denied: without it, "Ask
						// dispatch again" would be refused because the purchase is no
						// longer a draft, and "Submit for review" would want a receipt
						// for something that was never bought — leaving both buttons
						// dead with no way forward.
						<FooterButton
							tone="warning"
							icon={
								<ShieldQuestion
									aria-hidden
									size={16}
								/>
							}
							label="Ask dispatch again"
							blockedReason={
								estimateNum <= 0
									? "Put an estimated cost in first"
									: null
							}
							disabled={
								preauth.isPending ||
								estimateNum <= 0
							}
							onClick={() => void onRequestPreauth()}
						/>
					) : needsPreauth ? (
						<FooterButton
							tone="warning"
							icon={
								<ShieldQuestion
									aria-hidden
									size={16}
								/>
							}
							label="Send for pre-approval"
							blockedReason={null}
							disabled={preauth.isPending}
							onClick={() => void onRequestPreauth()}
						/>
					) : (
						<FooterButton
							tone="primary"
							icon={<Send aria-hidden size={16} />}
							label={copy.submitLabel}
							blockedReason={blockedReason}
							disabled={submit.isPending || incomplete || overRefund}
							onClick={() => void onSubmit()}
						/>
					)}
				</div>
			)}

			{canRefund && (
				// Same slot as the editable bar, which never shows alongside it —
				// `approved` is not tech-editable — so the thumb finds this screen's
				// one action where every other state of it keeps its own.
				<div className="fixed inset-x-0 bottom-16 z-40 border-t border-border bg-base px-4 py-2.5">
					<ReturnPartBar
						summary={purchase.refund_summary ?? null}
						pending={refund.isPending}
						onClick={() => void startRefund()}
					/>
				</div>
			)}
		</TechPage>
	);
}

/**
 * What this refund is against, and how much of it is still refundable. Without it
 * the sheet is a blank credit with a vendor name, and the ceiling is only
 * discovered as a refusal at submit.
 */
function RefundOf({
	parent,
	editable,
}: {
	parent: FieldPurchaseRefundParent;
	editable: boolean;
}) {
	return (
		<Link
			to={`/technician/purchases/${parent.id}`}
			className={`group flex min-h-14 items-center gap-3 rounded-lg border border-border bg-surface py-2 pl-3 pr-1.5 transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-raised ${FOCUS_RING}`}
		>
			<Undo2 aria-hidden size={16} className="flex-shrink-0 text-text-muted" />
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium text-text-primary">
					Original purchase
				</span>
				<span className="block truncate text-xs text-text-muted">
					{[
						parent.vendor_name,
						parent.purchased_at &&
							new Date(parent.purchased_at).toLocaleDateString(),
					]
						.filter(Boolean)
						.join(" · ") || "Open the purchase"}
				</span>
				{/* The ceiling only matters while the amount can still change. */}
				{editable && (
					<span className="block truncate text-xs text-text-muted">
						Up to {money(Number(parent.remaining))} can still be refunded
					</span>
				)}
			</span>
			{/* Its own column, centred on the tile as the job tiles are. */}
			<span className="flex-shrink-0 text-sm font-medium tabular-nums text-text-primary">
				{money(Number(parent.total))}
			</span>
			<ChevronRight
				aria-hidden
				size={16}
				className="flex-shrink-0 text-text-muted transition-colors duration-150 ease-out group-hover:text-text-primary"
			/>
		</Link>
	);
}

const TONE_CLASS = {
	success: "text-success",
	warning: "text-warning-text",
	error: "text-error-text",
	muted: "text-text-muted",
} as const;

/**
 * Every refund raised against this purchase, and what the purchase has cost once
 * they are counted. A list of amounts alone read every refund as money back —
 * including the ones dispatch turned down.
 */
function RefundsOnPurchase({
	summary,
	paid,
}: {
	summary: FieldPurchaseRefundSummary;
	paid: number;
}) {
	if (summary.refunds.length === 0) return null;
	const ledger = refundLedger(paid, summary);
	const rows: [string, number][] = [
		["Credit received", ledger.received],
		["Credit on its way", ledger.onItsWay],
		["With dispatch", ledger.withDispatch],
	];
	return (
		<section className="rounded-xl border border-border bg-base p-4">
			<div className="mb-1 flex items-center gap-2">
				<h2 className="text-sm font-semibold text-text-primary">Refunds</h2>
				<span className="rounded-full bg-surface px-1.5 text-xs tabular-nums text-text-muted">
					{summary.refunds.length}
				</span>
			</div>
			<p className="mb-2 text-xs text-text-muted">
				Parts you took back against this receipt
			</p>
			<ul className="-mx-2">
				{summary.refunds.map((r) => {
					const counted = r.status !== "rejected";
					return (
						<li key={r.id}>
							<Link
								to={`/technician/purchases/${r.id}`}
								className="flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-surface-raised"
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm text-text-primary">
										{partsSummary(r.parts) ?? "Refund"}
									</span>
									<span className="block truncate text-xs text-text-muted">
										{r.returned_at
											? `Returned ${new Date(r.returned_at).toLocaleDateString()}`
											: `Started ${new Date(r.created_at).toLocaleDateString()}`}
									</span>
								</span>
								<span className="flex-shrink-0 text-right">
									<span
										className={`block text-sm tabular-nums ${
											counted
												? "text-text-primary"
												: "text-text-muted line-through"
										}`}
									>
										{counted ? "−" : ""}
										{money(Number(r.amount))}
									</span>
									<span
										className={`block text-xs font-medium ${TONE_CLASS[refundStateTone(r)]}`}
									>
										{refundStateLabel(r)}
									</span>
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
			<dl className="mt-2 space-y-1 border-t border-border pt-2 text-xs">
				<div className="flex justify-between gap-2 text-text-secondary">
					<dt>Paid</dt>
					<dd className="tabular-nums">{money(ledger.paid)}</dd>
				</div>
				{rows
					.filter(([, v]) => v > 0)
					.map(([label, v]) => (
						<div
							key={label}
							className="flex justify-between gap-2 text-text-secondary"
						>
							<dt>{label}</dt>
							<dd className="tabular-nums">−{money(v)}</dd>
						</div>
					))}
				<div className="flex justify-between gap-2 border-t border-border pt-1 text-sm font-semibold text-text-primary">
					{/* Only a landed credit comes off: one still on its way or with
					    dispatch can yet be turned down. */}
					<dt>Net cost so far</dt>
					<dd className="tabular-nums">{money(ledger.net)}</dd>
				</div>
				{ledger.stillRefundable > 0 && (
					<p className="text-text-muted">
						{money(ledger.stillRefundable)} still refundable
					</p>
				)}
			</dl>
		</section>
	);
}

/**
 * A return is its own purchase pointing back at this one: same receipt (the credit
 * slip), same lines, same review. Outline rather than primary — the purchase is
 * done, and a filled button would read as a step still owed on it.
 */
function ReturnPartBar({
	summary,
	pending,
	onClick,
}: {
	summary: FieldPurchaseRefundSummary | null;
	pending: boolean;
	onClick: () => void;
}) {
	// Every part accounted for: nothing left to start, so no button to press.
	if (summary && Number(summary.remaining) <= 0 && !summary.draft_id) {
		return (
			<p className="flex h-11 items-center gap-2 text-sm text-text-muted">
				<Undo2 aria-hidden size={16} /> Fully refunded
			</p>
		);
	}
	const resuming = !!summary?.draft_id;
	const subtitle = resuming
		? "You started a refund and have not sent it"
		: summary && summary.in_progress_count > 0
			? pendingRefundsLine(
					summary.in_progress_count,
					money(Number(summary.in_progress_value))
				)
			: "Refund it against this receipt";
	return (
		<div className="flex items-center gap-3">
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-text-primary">
					{resuming ? "Refund in progress" : "Took a part back?"}
				</p>
				<p className="truncate text-xs text-text-muted">{subtitle}</p>
			</div>
			<button
				type="button"
				disabled={pending}
				aria-busy={pending}
				onClick={onClick}
				className="inline-flex h-11 flex-shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-semibold text-text-primary transition-colors duration-150 ease-out hover:enabled:border-border-strong hover:enabled:bg-surface-raised disabled:opacity-60"
			>
				{pending ? (
					<Loader2 aria-hidden size={16} className="animate-spin" />
				) : (
					<Undo2 aria-hidden size={16} />
				)}
				{pending ? "Starting…" : resuming ? "Continue refund" : "Return a part"}
			</button>
			<p role="status" aria-live="polite" className="sr-only">
				{pending ? "Starting a refund" : ""}
			</p>
		</div>
	);
}

/**
 * The one action, and — when it is dead — the reason, carried as its own label. A
 * disabled button plus a sentence underneath is two rows for one message, and the
 * sentence was on screen whether or not it applied.
 */
function FooterButton({
	tone,
	icon,
	label,
	blockedReason,
	disabled,
	onClick,
}: {
	tone: "primary" | "warning";
	icon: ReactNode;
	label: string;
	blockedReason: string | null;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<>
			<button
				type="button"
				disabled={disabled}
				onClick={onClick}
				className={`inline-flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:opacity-40 ${
					tone === "warning"
						? "bg-warning text-on-warning hover:enabled:opacity-90"
						: "bg-primary-hover text-on-primary hover:enabled:bg-primary-active"
				}`}
			>
				{blockedReason ? <AlertTriangle aria-hidden size={16} /> : icon}
				{blockedReason ?? label}
			</button>
			{/* Renaming a button nobody is focused on announces nothing, and this is
			    the message that decides whether the trip is over. */}
			<p role="status" aria-live="polite" className="sr-only">
				{blockedReason ?? ""}
			</p>
		</>
	);
}
