import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, X, Loader2 } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import ReasonField from "../ui/ReasonField";
import { useOpenDisputeMutation, useResolveDisputeMutation } from "../../hooks/useDisputes";
import { OUTCOME_LABELS, outcomesFor } from "./outcomes";
import AdjustmentEditor from "./AdjustmentEditor";
import {
	adjustmentInvalid,
	netAdjustment,
	seedAdjustmentLines,
	toAdjustmentLineInputs,
	type AdjustmentDraft,
	type AttributionTarget,
	type DisputeLineItem,
} from "./adjustmentDraft";
import type { Dispute, DisputeKind, DisputeResolution } from "../../types/disputes";
import { errorMessage, formatCurrency } from "../../util/util";

interface DisputeModalProps {
	/** Passed straight through to FullPopup's `isModalOpen` — this component stays
	 *  mounted while closed so FullPopup's 300ms close fade can play, matching every
	 *  other FullPopup consumer in the app (SendDocumentModal, SupplierMergeModal,
	 *  the Create/Edit wizards). Do not conditionally mount this component instead. */
	isOpen: boolean;
	kind: DisputeKind;
	documentId: string;
	documentNumber: string;
	lineItems: DisputeLineItem[];
	mode: "open" | "resolve";
	/** Required in resolve mode — the dispute being resolved, carrying the
	 *  server's judgement of each outcome. Unused in open mode. */
	dispute?: Dispute | null;
	/** Pre-selects an outcome in resolve mode — the dispatcher already chose it
	 *  in the lifecycle bar, so asking twice is a step for nothing. */
	initialResolution?: DisputeResolution;
	/** Invoice resolve mode: the root's billed jobs/visits. With more than one,
	 *  the adjustment editor makes each credit name the one it lands on (D4). */
	attributionTargets?: AttributionTarget[];
	/** Resolve mode: fired with the resolved dispute on success, before close.
	 *  The quote/invoice page uses it to follow a Revise & Resend to the
	 *  replacement document, matching handleCreateRevision (DW-68). */
	onResolved?: (dispute: Dispute) => void;
	onClose: () => void;
}

