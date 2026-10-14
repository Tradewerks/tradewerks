import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { outcomesFor } from "../disputes/outcomes";
import type { DisputeLineItem } from "../disputes/adjustmentDraft";
import type {
	Dispute,
	DisputeKind,
	DisputeOutcomeState,
	DisputeResolution,
} from "../../types/disputes";
import { formatDate } from "../../util/util";
import { documentStatusLabel } from "./documentStatusLabel";
import type { LifecycleAction } from "./types";

const REASON_CLAMP = 160;

/**
 * The three exits, as bar actions, with the server's availability and reasons
 * (Ruling P11) visible before the modal opens.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function disputeActions(
	kind: DisputeKind,
	outcomes: readonly DisputeOutcomeState[],
	onSelect: (outcome: DisputeResolution) => void
): LifecycleAction[] {
	return outcomesFor(kind, outcomes).map((outcome) => ({
		id: outcome.id,
		label: outcome.label,
		intent: outcome.destructive ? "destructive" : "primary",
		disabled: outcome.disabled,
		disabledReason: outcome.disabledReason,
		onSelect: () => onSelect(outcome.id),
	}));
}

interface DisputeStageProps {
	kind: DisputeKind;
	dispute: Dispute;
	lineItems: DisputeLineItem[];
}

/**
 * `kind` stays in the props even though the body no longer reads it:
 * disputeActions needs it, and a caller passing one without the other is the
 * mistake worth making impossible.
 */
export default function DisputeStage({ dispute, lineItems }: DisputeStageProps) {
	const [expanded, setExpanded] = useState(false);

	const contestedCount = dispute.contested_line_item_ids?.length ?? 0;
	const needsClamp = dispute.reason.length > REASON_CLAMP;
	const shown =
		needsClamp && !expanded
			? `${dispute.reason.slice(0, REASON_CLAMP)}…`
			: dispute.reason;

	return (
		<div className="min-w-0">
			{/* No "Disputed" label. The header pill carries the status word,
			    and the warning tone plus this icon already say which stage
			    this is; printing it here made the page state the same thing
			    three times across two adjacent strips. The reason stays — it
			    is what the pill cannot carry. */}
			<p className="flex items-start gap-2 text-sm text-warning-text">
				<AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
				<span className="font-normal break-words">{shown}</span>
			</p>
			{needsClamp && (
				<button
					onClick={() => setExpanded((open) => !open)}
					className="mt-0.5 text-xs text-text-tertiary underline hover:text-text-secondary transition-colors duration-150 ease-out"
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
			<p className="mt-1 text-xs text-text-tertiary">
				Opened by {dispute.opened_by_dispatcher?.name ?? "someone"} on{" "}
				{formatDate(dispute.opened_at)}
				{` · was ${documentStatusLabel(dispute.document_kind, dispute.status_at_open)} when opened`}
				{contestedCount > 0 &&
					` · ${contestedCount} of ${lineItems.length} lines contested`}
			</p>
		</div>
	);
}
