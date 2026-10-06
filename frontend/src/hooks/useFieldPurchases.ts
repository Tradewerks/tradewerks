import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import { invalidate, qk } from "../lib/queryKeys";
import * as api from "../api/fieldPurchases";
import type {
	CreatePurchaseInput,
	FieldPurchasePage,
	ListPurchasesParams,
	ReceiptCapture,
	SubmitSheetInput,
	UpsertGrantInput,
} from "../api/fieldPurchases";
import type {
	FieldPurchase,
	FieldPurchaseDetail,
	FieldPurchaseCaptureLocation,
	FieldPurchaseExtraction,
	FieldPurchaseGrant,
	FieldPurchaseSummary,
	LimitBreach,
	LimitCheckResult,
	MyFieldPurchaseAuthority,
	SubmitResult,
} from "../types/fieldPurchases";

const useQuery = moduleQuery("field_purchases");

// ── Grants ───────────────────────────────────────────────────────────────────

export const useFieldPurchaseGrants = (
	enabled = true
): UseQueryResult<FieldPurchaseGrant[], Error> =>
	useQuery({
		queryKey: qk.fieldPurchases.grants,
		queryFn: api.getGrants,
		enabled,
	});

export const useUpsertFieldPurchaseGrant = (): UseMutationResult<
	FieldPurchaseGrant,
	Error,
	UpsertGrantInput
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.upsertGrant,
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.fieldPurchases.all }),
	});
};

export const useRevokeFieldPurchaseGrant = (): UseMutationResult<
	FieldPurchaseGrant,
	Error,
	{ id: string; reason?: string | null }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, reason }) => api.revokeGrant(id, reason),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.fieldPurchases.all }),
	});
};

// ── Technician pre-flight ────────────────────────────────────────────────────

export const useMyPurchaseAuthority = (
	enabled = true
): UseQueryResult<MyFieldPurchaseAuthority, Error> =>
	useQuery({
		queryKey: qk.fieldPurchases.myGrant,
		queryFn: api.getMyAuthority,
		enabled,
	});

/**
 * Asked as the technician types an amount, so `enabled` gates on a real number:
 * a zero-amount check would answer a question nobody asked.
 */
export const usePurchaseLimitCheck = (
	amount: number,
	jobs?: JobShare[],
	enabled = true
): UseQueryResult<LimitCheckResult, Error> =>
	useQuery({
		queryKey: qk.fieldPurchases.limitCheck({ amount, jobs }),
		queryFn: () => api.checkLimit(amount, jobs),
		enabled: enabled && amount > 0,
		staleTime: 30_000,
	});

/** Long enough that an amount is typed rather than asked digit by digit. */
const LIMIT_CHECK_DEBOUNCE_MS = 400;

/**
 * The ceilings crossed by the amount CURRENTLY on screen, or undefined while it is
 * still being typed. Both callers have to refuse a verdict fetched for an earlier
 * amount: a stale one flips the submit button into "send for pre-approval" against
 * a total the server never saw.
 */
