import { useState } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import type { UiToolCall } from "../../types/assistant";

/**
 * A change the assistant wants to make, waiting on a person.
 *
 * Deliberately louder than a tool card: this is the one moment where clicking
 * without reading has consequences. The summary says what will change in plain
 * words, and the exact arguments are one click away — a person approving a
 * reschedule should be able to see the date they are agreeing to.
 */
export default function ApprovalCard({
	call,
	onDecide,
	busy,
}: {
	call: UiToolCall;
	onDecide: (approvalId: string, decision: "approve" | "reject") => void;
	busy: boolean;
}) {
	const [open, setOpen] = useState(false);
	if (!call.approvalId) return null;

	return (
		<div className="rounded-md border border-warning-border bg-warning-bg">
			<div className="flex items-start gap-2 px-3 py-2.5">
				<ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning-text" />
				<div className="flex min-w-0 flex-1 flex-col gap-2">
					<div>
						<p className="text-xs font-semibold uppercase tracking-wide text-warning-text">
							Needs your approval
						</p>
						<p className="mt-0.5 text-sm text-text-primary">{call.summary ?? call.title ?? call.name}</p>
					</div>

					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={busy}
							onClick={() => onDecide(call.approvalId!, "approve")}
							className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Approve
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => onDecide(call.approvalId!, "reject")}
							className="rounded-md border border-border-card bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Decline
						</button>
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							aria-expanded={open}
							className="ml-auto flex items-center gap-0.5 text-xs text-text-muted hover:text-text-primary"
						>
							Details
							<ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
						</button>
					</div>
				</div>
			</div>

			{open && (
				<div className="border-t border-warning-border px-3 py-2">
					<div className="font-mono text-[11px] text-text-muted">{call.name}</div>
					<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">
						{JSON.stringify(call.input ?? {}, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
