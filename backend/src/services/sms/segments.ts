// GSM 03.38 basic character set (ESC excluded) and its extension table.
const GSM_BASIC = new Set(
	"@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
		"¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENSION = new Set("\f^{}\\[~]|€");

// A part never splits an escape pair or a surrogate pair, so parts are packed
// whole-character by whole-character rather than by dividing the total.
function pack(weights: number[], single: number, perPart: number): number {
	const total = weights.reduce((a, b) => a + b, 0);
	if (total <= single) return 1;
	let parts = 1;
	let used = 0;
	for (const w of weights) {
		if (used + w > perPart) {
			parts++;
			used = 0;
		}
		used += w;
	}
	return parts;
}

export function countSegments(body: string): {
	encoding: "GSM-7" | "UCS-2";
	segments: number;
} {
	const chars = Array.from(body);
	const gsm = chars.every((c) => GSM_BASIC.has(c) || GSM_EXTENSION.has(c));
	if (gsm) {
		const weights = chars.map((c) => (GSM_EXTENSION.has(c) ? 2 : 1));
		return { encoding: "GSM-7", segments: pack(weights, 160, 153) };
	}
	// UCS-2 is billed in UTF-16 code units: an emoji is two.
	const weights = chars.map((c) => c.length);
	return { encoding: "UCS-2", segments: pack(weights, 70, 67) };
}
