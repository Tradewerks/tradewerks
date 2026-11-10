import { getScopedDb } from "../lib/context.js";
import type { CreateInvoicePayload } from "./invoiceService.js";

type LineItemType = "labor" | "material" | "equipment" | "other" | null;

export interface OverlapWarning {
	visit_id: string;
	scheduled_start_at: string;
	existing_invoices: Array<{
		invoice_id: string;
		invoice_number: string;
		status: string;
		billed_amount: number | null;
	}>;
}

export interface VisitInvoiceResult {
	payload: CreateInvoicePayload;
	warnings: OverlapWarning[];
	emptyVisitIds: string[];
}

export interface RecurringInvoiceResult {
	payload: CreateInvoicePayload;
	warnings: OverlapWarning[];
}

export async function buildVisitInvoicePayload(
	visitIds: string[],
	sdb: ReturnType<typeof getScopedDb>,
): Promise<VisitInvoiceResult> {
	if (visitIds.length === 0) {
		throw new Error("At least one visit_id required");
	}

	// Fetch visits with line items and job context
	const visits = await sdb.job_visit.findMany({
		where: { id: { in: visitIds } },
		include: {
			line_items: { orderBy: { sort_order: "asc" } },
			job: { select: { id: true, client_id: true } },
		},
	});

	if (visits.length === 0) {
		throw new Error("No visits found for provided IDs");
	}

	// All visits must belong to same client
	const clientIds = new Set(visits.map((v) => v.job.client_id));
	if (clientIds.size > 1) {
		throw new Error("All visits must belong to the same client");
	}
	const clientId = [...clientIds][0];

	// Overlap check — visits already on active (non-Draft, non-Void) invoices
	const activeInvoiceVisits = await sdb.invoice_visit.findMany({
		where: {
			visit_id: { in: visitIds },
			invoice: { status: { notIn: ["Draft", "Void"] } },
		},
		include: {
			invoice: {
				select: {
					id: true,
					invoice_number: true,
					status: true,
				},
			},
		},
	});

	const warningMap = new Map<string, OverlapWarning>();
	for (const iv of activeInvoiceVisits) {
		const visit = visits.find((v) => v.id === iv.visit_id);
		if (!visit) continue;
		if (!warningMap.has(iv.visit_id)) {
			warningMap.set(iv.visit_id, {
				visit_id: iv.visit_id,
				scheduled_start_at: visit.scheduled_start_at.toISOString(),
				existing_invoices: [],
			});
		}
		warningMap.get(iv.visit_id)!.existing_invoices.push({
			invoice_id: iv.invoice.id,
			invoice_number: iv.invoice.invoice_number,
			status: iv.invoice.status,
			billed_amount: iv.billed_amount != null ? Number(iv.billed_amount) : null,
		});
	}

	const emptyVisitIds: string[] = [];
	const lineItems: NonNullable<CreateInvoicePayload["line_items"]> = [];
	const visitBillings: NonNullable<CreateInvoicePayload["visit_billings"]> = [];
	const jobIdSet = new Set<string>();

	for (const visit of visits) {
		if (visit.line_items.length === 0) {
			emptyVisitIds.push(visit.id);
		}
		for (const li of visit.line_items) {
			lineItems.push({
				name: li.name,
				description: li.description ?? null,
				quantity: Number(li.quantity),
				unit_price: Number(li.unit_price),
				total: Number(li.total),
				item_type: li.item_type as LineItemType,
				sort_order: li.sort_order,
				source_visit_id: visit.id,
				source_job_id: visit.job.id,
			});
		}
		const visitTotal = visit.line_items.reduce(
			(sum, li) => sum + Number(li.total),
			0,
		);
		visitBillings.push({ visit_id: visit.id, billed_amount: visitTotal });
		jobIdSet.add(visit.job.id);
	}

	const subtotal = lineItems.reduce((sum, li) => sum + (li.total ?? 0), 0);

	return {
		payload: {
			client_id: clientId,
			line_items: lineItems,
			visit_billings: visitBillings,
			job_ids: [...jobIdSet],
			subtotal,
		},
		warnings: [...warningMap.values()],
		emptyVisitIds,
	};
}

