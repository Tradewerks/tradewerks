/** Page numbers to render: first, last, and current ±1, with "gap" where pages are skipped. */
export function pageList(current: number, totalPages: number): (number | "gap")[] {
	const out: (number | "gap")[] = [];
	for (let p = 1; p <= totalPages; p++) {
		if (p !== 1 && p !== totalPages && Math.abs(p - current) > 1) continue;
		const prev = out[out.length - 1];
		if (typeof prev === "number" && p - prev > 1) out.push("gap");
		out.push(p);
	}
	return out;
}
