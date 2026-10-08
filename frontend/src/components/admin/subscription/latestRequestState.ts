import type { UpgradeRequest } from "../../../api/upgradeRequests";

const DAY = 86_400_000;

export function latestRequestState(
	requests: UpgradeRequest[],
	now: Date
): { kind: "open" | "approved" | "declined"; request: UpgradeRequest } | null {
	const open = requests.find((r) => r.status === "open");
	if (open) return { kind: "open", request: open };
	const closed = requests
		.filter(
			(r) => (r.status === "approved" || r.status === "declined") && r.resolved_at
		)
		.sort((a, b) => b.resolved_at!.localeCompare(a.resolved_at!))[0];
	if (!closed || now.getTime() - new Date(closed.resolved_at!).getTime() > 30 * DAY)
		return null;
	return { kind: closed.status as "approved" | "declined", request: closed };
}
