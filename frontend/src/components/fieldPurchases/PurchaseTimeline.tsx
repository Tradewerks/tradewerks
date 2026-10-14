import {
	Camera,
	Check,
	FileText,
	MessageSquare,
	PenLine,
	ScanLine,
	Send,
	ShieldCheck,
	Undo2,
	Wallet,
	X,
	type LucideIcon,
} from "lucide-react";
import { timeAgo } from "../dashboard/activityFormat";
import type { FieldPurchaseEvent } from "../../types/fieldPurchases";

/**
 * The trail is append-only — a correction is another row, never an edit — which
 * makes it the thing an auditor actually reads. It printed raw enum names until
 * now, so the record that justifies the money was the least legible part of the
 * page.
 */

type Tone = "neutral" | "primary" | "success" | "warning" | "error";

const EVENT_META: Record<string, { label: string; icon: LucideIcon; tone: Tone }> = {
	"purchase.created": { label: "Draft started", icon: FileText, tone: "neutral" },
	"purchase.updated": { label: "Details edited", icon: PenLine, tone: "neutral" },
	"purchase.lines_replaced": { label: "Lines rewritten", icon: PenLine, tone: "neutral" },
	"purchase.lines_verified": { label: "Lines confirmed", icon: Check, tone: "neutral" },
	"purchase.lines_unverified": {
		label: "Line confirmation withdrawn",
		icon: Undo2,
		tone: "warning",
	},
	"purchase.receipt_captured": {
		label: "Receipt photographed",
		icon: Camera,
		tone: "neutral",
	},
	"purchase.ocr_completed": { label: "Receipt read", icon: ScanLine, tone: "neutral" },
	"purchase.preauth_requested": {
		label: "Pre-approval requested",
		icon: Send,
		tone: "neutral",
	},
	"purchase.preauth_approved": { label: "Pre-approved", icon: ShieldCheck, tone: "success" },
	"purchase.preauth_denied": { label: "Pre-approval denied", icon: X, tone: "error" },
	"purchase.submitted": { label: "Submitted for review", icon: Send, tone: "primary" },
	"purchase.approve": { label: "Approved", icon: Check, tone: "success" },
	"purchase.query": {
		label: "Sent back to the technician",
		icon: MessageSquare,
		tone: "warning",
	},
	"purchase.reject": { label: "Rejected", icon: X, tone: "error" },
	"purchase.second_signed": {
		label: "Second signature given",
		icon: ShieldCheck,
		tone: "success",
	},
	"purchase.second_signoff_refused": {
		label: "Second signature refused",
		icon: X,
		tone: "error",
	},
	"purchase.refund_started": { label: "Refund raised", icon: Undo2, tone: "neutral" },
	"purchase.refund_settled": { label: "Refund settled", icon: Wallet, tone: "success" },
	"purchase.supplier_linked": { label: "Supplier linked", icon: PenLine, tone: "neutral"}
};

const TONE_CLASS: Record<Tone, string> = {
	neutral: "border-border bg-surface-raised text-text-tertiary",
	primary: "border-primary-border bg-primary-bg text-primary-text",
	success: "border-success-border bg-success-bg text-success-text",
	warning: "border-warning-border bg-warning-bg text-warning-text",
	error: "border-error-border bg-error-bg text-error-text",
};

const ACTOR_LABEL: Record<string, string> = {
	technician: "Technician",
	dispatcher: "Dispatcher",
	system: "System",
};

/** The note is the only free text on the record, so it is never truncated away. */
function noteOf(event: FieldPurchaseEvent): string | null {
	const note = event.detail?.note;
	return typeof note === "string" && note.trim() ? note : null;
}

export default function PurchaseTimeline({ events }: { events: FieldPurchaseEvent[] }) {
	if (events.length === 0) {
		return <p className="px-4 py-3 text-xs text-text-muted">Nothing has happened to this yet.</p>;
	}

	return (
		<ol className="px-4 py-3">
			{events.map((e, i) => {
				const meta = EVENT_META[e.type] ?? {
					label: e.type,
					icon: FileText,
					tone: "neutral" as Tone,
				};
				const Icon = meta.icon;
				const note = noteOf(e);
				const last = i === events.length - 1;

				return (
					<li key={e.id} className="relative flex gap-2.5 pb-3 last:pb-0">
						{/* The rail stops at the last dot rather than trailing into nothing. */}
						{!last && (
							<span
								aria-hidden
								className="absolute bottom-0 left-[11px] top-6 w-px bg-border-subtle"
							/>
						)}
						<span
							className={`z-10 flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full border ${TONE_CLASS[meta.tone]}`}
						>
							<Icon aria-hidden size={11} />
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-baseline gap-x-2">
								<span className="text-xs font-medium text-text-secondary">{meta.label}</span>
								<span className="text-[11px] text-text-tertiary">
									{ACTOR_LABEL[e.actor_type] ?? e.actor_type}
								</span>
								<span
									className="ml-auto text-[11px] tabular-nums text-text-muted"
									title={new Date(e.at).toLocaleString()}
								>
									{timeAgo(e.at)}
								</span>
							</div>
							{note && (
								<p className="mt-1 rounded border border-border-subtle bg-surface px-2 py-1 text-xs text-text-secondary">
									{note}
								</p>
							)}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