export default function DisputeModal({
	isOpen,
	kind,
	documentId,
	documentNumber,
	lineItems,
	mode,
	dispute,
	initialResolution,
	attributionTargets,
	onResolved,
	onClose,
}: DisputeModalProps) {

	// Open mode state
	const [reason, setReason] = useState("");
	const [contestedIds, setContestedIds] = useState<Set<string>>(new Set());

	// Resolve mode state
	const [selectedResolution, setSelectedResolution] = useState<DisputeResolution | null>(
		null
	);
	const [resolutionNote, setResolutionNote] = useState("");
	const [adjustmentLines, setAdjustmentLines] = useState<AdjustmentDraft[]>([]);
	// Associates the resolution-note label with its textarea; ReasonField does
	// the same for the reason fields it owns.
	const noteFieldId = useId();

	const openMutation = useOpenDisputeMutation(kind, documentId);
	const resolveMutation = useResolveDisputeMutation(kind, documentId);

	/**
	 * This component stays mounted while closed (see isOpen above), so nothing
	 * clears its state on its own. Without this, an abandoned draft comes back
	 * on the next open — including a half-typed adjustment line that is one
	 * click from being submitted as a real credit. Mirrors QuoteReasonModal.
	 */
	const handleClose = () => {
		setReason("");
		setContestedIds(new Set());
		setSelectedResolution(null);
		setResolutionNote("");
		setAdjustmentLines([]);
		openMutation.reset();
		resolveMutation.reset();
		onClose();
	};

	const activeError = mode === "open" ? openMutation.error : resolveMutation.error;
	// undefined while idle. The helper reads the { error: { message } } envelope,
	// where a worded 422/403 refusal lives, and falls back to a friendly line
	// for a network drop or an envelope-less 5xx.
	const errorText = activeError
		? errorMessage(activeError, "Something went wrong. Please try again.")
		: undefined;

	const isPending = mode === "open" ? openMutation.isPending : resolveMutation.isPending;

	const reasonIsEmpty = reason.trim().length === 0;
	const noteIsEmpty = resolutionNote.trim().length === 0;
	const repealSelected = selectedResolution === "Repeal";
	const adjustmentSelected = selectedResolution === "IssueAdjustment";

	const net = netAdjustment(adjustmentLines);
	const requireAttribution = (attributionTargets?.length ?? 0) > 1;
	const adjustmentIsInvalid = adjustmentInvalid(adjustmentLines, requireAttribution);

	// The server's judgement, carried on the dispute itself: the modal is the
	// last screen before the write, and this is the answer the write will give.
	const outcomeOptions =
		mode === "resolve" ? outcomesFor(kind, dispute?.outcomes ?? []) : [];
	// DW-44: the picked card can turn disabled while the modal is open — a
	// colleague records a payment, and Revise re-renders greyed out. Gate the
	// footer on the option's live state, not just on something being selected.
	const chosenOutcome = outcomeOptions.find((o) => o.id === selectedResolution);

	const submitDisabled =
		mode === "open"
			? reasonIsEmpty || isPending
			: !chosenOutcome ||
				chosenOutcome.disabled ||
				(repealSelected && noteIsEmpty) ||
				(adjustmentSelected && adjustmentIsInvalid) ||
				isPending;

	/**
	 * Applies the outcome the dispatcher already picked in the lifecycle bar,
	 * exactly as if they had clicked that option here. The ref confines it to
	 * the opening edge: re-running on later renders would snap the selection
	 * back and strand anyone who changed their mind inside the modal.
	 * handleClose lowers the ref via isOpen, so the next open seeds again.
	 */
	const seededThisOpen = useRef(false);
	useEffect(() => {
		if (!isOpen) {
			seededThisOpen.current = false;
			return;
		}
		if (seededThisOpen.current || !initialResolution) return;
		seededThisOpen.current = true;
		setSelectedResolution(initialResolution);
		if (initialResolution === "IssueAdjustment") {
			setAdjustmentLines((rows) =>
				rows.length > 0
					? rows
					: seedAdjustmentLines(
							lineItems,
							dispute?.contested_line_item_ids
						)
			);
		}
		// lineItems and dispute?.contested_line_item_ids are deliberately not
		// dependencies: the ref above confines this to the opening edge, and
		// re-running on a prop identity change would re-seed a draft mid-edit.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen, initialResolution]);

	const toggleContested = (id: string) => {
		setContestedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const handleSubmit = () => {
		if (mode === "open") {
			if (reasonIsEmpty) return;
			openMutation.mutate(
				{
					reason: reason.trim(),
					contested_line_item_ids:
						contestedIds.size > 0
							? Array.from(contestedIds)
							: undefined,
				},
				{ onSuccess: handleClose }
			);
			return;
		}

		if (!dispute || !selectedResolution) return;
		// DW-44: re-check here too — state can change between the last render
		// and the click.
		if (!chosenOutcome || chosenOutcome.disabled) return;
		if (adjustmentSelected && adjustmentIsInvalid) return;
		resolveMutation.mutate(
			{
				disputeId: dispute.id,
				resolution: selectedResolution,
				note: noteIsEmpty ? undefined : resolutionNote.trim(),
				adjustment_lines: adjustmentSelected
					? toAdjustmentLineInputs(adjustmentLines)
					: undefined,
			},
			{
				onSuccess: (resolved) => {
					onResolved?.(resolved);
					handleClose();
				},
			}
		);
	};

	/**
	 * One label for three very different commitments read as one commitment.
	 * Naming the outcome — and the amount, which is the sign confirmation — is
	 * the last chance to catch a credit that was toggled into a charge.
	 */
	const submitLabel = (): string => {
		if (mode === "open") return "Open Dispute";
		if (selectedResolution === "Repeal")
			return kind === "quote" ? "Repeal Quote" : "Repeal Invoice";
		if (selectedResolution === "ReviseAndResend") return OUTCOME_LABELS.ReviseAndResend;
		if (selectedResolution === "IssueAdjustment") {
			if (net < 0) return `Issue Credit of ${formatCurrency(Math.abs(net))}`;
			if (net > 0) return `Charge an Extra ${formatCurrency(net)}`;
			return OUTCOME_LABELS.IssueAdjustment;
		}
		return "Resolve Dispute";
	};

	// Matches LifecycleBar's destructive intent rather than inventing a third
	// red: repealing from here and repealing from the bar are one action.
	const submitClass = repealSelected
		? "bg-surface hover:enabled:bg-surface-raised border border-border text-error-text"
		: "bg-primary-hover hover:bg-primary text-on-primary";

	const content = (
		<div className="flex flex-col min-h-0">
			{/* Header */}
			<div className="flex flex-shrink-0 items-center justify-between px-6 py-4 border-b border-border-subtle">
				<div className="flex items-center gap-2">
					<AlertTriangle size={18} className="text-warning-text" />
					<h2 className="text-base font-semibold text-primary">
						{mode === "open"
							? "Open Dispute"
							: "Resolve Dispute"}{" "}
						— {documentNumber}
					</h2>
				</div>
				<button
					onClick={handleClose}
					className="p-1.5 hover:bg-surface rounded-md transition-colors duration-150 ease-out text-text-tertiary hover:text-text-primary"
				>
					<X size={16} />
				</button>
			</div>

			{/* Body */}
			<div className="flex-1 min-h-0 px-6 py-5 space-y-5 overflow-y-auto">
				{mode === "open" ? (
					<>
						<ReasonField
							value={reason}
							onChange={setReason}
							placeholder="What's wrong with this document?"
						/>

						{lineItems.length > 0 && (
							<div>
								<label className="block text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
									Which lines are contested?
									(optional)
								</label>
								<div className="space-y-1.5 max-h-56 overflow-y-auto">
									{lineItems.map((line) => {
										const checked =
											contestedIds.has(
												line.id
											);
										return (
											<label
												key={
													line.id
												}
												className={`flex items-center gap-2.5 px-3 py-2 rounded-md border text-sm cursor-pointer transition-colors duration-150 ease-out ${
													checked
														? "border-primary bg-primary-bg-subtle"
														: "border-border-subtle bg-surface"
												}`}
											>
												<input
													type="checkbox"
													checked={
														checked
													}
													onChange={() =>
														toggleContested(
															line.id
														)
													}
													className="shrink-0"
												/>
												<span className="flex-1 min-w-0 truncate text-text-primary">
													{
														line.name
													}
												</span>
												<span className="flex-shrink-0 text-text-tertiary tabular-nums">
													{formatCurrency(
														line.total
													)}
												</span>
											</label>
										);
									})}
								</div>
							</div>
						)}
					</>
				) : (
					<>
						{dispute && (
							<div className="rounded-md border border-warning-border bg-warning-bg p-3">
								<p className="text-xs font-medium text-warning-text">
									Disputed: {dispute.reason}
								</p>
							</div>
						)}

						<div>
							<label className="block text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
								Resolution
							</label>
							<div className="space-y-2">
								{outcomeOptions.map((option) => {
									const selected =
										selectedResolution ===
										option.id;
									return (
										<button
											key={
												option.id
											}
											type="button"
											disabled={
												option.disabled
											}
											onClick={() => {
												setSelectedResolution(
													option.id
												);
												if (
													option.id ===
														"IssueAdjustment" &&
													adjustmentLines.length ===
														0
												) {
													setAdjustmentLines(
														seedAdjustmentLines(
															lineItems,
															dispute?.contested_line_item_ids
														)
													);
												}
											}}
											aria-pressed={
												selected
											}
											className={`w-full text-left rounded-lg border p-3 transition-colors duration-150 ease-out ${
												option.disabled
													? "opacity-40 cursor-not-allowed border-border-subtle bg-surface"
													: selected
														? "border-primary bg-primary-bg-subtle cursor-pointer"
														: "border-border-subtle bg-surface hover:border-border cursor-pointer"
											}`}
										>
											<p
												className={`text-sm font-medium ${
													option.destructive
														? "text-error-text"
														: "text-text-primary"
												}`}
											>
												{
													option.label
												}
											</p>
											<p className="mt-0.5 text-xs text-text-tertiary">
												{
													option.blurb
												}
											</p>
											{option.disabled &&
												option.disabledReason && (
													<p className="mt-1.5 text-xs text-text-muted">
														{
															option.disabledReason
														}
													</p>
												)}
										</button>
									);
								})}
							</div>
						</div>

						{adjustmentSelected && (
							<AdjustmentEditor
								lineItems={lineItems}
								drafts={adjustmentLines}
								onChange={setAdjustmentLines}
								attributionTargets={attributionTargets}
							/>
						)}

						<div>
							<label
								htmlFor={noteFieldId}
								className="block text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2"
							>
								Resolution note
								{repealSelected
									? " (required)"
									: " (optional)"}
							</label>
							<textarea
								id={noteFieldId}
								value={resolutionNote}
								onChange={(e) =>
									setResolutionNote(
										e.target.value
									)
								}
								placeholder={
									repealSelected
										? "Why is this being repealed?"
										: "Add context for this resolution (optional)"
								}
								rows={3}
								className="w-full px-3 py-2.5 bg-surface-inset border border-border rounded-md text-sm text-primary placeholder:text-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary-border transition-colors duration-150 ease-out resize-none"
							/>
						</div>
					</>
				)}

				{errorText && (
					<div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-md">
						<AlertTriangle
							size={14}
							className="text-error-text flex-shrink-0"
						/>
						<p className="text-sm text-error-text">
							{errorText}
						</p>
					</div>
				)}
			</div>

			{/* Footer */}
			<div className="flex flex-shrink-0 items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle">
				<button
					onClick={handleClose}
					disabled={isPending}
					className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface rounded-md transition-colors duration-150 ease-out disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onClick={handleSubmit}
					disabled={submitDisabled}
					className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed ${submitClass}`}
				>
					{isPending && (
						<Loader2 size={14} className="animate-spin" />
					)}
					{submitLabel()}
				</button>
			</div>
		</div>
	);

	// Resolve mode is a workspace — a line picker above a row of five controls
	// does not fit md. Sized by mode, not by the selected outcome, so the box
	// does not jump width under the dispatcher when they pick one.
	return (
		<FullPopup
			content={content}
			isModalOpen={isOpen}
			onClose={handleClose}
			size={mode === "resolve" ? "lg" : "md"}
		/>
	);
}