export function usePurchaseLimitBreaches(
	amount: number,
	jobId?: string,
	enabled = true
): LimitBreach[] | undefined {
	const [settled, setSettled] = useState(0);
	useEffect(() => {
		const t = setTimeout(() => setSettled(amount), LIMIT_CHECK_DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [amount]);

	// A pre-authorization names one job and has no lines to split, so its share is
	// the whole ask.
	const jobs = useMemo(
		() => (jobId ? [{ job_id: jobId, amount: settled }] : undefined),
		[jobId, settled]
	);
	const { data } = usePurchaseLimitCheck(settled, jobs, enabled);
	return settled === amount ? data?.verdict.breaches : undefined;
}

/** One job's share of a receipt, as the limit check needs to see it. */
export interface JobShare {
	job_id: string;
	amount: number;
}

export interface PurchaseLimitGate {
	/**
	 * Every ceiling crossed by the amount currently on screen — and only ever a
	 * verdict the server gave for *that* amount. Empty while one is in flight,
	 * because `describeBreach` does arithmetic against the amount it is handed: a
	 * held-over breach rendered "Come down $350" beside a field reading $50.
	 */
	breaches: LimitBreach[];
	/**
	 * The verdict for the amount on screen is not known, and what is known does
	 * not rule a breach out. The caller must offer the cautious path — never the
	 * submit — and should say it is still checking rather than imply it is clear.
	 */
	assumeBreach: boolean;
}

const NO_BREACHES: PurchaseLimitGate = { breaches: [], assumeBreach: false };

/** What a held answer was given for: the whole receipt, and every job's share. */
const probeKey = (total: number, jobs: JobShare[]) =>
	`${total}|${jobs.map((j) => `${j.amount}@${j.job_id}`).join(",")}`;

/**
 * Which button the trip ends on, and whether that answer is known or assumed.
 *
 * `usePurchaseLimitBreaches` blanks for the whole debounce window - fine for
 * drawing a notice, wrong for picking a primary action: the bar offered "Submit
 * for review" while a technician typed a total that crossed a ceiling. So the
 * in-flight window is answered, always in the cautious direction.
 *
 * Ceilings rise monotonically, so a probe at or below a figure the server already
 * cleared cannot breach; anything else assumes one. Compared per probe rather than
 * on the total, because a split can move a share up while the total goes down.
 */
export function usePurchaseLimitGate({
	scopeKey,
	total,
	allocations,
	enabled = true,
}: {
	/**
	 * What the held answers belong to — the purchase id. A cleared figure is a
	 * statement about one technician's spend windows on one record, and this hook
	 * outlives the record: the route param changes without remounting the sheet,
	 * so without this a figure cleared on the previous purchase would vouch for an
	 * amount nobody has checked against the spend that purchase itself added.
	 */
	scopeKey: string;
	total: number;
	allocations: JobShare[];
	enabled?: boolean;
}): PurchaseLimitGate {
	// The whole receipt against the windowed ceilings and every job's share against
	// `per_job`, in one verdict. Asked a job at a time this cost a request per
	// allocation, and each one answered the windowed ceilings on the wrong figure.
	const jobs = allocations.filter((a) => a.amount > 0);
	const wanted = probeKey(total, jobs);

	const [settled, setSettled] = useState<{ total: number; jobs: JobShare[] } | null>(null);
	useEffect(() => {
		const t = setTimeout(() => setSettled({ total, jobs }), LIMIT_CHECK_DEBOUNCE_MS);
		return () => clearTimeout(t);
		// `jobs` is rebuilt every render; the string is what actually changed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [wanted]);

	const { data } = useQuery({
		queryKey: qk.fieldPurchases.limitCheck({
			amount: settled?.total ?? 0,
			jobs: settled?.jobs,
			purchaseId: scopeKey,
		}),
		queryFn: () => api.checkLimit(settled!.total, settled!.jobs, scopeKey),
		enabled: enabled && !!settled && settled.total > 0,
		staleTime: 30_000,
	});

	const answered = !!settled && probeKey(settled.total, settled.jobs) === wanted && !!data;
	const verdict: LimitBreach[] | null = answered ? data.verdict.breaches : null;

	// The largest figure per job the server has answered *clear* for. Only the
	// clear ones are worth holding: a remembered breach cannot be redrawn against
	// a different amount, and "assume a breach" already covers that case.
	const cleared = useRef<Map<string, number>>(new Map());
	// Dropped during render, not in an effect: the reset has to be visible to the
	// `withinCleared` test below on this very render, or the first render after the
	// route param changes answers the new purchase out of the old one's cache.
	const scope = useRef(scopeKey);
	if (scope.current !== scopeKey) {
		scope.current = scopeKey;
		cleared.current = new Map();
	}
	const clearedKey =
		verdict?.length === 0 && settled
			? `${scopeKey}|${probeKey(settled.total, settled.jobs)}`
			: null;
	useEffect(() => {
		if (!clearedKey || !settled) return;
		const hold = (key: string, amount: number) =>
			cleared.current.set(key, Math.max(cleared.current.get(key) ?? 0, amount));
		// The whole receipt under its own key, so a job that has never been asked
		// about cannot vouch for the total.
		hold("", settled.total);
		for (const j of settled.jobs) hold(j.job_id, j.amount);
		// `settled` is what `clearedKey` is derived from, so the string covers it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [clearedKey]);

	if (!enabled || total <= 0) return NO_BREACHES;
	if (verdict) return { breaches: verdict, assumeBreach: false };
	// Below a cleared figure on every probe, including the whole-receipt one — a
	// job the server has never been asked about has no ceiling to compare against.
	const withinCleared =
		total <= (cleared.current.get("") ?? -1) &&
		jobs.every((j) => j.amount <= (cleared.current.get(j.job_id) ?? -1));
	return { breaches: [], assumeBreach: !withinCleared };
}

/** A reviewer moving one line to another of the receipt's jobs. */
export const useAssignLineJob = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ id: string; lineId: string; jobId: string }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, lineId, jobId }) => api.assignLineJob(id, lineId, jobId),
		onSuccess: (_p, { id }) => {
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.detail(id) });
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
			// The charge left one visit and landed on another, so both invoices moved.
			qc.invalidateQueries({ queryKey: ["jobVisits"] });
		},
	});
};

