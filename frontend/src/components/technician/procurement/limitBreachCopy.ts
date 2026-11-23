import i18n from "../../../i18n";
import { money } from "../../fieldPurchases/fieldPurchaseFormat";
import type { LimitBreach } from "../../../types/fieldPurchases";

/**
 * One breach, said in numbers a technician can act on: the ceiling, what has
 * already gone against it, and how far this purchase has to come down.
 *
 * Shared by the pre-approval sheet and the purchase screen so the two cannot
 * drift — they answer the same question at different points in the same trip.
 */
export interface BreachCopy {
	/** The ceiling, named by its window. */
	title: string;
	/** Null for `per_transaction`: one purchase has no window to have spent against. */
	spent: string | null;
	action: string;
}

/** One job's share of the receipt, as the limit check was asked about it. */
export interface BreachShare {
	job_id: string;
	amount: number;
}

export function describeBreach(
	breach: LimitBreach,
	/** The whole receipt, which is what every windowed ceiling was measured against. */
	amount: number,
	/** Every job's share of it. A `per_job` ceiling was measured against just one. */
	shares?: readonly BreachShare[],
): BreachCopy {
	const limit = Number(breach.limit);
	// The server's `would_be` is the spend this ceiling saw with the relevant
	// amount already in it, so the spend on its own is what is left after taking
	// that amount back out — and for `per_job` the amount it saw was one job's
	// share, not the receipt. Subtracting the whole receipt read "$0.00 already
	// spent on this job", which the clamp below hid rather than caught.
	const wouldBe = Number(breach.would_be);
	const share =
		breach.code === "per_job" && breach.job_id
			? shares?.find((s) => s.job_id === breach.job_id)?.amount
			: undefined;
	const measured = share ?? amount;
	// "Per purchase" matches the name AuthorityStrip prints for this ceiling.
	const { t } = i18n;
	const spent = money(Math.max(0, wouldBe - measured));
	return {
		title: t(`limits.title.${breach.code}`, { amount: money(limit) }),
		spent: breach.code === "per_transaction" ? null : t(`limits.spent.${breach.code}`, { amount: spent }),
		action: t("limits.over", { amount: money(Math.max(0, wouldBe - limit)) }),
	};
}
