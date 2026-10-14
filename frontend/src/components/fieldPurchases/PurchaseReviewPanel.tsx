import { forwardRef, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
	AlertTriangle,
	Boxes,
	Check,
	Clock,
	FileSearch,
	Loader2,
	MapPin,
	MessageSquare,
	RefreshCw,
	ScanLine,
	ShieldCheck,
	ShoppingCart,
	ChevronUp,
	Undo2,
	Wallet,
	X,
} from "lucide-react";
import {
	useDecidePreauth,
	useFieldPurchase,
	useReviewFieldPurchase,
	useSecondSignoff,
	useSettleRefund,
} from "../../hooks/useFieldPurchases";
import { useQBStatusQuery, usePushFieldPurchaseToQBMutation } from "../../hooks/useQuickbooks";
import { useToast } from "../ui/useToast";
import { errorMessage } from "../../util/util";
import ReceiptViewer from "./ReceiptViewer";
import PurchaseTimeline from "./PurchaseTimeline";
import { ActionButton, AgeChip, Chip, MetaCell, SectionBar } from "./fieldPurchaseUi";
import { COL_LABEL, FOCUS_RING, isTypingKeystroke, money, RECORD_LINK } from "./fieldPurchaseFormat";
import { reconcileHref } from "../reconcile/reconcileFilters";
import { usePermission } from "../../hooks/usePermission";
import { useAssignLineJob, useCaptureLocation, useLinkSupplier } from "../../hooks/useFieldPurchases";
import { useSuppliers } from "../../hooks/useSuppliers";
import { normalizeSupplierName } from "../../lib/suppliers";
import FilterableSelect, { type FilterableOption } from "../ui/forms/FilterableSelect";
import SupplierFormModal from "../suppliers/SupplierFormModal";
import {
	DISPOSITION_LABELS,
	FIELD_PURCHASE_STATUS_LABELS,
	FLAG_META,
	isPrePurchase,
	OCR_LOW_CONFIDENCE,
	type FieldPurchase,
	type FieldPurchaseLine,
} from "../../types/fieldPurchases";

/**
 * The dispatcher's side of emergency purchasing. Reimbursement has no
 * independent upstream record of the spend — the receipt is the only proof — so
 * this panel leads with the evidence and keeps the decision within reach of it,
 * rather than making the reviewer scroll away from the photo to read the lines.
 */

/** What a line does to stock, which is the whole difference between dispositions. */
function stockEffect(l: FieldPurchaseLine): string {
	if (!l.inventory_item) return "Unmapped";
	const intent = l.disposition ? DISPOSITION_LABELS[l.disposition] : "Not recorded";
	const where = l.disposition_vehicle ? ` (${l.disposition_vehicle.name})` : "";
	return `${l.inventory_item.name} — ${intent}${where}`;
}

/**
 * What this decision actually settles on the customer's bill.
 *
 * The charge was raised at submit so the visit could be invoiced the moment the
 * technician left; approving confirms it and rejecting takes it back off. A
 * reviewer pressing either should know which of the two they are doing.
 */
function BilledSummary({ purchase }: { purchase: FieldPurchase }) {
	const billed = purchase.lines.filter((l) => l.visit_line_item_id);
	if (billed.length === 0) return null;

	const total = billed.reduce((n, l) => n + Number(l.line_total), 0);
	const decided = purchase.status === "approved" || purchase.status === "rejected";

	return (
		<p className="px-4 py-3 text-xs text-text-secondary">
			{billed.length} line{billed.length === 1 ? "" : "s"} ({money(total)}) already on the
			customer's bill.{" "}
			{decided
				? purchase.status === "approved"
					? "Approving confirmed the charge."
					: "Rejecting removed the charge."
				: "Rejecting will take it back off."}
		</p>
	);
}

/**
 * Which job a line served, and — while the receipt is still under review — the
 * reviewer's chance to correct it. The technician answers at the counter with a
 * paid receipt in hand; the reviewer is the one who knows the two call-outs apart,
 * and the charge follows the correction onto the right invoice.
 */
function LineJobCell({
	purchase,
	line,
	names,
}: {
	purchase: FieldPurchase;
	line: FieldPurchaseLine;
	names: Map<string, string>;
}) {
	const assign = useAssignLineJob();
	const toast = useToast();
	const canReview = usePermission("review_field_purchases");
	const editable = canReview && purchase.status === "pending_review";

	if (!editable) {
		return line.allocation_id ? (
			<span className="text-text-secondary">{names.get(line.allocation_id) ?? "Job"}</span>
		) : (
			<span className="text-warning">No job</span>
		);
	}

	return (
		<select
			value={line.allocation_id ?? ""}
			disabled={assign.isPending}
			aria-label={`Job for ${line.description}`}
			onChange={async (e) => {
				const jobId = purchase.allocations.find((a) => a.id === e.target.value)?.job_id;
				if (!jobId) return;
				try {
					await assign.mutateAsync({ id: purchase.id, lineId: line.id, jobId });
					toast.success("Line moved — the charge moved with it");
				} catch (err) {
					toast.error(errorMessage(err, "Could not move that line"));
				}
			}}
			className="h-8 max-w-[9rem] rounded-md border border-border bg-base px-1.5 text-xs text-text-primary disabled:opacity-50"
		>
			{/* Selectable only in the sense that it is where an unclaimed line
			    already sits; picking a job is the only move out of it. */}
			<option value="" disabled>
				No job
			</option>
			{purchase.allocations.map((a) => (
				<option key={a.id} value={a.id}>
					{names.get(a.id) ?? "Job"}
				</option>
			))}
		</select>
	);
}

const statusTone = (p: FieldPurchase) =>
	p.status === "approved"
		? "success"
		: p.status === "rejected" || p.status === "preauth_denied"
			? "error"
			: p.status === "queried"
				? "warning"
				: "primary";

