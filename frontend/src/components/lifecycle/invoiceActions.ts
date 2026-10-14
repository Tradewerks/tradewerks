import type { InvoiceStatus } from "../../types/invoices";
import type { LifecycleAction } from "./types";
import {
	buildAction as build,
	NO_PERMISSION,
	notApplicable,
	openDisputeReason,
	unknownDisputeReason,
} from "./actionBuilder";
import type { ActionGate } from "./actionBuilder";

export const INVOICE_STEPS = ["Draft", "Issued", "Sent", "PartiallyPaid", "Paid"] as const;

export const INVOICE_OFF_RAMPS: readonly InvoiceStatus[] = ["Viewed", "Disputed", "Void"];

export function isInvoiceOffRamp(status: string): boolean {
	return (INVOICE_OFF_RAMPS as readonly string[]).includes(status);
}

export interface InvoiceActionContext {
	status: InvoiceStatus;
	amountPaid: number;
	hasOpenDispute: boolean;
	disputeStateUnknown: boolean;
	/** disputeList.open_refusal — why Open Dispute is shut, or null. Produced by
	 *  the open door itself, so the button and the 422 body match. */
	openRefusal: string | null;
	/** disputeList.void_refusal — why Void is shut (a payment is applied, or a
	 *  live adjustment names this invoice), or null. Produced by the same
	 *  functions updateInvoice refuses the void with. */
	voidRefusal: string | null;
	canEdit: boolean;
	/** Holds send_invoices. Not canEdit: mailing an invoice accounting has
	 *  already approved is not a restatement of what it bills. */
	canSend: boolean;
	/** Holds open_disputes. Not canEdit: recording a disagreement isn't an edit. */
	canOpenDispute: boolean;
	/** Holds refund_invoices — cash out, which covers both the refund and
	 *  the void. */
	canRefund: boolean;
	handlers: Record<
		"send" | "issue" | "recordPayment" | "refund" | "dispute" | "void",
		() => void
	>;
}

function voidReason(ctx: InvoiceActionContext): ActionGate {
	// Voiding needs both grants: the server gates the route on edit_invoices
	// and the void itself on refund_invoices.
	if (!ctx.canEdit || !ctx.canRefund) return NO_PERMISSION;
	if (ctx.status === "Void") return notApplicable("This invoice is already void.");
	if (ctx.disputeStateUnknown) return unknownDisputeReason("invoice");
	// The server refuses any status change under an open dispute, and voiding
	// would leave the dispute with no exit. Repeal closes both at once.
	if (ctx.hasOpenDispute) {
		return "This invoice has an open dispute — resolve it and choose Repeal instead.";
	}
	// Money and the adjustment chain, from the server: matches the kebab Void.
	return ctx.voidRefusal;
}

export function invoiceActions(ctx: InvoiceActionContext): LifecycleAction[] {
	const dead = ctx.status === "Void";

	return [
		// Two delivery doors, not two steps: the system emails the invoice, or
		// the business issues it and delivers the PDF itself. Both open from Draft.
		build(
			"send",
			"Email to Client",
			"primary",
			// canSend, not canEdit: the server gates this route on send_invoices,
			// which a billing clerk can hold without the rights to restate the
			// amount on the way out.
			!ctx.canSend
				? NO_PERMISSION
				: dead
					? notApplicable("A void invoice can't be sent.")
					: !["Draft", "Issued"].includes(ctx.status)
						? notApplicable("This invoice has already been sent.")
						: null,
			ctx.handlers.send
		),
		build(
			"issue",
			"Create Without Sending",
			"neutral",
			!ctx.canEdit
				? NO_PERMISSION
				: dead
					? notApplicable("A void invoice can't be marked Created.")
					: ctx.status !== "Draft"
						? notApplicable("This invoice has already been created.")
						: null,
			ctx.handlers.issue
		),
		build(
			"recordPayment",
			"Record Payment",
			"primary",
			!ctx.canEdit
				? NO_PERMISSION
				: dead
					? notApplicable("A void invoice can't take a payment.")
					: ctx.status === "Paid"
						? notApplicable("This invoice is paid in full.")
						: !["Sent", "Viewed", "PartiallyPaid", "Disputed"].includes(
									ctx.status
							  )
							? "Send the invoice before recording a payment."
							: null,
			ctx.handlers.recordPayment
		),
		build(
			"dispute",
			"Open Dispute",
			"warning",
			openDisputeReason({
				kind: "invoice",
				canOpenDispute: ctx.canOpenDispute,
				isDead: dead,
				disputeStateUnknown: ctx.disputeStateUnknown,
				hasOpenDispute: ctx.hasOpenDispute,
				openRefusal: ctx.openRefusal,
			}),
			ctx.handlers.dispute
		),
		build(
			"refund",
			"Record Refund",
			"neutral",
			!ctx.canRefund
				? NO_PERMISSION
				: dead
					? notApplicable("A void invoice can't be refunded.")
					: ctx.disputeStateUnknown
						? unknownDisputeReason("invoice")
						: !(ctx.amountPaid > 0)
							? "Nothing has been paid on this invoice yet."
							: null,
			ctx.handlers.refund
		),
		build("void", "Void Invoice", "destructive", voidReason(ctx), ctx.handlers.void),
	];
}
