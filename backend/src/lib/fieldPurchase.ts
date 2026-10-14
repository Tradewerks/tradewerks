import { Prisma } from "../../generated/prisma/client.js";
import { utcDayRange } from "./dayRange.js";

/**
 * Limit maths and deterministic checks for emergency field purchases. Shared so the
 * pre-flight a technician sees BEFORE buying and the enforcement at submit cannot
 * disagree: disagreement means being told you may spend, then that you may not,
 * having already paid.
 */

export type FieldPurchaseDisposition = "receive" | "non_stock";

/**
 * `consume` is deliberately absent: it means "deduct from our stock", and a part
 * bought at a counter was never on our shelf to deduct.
 */
export const FIELD_PURCHASE_DISPOSITIONS: readonly FieldPurchaseDisposition[] = [
	"receive",
	"non_stock",
];

/** Statuses whose purchase the owning technician may still edit. */
export const TECH_EDITABLE_STATUSES = [
	"draft",
	"preauth_approved",
	"preauth_denied",
	"queried",
] as const;

export const isTechEditable = (status: string): boolean =>
	(TECH_EDITABLE_STATUSES as readonly string[]).includes(status);

/** Statuses a dispatcher may act on from the review queue. */
export const REVIEWABLE_STATUSES = ["pending_review"] as const;

/** Spend that counts against a limit: anything not refused. */
export const COUNTED_SPEND_STATUSES = [
	"pending_preauth",
	"preauth_approved",
	"pending_review",
	"queried",
	"approved",
] as const;

const ZERO = new Prisma.Decimal(0);

export type Money = number | Prisma.Decimal | string | null | undefined;

export function toDecimal(v: Money): Prisma.Decimal {
	if (v === null || v === undefined) return ZERO;
	return v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
}

export function sumDecimal(values: Iterable<Money>): Prisma.Decimal {
	let total = ZERO;
	for (const v of values) total = total.plus(toDecimal(v));
	return total;
}

/**
 * Rounding leftovers land on the biggest share, where they are the smallest
 * proportional distortion. Split two ways or three, the parts have to add up to
 * the whole exactly: one unallocated penny is a receipt reported as partly
 * unallocated.
 */
function settleDrift(shares: Prisma.Decimal[], target: Prisma.Decimal): Prisma.Decimal[] {
	if (shares.length === 0) return shares;
	const drift = target.minus(sumDecimal(shares));
	if (drift.isZero()) return shares;
	let biggest = 0;
	for (let i = 1; i < shares.length; i++) {
		if (shares[i]!.greaterThan(shares[biggest]!)) biggest = i;
	}
	shares[biggest] = shares[biggest]!.plus(drift);
	return shares;
}

export interface AllocationLines {
	id: string;
	lines: { line_total: Money }[];
}

/**
 * Every job's share of a receipt, derived from the lines assigned to it. Nobody
 * types a share: the line split IS the billing split, and a second typed answer to
 * a question the lines already answer only drifts from them.
 *
 * Tax is spread pro-rata by line subtotal, because that is how the till charged
 * it. A line assigned to no job contributes to nobody's share — it also bills
 * nobody, and submit refuses to leave one behind on a split receipt.
 */
export function deriveAllocationAmounts(
	allocations: AllocationLines[],
	tax: Money,
): { id: string; amount: Prisma.Decimal }[] {
	const subtotals = allocations.map((a) => sumDecimal(a.lines.map((l) => l.line_total)));
	const assigned = sumDecimal(subtotals);
	const taxTotal = toDecimal(tax);

	// Nothing to spread tax against: a receipt of free lines still owes its tax to
	// somebody, and equal shares is the only answer the lines do not contradict.
	const taxShares = assigned.isZero()
		? allocations.map(() =>
				allocations.length === 0
					? ZERO
					: taxTotal.dividedBy(allocations.length).toDecimalPlaces(2),
			)
		: subtotals.map((s) => s.times(taxTotal).dividedBy(assigned).toDecimalPlaces(2));
	settleDrift(taxShares, taxTotal);

	return allocations.map((a, i) => ({ id: a.id, amount: subtotals[i]!.plus(taxShares[i]!) }));
}

