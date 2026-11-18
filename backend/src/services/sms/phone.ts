// NANP: area code and exchange both start 2-9.
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;

/**
 * US and Canada share +1, so the default country does not change the result;
 * it is kept so non-NANP countries can be added without changing callers.
 */
export function toE164(
	raw: string,
	_defaultCountry: "US" | "CA",
): string | null {
	const main = raw.split(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i)[0].trim();
	if (!/^\+?[\d\s().-]+$/.test(main)) return null;
	let digits = main.replace(/\D/g, "");
	if (main.startsWith("+")) {
		if (!digits.startsWith("1")) return null;
		digits = digits.slice(1);
	} else if (digits.length === 11 && digits.startsWith("1")) {
		digits = digits.slice(1);
	}
	return NANP.test(digits) ? `+1${digits}` : null;
}
