import type { VisitStatus } from "../../../types/jobs";
import type { FeedEvent, TechStatusChangeType } from "../../../types/technicians";

export const STATUS_COLORS: Record<VisitStatus, string> = {
	Scheduled:  "var(--color-visit-scheduled)",
	Driving:    "var(--color-visit-driving)",
	OnSite:     "var(--color-visit-onsite)",
	InProgress: "var(--color-visit-inprogress)",
	Paused:     "var(--color-visit-paused)",
	Delayed:    "var(--color-visit-delayed)",
	Completed:  "var(--color-visit-completed)",
	Cancelled:  "var(--color-visit-cancelled)",
};

const TECH_CHANGE_COLORS: Record<TechStatusChangeType, string> = {
	shift_start:         "var(--color-visit-completed)",
	shift_end:           "var(--color-visit-scheduled)",
	break_start:         "var(--color-visit-paused)",
	break_end:           "var(--color-visit-completed)",
	wrapping_up_cleared: "var(--color-visit-completed)",
	heading_back:        "var(--color-visit-driving)",
};

const TECH_CHANGE_TEXT: Record<TechStatusChangeType, (name: string) => { primary: string; sub: string }> = {
	shift_start:         (n) => ({ primary: `${n} started shift`,       sub: "" }),
	shift_end:           (n) => ({ primary: `${n} ended shift`,         sub: "" }),
	break_start:         (n) => ({ primary: `${n} on break`,            sub: "" }),
	break_end:           (n) => ({ primary: `${n} returned from break`, sub: "" }),
	wrapping_up_cleared: (n) => ({ primary: `${n} is available`,        sub: "" }),
	heading_back:        (n) => ({ primary: `${n} is heading back`,     sub: "" }),
};

export function timeAgo(isoString: string): string {
	const diffMs = Date.now() - new Date(isoString).getTime();
	const mins = Math.floor(diffMs / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function getStatusColor(event: FeedEvent): string {
	if (event.kind === "tech") return TECH_CHANGE_COLORS[event.changeType] ?? "var(--color-visit-scheduled)";
	return STATUS_COLORS[event.visitStatus] ?? "var(--color-visit-scheduled)";
}

export function getEventText(event: FeedEvent): { primary: string; sub: string } {
	if (event.kind === "tech") return TECH_CHANGE_TEXT[event.changeType](event.techName);

	const client = event.visit.job.client.name;
	const techName =
		event.actor?.type === "technician" && event.actor.name ? event.actor.name : null;

	if (event.visitStatusChanged) {
		switch (event.visitStatus) {
			case "Driving":
				return {
					primary: `${client} visit started`,
					sub: techName ? `${techName} en route` : "",
				};
			case "OnSite":
				return {
					primary: `First arrival — ${client}`,
					sub: techName ? `${techName} on site` : "",
				};
			case "InProgress":
				if (event.previousVisitStatus === "Paused") {
					return { primary: `${client} visit resumed`, sub: techName ?? "" };
				}
				return { primary: `Work underway — ${client}`, sub: techName ?? "" };
			case "Paused":
				return { primary: `${client} visit paused`, sub: techName ?? "" };
			case "Delayed":
				return { primary: `${client} visit delayed`, sub: techName ?? "" };
			case "Completed":
				return { primary: `${client} visit completed`, sub: techName ?? "" };
			case "Cancelled":
				return { primary: `${client} visit cancelled`, sub: "" };
			default:
				return { primary: `${client} — ${event.visitStatus}`, sub: "" };
		}
	}

	const name = event.actor?.name ?? "Technician";
	switch (event.visitStatus) {
		case "Driving":
			return { primary: `${name} also en route to ${client}`, sub: "" };
		case "Paused":
			return { primary: `${name} paused at ${client}`, sub: "" };
		case "InProgress":
			return { primary: `${name} resumed at ${client}`, sub: "" };
		case "Completed":
			return { primary: `${name} finished at ${client}`, sub: "" };
		default:
			return { primary: `${name} — ${event.visitStatus} at ${client}`, sub: "" };
	}
}
