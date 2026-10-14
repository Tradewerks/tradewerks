import { AlertTriangle } from "lucide-react";
import { describeBreach, type BreachShare } from "./limitBreachCopy";
import type { LimitBreach } from "../../../types/fieldPurchases";

/**
 * Every ceiling this amount crosses, one row each — the run-on line this replaced
 * held four of them, and none of its numbers said what to do next.
 *
 * Never a refusal: crossing a limit routes the purchase through dispatch, so the
 * heading says whose call it is and the caller's button stays live.
 */
export default function LimitBreachNotice({
	breaches,
	amount,
	shares,
}: {
	breaches: LimitBreach[];
	amount: number;
	/**
	 * Every job's share of `amount`. Needed only for a `per_job` row, which the
	 * server measured against one share rather than the whole receipt. Omitted
	 * where a purchase names one job, whose share is the whole thing.
	 */
	shares?: readonly BreachShare[];
}) {
	if (breaches.length === 0) return null;

	return (
		// Announced, not just drawn: this appears as the amount is typed, with no
		// focus move of its own, and it decides which button the trip ends on.
		<div
			role="status"
			aria-live="polite"
			className="rounded-lg border border-warning-border bg-warning-bg p-3 text-left"
		>
			<p className="flex items-center gap-1.5 text-xs font-semibold text-warning-text">
				<AlertTriangle size={12} aria-hidden className="flex-shrink-0" />
				Over a limit — dispatch has to approve it
			</p>
			<ul className="mt-2 space-y-2">
				{breaches.map((b) => {
					const copy = describeBreach(b, amount, shares);
					return (
						<li
							key={`${b.code}:${b.job_id ?? ""}`}
							className="text-xs leading-snug"
						>
							<span className="block tabular-nums text-text-secondary">
								{copy.title}
							</span>
							{/* Each figure is its own nowrap chunk: at 360px the line wraps
							    between them rather than through an amount. */}
							<span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-warning-text">
								{copy.spent && (
									<>
										<span className="whitespace-nowrap tabular-nums">
											{copy.spent}
										</span>
										<span
											aria-hidden
											className="text-text-tertiary"
										>
											·
										</span>
									</>
								)}
								<span className="whitespace-nowrap font-semibold tabular-nums">
									{copy.action}
								</span>
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
