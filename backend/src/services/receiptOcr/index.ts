import { log } from "../appLogger.js";
import { extractFixture } from "./fixture.js";
import type { ReceiptOcrProvider } from "./normalize.js";
import { extractWithTextract } from "./textract.js";

/**
 * Provider selection. The parsing contract and its helpers live in
 * `normalize.ts` so the adapters can reach them without importing the module
 * that imports them.
 */

export * from "./normalize.js";

/**
 * Returning null is a supported end state, not an error: manual entry is the
 * mandatory fallback for an illegible receipt, so it has to work for a missing key
 * too. Resolved per call rather than cached at import, so a rotated key takes
 * effect on the next receipt rather than the next deploy.
 */
export function getReceiptOcrProvider(): ReceiptOcrProvider | null {
	const configured = (process.env.RECEIPT_OCR_PROVIDER ?? "").trim().toLowerCase();
	if (configured === "" || configured === "none") return null;

	// Keyless and offline, so auto-fill can be demonstrated and end-to-end tested
	// without a vendor account. Never the default: it would invent a receipt.
	if (configured === "fixture") {
		// Refused in production rather than trusted to the operator's .env. What it
		// returns is fabricated financial data - a vendor, a date and a total nobody
		// paid - and runReceiptOcr applies it silently by design, so a stale or
		// copy-pasted env value would corrupt real reimbursements with no error.
		if (process.env.NODE_ENV === "production") {
			log.error("RECEIPT_OCR_PROVIDER=fixture is refused in production - OCR disabled");
			return null;
		}
		return { name: "fixture", extract: extractFixture };
	}

	if (configured === "textract") {
		const region = process.env.TEXTRACT_REGION;
		const accessKeyId = process.env.TEXTRACT_ACCESS_KEY_ID;
		const secretAccessKey = process.env.TEXTRACT_SECRET_ACCESS_KEY;
		// Its own keys rather than the AWS default chain: object storage is Wasabi,
		// and an ambient AWS_* credential is not one this provider should pick up.
		if (!region || !accessKeyId || !secretAccessKey) {
			log.warn(
				"RECEIPT_OCR_PROVIDER=textract needs TEXTRACT_REGION, TEXTRACT_ACCESS_KEY_ID and TEXTRACT_SECRET_ACCESS_KEY - OCR disabled",
			);
			return null;
		}
		const cfg = { region, accessKeyId, secretAccessKey };
		return { name: "textract", extract: (file) => extractWithTextract(file, cfg) };
	}

	log.warn({ configured }, "Unknown RECEIPT_OCR_PROVIDER - OCR disabled");
	return null;
}