/** A dispatcher linking (or correcting) the supplier on a purchase, at any status. */
export const useLinkSupplier = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ id: string; supplierId: string }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, supplierId }) => api.linkSupplier(id, supplierId),
		onSuccess: (_p, { id }) => {
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.detail(id) });
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
		},
	});
};

// ── Purchases ────────────────────────────────────────────────────────────────

const listKey = (params: ListPurchasesParams) =>
	qk.fieldPurchases.list({
		status: params.status ?? "all",
		technicianId: params.technician_id,
		jobId: params.job_id,
		flagged: params.flagged,
		kind: params.kind,
		search: params.search,
		dateFrom: params.date_from,
		dateTo: params.date_to,
		sort: params.sort,
		offset: params.offset,
		limit: params.limit,
	});

/**
 * The rows only. Callers that never paginate — the technician's own list — do
 * not want to unwrap a page envelope to get at them.
 */
export const useFieldPurchases = (
	params: ListPurchasesParams = {},
	enabled = true
): UseQueryResult<FieldPurchase[], Error> =>
	useQuery({
		queryKey: listKey(params),
		queryFn: () => api.getPurchases(params),
		select: (page) => page.items,
		enabled,
	});

/** Same request, page envelope kept: the dispatcher's queue has to admit truncation. */
export const useFieldPurchaseQueue = (
	params: ListPurchasesParams = {},
	enabled = true
): UseQueryResult<FieldPurchasePage, Error> =>
	useQuery({
		queryKey: listKey(params),
		queryFn: () => api.getPurchases(params),
		enabled,
	});

export const useFieldPurchaseSummary = (
	enabled = true
): UseQueryResult<FieldPurchaseSummary, Error> =>
	useQuery({
		queryKey: qk.fieldPurchases.summary,
		queryFn: api.getPurchasesSummary,
		enabled,
		staleTime: 30_000,
	});

/**
 * Polls while an extraction is in flight. OCR runs off the request that uploaded
 * the receipt, so nothing else would tell the technician it finished.
 */
export const useFieldPurchase = (
	id: string | undefined
): UseQueryResult<FieldPurchaseDetail, Error> =>
	useQuery({
		queryKey: qk.fieldPurchases.detail(id ?? ""),
		queryFn: () => api.getPurchase(id!),
		enabled: !!id,
		refetchInterval: (query) =>
			query.state.data?.purchase.ocr_status === "pending" ? 3000 : false,
	});

/**
 * What the receipt read, for the sheet that has to offer it. Only worth asking for
 * once there is a receipt: with no provider configured every upload is stamped
 * `skipped` and there is nothing on the other end.
 */
export const usePurchaseExtraction = (
	id: string | undefined,
	enabled: boolean
): UseQueryResult<FieldPurchaseExtraction, Error> =>
	useQuery({
		queryKey: qk.fieldPurchases.extraction(id ?? ""),
		queryFn: () => api.getExtraction(id!),
		enabled: !!id && enabled,
	});

/**
 * Only on demand, and only for a holder of `view_field_purchase_location`: the
 * coordinates are sensitive personal information, so nothing fetches them until a
 * reviewer asks. `staleTime: Infinity` because a captured position never changes.
 */
export const useCaptureLocation = (
	id: string | undefined,
	enabled: boolean
): UseQueryResult<FieldPurchaseCaptureLocation, Error> =>
	useQuery({
		queryKey: qk.fieldPurchases.captureLocation(id ?? ""),
		queryFn: () => api.getCaptureLocation(id!),
		enabled: !!id && enabled,
		staleTime: Infinity,
	});