/**
 * The shares a pre-authorization implies, before there is a single line to derive
 * from. Equal, because nothing on an estimate says otherwise — and asked for at
 * all because `per_job` is a ceiling on what ONE job is charged: handing every job
 * the whole estimate flagged a split against a limit no single job was near.
 */
export function spreadEstimate(jobIds: string[], estimate: Money): Map<string, Prisma.Decimal> {
	const target = toDecimal(estimate);
	if (jobIds.length === 0) return new Map();
	if (jobIds.length === 1) return new Map([[jobIds[0]!, target]]);
	const shares = settleDrift(
		jobIds.map(() => target.dividedBy(jobIds.length).toDecimalPlaces(2)),
		target,
	);
	return new Map(jobIds.map((id, i) => [id, shares[i]!]));
}

export interface GrantLimits {
	per_transaction_limit: Money;
	daily_limit?: Money;
	weekly_limit?: Money;
	per_job_limit?: Money;
	is_active: boolean;
}

export interface SpendSoFar {
	/** Counted spend inside the org-local day containing the purchase. */
	today: Money;
	/** Counted spend inside the 7-day window ending with that day. */
	week: Money;
	/** Counted spend already allocated to the jobs this purchase touches. */
	perJob?: Map<string, Money>;
}

export interface LimitBreach {
	code: "per_transaction" | "daily" | "weekly" | "per_job";
	limit: string;
	would_be: string;
	job_id?: string;
}

export interface LimitVerdict {
	/** False only when the grant itself is missing or revoked. */
	authorized: boolean;
	/** True when any ceiling would be crossed, so Flow B pre-auth applies. */
	requires_preauth: boolean;
	breaches: LimitBreach[];
}

/**
 * A breach routes through pre-authorization, it never refuses: refusing is the wrong
 * answer at a parts counter, and a dispatcher's yes is the control.
 */
export function checkLimits(
	grant: GrantLimits | null,
	amount: Money,
	spent: SpendSoFar,
	jobAmounts?: Map<string, Money>,
	opts: { kind?: "purchase" | "refund" } = {},
): LimitVerdict {
	if (!grant || !grant.is_active) {
		return { authorized: false, requires_preauth: false, breaches: [] };
	}

	const amt = toDecimal(amount);
	const breaches: LimitBreach[] = [];

	// A refund is money coming back, and a ceiling governs money going out.
	// Amounts are stored positive on both kinds, so measuring a return against one
	// refuses the only transaction that can lower what the technician is holding.
	if (opts.kind === "refund") {
		return { authorized: true, requires_preauth: false, breaches };
	}

	const perTxn = toDecimal(grant.per_transaction_limit);
	if (amt.greaterThan(perTxn)) {
		breaches.push({ code: "per_transaction", limit: perTxn.toFixed(2), would_be: amt.toFixed(2) });
	}

	const daily = grant.daily_limit != null ? toDecimal(grant.daily_limit) : null;
	if (daily) {
		const wouldBe = toDecimal(spent.today).plus(amt);
		if (wouldBe.greaterThan(daily)) {
			breaches.push({ code: "daily", limit: daily.toFixed(2), would_be: wouldBe.toFixed(2) });
		}
	}

	const weekly = grant.weekly_limit != null ? toDecimal(grant.weekly_limit) : null;
	if (weekly) {
		const wouldBe = toDecimal(spent.week).plus(amt);
		if (wouldBe.greaterThan(weekly)) {
			breaches.push({ code: "weekly", limit: weekly.toFixed(2), would_be: wouldBe.toFixed(2) });
		}
	}

	const perJob = grant.per_job_limit != null ? toDecimal(grant.per_job_limit) : null;
	if (perJob && jobAmounts) {
		for (const [jobId, share] of jobAmounts) {
			const wouldBe = toDecimal(spent.perJob?.get(jobId)).plus(toDecimal(share));
			if (wouldBe.greaterThan(perJob)) {
				breaches.push({
					code: "per_job",
					limit: perJob.toFixed(2),
					would_be: wouldBe.toFixed(2),
					job_id: jobId,
				});
			}
		}
	}

	return { authorized: true, requires_preauth: breaches.length > 0, breaches };
}

