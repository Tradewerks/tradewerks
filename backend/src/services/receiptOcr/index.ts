import { log } from "../appLogger.js";
import { extractFixture } from "./fixture.js";
import { extractWithMindee } from "./mindee.js";
import type { ReceiptOcrProvider } from "./normalize.js";

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

	if (configured === "mindee") {
		const apiKey = process.env.MINDEE_API_KEY;
		// Mindee V2 has no shared model IDs: the operator creates a Receipt model in
		// their own console, and the UUID it mints is what names the schema to read.
		const modelId = process.env.MINDEE_MODEL_ID;
		if (!apiKey || !modelId) {
			log.warn("RECEIPT_OCR_PROVIDER=mindee needs MINDEE_API_KEY and MINDEE_MODEL_ID - OCR disabled");
			return null;
		}
		return { name: "mindee", extract: (file) => extractWithMindee(file, { apiKey, modelId }) };
	}

	log.warn({ configured }, "Unknown RECEIPT_OCR_PROVIDER - OCR disabled");
	return null;
}