export const useCreateFieldPurchase = (): UseMutationResult<
	FieldPurchase,
	Error,
	CreatePurchaseInput
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createPurchase,
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.fieldPurchases.all }),
	});
};

export const useDeleteFieldPurchase = (): UseMutationResult<void, Error, string> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deletePurchase,
		onSuccess: (_data, id) => {
			// Dropped from the cache rather than invalidated: the row is gone, so
			// invalidating its own detail query would refetch a 404 and retry for
			// several seconds — on the very page still showing it — before the
			// discard could finish.
			qc.removeQueries({ queryKey: qk.fieldPurchases.detail(id) });
			void qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
		},
	});
};

export const useUploadReceipt = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ id: string; capture: ReceiptCapture }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, capture }) => api.uploadReceipt(id, capture),
		onSuccess: (_r, { id }) => qc.invalidateQueries({ queryKey: qk.fieldPurchases.detail(id) }),
	});
};

export const useRetryOcr = (): UseMutationResult<void, Error, string> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.retryOcr,
		onSuccess: (_r, id) => qc.invalidateQueries({ queryKey: qk.fieldPurchases.detail(id) }),
	});
};

export const useRequestPreauth = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ id: string; estimatedAmount: number; reason?: string | null; sheet?: SubmitSheetInput }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, estimatedAmount, reason, sheet }) =>
			api.requestPreauth(id, estimatedAmount, reason, sheet),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.fieldPurchases.all }),
	});
};

export const useDecidePreauth = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ id: string; approve: boolean; note?: string | null }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, approve, note }) => api.decidePreauth(id, approve, note),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.fieldPurchases.all }),
	});
};

/**
 * Submitting carries the sheet. The technician presses one button, not three, so
 * a receipt cannot be left half-saved when a phone loses signal mid-flow.
 */
export const useSubmitFieldPurchase = (): UseMutationResult<
	SubmitResult,
	Error,
	{ id: string; sheet?: SubmitSheetInput }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, sheet }) => api.submitPurchase(id, sheet),
		// The billable line lands on a visit, so that visit's totals moved too — and
		// the sheet carries the lines, so the same submit can mint provisional items.
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
			await qc.invalidateQueries({ queryKey: ["jobVisits"] });
			await qc.invalidateQueries({ queryKey: qk.inventory.provisional });
			await qc.invalidateQueries({ queryKey: qk.inventory.reconcile() });
		},
	});
};

/** For a technician who can reach the flow but has no ceiling to spend under. */
export const useRequestGrant = (): UseMutationResult<void, Error, void> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.requestGrant,
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.fieldPurchases.myGrant }),
	});
};

export const useSecondSignoff = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ id: string; approve: boolean; note?: string | null }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, approve, note }) => api.secondSignoff(id, approve, note),
		onSuccess: (_r, { approve }) => {
			void qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
			// The stock effect was held back for this signature, so it lands now.
			if (approve) invalidate.warehouse(qc);
			// Refusing takes the charge back off the visit it was raised on.
			else void qc.invalidateQueries({ queryKey: ["jobVisits"] });
		},
	});
};

export const useCreateRefund = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ parentPurchaseId: string; reason?: string | null }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ parentPurchaseId, reason }) => api.createRefund(parentPurchaseId, reason),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.fieldPurchases.all }),
	});
};

export const useSettleRefund = (): UseMutationResult<FieldPurchase, Error, string> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.settleRefund,
		onSuccess: (_r, id) => {
			void qc.invalidateQueries({ queryKey: qk.fieldPurchases.detail(id) });
			void qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
		},
	});
};

export const useReviewFieldPurchase = (): UseMutationResult<
	FieldPurchase,
	Error,
	{ id: string; decision: "approve" | "query" | "reject"; note?: string | null }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, decision, note }) => api.reviewPurchase(id, decision, note),
		onSuccess: (_r, { decision }) => {
			qc.invalidateQueries({ queryKey: qk.fieldPurchases.all });
			// Approving a `receive` line writes stock, so the warehouse, vehicle
			// stock and vendor price list all move with it.
			if (decision === "approve") invalidate.warehouse(qc);
			// Rejecting means the customer is not charged either, so the visit the
			// charge was raised on loses it.
			if (decision === "reject") qc.invalidateQueries({ queryKey: ["jobVisits"] });
		},
	});
};