/** Org-local day containing `at`, plus the 7-day window ending with it. */
export function spendWindows(at: Date, timezone?: string) {
	const day = utcDayRange(at, 1, timezone);
	const weekStart = utcDayRange(at, -6, timezone).end;
	return { dayStart: day.start, dayEnd: day.end, weekStart, weekEnd: day.end };
}

export interface PurchaseFlag {
	code:
		| "total_mismatch"
		| "outside_job_window"
		| "over_estimate"
		| "limit_breach"
		| "geo_missing"
		| "duplicate_suspected"
		| "velocity"
		| "split_transaction"
		| "refund_unsettled"
		| "not_billed"
		| "not_a_receipt"
		| "foreign_currency";
	message: string;
}

export interface FlagInput {
	total: Money;
	tax_amount: Money;
	estimated_amount?: Money;
	purchased_at?: Date | null;
	lines: { line_total: Money }[];
	/** Active windows of the jobs this purchase is allocated to. */
	jobWindows?: { job_id: string; start: Date | null; end: Date | null }[];
	has_geo: boolean;
}

/** A cent of slack, so a receipt that rounds its own tax does not raise a flag. */
const TOTAL_TOLERANCE = new Prisma.Decimal("0.01");

/**
 * Deterministic checks, all advisory: they route a dispatcher's attention, never
 * refuse. A tech at a counter with a paid receipt cannot act on a refusal, and geo
 * is WiFi-grade or absent on desktop.
 */
export function evaluateFlags(input: FlagInput): PurchaseFlag[] {
	const flags: PurchaseFlag[] = [];

	const total = toDecimal(input.total);
	const expected = sumDecimal(input.lines.map((l) => l.line_total)).plus(
		toDecimal(input.tax_amount),
	);
	if (total.minus(expected).abs().greaterThan(TOTAL_TOLERANCE)) {
		flags.push({
			code: "total_mismatch",
			message: `Receipt total ${total.toFixed(2)} does not match lines plus tax (${expected.toFixed(2)})`,
		});
	}

	const estimate = input.estimated_amount != null ? toDecimal(input.estimated_amount) : null;
	if (estimate && total.greaterThan(estimate)) {
		flags.push({
			code: "over_estimate",
			message: `Spent ${total.toFixed(2)} against a pre-authorized estimate of ${estimate.toFixed(2)}`,
		});
	}

	const at = input.purchased_at;
	if (at && input.jobWindows?.length) {
		// Any job covering the purchase clears the check: a receipt legitimately
		// serving several jobs only has to fall inside one of their windows.
		const covered = input.jobWindows.some(
			(w) => (!w.start || at >= w.start) && (!w.end || at <= w.end),
		);
		if (!covered) {
			flags.push({
				code: "outside_job_window",
				message: "Purchase time falls outside the active window of every linked job",
			});
		}
	}

	if (!input.has_geo) {
		flags.push({
			code: "geo_missing",
			message: "No capture location recorded (expected on desktop, advisory only)",
		});
	}

	return flags;
}

// ---------------------------------------------------------------------------
// OCR correction rate
// ---------------------------------------------------------------------------

export interface OcrLineSnapshot {
	description: string;
	quantity: Money;
	unit_price: Money;
	line_total: Money;
}

const normDescription = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const sameDescription = (a: OcrLineSnapshot, b: OcrLineSnapshot) =>
	normDescription(a.description) === normDescription(b.description);

const sameAmounts = (a: OcrLineSnapshot, b: OcrLineSnapshot) =>
	toDecimal(a.quantity).equals(toDecimal(b.quantity)) &&
	toDecimal(a.unit_price).equals(toDecimal(b.unit_price)) &&
	toDecimal(a.line_total).equals(toDecimal(b.line_total));

