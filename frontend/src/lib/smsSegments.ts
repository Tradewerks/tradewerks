// GSM-7 basic set plus the extension table (each extension char costs two
// septets). Anything outside both switches the whole message to UCS-2.
const GSM_BASIC =
	"@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

export interface SmsSegmentInfo {
	encoding: "GSM-7" | "UCS-2";
	/** Characters as the carrier counts them (GSM extension chars count 2). */
	length: number;
	segments: number;
	/** Capacity of one segment at this length. */
	perSegment: number;
}

// Mirrors backend/src/services/sms/segments.ts: a part never splits an escape
// pair or a surrogate pair, so parts are packed character by character.
function pack(weights: number[], total: number, single: number, perPart: number): number {
	if (total === 0) return 0;
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

export function smsSegments(text: string): SmsSegmentInfo {
	const chars = Array.from(text);
	const gsm = chars.every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c));
	// UCS-2 counts UTF-16 code units, so an emoji is two.
	const weights = gsm
		? chars.map((c) => (GSM_EXTENDED.includes(c) ? 2 : 1))
		: chars.map((c) => c.length);
	const length = weights.reduce((a, b) => a + b, 0);
	const [single, perPart] = gsm ? [160, 153] : [70, 67];
	return {
		encoding: gsm ? "GSM-7" : "UCS-2",
		length,
		segments: pack(weights, length, single, perPart),
		perSegment: length <= single ? single : perPart,
	};
}
