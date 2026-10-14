import { PLOT_WINDOW_DAYS } from "./reorderChart";

// Geometry for the item detail card's runway meter, kept out of the component so
// the "how far along the track" arithmetic is testable without a DOM. The meter
// reads in DAYS on the same 0→30d scale the org-wide priority bars use, because
// a quantity-scaled axis mixes units: the right edge would be a number nobody
// can name, and a stockout DATE has no place on a quantity scale.

export interface RunwayMeter {
	/** Fill width, 0–100. */
	pct: number;
	/** Runway runs past the window, so the fill is a cap, not a measurement. */
	clamped: boolean;
}

/**
 * Fill for a runway of `daysOfStock`. Null when there's nothing to measure — a
 * card with no rate must drop the meter entirely rather than draw an empty track
 * that reads as "zero days left".
 */
export function runwayMeter(
	daysOfStock: number | null | undefined,
	plotMax: number = PLOT_WINDOW_DAYS,
): RunwayMeter | null {
	if (daysOfStock == null || !Number.isFinite(daysOfStock)) return null;
	const days = Math.max(0, daysOfStock);
	return {
		pct: (Math.min(days, plotMax) / plotMax) * 100,
		clamped: days > plotMax,
	};
}

/** Where a band threshold sits on the same track, for its marker and tick. */
export function bandPct(days: number, plotMax: number = PLOT_WINDOW_DAYS): number {
	return (Math.min(Math.max(0, days), plotMax) / plotMax) * 100;
}