/**
 * How many extracted lines the technician had to touch, counted at submit against
 * the OCR snapshot. Counted rather than flagged per line because editing replaces
 * the whole line set with a payload carrying no ids. An added line and a deleted
 * line each count as one thing the extraction got wrong.
 */
export function countOcrCorrections(
	snapshot: OcrLineSnapshot[],
	final: OcrLineSnapshot[],
): number {
	const unmatched = [...snapshot];
	const take = (line: OcrLineSnapshot, match: (s: OcrLineSnapshot) => boolean) => {
		const idx = unmatched.findIndex(match);
		if (idx === -1) return false;
		unmatched.splice(idx, 1);
		return true;
	};

	// Exact matches claim their snapshot line first, so an untouched line is never
	// consumed by an edited one that happens to share its description.
	const remaining = final.filter(
		(line) => !take(line, (s) => sameDescription(s, line) && sameAmounts(s, line)),
	);

	let corrections = 0;
	for (const line of remaining) {
		// A same-description line with different numbers is one correction, not a
		// delete plus an add.
		take(line, (s) => sameDescription(s, line));
		corrections++;
	}

	return corrections + unmatched.length;
}

// ---------------------------------------------------------------------------
// Duplicate, velocity and split-transaction detection
// ---------------------------------------------------------------------------

/**
 * The receipt is the only proof of the spend, which makes reusing one the primary
 * way to steal here. The image hash catches a byte-identical resubmission; these
 * checks are what is left when the same receipt is re-photographed.
 */

export interface DuplicateCandidate {
	id: string;
	status: string;
	vendor_name: string | null;
	purchased_at: Date | null;
	total: Money;
	technician_name?: string | null;
	receipt_number: string | null;
}

export interface DuplicateSubject {
	vendor_name: string | null;
	purchased_at: Date | null;
	total: Money;
	receipt_number: string | null;
}

export interface DuplicateVerdict {
	/**
	 * `exact` refuses the submit; `near` only flags. Two tiers reach `exact`: a
	 * fuzzy vendor/day/total match against already-*reimbursed* money, or a shared
	 * receipt number against *any* candidate still in `COUNTED_SPEND_STATUSES` -
	 * including one only pending review, not yet settled. The second claim on one
	 * ticket number should not enter the queue at all, and it self-heals if the
	 * prior purchase is rejected.
	 */
	level: "exact" | "near";
	purchase_id: string;
	message: string;
}

/** Nothing looser matches: two receipts a dollar apart are two receipts. */
const NEAR_TOTAL_PERCENT = new Prisma.Decimal("0.02");
const NEAR_TOTAL_FLOOR = new Prisma.Decimal("2.00");
const DAY_MS = 86_400_000;