export async function buildRecurringPlanInvoicePayload(
	planId: string,
	sdb: ReturnType<typeof getScopedDb>,
	scopeOverride?: { last_invoiced_at: Date | null },
): Promise<RecurringInvoiceResult> {
	// Fetch plan with schedule, line items, and job container (for job id)
	const plan = await sdb.recurring_plan.findFirst({
		where: { id: planId },
		include: {
			invoice_schedule: true,
			line_items: { orderBy: { sort_order: "asc" } },
			job_container: { select: { id: true } },
		},
	});

	if (!plan) {
		throw new Error("Recurring plan not found");
	}

	const schedule = plan.invoice_schedule;
	if (!schedule) {
		throw new Error("Recurring plan has no invoice schedule");
	}

	const clientId = plan.client_id;
	const basis = schedule.billing_basis;
	// When the caller has already read the schedule (e.g., for a CAS guard), use
	// that snapshot for visit scoping so both reads see the same last_invoiced_at.
	const scopedLastInvoicedAt = scopeOverride !== undefined
		? scopeOverride.last_invoiced_at
		: schedule.last_invoiced_at;

	const lineItems: NonNullable<CreateInvoicePayload["line_items"]> = [];
	const visitBillings: NonNullable<CreateInvoicePayload["visit_billings"]> = [];
	const warnings: OverlapWarning[] = [];

	if (basis === "fixed_amount") {
		if (!schedule.fixed_amount || Number(schedule.fixed_amount) === 0) {
			throw new Error("fixed_amount billing requires a non-zero fixed_amount on the schedule");
		}
		lineItems.push({
			name: schedule.memo_template ?? plan.name ?? "Service",
			description: null,
			quantity: 1,
			unit_price: Number(schedule.fixed_amount),
			total: Number(schedule.fixed_amount),
			item_type: null,
			sort_order: 0,
		});
	} else if (basis === "plan_line_items") {
		for (const li of plan.line_items) {
			const total = Number(li.quantity) * Number(li.unit_price);
			lineItems.push({
				name: li.name,
				description: li.description ?? null,
				quantity: Number(li.quantity),
				unit_price: Number(li.unit_price),
				total,
				item_type: li.item_type as LineItemType,
				sort_order: li.sort_order,
				taxable: li.taxable,
				tax_group_id: li.tax_group_id,
			});
		}
	} else if (basis === "visit_actuals") {
		if (!plan.job_container) {
			throw new Error("Recurring plan has no job container — cannot fetch visit actuals");
		}
		const jobId = plan.job_container.id;

		// Find completed visits via recurring_occurrence → job_visit
		// Scoped to occurrences for this plan whose linked visit is Completed
		// and whose visit completed after last_invoiced_at (or all-time if null)
		const occurrences = await sdb.recurring_occurrence.findMany({
			where: {
				recurring_plan_id: planId,
				job_visit: {
					status: "Completed",
					...(scopedLastInvoicedAt != null
						? {
							OR: [
								{ actual_end_at: { gt: scopedLastInvoicedAt } },
								{
									actual_end_at: null,
									scheduled_start_at: { gt: scopedLastInvoicedAt },
								},
								{
									actual_end_at: null,
									status: "Completed",
									updated_at: { gt: scopedLastInvoicedAt },
								},
							],
						  }
						: {}),
				},
			},
			include: {
				job_visit: {
					include: {
						line_items: { orderBy: { sort_order: "asc" } },
					},
				},
			},
		});

		// Collect the actual visit objects (occurrences with a linked visit)
		const completedVisits = occurrences
			.map((o) => o.job_visit)
			.filter((v): v is NonNullable<typeof v> => v !== null);

		const completedVisitIds = completedVisits.map((v) => v.id);

		// Overlap check — same pattern as buildVisitInvoicePayload
		if (completedVisitIds.length > 0) {
			const activeInvoiceVisits = await sdb.invoice_visit.findMany({
				where: {
					visit_id: { in: completedVisitIds },
					invoice: { status: { notIn: ["Draft", "Void"] } },
				},
				include: {
					invoice: {
						select: {
							id: true,
							invoice_number: true,
							status: true,
						},
					},
				},
			});

			const warningMap = new Map<string, OverlapWarning>();
			for (const iv of activeInvoiceVisits) {
				const visit = completedVisits.find((v) => v.id === iv.visit_id);
				if (!visit) continue;
				if (!warningMap.has(iv.visit_id)) {
					warningMap.set(iv.visit_id, {
						visit_id: iv.visit_id,
						scheduled_start_at: visit.scheduled_start_at.toISOString(),
						existing_invoices: [],
					});
				}
				warningMap.get(iv.visit_id)!.existing_invoices.push({
					invoice_id: iv.invoice.id,
					invoice_number: iv.invoice.invoice_number,
					status: iv.invoice.status,
					billed_amount: iv.billed_amount != null ? Number(iv.billed_amount) : null,
				});
			}
			warnings.push(...warningMap.values());
		}

		// Build line items from visit actuals
		for (const visit of completedVisits) {
			for (const li of visit.line_items) {
				lineItems.push({
					name: li.name,
					description: li.description ?? null,
					quantity: Number(li.quantity),
					unit_price: Number(li.unit_price),
					total: Number(li.total),
					item_type: li.item_type as LineItemType,
					sort_order: li.sort_order,
					taxable: li.taxable,
					tax_group_id: li.tax_group_id,
					source_visit_id: visit.id,
					source_job_id: jobId,
				});
			}
			const visitTotal = visit.line_items.reduce((sum, li) => sum + Number(li.total), 0);
			visitBillings.push({ visit_id: visit.id, billed_amount: visitTotal });
		}
	} else {
		throw new Error(`Unsupported billing_basis: ${basis}`);
	}

	const subtotal = lineItems.reduce((sum, li) => sum + (li.total ?? 0), 0);

	const payload: CreateInvoicePayload = {
		client_id: clientId,
		recurring_plan_id: plan.id,
		line_items: lineItems,
		memo: schedule.memo_template ?? null,
		subtotal,
		...(schedule.payment_terms_days != null
			? { payment_terms_days: schedule.payment_terms_days }
			: {}),
		...(basis === "visit_actuals" && visitBillings.length > 0
			? {
				visit_billings: visitBillings,
				job_ids: plan.job_container ? [plan.job_container.id] : [],
			  }
			: {}),
	};

	return { payload, warnings };
}
