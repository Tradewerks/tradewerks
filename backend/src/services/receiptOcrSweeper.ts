import { db } from "../db.js";
import { isTechEditable } from "../lib/fieldPurchase.js";
import { READ_STALLED, runReceiptOcr } from "../controllers/fieldPurchasesController.js";
import { log } from "./appLogger.js";
import { getReceiptOcrProvider, OCR_STALE_MS } from "./receiptOcr/index.js";
import { ocrMetrics, registerOcrPendingGauges } from "./receiptOcr/ocrMetrics.js";
import { emitToOrg } from "./socketService.js";
import { getBuffer } from "./wasabiService.js";

const SWEEP_INTERVAL_MS = 60_000;
const BATCH = 20;

function maxAttempts(): number {
	const n = Number(process.env.OCR_MAX_ATTEMPTS);
	return Number.isInteger(n) && n > 0 ? n : 3;
}

type StaleRow = {
	id: string;
	organization_id: string;
	status: string;
	receipt_image_url: string | null;
	receipt_image_hash: string | null;
	ocr_started_at: Date | null;
	ocr_attempts: number;
};

/**
 * Re-runs receipt reads left `pending` past OCR_STALE_MS: the process died mid-read, or
 * the provider failed retryably. Cross-org on purpose, so the base client. Re-runs are
 * not charged to the scan meter - the failure was ours (user call, Nov 6 2026).
 */
export async function sweepStalledReads(now = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - OCR_STALE_MS);
	const rows: StaleRow[] = await db.field_purchase.findMany({
		where: {
			ocr_status: "pending",
			OR: [
				{ ocr_started_at: { lt: cutoff } },
				// Marked pending before ocr_started_at existed.
				{ ocr_started_at: null, updated_at: { lt: cutoff } },
			],
		},
		select: {
			id: true,
			organization_id: true,
			status: true,
			receipt_image_url: true,
			receipt_image_hash: true,
			ocr_started_at: true,
			ocr_attempts: true,
		},
		orderBy: { ocr_started_at: "asc" },
		take: BATCH,
	});
	let rerun = 0;
	for (const row of rows) {
		try {
			if (await recover(row, now)) rerun += 1;
		} catch (err) {
			log.error({ err, purchaseId: row.id }, "receipt OCR recovery failed - left for the next sweep");
		}
	}
	return rerun;
}

/** Whether this sweep ran the read again. */
async function recover(row: StaleRow, now: Date): Promise<boolean> {
	const provider = getReceiptOcrProvider();
	const giveUp = !provider
		? "Receipt reading is not configured — enter the lines by hand"
		: !row.receipt_image_url
			? READ_STALLED
			: !isTechEditable(row.status)
				? "The purchase moved on before the receipt was read"
				: row.ocr_attempts >= maxAttempts()
					? READ_STALLED
					: null;

	// Compare-and-set on the start time this sweep saw: zero rows means another instance,
	// or the technician's Try again, took the row since. That is the whole lock.
	const owned = { id: row.id, ocr_status: "pending" as const, ocr_started_at: row.ocr_started_at };

	if (giveUp) {
		const { count } = await db.field_purchase.updateMany({
			where: owned,
			data: { ocr_status: "failed", ocr_error: giveUp, ocr_completed_at: now },
		});
		if (count === 0) return false;
		ocrMetrics.read(provider?.name ?? "none", "abandoned");
		log.warn({ purchaseId: row.id, attempts: row.ocr_attempts }, "receipt OCR abandoned by the sweeper");
		emitToOrg(row.organization_id, "field_purchase:ocr", { id: row.id, status: "failed" });
		return false;
	}

	const { count } = await db.field_purchase.updateMany({
		where: owned,
		data: { ocr_started_at: now, ocr_attempts: { increment: 1 } },
	});
	if (count === 0) return false;

	// The upload's buffer died with the read. A storage failure leaves the row claimed;
	// it goes stale again and the attempt cap ends it.
	let stored: Awaited<ReturnType<typeof getBuffer>>;
	try {
		stored = await getBuffer(row.receipt_image_url!);
	} catch (err) {
		log.warn({ err, purchaseId: row.id }, "receipt OCR recovery could not fetch the image");
		return false;
	}

	log.info({ purchaseId: row.id, attempt: row.ocr_attempts + 1 }, "re-running a stalled receipt read");
	await runReceiptOcr(
		row.organization_id,
		row.id,
		{ buffer: stored.buffer, mimetype: stored.contentType, filename: "receipt" },
		row.receipt_image_hash,
		{ recovery: true },
	);
	return true;
}

let running = false;

async function tick(label: string) {
	if (running) return;
	running = true;
	try {
		const n = await sweepStalledReads();
		if (n > 0) log.info({ rerun: n }, "receipt OCR sweep re-ran stalled reads");
	} catch (err) {
		log.error({ err }, `receipt OCR sweep ${label} failed`);
	} finally {
		running = false;
	}
}

export function startReceiptOcrSweeper(): void {
	registerOcrPendingGauges();
	// Startup run catches the reads the restart that started this process orphaned.
	void tick("startup run");
	setInterval(() => void tick("interval run"), SWEEP_INTERVAL_MS);
}