/** Punctuation and store numbers vary between two prints of the same vendor. */
export function normalizeVendor(name: string | null): string {
	return (name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Formatting varies between a receipt print and whatever someone typed into the app. */
export function normalizePhone(value: string | null): string {
	return (value ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

/** Leading zeros and separators vary between two prints of one ticket. */
export function normalizeReceiptNumber(value: string | null): string {
	return (value ?? "")
		.replace(/[^a-zA-Z0-9]/g, "")
		.replace(/^0+/, "")
		.toLowerCase();
}

/** A store number appended to one print of a receipt should not defeat a vendor match. */
const vendorsNear = (a: string, b: string): boolean =>
	!!a && !!b && (a === b || (a.length >= 4 && (b.includes(a) || a.includes(b))));

const sameUtcDay = (a: Date, b: Date) =>
	a.getUTCFullYear() === b.getUTCFullYear() &&
	a.getUTCMonth() === b.getUTCMonth() &&
	a.getUTCDate() === b.getUTCDate();

/**
 * `exact` needs all three to line up; anything looser is a suspicion for the
 * dispatcher, not a refusal. Two legitimate same-day trips to one supplier happen.
 */
export function findDuplicate(
	subject: DuplicateSubject,
	priors: DuplicateCandidate[],
): DuplicateVerdict | null {
	// A vendor's own ticket number is the one thing on a receipt that is unique by
	// construction, so it outranks the fuzzy tier: a re-photographed receipt keeps its
	// number while its bytes, and sometimes its read date and total, change.
	const subjectNo = normalizeReceiptNumber(subject.receipt_number);
	if (subjectNo) {
		const subjectVendor = normalizeVendor(subject.vendor_name);
		for (const prior of priors) {
			if (
				normalizeReceiptNumber(prior.receipt_number) === subjectNo &&
				vendorsNear(subjectVendor, normalizeVendor(prior.vendor_name))
			) {
				return {
					level: "exact",
					purchase_id: prior.id,
					message: `Receipt ${subject.receipt_number} from this vendor was already submitted`,
				};
			}
		}
	}

	const vendor = normalizeVendor(subject.vendor_name);
	const at = subject.purchased_at;
	const total = toDecimal(subject.total);
	if (!vendor || !at || total.isZero()) return null;

	const nearTotal = Prisma.Decimal.max(total.times(NEAR_TOTAL_PERCENT), NEAR_TOTAL_FLOOR);
	let near: DuplicateVerdict | null = null;

	for (const prior of priors) {
		const priorVendor = normalizeVendor(prior.vendor_name);
		const priorAt = prior.purchased_at;
		if (!priorVendor || !priorAt) continue;

		const vendorExact = priorVendor === vendor;
		if (!vendorsNear(vendor, priorVendor)) continue;

		const dayExact = sameUtcDay(at, priorAt);
		const dayNear = Math.abs(at.getTime() - priorAt.getTime()) <= DAY_MS;
		if (!dayNear) continue;

		const priorTotal = toDecimal(prior.total);
		const totalExact = priorTotal.equals(total);
		const totalNear = totalExact || priorTotal.minus(total).abs().lessThanOrEqualTo(nearTotal);
		if (!totalNear) continue;

		const who = prior.technician_name ? ` by ${prior.technician_name}` : "";
		if (vendorExact && dayExact && totalExact && prior.status === "approved") {
			return {
				level: "exact",
				purchase_id: prior.id,
				message: `A ${total.toFixed(2)} purchase from ${subject.vendor_name} on this date was already reimbursed${who}`,
			};
		}
		near ??= {
			level: "near",
			purchase_id: prior.id,
			message: `Closely matches an existing ${priorTotal.toFixed(2)} purchase from ${prior.vendor_name}${who}`,
		};
	}

	return near;
}

/** Three trips to one counter in a day is the point where it stops being a coincidence. */
export const VELOCITY_COUNT = 3;

export interface VendorDayPurchase {
	id: string;
	total: Money;
}

/**
 * A per-transaction cap is trivially defeated by several sub-limit buys, so the
 * aggregate is the check that matters. Split detection fires only when every
 * purchase stayed under the ceiling on its own: a day that went over in one honest
 * transaction already had its own breach.
 */
export function velocityFlags(
	amount: Money,
	sameVendorSameDay: VendorDayPurchase[],
	perTransactionLimit: Money | null,
	vendorName?: string | null,
): PurchaseFlag[] {
	const flags: PurchaseFlag[] = [];
	const vendor = vendorName ? ` at ${vendorName}` : "";
	const count = sameVendorSameDay.length + 1;

	if (count >= VELOCITY_COUNT) {
		flags.push({ code: "velocity", message: `${count} purchases${vendor} on the same day` });
	}

	const amt = toDecimal(amount);
	const limit = perTransactionLimit != null ? toDecimal(perTransactionLimit) : null;
	if (limit && !limit.isZero() && sameVendorSameDay.length > 0) {
		const aggregate = sumDecimal(sameVendorSameDay.map((p) => p.total)).plus(amt);
		const everyUnderLimit =
			amt.lessThanOrEqualTo(limit) &&
			sameVendorSameDay.every((p) => toDecimal(p.total).lessThanOrEqualTo(limit));
		if (everyUnderLimit && aggregate.greaterThan(limit)) {
			flags.push({
				code: "split_transaction",
				message: `${count} under-limit purchases${vendor} today total ${aggregate.toFixed(2)}, over the ${limit.toFixed(2)} per-purchase limit`,
			});
		}
	}

	return flags;
}
