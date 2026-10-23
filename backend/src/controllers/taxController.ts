import { ZodError } from "zod";
import {
	createTaxRateSchema,
	updateTaxRateSchema,
	createTaxGroupSchema,
	updateTaxGroupSchema,
} from "../lib/validate/tax.js";
import { getScopedDb } from "../lib/context.js";
import { log } from "../services/appLogger.js";
import { computeCombinedRate } from "../services/taxEngine.js";
import type { Prisma } from "../../generated/prisma/client.js";

// ---------------------------------------------------------------------------
// Discriminated result type — no string-parsing in routes
// ---------------------------------------------------------------------------

export type TaxOkResult<T> = { ok: true; item: T };
export type TaxErrResult = {
	ok: false;
	code: "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "INTERNAL" | "NOT_IN_PLAN";
	message: string;
};
export type TaxResult<T> = TaxOkResult<T> | TaxErrResult;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function taxErr(
	code: TaxErrResult["code"],
	message: string,
): TaxErrResult {
	return { ok: false, code, message };
}

function handleTaxError(e: unknown, context: string): TaxErrResult {
	if (e instanceof ZodError)
		return taxErr("VALIDATION", `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`);
	if (e instanceof Error) return taxErr("INTERNAL", e.message);
	log.error({ err: e }, context);
	return taxErr("INTERNAL", "Internal server error");
}

/** Unset all existing defaults for a model within the transaction. */
async function clearDefaults(
	tx: Prisma.TransactionClient,
	model: "tax_rate" | "tax_group",
): Promise<void> {
	// Indexed access on the model-name union leaves updateMany's overloads
	// mutually incompatible to TS — pick either arm's shape, both accept this call.
	await (tx[model] as Prisma.TransactionClient["tax_rate"]).updateMany({
		where: { is_default: true },
		data: { is_default: false },
	});
}

/** Cast a `$transaction` callback's `tx` to `Prisma.TransactionClient` for `clearDefaults`. */
const asTx = (tx: unknown) => tx as unknown as Prisma.TransactionClient;

// ============================================================================
// TAX RATES
// ============================================================================

export const getTaxRates = async (organizationId: string, includeInactive = false) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.tax_rate.findMany({
		where: includeInactive ? {} : { is_active: true },
		orderBy: [{ is_default: "desc" }, { name: "asc" }],
	});
};

export const createTaxRate = async (
	data: unknown,
	organizationId: string,
): Promise<TaxResult<Awaited<ReturnType<ReturnType<typeof getScopedDb>["tax_rate"]["create"]>>>> => {
	try {
		const parsed = createTaxRateSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const created = await sdb.$transaction(async (tx) => {
			if (parsed.is_default) await clearDefaults(asTx(tx), "tax_rate");
			return tx.tax_rate.create({
				data: {
					organization_id: organizationId,
					name: parsed.name,
					rate: parsed.rate,
					description: parsed.description ?? null,
					jurisdiction: parsed.jurisdiction ?? null,
					is_default: parsed.is_default,
				},
			});
		});

		return { ok: true, item: created };
	} catch (e) {
		return handleTaxError(e, "Create tax rate error");
	}
};

export const updateTaxRate = async (id: string, data: unknown, organizationId: string) => {
	try {
		const parsed = updateTaxRateSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const updated = await sdb.$transaction(async (tx) => {
			const existing = await tx.tax_rate.findFirst({ where: { id } });
			if (!existing) throw Object.assign(new Error("Tax rate not found"), { code: "NOT_FOUND" });

			if (parsed.is_default === true) await clearDefaults(asTx(tx), "tax_rate");

			return tx.tax_rate.update({
				where: { id },
				data: {
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.rate !== undefined && { rate: parsed.rate }),
					...(parsed.description !== undefined && { description: parsed.description }),
					...(parsed.jurisdiction !== undefined && { jurisdiction: parsed.jurisdiction }),
					...(parsed.is_default !== undefined && { is_default: parsed.is_default }),
					...(parsed.is_active !== undefined && { is_active: parsed.is_active }),
				},
			});
		});

		return { ok: true as const, item: updated };
	} catch (e) {
		if (e instanceof Error && (e as NodeJS.ErrnoException).code === "NOT_FOUND")
			return taxErr("NOT_FOUND", e.message);
		return handleTaxError(e, "Update tax rate error");
	}
};

export const deleteTaxRate = async (id: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);

		return await sdb.$transaction(async (tx) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const ttx = tx as any;

			const existing = await ttx.tax_rate.findFirst({ where: { id } });
			if (!existing) return taxErr("NOT_FOUND", "Tax rate not found");

			const groupCount = await ttx.tax_group_rate.count({
				where: { tax_rate_id: id },
			});
			if (groupCount > 0) {
				return taxErr("CONFLICT", "Tax rate is used in one or more tax groups and cannot be deleted");
			}

			await ttx.tax_rate.update({
				where: { id },
				data: { is_active: false },
			});

			return { ok: true as const, item: { id } };
		});
	} catch (e) {
		return handleTaxError(e, "Delete tax rate error");
	}
};

// ============================================================================
// TAX GROUPS
// ============================================================================

const taxGroupInclude = {
	rates: {
		include: {
			tax_rate: true,
		},
		orderBy: { sort_order: "asc" as const },
	},
};

export const getTaxGroups = async (organizationId: string, includeInactive = false) => {
	const sdb = getScopedDb(organizationId);
	const groups = await sdb.tax_group.findMany({
		where: includeInactive ? {} : { is_active: true },
		include: taxGroupInclude,
		orderBy: [{ is_default: "desc" }, { name: "asc" }],
	});

	return groups.map((g) => ({
		...g,
		combined_rate: computeCombinedRate(g.rates),
	}));
};

