import { Prisma } from "../../generated/prisma/client.js";
import {
	mapPrismaTaxGroup,
	dollarsToCents,
	type LineItemTaxInput,
	type TaxGroupConfig,
} from "../services/taxEngine.js";

export const TAX_GROUP_WITH_RATES_INCLUDE = {
	rates: {
		orderBy: { sort_order: "asc" as const },
		include: {
			tax_rate: {
				select: { id: true, name: true, rate: true, jurisdiction: true },
			},
		},
	},
} satisfies Prisma.tax_groupInclude;

export interface DocumentLineItemRaw {
	id: string;
	total: number;
	tax_group_id: string | null;
	taxable: boolean;
}

export interface ResolveTaxInputOptions {
	/** Already loaded by the caller; skips the client query. */
	client?: { is_tax_exempt: boolean; tax_group_id: string | null } | null;
	/** Replaces the org-default lookup for lines with no group of their own (spec §4.3). */
	defaultGroup?: TaxGroupConfig | null;
}

export async function resolveLineItemTaxInputs(
	lineItems: DocumentLineItemRaw[],
	clientId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	opts: ResolveTaxInputOptions = {},
): Promise<{ inputs: LineItemTaxInput[]; clientExempt: boolean }> {
	const client =
		opts.client !== undefined
			? opts.client
			: await tx.client.findFirst({
					where: { id: clientId, organization_id: organizationId },
					select: { is_tax_exempt: true, tax_group_id: true },
				});

	const clientExempt = client?.is_tax_exempt ?? false;

	if (clientExempt) {
		return {
			inputs: lineItems.map((li) => ({
				id: li.id,
				total_cents: dollarsToCents(li.total),
				taxable: false,
				tax_group: null,
			})),
			clientExempt: true,
		};
	}

	const neededGroupIds = new Set<string>();
	for (const li of lineItems) {
		if (li.tax_group_id) neededGroupIds.add(li.tax_group_id);
	}
	if (client?.tax_group_id) neededGroupIds.add(client.tax_group_id);

	// Only fetch org default when at least one line item has no explicit group
	// and the client also has no group fallback — avoids an unnecessary DB query
	// in the common case where all items are explicitly assigned.
	const needsOrgDefault =
		opts.defaultGroup === undefined &&
		lineItems.some((li) => !li.tax_group_id) &&
		!client?.tax_group_id;

	const [fetchedGroups, orgDefaultGroup] = await Promise.all([
		neededGroupIds.size > 0
			? tx.tax_group.findMany({
					where: {
						id: { in: [...neededGroupIds] },
						organization_id: organizationId,
					},
					include: TAX_GROUP_WITH_RATES_INCLUDE,
				})
			: Promise.resolve([]),
		needsOrgDefault
			? tx.tax_group.findFirst({
					where: {
						organization_id: organizationId,
						is_default: true,
						is_active: true,
					},
					include: TAX_GROUP_WITH_RATES_INCLUDE,
				})
			: Promise.resolve(null),
	]);

	const taxGroupCache = new Map<string, TaxGroupConfig | null>();
	for (const g of fetchedGroups) {
		taxGroupCache.set(g.id, mapPrismaTaxGroup(g));
	}
	const orgDefault =
		opts.defaultGroup !== undefined
			? opts.defaultGroup
			: orgDefaultGroup
				? mapPrismaTaxGroup(orgDefaultGroup)
				: null;

	const inputs: LineItemTaxInput[] = lineItems.map((li) => {
		let resolvedGroup: TaxGroupConfig | null = null;
		if (li.tax_group_id) {
			resolvedGroup = taxGroupCache.get(li.tax_group_id) ?? null;
		} else if (client?.tax_group_id) {
			resolvedGroup = taxGroupCache.get(client.tax_group_id) ?? null;
		} else {
			resolvedGroup = orgDefault;
		}
		return {
			id: li.id,
			total_cents: dollarsToCents(li.total),
			taxable: li.taxable,
			tax_group: resolvedGroup,
		};
	});

	return { inputs, clientExempt: false };
}

/** line.tax_group_id is an FK to tax_group but not to the caller's org; this closes that. */
export async function assertTaxGroupsInOrg(
	tx: Prisma.TransactionClient,
	organizationId: string,
	ids: (string | null | undefined)[],
): Promise<void> {
	const wanted = [...new Set(ids.filter((v): v is string => !!v))];
	if (wanted.length === 0) return;
	const found = await tx.tax_group.count({
		where: { id: { in: wanted }, organization_id: organizationId },
	});
	if (found !== wanted.length) throw new Error("Tax group not found");
}

interface TaxGroupReader {
	tax_group: {
		findMany(args: {
			where: { id: { in: string[] }; organization_id: string };
			select: { id: true };
		}): Promise<{ id: string }[]>;
	};
}

/** Non-throwing form of {@link assertTaxGroupsInOrg}, for callers that return `{ err }`. */
export async function findForeignTaxGroupIds(
	client: TaxGroupReader,
	organizationId: string,
	ids: readonly (string | null | undefined)[],
): Promise<string[]> {
	const wanted = [...new Set(ids.filter((v): v is string => !!v))];
	if (wanted.length === 0) return [];
	const found = await client.tax_group.findMany({
		where: { id: { in: wanted }, organization_id: organizationId },
		select: { id: true },
	});
	const valid = new Set(found.map((g) => g.id));
	return wanted.filter((id) => !valid.has(id));
}
