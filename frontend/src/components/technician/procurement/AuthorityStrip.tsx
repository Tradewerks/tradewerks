import { COL_LABEL, money } from "../../fieldPurchases/fieldPurchaseFormat";
import type { FieldPurchaseGrant, SpentSoFar } from "../../../types/fieldPurchases";

/** Below this much of a ceiling left, the number is the reason to stop and think. */
const LOW = 0.2;

interface Cell {
	label: string;
	value: string;
	low: boolean;
}

/**
 * What the technician is allowed to spend, as the three numbers a decision at a
 * counter turns on. The daily and weekly ceilings are nullable, so an unlimited
 * one reports what has been spent rather than an ungrounded "left".
 */
export default function AuthorityStrip({
	grant,
	spent,
}: {
	grant: FieldPurchaseGrant;
	spent: SpentSoFar;
}) {
	const window = (label: string, limit: string | null, used: string): Cell => {
		if (!limit) return { label: `Spent ${label}`, value: money(used), low: false };
		const left = Math.max(0, Number(limit) - Number(used));
		return { label: `Left ${label}`, value: money(left), low: left < Number(limit) * LOW };
	};

	const cells: Cell[] = [
		{ label: "Per purchase", value: money(grant.per_transaction_limit), low: false },
		window("today", grant.daily_limit, spent.today),
		window("this week", grant.weekly_limit, spent.week),
	];

	return (
		<dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border">
			{cells.map((c) => (
				<div key={c.label} className="bg-base px-3 py-2.5">
					<dt className={COL_LABEL}>{c.label}</dt>
					<dd
						className={`mt-0.5 text-sm font-semibold tabular-nums ${
							c.low ? "text-warning-text" : "text-text-primary"
						}`}
					>
						{c.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