export const getDefaultTaxGroup = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const group = await sdb.tax_group.findFirst({
		where: { is_default: true, is_active: true },
		include: taxGroupInclude,
	});

	if (!group) return null;

	return {
		...group,
		combined_rate: computeCombinedRate(group.rates),
	};
};

export const createTaxGroup = async (data: unknown, organizationId: string) => {
	try {
		const parsed = createTaxGroupSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const created = await sdb.$transaction(async (tx) => {
			if (parsed.is_default) await clearDefaults(asTx(tx), "tax_group");

			if (parsed.rate_ids.length > 0) {
				const foundRates = await tx.tax_rate.findMany({
					where: { id: { in: parsed.rate_ids }, is_active: true },
					select: { id: true },
				});
				if (foundRates.length !== parsed.rate_ids.length) {
					throw new Error("One or more tax rate IDs are invalid or inactive");
				}
			}

			return tx.tax_group.create({
				data: {
					organization_id: organizationId,
					name: parsed.name,
					description: parsed.description ?? null,
					is_default: parsed.is_default,
					rates:
						parsed.rate_ids.length > 0
							? {
									create: parsed.rate_ids.map((rateId, index) => ({
										tax_rate_id: rateId,
										sort_order: index,
									})),
								}
							: undefined,
				},
				include: taxGroupInclude,
			});
		});

		return {
			ok: true as const,
			item: { ...created, combined_rate: computeCombinedRate(created.rates) },
		};
	} catch (e) {
		return handleTaxError(e, "Create tax group error");
	}
};

export const updateTaxGroup = async (id: string, data: unknown, organizationId: string) => {
	try {
		const parsed = updateTaxGroupSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const updated = await sdb.$transaction(async (tx) => {
			const existing = await tx.tax_group.findFirst({ where: { id } });
			if (!existing) throw Object.assign(new Error("Tax group not found"), { code: "NOT_FOUND" });

			if (parsed.is_default === true) await clearDefaults(asTx(tx), "tax_group");

			if (parsed.rate_ids !== undefined && parsed.rate_ids.length > 0) {
				const foundRates = await tx.tax_rate.findMany({
					where: { id: { in: parsed.rate_ids }, is_active: true },
					select: { id: true },
				});
				if (foundRates.length !== parsed.rate_ids.length) {
					throw new Error("One or more tax rate IDs are invalid or inactive");
				}
			}

			if (parsed.rate_ids !== undefined) {
				await tx.tax_group_rate.deleteMany({ where: { tax_group_id: id } });
				if (parsed.rate_ids.length > 0) {
					await tx.tax_group_rate.createMany({
						data: parsed.rate_ids.map((rateId, index) => ({
							tax_group_id: id,
							tax_rate_id: rateId,
							sort_order: index,
						})),
						skipDuplicates: true,
					});
				}
			}

			return tx.tax_group.update({
				where: { id },
				data: {
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.description !== undefined && { description: parsed.description }),
					...(parsed.is_default !== undefined && { is_default: parsed.is_default }),
					...(parsed.is_active !== undefined && { is_active: parsed.is_active }),
				},
				include: taxGroupInclude,
			});
		});

		return {
			ok: true as const,
			item: { ...updated, combined_rate: computeCombinedRate(updated.rates) },
		};
	} catch (e) {
		if (e instanceof Error && (e as NodeJS.ErrnoException).code === "NOT_FOUND")
			return taxErr("NOT_FOUND", e.message);
		return handleTaxError(e, "Update tax group error");
	}
};

export const deleteTaxGroup = async (id: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);

		return await sdb.$transaction(async (tx) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const ttx = tx as any;

			const existing = await ttx.tax_group.findFirst({ where: { id } });
			if (!existing) return taxErr("NOT_FOUND", "Tax group not found");

			// Check all active references in parallel — inside the transaction so
			// concurrent deletes or new references are serialised.
			const [clientCount, quoteItemCount, invoiceItemCount, recurringItemCount] =
				await Promise.all([
					ttx.client.count({ where: { tax_group_id: id } }),
					ttx.quote_line_item.count({
						where: {
							tax_group_id: id,
							quote: { status: { in: ["Draft", "Issued", "Sent", "Viewed"] } },
						},
					}),
					ttx.invoice_line_item.count({
						where: {
							tax_group_id: id,
							invoice: { status: { in: ["Draft", "Issued", "Sent", "Viewed"] } },
						},
					}),
					ttx.recurring_plan_line_item.count({ where: { tax_group_id: id } }),
				]);

			const totalRefs = clientCount + quoteItemCount + invoiceItemCount + recurringItemCount;
			if (totalRefs > 0) {
				const parts: string[] = [];
				if (clientCount > 0) parts.push(`${clientCount} client(s)`);
				if (quoteItemCount > 0) parts.push(`${quoteItemCount} quote line item(s)`);
				if (invoiceItemCount > 0) parts.push(`${invoiceItemCount} invoice line item(s)`);
				if (recurringItemCount > 0) parts.push(`${recurringItemCount} recurring plan line item(s)`);
				return taxErr(
					"CONFLICT",
					`Tax group is referenced by ${parts.join(", ")} and cannot be deleted. Deactivate it instead.`,
				);
			}

			await ttx.tax_group.update({
				where: { id },
				data: { is_active: false },
			});

			return { ok: true as const, item: { id } };
		});
	} catch (e) {
		return handleTaxError(e, "Delete tax group error");
	}
};
