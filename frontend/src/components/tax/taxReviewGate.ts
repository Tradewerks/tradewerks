import { isAxiosError } from "axios";
import { errorMessage } from "../../util/util";
import type { LifecycleAction } from "../lifecycle/types";

export interface TaxReviewGate {
	/** tax_needs_review && !tax_review_ack_at */
	needsAck: boolean;
	/** Holds the kind's ack permission. */
	canAck: boolean;
	/** The ack mutation is in flight. Pages rebuild actions each render, so the closure
	 *  guard below resets; this is what actually blocks a double-click. */
	pending: boolean;
	acknowledge: () => Promise<unknown>;
	onError: (message: string) => void;
}

/** A finalize refused with 409 QB_TAX_REVIEW has already updated the invoice server-side. */
export const isQbTaxReviewError = (err: unknown): boolean =>
	isAxiosError(err) && err.response?.data?.error?.code === "QB_TAX_REVIEW";

export const isQbTaxZeroError = (err: unknown): boolean =>
	isAxiosError(err) && err.response?.data?.error?.code === "QB_TAX_ZERO";

export const GATED_ACTION_LABEL = {
	send: "Acknowledge & email",
	issue: "Acknowledge & create",
} as const;

/**
 * A review never hard-blocks. Holders of the ack permission acknowledge on the way
 * through; everyone else proceeds unchanged. A failed ack stops the send — sending an
 * unacknowledged review silently would defeat the audit.
 */
export function withTaxReviewGate(
	actions: LifecycleAction[],
	gate: TaxReviewGate
): LifecycleAction[] {
	if (!gate.needsAck || !gate.canAck) return actions;
	return actions.map((a) => {
		if ((a.id !== "send" && a.id !== "issue") || a.disabled || a.hidden) return a;
		if (gate.pending) {
			return {
				...a,
				label: GATED_ACTION_LABEL[a.id],
				disabled: true,
				disabledReason: "Acknowledging the tax review…",
				pending: true,
			};
		}
		let pending = false;
		return {
			...a,
			label: GATED_ACTION_LABEL[a.id],
			onSelect: () => {
				if (pending) return;
				pending = true;
				gate.acknowledge().then(
					() => {
						pending = false;
						a.onSelect();
					},
					(err: unknown) => {
						pending = false;
						gate.onError(
							errorMessage(
								err,
								"Couldn't acknowledge the tax review."
							)
						);
					}
				);
			},
		};
	});
}
