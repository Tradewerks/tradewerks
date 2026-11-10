/** One line's stock & billing answer, as either side of the app holds it. */
export interface DispositionLike {
	disposition: string | null;
	/** Null or "" for the warehouse; ignored unless `receive`. */
	vehicleName: string | null;
}

function phrase(l: DispositionLike): string {
	if (l.disposition === "non_stock") return "consumed on job";
	if (l.disposition === "receive") return `added to ${l.vehicleName || "Warehouse"}`;
	return "not recorded";
}

/**
 * What a whole receipt did with its parts, in one sentence: "All 6 lines consumed
 * on job", or "4 consumed on job · 2 added to Truck 12". Largest group first, so the
 * sheet's answer leads and the exceptions follow it. Null with no lines.
 */
export function dispositionSentence(lines: DispositionLike[]): string | null {
	if (lines.length === 0) return null;
	const groups = new Map<string, number>();
	for (const l of lines) {
		const p = phrase(l);
		groups.set(p, (groups.get(p) ?? 0) + 1);
	}
	if (groups.size === 1) {
		const [p] = [...groups.keys()];
		return lines.length === 1 ? `1 item ${p}` : `All ${lines.length} items ${p}`;
	}
	return [...groups.entries()]
		.sort(([, a], [, b]) => b - a)
		.map(([p, n]) => `${n} ${p}`)
		.join(" · ");
}
