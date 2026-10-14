import { PriorityValues } from "../types/common";

export const PRIORITY_SEVERITY = [...PriorityValues].reverse() as readonly string[];

export type SortDir = "asc" | "desc";

function priorityRank(p?: string | null): number {
    const i = PriorityValues.indexOf(p as (typeof PriorityValues)[number]);
    return i === -1 ? 0 : i + 1;
}

export function comparePriority(a?: string | null, b?: string | null): number {
    return priorityRank(a) - priorityRank(b);
}

export function compareByOrder(
    a: string | null | undefined, 
    b: string | null | undefined,
    order: readonly string[],
): number {
    const ia = order.indexOf(a ?? "");
    const ib = order.indexOf(b ?? "");
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
}

type DateLike = string | Date | null | undefined;

/** Epoch ms, or NaN when the value is missing or not a parseable date. */
function toTime(v: DateLike): number {
    return v ? new Date(v).getTime() : NaN;
}

/**
 * Ascending date comparator; missing/invalid dates sort last. Wrapping this in
 * `withDir(…, "desc")` flips the null placement too — for direction-aware sorting
 * use `compareDateNullsLast(dir)` instead.
 */
export function compareDate(a?: DateLike, b?: DateLike): number {
    const ta = toTime(a);
    const tb = toTime(b);
    const aMissing = Number.isNaN(ta);
    const bMissing = Number.isNaN(tb);
    if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
    return ta - tb;
}

/**
 * Date comparator for a given direction that keeps missing/invalid dates at the
 * end in BOTH directions (only the date comparison itself is flipped).
 */
export function compareDateNullsLast(dir: SortDir): (a?: DateLike, b?: DateLike) => number {
    return (a, b) => {
        const ta = toTime(a);
        const tb = toTime(b);
        const aMissing = Number.isNaN(ta);
        const bMissing = Number.isNaN(tb);
        if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
        return dir === "desc" ? tb - ta : ta - tb;
    };
}

export function compareString(a?: string | null, b?: string | null): number {
    return (a ?? "").localeCompare(b ?? "");
}

export function compareNumber(a?: number | null, b?: number | null): number {
    return (a ?? 0) - (b ?? 0);
}

export function withDir<T>(
    cmp: (a: T, b : T) => number,
    dir: SortDir,
): (a: T, b: T) => number {
    return dir === "desc" ? (a,b) => -cmp (a, b) : cmp;
}
