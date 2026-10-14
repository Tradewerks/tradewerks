import type { UpgradeRequest } from "../../../api/upgradeRequests";
import { requestSummary } from "../../../lib/upgradeRequests";
import { latestRequestState } from "./latestRequestState";

const day = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function RequestStatus({
	requests,
	onWithdraw,
	withdrawing,
}: {
	requests: UpgradeRequest[];
	onWithdraw: (id: string) => void;
	withdrawing: boolean;
}) {
	const latest = latestRequestState(requests, new Date());
	if (!latest) return null;
	const r = latest.request;
	const asked = requestSummary(r);
	if (latest.kind === "open")
		return (
			<div className="space-y-1 text-xs" role="status">
				<p className="text-text-secondary">
					Request sent {day(r.created_at)}
					{asked && ` · ${asked}`} · Waiting for TradeWerks
				</p>
				<button
					type="button"
					disabled={withdrawing}
					onClick={() => onWithdraw(r.id)}
					className="font-medium text-primary hover:underline disabled:opacity-50"
				>
					Withdraw
				</button>
			</div>
		);
	return (
		<p className="text-xs text-text-secondary" role="status">
			{latest.kind === "approved"
				? `Approved ${day(r.resolved_at!)}`
				: `Declined: ${r.resolution_note ?? ""}`}
		</p>
	);
}
