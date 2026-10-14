import type { CardModel } from "./cardModel";

/** Pixel budget shared by planCardLayout and the renderer; line heights are explicit px. */
export const CARD_METRICS = {
	STRIP_W: 4,
	H_PAD: 10,
	V_PAD: 8,
	OPEN_END_PAD: 6,
	ROW_GAP: 2,
	CHIP_H: 14,
	TITLE_LH: 13,
	SECONDARY_LH: 12,
	BUBBLE_SZ: 16,
	BUBBLE_GAP: 3,
	DOT_SZ: 7,
	DOT_GAP: 2,
	UNASSIGNED_H: 12,
	SLIVER_W: 56,
	INLINE_H: 44,
	INLINE_TEXT_MIN: 64,
	TITLE_CHAR_W: 6.2,
	SECONDARY_CHAR_W: 5.4,
} as const;

const M = CARD_METRICS;

export type CardMode = "sliver" | "inline" | "column";
export type TechRowKind = "bubbles" | "dots" | "unassigned" | "none";

export interface CardLayout {
	mode: CardMode;
	contentW: number;
	contentH: number;
	chip: boolean;
	titleLines: number;
	client: boolean;
	address: boolean;
	ref: boolean;
	descriptionLines: number;
	tech: TechRowKind;
	maxDots: number;
}

export function techRowHeight(tech: TechRowKind): number {
	if (tech === "bubbles") return M.BUBBLE_SZ;
	if (tech === "dots") return M.DOT_SZ;
	if (tech === "unassigned") return M.UNASSIGNED_H;
	return 0;
}

const dotsFit = (w: number) => Math.max(0, Math.floor((w + M.DOT_GAP) / (M.DOT_SZ + M.DOT_GAP)));

// Text is not measured in the DOM; an average glyph width is close enough to pick 1 vs 2 lines.
const linesFor = (text: string, charW: number, width: number) =>
	Math.max(1, Math.ceil((text.length * charW) / Math.max(width, 1)));

export function planCardLayout(model: CardModel, width: number, height: number): CardLayout {
	const contentW = width - M.STRIP_W - M.H_PAD;
	const contentH = height - M.V_PAD - (model.constraint.openEnded ? M.OPEN_END_PAD : 0);
	const n = model.techs.length;
	const empty = {
		contentW,
		contentH,
		chip: false,
		titleLines: 0,
		client: false,
		address: false,
		ref: false,
		descriptionLines: 0,
	};

	if (contentW < M.SLIVER_W) {
		const room = contentH - M.SECONDARY_LH - M.ROW_GAP;
		const maxDots = Math.min(n, dotsFit(room));
		return { ...empty, mode: "sliver", tech: maxDots > 0 ? "dots" : "none", maxDots };
	}

	if (height < M.INLINE_H) {
		const maxDots = Math.min(n, dotsFit(contentW - M.INLINE_TEXT_MIN));
		return { ...empty, mode: "inline", titleLines: 1, tech: maxDots > 0 ? "dots" : "none", maxDots };
	}

	const bubblesW = n * (M.BUBBLE_SZ + M.BUBBLE_GAP) - M.BUBBLE_GAP;
	const bubblesFit = bubblesW <= contentW && contentH >= M.TITLE_LH + M.ROW_GAP + M.BUBBLE_SZ;
	const baseTech: TechRowKind = model.kind === "occurrence" ? "unassigned" : "none";

	const stack = (tech: TechRowKind): CardLayout => {
		let used = techRowHeight(tech);
		let rows = used > 0 ? 1 : 0;
		const take = (h: number) => {
			const cost = h + (rows > 0 ? M.ROW_GAP : 0);
			if (used + cost > contentH) return false;
			used += cost;
			rows++;
			return true;
		};

		let titleLines = take(M.TITLE_LH) ? 1 : 0;
		const chip = take(M.CHIP_H);
		const titleText = model.kind === "occurrence" ? `  ${model.title}` : model.title;
		const titleNeed = Math.min(2, linesFor(titleText, M.TITLE_CHAR_W, contentW));
		// The second title line shares the title's box, so it costs a line height and no gap.
		if (titleLines === 1 && titleNeed === 2 && used + M.TITLE_LH <= contentH) {
			used += M.TITLE_LH;
			titleLines = 2;
		}
		const client = !!model.client && take(M.SECONDARY_LH);
		const address = !!model.address && take(M.SECONDARY_LH);
		const ref = !!model.ref && take(M.SECONDARY_LH);

		let descriptionLines = 0;
		if (model.description) {
			const free = Math.floor((contentH - used - M.ROW_GAP) / M.SECONDARY_LH);
			if (free >= 3) {
				const lines = Math.min(2, linesFor(model.description, M.SECONDARY_CHAR_W, contentW));
				if (take(lines * M.SECONDARY_LH)) descriptionLines = lines;
			}
		}

		let maxDots = 0;
		if (tech === "bubbles") maxDots = n;
		else if (tech === "dots") {
			const fit = dotsFit(contentW);
			maxDots = n <= fit ? n : Math.max(1, fit - 2);
		}

		return {
			mode: "column",
			contentW,
			contentH,
			chip,
			titleLines,
			client,
			address,
			ref,
			descriptionLines,
			tech,
			maxDots,
		};
	};

	// The time chip is row 1; shrink bubbles to dots before letting them push it out.
	if (n === 0) return stack(baseTech);
	const withBubbles = bubblesFit ? stack("bubbles") : null;
	return withBubbles?.chip ? withBubbles : stack("dots");
}