/** A field the reader was unsure about is worth a second pair of eyes, not silence. */
function lowConfidence(confidence: number | undefined): boolean {
	return confidence !== undefined && confidence < OCR_LOW_CONFIDENCE;
}

/** The pane before there is a purchase in it — nothing picked, loading, or broken. */
function PanelPlaceholder({
	icon,
	title,
	body,
	action,
}: {
	icon: ReactNode;
	title: string;
	body?: string;
	action?: ReactNode;
}) {
	return (
		<div
			// Announced because this pane swaps under a selection the reviewer made
			// with the keyboard, which moves no focus of its own.
			role="status"
			aria-live="polite"
			className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
		>
			{icon}
			<p className="text-sm text-text-muted">{title}</p>
			{body && <p className="max-w-72 text-xs text-text-tertiary">{body}</p>}
			{action}
		</div>
	);
}

export default function PurchaseReviewPanel({
	purchaseId,
	onDecided,
	onReceiptFullscreenChange,
}: {
	purchaseId: string | null;
	/** Advances the queue: the row a decision just settled is no longer the work. */
	onDecided: () => void;
	/** The page owns its own shortcut (queue j/k) that needs to stand down for the
	 *  same reason this panel's do: navigating a queue the dispatcher cannot see
	 *  past is its own defect. */
	onReceiptFullscreenChange?: (open: boolean) => void;
}) {
	const { data, isLoading, isError, isFetching, refetch } = useFieldPurchase(
		purchaseId ?? undefined
	);
	const review = useReviewFieldPurchase();
	const decide = useDecidePreauth();
	const sign = useSecondSignoff();
	const settle = useSettleRefund();
	const qbConnected = !!useQBStatusQuery().data?.connected;
	const pushToQB = usePushFieldPurchaseToQBMutation();
	const linkSupplier = useLinkSupplier();
	const { data: suppliersData } = useSuppliers();
	const [supplierQuery, setSupplierQuery] = useState("");
	const [isLinkingSupplier, setIsLinkingSupplier] = useState(false);
	const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
	const toast = useToast();
	const [note, setNote] = useState("");
	// Collapsed by default so the receipt keeps the height, but it opens in place
	// above the verbs and says which of them will not proceed without it.
	const [noteOpen, setNoteOpen] = useState(false);
	const noteRef = useRef<HTMLTextAreaElement>(null);

	// The lightbox is a fixed z-[60] sheet over this panel, which stays mounted
	// behind it. Without knowing it is open, a decision shortcut fires on a
	// keystroke aimed at a receipt the dispatcher is reading.
	const [receiptFull, setReceiptFull] = useState(false);

	// The page's own queue-navigation shortcut (j/k) has the same blind spot this
	// panel's verbs did, so it needs the same fact. Forwarded from state rather
	// than from ReceiptViewer's callback directly, so this panel stays the one
	// place that reconciles "is the receipt open" into a single value.
	useEffect(() => {
		onReceiptFullscreenChange?.(receiptFull);
	}, [receiptFull, onReceiptFullscreenChange]);

	// Mirrors ReceiptViewer's own unmount cleanup: if this whole panel unmounts
	// (the dispatcher leaves the queue view) while the receipt was open, nothing
	// else will ever tell the page to re-arm j/k.
	useEffect(() => {
		return () => onReceiptFullscreenChange?.(false);
	}, [onReceiptFullscreenChange]);

	/**
	 * The approve shortcut, armed but not fired. A click lands on a labelled button;
	 * a keystroke lands wherever focus is. `a` moves stock and confirms the charge
	 * with no way back, so it takes two presses. Send back and reject have no key at
	 * all: both need a written reason, which is a stronger gate than a second
	 * keypress because no stray keystroke can produce one.
	 */
	const [armedApprove, setArmedApprove] = useState(false);

	// A note is written about one purchase. Carrying it to the next one would
	// attach somebody else's reason to a different technician's money.
	//
	// receiptFull is deliberately not reset here: it now only ever mirrors what
	// ReceiptViewer reports (it resets itself, and its own url-change effect,
	// on the receipt belonging to the newly selected purchase). A second,
	// independent reset here raced that report — the panel cleared receiptFull
	// on selection change before the viewer's own effect ran, opening a window
	// where a queued keystroke fired against a receipt still covering the screen.
	useEffect(() => {
		setNote("");
		setNoteOpen(false);
		setArmedApprove(false);
		setSupplierQuery("");
		setIsLinkingSupplier(false);
	}, [purchaseId]);

	// Armed is a held gesture, not a mode: a dispatcher who pressed `a` and then
	// went back to reading the receipt should not approve on their next keypress.
	useEffect(() => {
		if (!armedApprove) return;
		const t = setTimeout(() => setArmedApprove(false), 5000);
		return () => clearTimeout(t);
	}, [armedApprove]);

	/** Reveals the field for the verbs that need a reason, rather than dead-ending the click. */
	function requireNote(): boolean {
		if (note.trim()) return true;
		setNoteOpen(true);
		// Focus after the field has actually been rendered.
		requestAnimationFrame(() => noteRef.current?.focus());
		return false;
	}

	const p = data?.purchase;
	const awaitingPreauth = p?.status === "pending_preauth";
	const awaitingReview = p?.status === "pending_review";
	const awaitingSignoff = p?.status === "pending_second_signoff";
	const prePurchase = !!p && isPrePurchase(p.status);
	// Answered by dispatch and handed back: nothing to decide here, only something
	// outstanding to see.
	const withTech = p?.status === "preauth_approved" || p?.status === "queried";

	// Only lines that carry an intent move stock, so a purchase of unmapped or
	// "not recorded" lines is a money decision with no inventory effect.
	const movesStock = !!p?.lines.some((l) => l.inventory_item_id && l.disposition);
	// Read through a ref, not closed over. The shortcut listener below re-binds on
	// [awaitingReview, armedApprove, note, p?.id], and a background refetch can
	// change a line's disposition without touching any of them — the toast then
	// names the wrong stock effect. Adding p.lines to those deps would re-bind the
	// window listener on every poll tick.
	const movesStockRef = useRef(movesStock);
	useEffect(() => {
		movesStockRef.current = movesStock;
	}, [movesStock]);

	const supplierExactMatch = useMemo(() => {
		const key = normalizeSupplierName(supplierQuery);
		if (!key) return undefined;
		return suppliersData?.find((s) => normalizeSupplierName(s.name) === key);
	}, [suppliersData, supplierQuery]);
	const supplierOptions = useMemo<FilterableOption[]>(() => {
		const q = supplierQuery.trim().toLowerCase();
		const base = (suppliersData ?? [])
			.filter((s) => !q || s.name.toLowerCase().includes(q))
			.map((s) => ({ id: s.id, label: s.name, sublabel: s.account_number ?? undefined }));
		if (supplierQuery.trim() && !supplierExactMatch) {
			return [{ id: "__create_supplier__", label: `+ Create supplier "${supplierQuery.trim()}"` }, ...base];
		}
		return base;
	}, [suppliersData, supplierQuery, supplierExactMatch]);

	function linkSupplierById(purchaseId: string, supplierId: string) {
		linkSupplier.mutate(
			{ id: purchaseId, supplierId },
			{ onError: (err) => toast.error(errorMessage(err, "Failed to link that supplier")) },
		);
	}

	/**
	 * Every decision here is the same shape: mutate, clear the note it consumed,
	 * say what happened, hand the queue the next row.
	 */
	async function decideWith<T>(
		mutate: Promise<T>,
		// A function where the server decides the outcome: approving over the org
		// threshold does not approve anything, and saying so needs the result.
		success: string | ((result: T) => string),
		failure: string,
		{ advance = true } = {},
	) {
		try {
			const result = await mutate;
			if (advance) setNote("");
			toast.success(typeof success === "function" ? success(result) : success);
			if (advance) onDecided();
		} catch (err) {
			toast.error(errorMessage(err, failure));
		}
	}

	/** Approving is the only verb with an inventory consequence worth naming. */
	const approvedCopy = (verb: string) =>
		movesStockRef.current
			? `${verb} — stock updated`
			: `${verb} — no stock effect on this one`;

	async function act(decision: "approve" | "query" | "reject") {
		if (!p) return;
		await decideWith(
			review.mutateAsync({ id: p.id, decision, note: note.trim() || null }),
			decision === "approve"
				? // Over the org threshold the server holds it at pending_second_signoff
					// and moves nothing. Reporting "stock updated" told the reviewer the
					// opposite of what happened, and named no rail to find it on.
					(updated: FieldPurchase) =>
						updated.status === "pending_second_signoff"
							? "Approved — now waiting on a second signature under Second sign-off; no stock has moved"
							: approvedCopy("Approved")
				: decision === "query"
					? "Sent back to the technician"
					: "Rejected",
			"Failed to record the review",
		);
	}

	async function actPreauth(approve: boolean) {
		if (!p) return;
		await decideWith(
			decide.mutateAsync({ id: p.id, approve, note: note.trim() || null }),
			// The rail it lands on, because the pre-approvals rail it just left is
			// usually now empty and says nothing about where the record went.
			approve
				? "Pre-approved — now under With the technician until the receipt arrives"
				: "Pre-approval denied",
			"Failed to record the decision",
		);
	}

	async function actSignoff(approve: boolean) {
		if (!p) return;
		await decideWith(
			sign.mutateAsync({ id: p.id, approve, note: note.trim() || null }),
			approve ? approvedCopy("Signed off") : "Sign-off refused",
			"Failed to record the sign-off",
		);
	}

	// Settling asserts money came back; it decides nothing, so the queue stays put.
	async function actSettle() {
		if (!p) return;
		await decideWith(settle.mutateAsync(p.id), "Refund marked settled", "Failed to settle the refund", {
			advance: false,
		});
	}

	// Reviewing is repetitive work, so the verbs get keys. Guarded on the focused
	// element — the same letters are ordinary typing inside the note — and stood
	// down while the receipt is open full screen, which paints over this panel
	// without unmounting it.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTypingKeystroke(e) || !awaitingReview || receiptFull) return;
			if (e.key === "a") {
				e.preventDefault();
				if (!armedApprove) return setArmedApprove(true);
				setArmedApprove(false);
				void act("approve");
			} else if (e.key === "s") {
				e.preventDefault();
				setArmedApprove(false);
				// Same contract as the button: opens the note when there isn't one yet.
				if (requireNote()) void act("query");
			} else if (armedApprove) {
				setArmedApprove(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [awaitingReview, armedApprove, receiptFull, note, p?.id]);

	if (!purchaseId) {
		return (
			<PanelPlaceholder
				icon={<FileSearch size={28} aria-hidden className="text-text-faint" />}
				title="Pick a purchase to see the receipt and decide."
				body="Approving is what records the stock that came in."
			/>
		);
	}

	// Loading, error, and a selection that no longer resolves each get their own
	// copy rather than falling into the nothing-selected state: a purchase named by
	// a link — from a job page, a notification, or a colleague — deserves an answer
	// tied to that purchase, not a generic "pick a purchase" prompt.
	if (isLoading) {
		return (
			<PanelPlaceholder
				icon={<Loader2 size={24} aria-hidden className="animate-spin text-text-faint" />}
				title="Opening the receipt…"
			/>
		);
	}

	if (isError || !data || !p) {
		return (
			<PanelPlaceholder
				icon={<AlertTriangle size={26} aria-hidden className="text-warning-text" />}
				title="Could not open this purchase."
				body="It may have been withdrawn, or the request failed. Reloading the queue will say which."
				action={
					<ActionButton
						variant="secondary"
						icon={
							<RefreshCw
								size={13}
								aria-hidden
								className={isFetching ? "animate-spin" : ""}
							/>
						}
						disabled={isFetching}
						onClick={() => void refetch()}
					>
						{isFetching ? "Retrying…" : "Try again"}
					</ActionButton>
				}
			/>
		);
	}

	const isRefund = p.kind === "refund";
	const owedBack = isRefund && p.status === "approved" && !p.refund_settled_at;
	const allocated = p.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
	const variance = allocated - Number(p.total);
	const unallocated = Math.abs(variance) > 0.005;
	// Shares follow the lines, so the only way a receipt comes up short now is a
	// line nobody claimed. Naming the job per line is what the reviewer can fix.
	const isSplit = p.allocations.length > 1;
	const jobOfAllocation = new Map(
		p.allocations.map((a) => [
			a.id,
			a.job?.job_number ? `#${a.job.job_number}` : (a.job?.name ?? "Job"),
		])
	);
	const confidence = p.ocr_field_confidence ?? {};

	return (
		<>
			<header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
				<h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
					{/* The name a receipt is matched against, so it wraps rather than
					    losing its tail — the money and the age keep their line. */}
					<span className="min-w-0 break-words">{p.technician.name}</span>
					<span className="whitespace-nowrap tabular-nums">{money(p.total)}</span>
					<AgeChip since={p.submitted_at ?? p.created_at} />
				</h2>
				<span className="flex items-center gap-1.5">
					{isRefund && (
						<Chip icon={<Undo2 aria-hidden size={11} />} tone="neutral">
							Refund
						</Chip>
					)}
					<Chip tone={statusTone(p)}>{FIELD_PURCHASE_STATUS_LABELS[p.status]}</Chip>
				</span>
			</header>

			{/* A column border is drawn by the pane, so it stops where that pane's
			    content stops. Filling the scroller lets the rules run the whole way
			    down to the decision bar instead of ending under a short receipt. */}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{p.flags.length > 0 && (
					<ul className="space-y-1 border-b border-warning-border bg-warning-bg px-4 py-2.5">
						{p.flags.map((f, i) => (
							<li key={`${f.code}-${i}`} className="flex items-start gap-1.5 text-xs text-warning">
								<AlertTriangle aria-hidden size={12} className="mt-0.5 flex-shrink-0" />
								<span>
									<span className="font-medium">{FLAG_META[f.code]?.label ?? f.code}</span>
									{" — "}
									{f.message}
								</span>
							</li>
						))}
					</ul>
				)}

				{/* Evidence left, record right. The column stretches and its contents stick —
				    sticking the column itself cut the divider off partway down. */}
				<div className="flex-1 xl:flex">
					<div className="border-b border-border xl:w-[22rem] xl:flex-shrink-0 xl:border-b-0 xl:border-r">
						<div className="p-4 xl:sticky xl:top-0">
							{prePurchase ? (
								<NotBoughtYet purchase={p} />
							) : (
								<>
										<ReceiptViewer
											url={p.receipt_image_url}
											technicianName={p.technician.name}
											onFullscreenChange={setReceiptFull}
										/>
										<CaptureProvenance purchase={p} />
										<OcrBanner purchase={p} />
								</>
							)}
						</div>
					</div>

					<div className="flex min-w-0 flex-1 flex-col">
						<div className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-b border-border px-4 py-3 sm:grid-cols-3">
							{prePurchase ? (
								<>
									<MetaCell
										label="Estimate"
										value={p.estimated_amount ? money(p.estimated_amount) : "Not given"}
									/>
									<MetaCell
										label={p.preauth_requested_at ? "Requested" : "Started"}
										value={new Date(p.preauth_requested_at ?? p.created_at).toLocaleString()}
									/>
									{/* Only once there is one: an "Answered" row on a purchase nobody
									    has answered is the dead cell this block replaced. */}
									{p.preauth_decided_at && (
										<MetaCell
											label="Answered"
											value={new Date(p.preauth_decided_at).toLocaleString()}
										/>
									)}
								</>
							) : (
								<>
									<MetaCell
										label="Vendor"
										value={
											<span className="flex items-center gap-1">
												{p.vendor_name || "Not recorded"}
												{lowConfidence(confidence.vendor_name) && <LowConfidenceMark />}
											</span>
										}
									/>
									<MetaCell
										label="Purchased"
										value={
											<span className="flex items-center gap-1">
												{p.purchased_at ? new Date(p.purchased_at).toLocaleString() : "Not recorded"}
												{lowConfidence(confidence.purchased_at) && <LowConfidenceMark />}
											</span>
										}
									/>
									<MetaCell
										label="Submitted"
										value={p.submitted_at ? new Date(p.submitted_at).toLocaleString() : "Not submitted"}
									/>
								</>
							)}
							{p.reason && (
								<div className="col-span-2 min-w-0 sm:col-span-3">
									<span className={`block ${COL_LABEL}`}>Reason given</span>
									<span className="block text-sm text-text-secondary">{p.reason}</span>
								</div>
							)}
						</div>

						{/* Past 2xl the trail moves beside the money: it is the longest section
						    and the one you read rather than act on. */}
						<div className="flex min-w-0 flex-1 flex-col 2xl:flex-row 2xl:items-stretch">
							<div className="min-w-0 flex-1 2xl:border-r 2xl:border-border">
								{/* Nothing was bought in the pre-purchase states, so a lines table and a
								    money breakdown of zeroes are not a summary of anything. */}
								{!prePurchase && (
									<>
									<SectionBar>Money</SectionBar>
									{/* A dl takes only dt/dd groups, so the rule and the warning are the
									    row's own and the wrapper's, not children of the list. */}
									<div className="border-b border-border px-4 py-3 text-sm">
										<dl className="space-y-1">
											<MoneyRow label="Subtotal" value={money(p.subtotal)} />
											<MoneyRow
												label="Tax"
												value={money(p.tax_amount)}
												mark={lowConfidence(confidence.tax_amount)}
											/>
											<MoneyRow
												label="Total"
												value={money(p.total)}
												strong
												mark={lowConfidence(confidence.total)}
											/>
											<MoneyRow label="Allocated to jobs" value={money(allocated)} divider />
										</dl>
										{unallocated && (
											<p className="mt-1 text-xs text-warning">
												{variance < 0
													? `${money(Math.abs(variance))} of this receipt is not allocated to any job — check the lines below for one with no job named.`
													: `Job shares exceed the receipt by ${money(variance)}, so the total does not match its own lines.`}
											</p>
										)}
									</div>

									<SectionBar>Lines</SectionBar>
									<div className="overflow-x-auto border-b border-border">
										<table className="w-full text-sm">
											<thead>
												<tr className="border-b border-border">
													<th className={`${COL_LABEL} min-w-[9rem] px-4 py-1.5 text-left`}>
														Item
													</th>
													<th className={`${COL_LABEL} px-2 py-1.5 text-right`}>Qty</th>
													<th className={`${COL_LABEL} px-2 py-1.5 text-right`}>Unit</th>
													{/* Only on a split. With one job the column would repeat the
													    same answer down the whole table. */}
													{isSplit && (
														<th className={`${COL_LABEL} px-2 py-1.5 text-left`}>Job</th>
													)}
													<th className={`${COL_LABEL} px-2 py-1.5 text-left`}>Effect on stock</th>
													<th className={`${COL_LABEL} px-4 py-1.5 text-right`}>Total</th>
												</tr>
											</thead>
											<tbody>
												{p.lines.map((l) => (
													<tr key={l.id} className="border-b border-border-subtle last:border-b-0">
														<td className="min-w-[9rem] max-w-[16rem] px-4 py-1.5 text-text-primary">
															{/* Inline flow rather than a flex row: the part name is the
															    identifier read off the receipt photo, so it wraps to as many
															    lines as it needs and the marks follow its last word. */}
															<span className="break-words">
																{l.description}{" "}
																{lowConfidence(
																	l.ocr_confidence == null ? undefined : Number(l.ocr_confidence)
																) && <LowConfidenceMark />}
																{!l.verified_at && (
																	<span
																		title="The technician never confirmed this line"
																		className="ml-1 text-[10px] font-medium uppercase text-warning"
																	>
																		unconfirmed
																	</span>
																)}
															</span>
														</td>
														<td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
															{Number(l.quantity)}
														</td>
														<td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
															{money(l.unit_price)}
														</td>
														{isSplit && (
															<td className="px-2 py-1.5">
																<LineJobCell purchase={p} line={l} names={jobOfAllocation} />
															</td>
														)}
														<td className="px-2 py-1.5 text-text-muted">{stockEffect(l)}</td>
														<td className="px-4 py-1.5 text-right tabular-nums text-text-secondary">
															{money(l.line_total)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
									<p className="border-b border-border px-4 py-2 text-xs text-text-muted">
										Unmapped lines carry no inventory effect — that is a valid outcome, not an error.
									</p>
									<ReconcileFooter purchase={p} />
									</>
								)}

								<SectionBar>Jobs and billing</SectionBar>
								<div className="overflow-x-auto border-b border-border">
									{p.allocations.length === 0 ? (
										<p className="px-4 py-3 text-xs text-text-muted">
											Not allocated to a job, so nothing will be job-costed.
										</p>
									) : (
										<table className="w-full text-sm">
											<tbody>
												{p.allocations.map((a) => (
													<tr key={a.id} className="border-b border-border-subtle last:border-b-0">
														<td className="px-4 py-1.5 text-text-secondary">
															{/* Deciding a charge without being able to open what it lands on
															    left the reviewer to search for the job by hand. */}
															<Link to={`/dispatch/jobs/${a.job_id}`} className={RECORD_LINK}>
																{a.job?.job_number
																	? `#${a.job.job_number} ${a.job.name ?? ""}`.trim()
																	: (a.job?.name ?? "Open the job")}
															</Link>
															{/* The charge lands on a visit, not on the job at large — say
															    which, since that is the invoice the customer sees it on. */}
															<span className="block text-[11px] text-text-muted">
																{a.job_visit_id ? (
																	<Link
																		to={`/dispatch/jobs/${a.job_id}/visits/${a.job_visit_id}`}
																		className={RECORD_LINK}
																	>
																		{a.job_visit?.name ?? "Attached to a visit"}
																	</Link>
																) : (
																	"No visit — nothing was billed"
																)}
															</span>
														</td>
														<td className="px-4 py-1.5 text-right tabular-nums text-text-secondary">
															{money(a.amount)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									)}
								</div>

								<BilledSummary purchase={p} />
							</div>

							<div className="min-w-0 2xl:w-[20rem] 2xl:flex-shrink-0">
								<SectionBar>Trail</SectionBar>
								<PurchaseTimeline events={data.events} />
							</div>
						</div>
					</div>
				</div>
			</div>

			{withTech && (
				<div className="flex items-start gap-2 border-t border-border bg-surface px-4 py-3">
					<Clock aria-hidden size={13} className="mt-0.5 flex-shrink-0 text-text-muted" />
					<p className="text-xs text-text-secondary">
						{p.status === "preauth_approved" ? (
							<>
								Pre-approved
								{p.estimated_amount ? ` up to ${money(p.estimated_amount)}` : ""}
								{p.preauth_decided_at
									? ` on ${new Date(p.preauth_decided_at).toLocaleDateString()}`
									: ""}
								. Waiting for {p.technician.name} to buy it and send the receipt — nothing
								has moved in stock or onto the customer's bill yet.
							</>
						) : (
							<>
								Sent back to {p.technician.name}
								{p.reviewed_at ? ` on ${new Date(p.reviewed_at).toLocaleDateString()}` : ""}
								{p.review_note ? `: “${p.review_note}”` : "."} Waiting on their answer — the
								charge stands until they resubmit.
							</>
						)}
					</p>
				</div>
			)}

			{owedBack && (
				<div className="flex items-center justify-between gap-2 border-t border-warning-border bg-warning-bg px-4 py-2.5">
					<p className="text-xs text-warning">The credit has not been recorded as received yet.</p>
					<ActionButton
						variant="secondary"
						icon={<Wallet aria-hidden size={13} />}
						disabled={settle.isPending}
						onClick={() => void actSettle()}
					>
						Mark settled
					</ActionButton>
				</div>
			)}

			{decide && p.status === "approved" && p.kind !== "refund" && qbConnected && (
				<div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-4 py-2.5">
					{p.qb_sync_status === "synced" ? (
						<span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-text">
							<Check aria-hidden size={13} /> Pushed to QuickBooks
						</span>
					) : p.supplier ? (
						<>
							<p className="text-xs text-text-secondary">Not yet pushed to QuickBooks.</p>
							<ActionButton
								variant="secondary"
								icon={<ShoppingCart aria-hidden size={13} />}
								disabled={pushToQB.isPending}
								className="border-none bg-quickbooks text-white hover:enabled:bg-quickbooks-hover"
								onClick={() =>
									pushToQB.mutate(p.id, {
										onError: (error) =>
										toast.error(errorMessage(error, "Failed to push to QuickBooks")),
									})
								}
							>
								{pushToQB.isPending ? "Pushing…" : "Push to QuickBooks"}
							</ActionButton>
						</>
					) : isLinkingSupplier ? (
						<div className="flex w-full items-center gap-2">
							<div className="w-56">
								<FilterableSelect
									placeholder={p.vendor_name ?? "Search suppliers…"}
									ariaLabel="Link supplier"
									value={supplierQuery}
									onChange={setSupplierQuery}
									options={supplierOptions}
									disabled={linkSupplier.isPending}
									onSelect={(opt) => {
										if (opt.id === "__create_supplier__") {
											setIsSupplierModalOpen(true);
											return;
										}
										setSupplierQuery("");
										setIsLinkingSupplier(false);
										linkSupplierById(p.id, opt.id);
									}}
								/>
							</div>
							<button
								type="button"
								onClick={() => {
									setIsLinkingSupplier(false);
									setSupplierQuery("");
								}}
								className="shrink-0 text-xs text-text-muted hover:text-text-secondary"
							>
								Cancel
							</button>
						</div>
					) : (
						<>
							<p className="text-xs text-text-secondary">Link a supplier to push this to QuickBooks.</p>
							<ActionButton variant="ghost" onClick={() => setIsLinkingSupplier(true)}>
								Link supplier
							</ActionButton>
						</>
					)}
				</div>
			)}

			{awaitingSignoff && (
				<div className="space-y-2 border-t border-border bg-surface px-4 py-3">
					<p className="text-xs text-text-secondary">
						Over the org threshold, so it needs a second signature — and not from whoever approved
						it. Nothing has moved in stock yet.
					</p>
					<NoteField
						ref={noteRef}
						open={noteOpen}
						onOpen={() => setNoteOpen(true)}
						onClose={() => setNoteOpen(false)}
						value={note}
						onChange={setNote}
						placeholder="Why the sign-off is being refused"
						label="Sign-off note"
						requiredFor="refuse"
					/>
					<div className="flex gap-2">
						<ActionButton
							variant="primary"
							fullWidth
							icon={<ShieldCheck aria-hidden size={14} />}
							disabled={sign.isPending}
							onClick={() => void actSignoff(true)}
						>
							Sign off
						</ActionButton>
						<ActionButton
							variant="danger"
							fullWidth
							icon={<X aria-hidden size={14} />}
							disabled={sign.isPending}
							// A refusal without a reason is not reviewable, so the click opens
							// the field rather than presenting a dead button.
							onClick={() => requireNote() && void actSignoff(false)}
						>
							Refuse
						</ActionButton>
					</div>
				</div>
			)}

			{(awaitingReview || awaitingPreauth) && (
				<div className="space-y-2 border-t border-border bg-surface px-4 py-3">
					{/* One slot, either state: the control keeps the verbs' own chrome
					    so it reads as a peer of them rather than as a footnote. */}
					<NoteField
						ref={noteRef}
						open={noteOpen}
						onOpen={() => setNoteOpen(true)}
						onClose={() => setNoteOpen(false)}
						value={note}
						onChange={setNote}
						placeholder="Note for the technician"
						label="Note for the technician"
						requiredFor={awaitingReview ? "send back or reject" : undefined}
					/>
					{armedApprove && awaitingReview && (
						<p role="status" className="text-xs font-medium text-warning-text">
							Press A again to approve — that records the stock and confirms the
							customer's charge.
						</p>
					)}
					{awaitingPreauth ? (
						<div className="flex gap-2">
							<ActionButton
								variant="primary"
								fullWidth
								icon={<ShieldCheck aria-hidden size={14} />}
								disabled={decide.isPending}
								onClick={() => void actPreauth(true)}
							>
								Pre-approve
							</ActionButton>
							<ActionButton
								variant="secondary"
								fullWidth
								icon={<X aria-hidden size={14} />}
								disabled={decide.isPending}
								onClick={() => void actPreauth(false)}
							>
								Deny
							</ActionButton>
						</div>
					) : (
						<div className="flex flex-wrap gap-2">
							<ActionButton
								variant="primary"
								fullWidth
								icon={<Check aria-hidden size={14} />}
								title="Approve (a, twice)"
								disabled={review.isPending}
								onClick={() => void act("approve")}
							>
								Approve
							</ActionButton>
							<ActionButton
								variant="secondary"
								fullWidth
								icon={<MessageSquare aria-hidden size={14} />}
								title="Send back (s)"
								disabled={review.isPending}
								// The technician cannot act on "sent back" alone, so the note is
								// still mandatory — the click just asks for it.
								onClick={() => requireNote() && void act("query")}
							>
								Send back
							</ActionButton>
							<ActionButton
								variant="danger"
								fullWidth
								icon={<X aria-hidden size={14} />}
								title="Reject"
								disabled={review.isPending}
								// Same contract as Send back: the click asks for the note
								// rather than dead-ending, and the reason is mandatory
								// because this un-bills a visit and cannot be undone.
								onClick={() => requireNote() && void act("reject")}
							>
								Reject
							</ActionButton>
						</div>
					)}
					<p className="text-[11px] leading-snug text-text-muted">
						Approving records the stock that came in. The reimbursement itself is still entered by
						hand in QuickBooks.
					</p>
				</div>
			)}
			<SupplierFormModal
				isOpen={isSupplierModalOpen}
				onClose={() => setIsSupplierModalOpen(false)}
				editing={null}
				initialName={supplierQuery}
				onSaved={(saved) => {
					setSupplierQuery("");
					setIsSupplierModalOpen(false);
					setIsLinkingSupplier(false);
					linkSupplierById(p.id, saved.id);
				}}
			/>
		</>
	);
}

/**
 * The catalog work this receipt leaves behind, and the way to it.
 *
 * A `non_stock` line with nothing chosen bills the customer under a name the
 * catalog cannot deduct from - an Unmapped name, keyed by the name. A `receive`
 * line with nothing chosen mints a placeholder - Needs detail, keyed by the item.
 * Both are legitimate outcomes of a counter decision, and neither is finished.
 */
function reconcileTargets(purchase: FieldPurchase) {
	const seen = new Set<string>();
	const out: { row: string; label: string; href: string }[] = [];
	for (const l of purchase.lines) {
		const target = l.inventory_item?.provisional
			? { tab: "detail" as const, row: l.inventory_item.id, label: l.inventory_item.name }
			: !l.inventory_item_id && l.disposition === "non_stock"
				? { tab: "unmapped" as const, row: l.description, label: l.description }
				: null;
		// One receipt can carry the same part twice; it is still one decision.
		if (!target || seen.has(target.row)) continue;
		seen.add(target.row);
		out.push({
			row: target.row,
			label: target.label,
			href: reconcileHref(target.tab, target.row, target.label),
		});
	}
	return out;
}

function ReconcileFooter({ purchase }: { purchase: FieldPurchase }) {
	// Reconcile is behind manage_inventory; showing a link that bounces off the
	// route guard is worse than showing none.
	const canReconcile = usePermission("manage_inventory");
	const targets = reconcileTargets(purchase);
	if (!canReconcile || targets.length === 0) return null;

	return (
		<div className="border-b border-border px-4 py-2.5">
			<p className="text-xs text-text-secondary">
				{targets.length === 1
					? "One part on this receipt is not settled in the catalog."
					: `${targets.length} parts on this receipt are not settled in the catalog.`}
			</p>
			<ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
				{targets.map((t) => (
					<li key={t.row}>
						<Link to={t.href} className={`inline-flex items-center gap-1 text-xs ${RECORD_LINK}`}>
							<Boxes aria-hidden size={11} className="flex-shrink-0" />
							Reconcile “{t.label}”
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * A control when closed, the field itself when open. A note is mandatory for the
 * verbs that hand the purchase back, so the closed state names that up front rather
 * than letting a dispatcher learn it by pressing Reject and being bounced. Still
 * collapsed by default: the receipt is what the height is for.
 */
const NoteField = forwardRef<
	HTMLTextAreaElement,
	{
		open: boolean;
		onOpen: () => void;
		onClose: () => void;
		value: string;
		onChange: (v: string) => void;
		placeholder: string;
		label: string;
		/** Which verbs will not proceed without one, named in the reviewer's words. */
		requiredFor?: string;
	}
>(function NoteField(
	{ open, onOpen, onClose, value, onChange, placeholder, label, requiredFor },
	ref
) {
	const id = useId();
	const draft = value.trim();

	if (!open) {
		return (
			<button
				type="button"
				onClick={onOpen}
				className={`flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-base px-3 py-1.5 text-left text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text-primary ${FOCUS_RING}`}
			>
				<MessageSquare aria-hidden size={13} className="flex-shrink-0" />
				<span className="flex-shrink-0 font-medium">{label}</span>
				{draft ? (
					<>
						{/* The note already written, so the closed state is not
						    identical to the empty one. */}
						<span className="line-clamp-1 min-w-0 flex-1 text-text-muted">
							“{draft}”
						</span>
						<span className="flex-shrink-0 font-medium text-primary-text">Edit</span>
					</>
				) : (
					<>
						{requiredFor && (
							<span className="min-w-0 flex-1 break-words font-medium text-warning-text">
								Required to {requiredFor}
							</span>
						)}
						<span className="ml-auto flex-shrink-0 text-text-muted">Add</span>
					</>
				)}
			</button>
		);
	}
	return (
		<div className="space-y-1">
			<span className="flex flex-wrap items-baseline gap-x-1.5">
				<label htmlFor={id} className={COL_LABEL}>
					{label}
				</label>
				{requiredFor && (
					<span className="text-[10px] font-medium text-warning-text">
						Required to {requiredFor}
					</span>
				)}
				{/* The way back to the receipt: without it a written note could
				    never return to its closed state. */}
				<button
					type="button"
					onClick={onClose}
					className={`ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-text-muted transition-colors duration-150 hover:text-text-primary ${FOCUS_RING}`}
				>
					<ChevronUp aria-hidden size={11} />
					Collapse
				</button>
			</span>
			<textarea
				id={id}
				ref={ref}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				rows={2}
				placeholder={placeholder}
				className="w-full rounded-md border border-border bg-base p-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary-border"
			/>
		</div>
	);
});

function MoneyRow({
	label,
	value,
	strong,
	mark,
	divider,
}: {
	label: string;
	value: string;
	strong?: boolean;
	mark?: boolean;
	divider?: boolean;
}) {
	return (
		<div
			className={`flex items-baseline justify-between gap-4 ${divider ? "mt-2 border-t border-border-subtle pt-2" : ""}`}
		>
			<dt className={strong ? "text-text-primary" : "text-text-muted"}>{label}</dt>
			<dd
				className={`flex items-center gap-1 tabular-nums ${strong ? "font-semibold text-text-primary" : "text-text-secondary"}`}
			>
				{mark && <LowConfidenceMark />}
				{value}
			</dd>
		</div>
	);
}

function LowConfidenceMark() {
	return (
		<span
			// A dot with no role reads as decoration, and aria-label on one is
			// discarded outright — role="img" is what makes the label carry.
			role="img"
			title={`The receipt reader was under ${Math.round(OCR_LOW_CONFIDENCE * 100)}% sure of this — check it against the photo`}
			className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning align-middle"
			aria-label="Low confidence"
		/>
	);
}

/**
 * The evidence column for a purchase that has not happened. ReceiptViewer's own
 * empty state reads as a receipt that went missing, which is the wrong thing to
 * say to a dispatcher being asked to authorise a spend before it is made.
 */
function NotBoughtYet({ purchase }: { purchase: FieldPurchase }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-surface px-4 py-10 text-center">
			<ShoppingCart aria-hidden size={24} className="text-text-faint" />
			<p className="text-sm text-text-muted">Nothing bought yet.</p>
			<p className="max-w-64 text-xs text-text-tertiary">
				{purchase.status === "draft"
					? `${purchase.technician.name} has not finished this one.`
					: `${purchase.technician.name} is asking before paying, so there is no receipt to read — only the estimate and the reason.`}
			</p>
		</div>
	);
}

/**
 * Where and when the photo was taken. `geo_missing` is raised on the absence, so
 * the absence has to be visible rather than an empty space.
 *
 * The position itself is fetched only when asked for, and only by a holder of
 * `view_field_purchase_location`: the coordinates locate an employee to about a
 * tenth of a metre, which is sensitive personal information, and comparing them
 * against the vendor is the only reason anyone needs them.
 */
function CaptureProvenance({ purchase }: { purchase: FieldPurchase }) {
	const canSeeLocation = usePermission("view_field_purchase_location");
	const [revealed, setRevealed] = useState(false);
	const location = useCaptureLocation(purchase.id, revealed);
	const coords = location.data;
	return (
		<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
			<span className="inline-flex items-center gap-1">
				<MapPin
					aria-hidden
					size={11}
					className={purchase.has_geo ? "text-text-tertiary" : "text-warning"}
				/>
				{purchase.has_geo ? (
					coords ? (
						<span className="tabular-nums">
							{Number(coords.capture_lat).toFixed(4)}, {Number(coords.capture_lng).toFixed(4)}
							{coords.capture_accuracy_m != null && ` ±${Math.round(coords.capture_accuracy_m)}m`}
						</span>
					) : (
						<span>Location captured</span>
					)
				) : (
					<span className="text-warning">No location captured</span>
				)}
			</span>
			{purchase.has_geo && canSeeLocation && !coords && (
				<button
					type="button"
					onClick={() => setRevealed(true)}
					disabled={location.isFetching}
					className="rounded text-[11px] text-accent underline-offset-2 transition-colors hover:underline disabled:text-text-faint"
				>
					{location.isFetching ? "Loading…" : "Show coordinates"}
				</button>
			)}
			{location.isError && <span className="text-warning">Location unavailable</span>}
			{purchase.captured_at && (
				<span>Photographed {new Date(purchase.captured_at).toLocaleString()}</span>
			)}
		</div>
	);
}

/**
 * `skipped` is a success — no provider is configured, so the technician typed the
 * lines — and saying so stops it from reading as a failed extraction. A skip that
 * carries an error is the monthly scan limit, the only skip with a reason.
 */
export function OcrBanner({ purchase }: { purchase: FieldPurchase }) {
	if (purchase.ocr_status === "not_run") return null;

	const body =
		purchase.ocr_status === "skipped"
			? purchase.ocr_error
				? "Lines typed in by the technician — this month's receipt scans were used up."
				: "Lines typed in by the technician — no receipt reader is configured."
			: purchase.ocr_status === "pending"
				? "Reading the receipt…"
				: purchase.ocr_status === "failed"
					? `Could not read the receipt${purchase.ocr_error ? `: ${purchase.ocr_error}` : "."}`
					: [
							purchase.ocr_provider ? `Read by ${purchase.ocr_provider}` : "Receipt read",
							purchase.ocr_line_count != null ? `${purchase.ocr_line_count} lines` : null,
							purchase.ocr_corrections ? `${purchase.ocr_corrections} corrected by hand` : null,
						]
							.filter(Boolean)
							.join(" · ");

	const tone =
		purchase.ocr_status === "failed"
			? "border-warning-border bg-warning-bg text-warning-text"
			: "border-border bg-surface text-text-muted";

	return (
		<p className={`mt-2 flex items-start gap-1.5 rounded border px-2 py-1.5 text-[11px] ${tone}`}>
			<ScanLine aria-hidden size={12} className="mt-px flex-shrink-0" />
			{body}
		</p>
	);
}
