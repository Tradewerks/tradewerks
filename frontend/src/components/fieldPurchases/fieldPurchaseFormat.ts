import { formatCurrency } from "../../util/util";

/**
 * Formatting and thresholds shared by the field-purchase surfaces. Split from the
 * components so a fast-refresh boundary holds: a module exporting both a constant
 * and a component cannot be hot-reloaded cleanly.
 */

export const COL_LABEL = "text-[10px] font-semibold uppercase tracking-wider text-text-tertiary";

export const FOCUS_RING =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-border";

/**
 * The one affordance for "open the record this names" — jobs, visits, and the
 * purchase a reconcile row came off. Underline on hover only: a table of
 * permanently underlined links reads as noise.
 */
export const RECORD_LINK = `rounded text-primary-text hover:underline ${FOCUS_RING}`;

/** Every amount is a numeric string on the wire; parsing late keeps the cents. */
export const money = (v: string | number) => formatCurrency(Number(v));

/**
 * How long the reviewer has been sitting on it. A purchase enters the queue when
 * it is submitted; before that only its creation time exists, so the fallback
 * matches the server's ordering clock.
 */
export function hoursWaiting(since: string | null): number | null {
	if (!since) return null;
	const ms = Date.now() - new Date(since).getTime();
	return ms < 0 ? 0 : ms / 3_600_000;
}

export function ageLabel(hours: number): string {
	if (hours < 1) return "<1h";
	if (hours < 48) return `${Math.floor(hours)}h`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * The same span, said rather than abbreviated. "<1h" and "3d" are compressions
 * for a 10px chip; read aloud they are not words. Kept beside `ageLabel` so the
 * two cannot come to describe different spans.
 */
export function spokenAge(hours: number): string {
	if (hours < 1) return "under an hour";
	if (hours < 48) {
		const h = Math.floor(hours);
		return `${h} hour${h === 1 ? "" : "s"}`;
	}
	const d = Math.floor(hours / 24);
	return `${d} day${d === 1 ? "" : "s"}`;
}

/** One working day is fine, three is not. The ramp is the service promise. */
export function ageTone(hours: number): "calm" | "warning" | "error" {
	if (hours >= 72) return "error";
	if (hours >= 24) return "warning";
	return "calm";
}

export { isTypingKeystroke } from "../../util/keyboard";
