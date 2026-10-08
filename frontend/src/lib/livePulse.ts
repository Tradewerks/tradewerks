import type { Technician } from "../types/technicians";

/**
 * A tech is "live" while their device keeps pinging. Devices send a fix at most
 * every 15s and a heartbeat every 60s while stationary (TechnicianLayout), so 90s
 * covers one missed heartbeat plus network slack.
 */
export const LIVE_WINDOW_MS = 90_000;

function pingMs(lastPingAt: string | null | undefined): number | null {
	if (!lastPingAt) return null;
	const ms = new Date(lastPingAt).getTime();
	return Number.isNaN(ms) ? null : ms;
}

export function isPingLive(
	status: Technician["status"],
	lastPingAt: string | null | undefined,
	now: number,
): boolean {
	if (status === "Offline") return false;
	const ms = pingMs(lastPingAt);
	return ms !== null && now - ms <= LIVE_WINDOW_MS;
}

/** "now" / "12s ago" / "4m ago" / "3h ago" / "Sep 12"; null when never pinged. */
export function formatPulseAge(lastPingAt: string | null | undefined, now: number): string | null {
	const ms = pingMs(lastPingAt);
	if (ms === null) return null;
	const secs = Math.max(0, Math.floor((now - ms) / 1000));
	if (secs < 5) return "now";
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Newest ping across the fleet, as ISO; null when nobody has pinged. */
export function latestPing(techs: Pick<Technician, "last_ping_at">[]): string | null {
	let best: number | null = null;
	let bestIso: string | null = null;
	for (const t of techs) {
		const ms = pingMs(t.last_ping_at);
		if (ms !== null && (best === null || ms > best)) {
			best = ms;
			bestIso = t.last_ping_at ?? null;
		}
	}
	return bestIso;
}
