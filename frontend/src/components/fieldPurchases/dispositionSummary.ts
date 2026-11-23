import i18n from "../../i18n";

/** One line's stock & billing answer, as either side of the app holds it. */
export interface DispositionLike {
	disposition: string | null;
	/** Null or "" for the warehouse; ignored unless `receive`. */
	vehicleName: string | null;
}

/** Grouping key; the phrase is built per count so Spanish can agree in number. */
function group(l: DispositionLike): string {
	if (l.disposition === "non_stock") return "consumed|";
	if (l.disposition === "receive")
		return `added|${l.vehicleName || i18n.t("stock.warehouse")}`;
	return "notRecorded|";
}

function phrase(key: string, count: number): string {
	const i = key.indexOf("|");
	const kind = key.slice(0, i) as "consumed" | "added" | "notRecorded";
	return i18n.t(`stock.phrase.${kind}`, { count, name: key.slice(i + 1) });
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
		const g = group(l);
		groups.set(g, (groups.get(g) ?? 0) + 1);
	}
	if (groups.size === 1) {
		const [g] = [...groups.keys()] as [string];
		return i18n.t("stock.sentence", {
			count: lines.length,
			phrase: phrase(g, lines.length),
		});
	}
	return [...groups.entries()]
		.sort(([, a], [, b]) => b - a)
		.map(([g, n]) => `${n} ${phrase(g, n)}`)
		.join(" · ");
}
