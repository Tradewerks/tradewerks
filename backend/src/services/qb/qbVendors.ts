import { getOrgRealmId, qbFetch } from "../quickbooksService.js";
import { qbQueryAll } from "./qbQuery.js";
import { db } from "../../db.js";
import { httpError, ErrorCodes } from "../../types/responses.js";
import { normalizeSupplierName, collapseWhitespace } from "../suppliers.js";
import { throwOnMappingConflict } from "./qbMappingErrors.js";

const PROVIDER = "quickbooks";

export interface QBVendor {
	Id: string;
	DisplayName: string;
	CompanyName?: string;
	AcctNum?: string;
	PrimaryPhone?: { FreeFormNumber?: string };
	PrimaryEmailAddr?: { Address?: string };
	Active?: boolean;
}

/** A QBO vendor, plus what we already know about it locally. */
export interface QBVendorRow extends QBVendor {
	/** Set when this QBO vendor is already mapped to one of our suppliers. */
	linkedSupplierId: string | null;
	/**
	 * An UNLINKED supplier whose name_key matches. Offered so the operator links
	 * the vendor they already have instead of importing a second copy of it —
	 * the duplicate-vendor mess is the whole reason this mapping exists.
	 */
	suggestedSupplierId: string | null;
	suggestedSupplierName: string | null;
}

export async function getQBVendors(orgId: string): Promise<QBVendorRow[]> {
	const [vendors, accountId] = await Promise.all([
		qbQueryAll<QBVendor>(orgId, "Vendor", "Active = true"),
		getOrgRealmId(orgId),
	]);

	const [mappings, suppliers] = await Promise.all([
		db.supplier_external_mapping.findMany({
			where: {
				provider: PROVIDER,
				account_id: accountId,
				supplier: { organization_id: orgId },
			},
			select: { supplier_id: true, external_id: true },
		}),
		db.supplier.findMany({
			where: { organization_id: orgId, is_active: true },
			select: { id: true, name: true, name_key: true },
		}),
	]);

	const linkedByExternal = new Map(mappings.map((m) => [m.external_id, m.supplier_id]));
	const linkedSupplierIds = new Set(mappings.map((m) => m.supplier_id));
	// Only unlinked suppliers can be suggested — suggesting one that's already
	// spoken for would offer a link the unique index is going to reject.
	const byNameKey = new Map(
		suppliers.filter((s) => !linkedSupplierIds.has(s.id)).map((s) => [s.name_key, s]),
	);

	return vendors.map((v) => {
		const linkedSupplierId = linkedByExternal.get(v.Id) ?? null;
		// Same normalization the supplier table keys on, so a suggestion means
		// exactly what a local dedupe would: case and spacing only, never fuzzy.
		const match = linkedSupplierId
			? undefined
			: (byNameKey.get(normalizeSupplierName(v.DisplayName ?? "")) ??
				byNameKey.get(normalizeSupplierName(v.CompanyName ?? "")));
		return {
			...v,
			linkedSupplierId,
			suggestedSupplierId: match?.id ?? null,
			suggestedSupplierName: match?.name ?? null,
		};
	});
}

export async function getMappedQBVendors(
	orgId: string,
): Promise<{ supplier_id: string; external_id: string }[]> {
	const accountId = await getOrgRealmId(orgId);
	return db.supplier_external_mapping.findMany({
		where: { provider: PROVIDER, account_id: accountId, supplier: { organization_id: orgId } },
		select: { supplier_id: true, external_id: true },
	});
}

/** QBO's own fields mapped onto ours. DisplayName is what QBO shows and bills under. */
function toSupplierFields(v: QBVendor) {
	const name = collapseWhitespace(v.DisplayName || v.CompanyName || "");
	return {
		name,
		name_key: normalizeSupplierName(name),
		account_number: v.AcctNum ?? null,
		phone: v.PrimaryPhone?.FreeFormNumber ?? null,
		email: v.PrimaryEmailAddr?.Address ?? null,
	};
}

/**
 * Pull a QBO vendor in as a supplier.
 *
 * If a supplier already owns the name, this LINKS to it rather than creating a
 * duplicate — a name_key collision means it's the same company, and the caller's
 * intent ("get this vendor into the system") is satisfied either way.
 */
export async function importQBVendor(orgId: string, qbVendorId: string) {
	const data = (await qbFetch(orgId, "GET", `/vendor/${qbVendorId}`)) as { Vendor: QBVendor };
	const vendor = data.Vendor;
	const accountId = await getOrgRealmId(orgId);
	const fields = toSupplierFields(vendor);

	if (!fields.name) {
		throw httpError(400, ErrorCodes.VALIDATION_ERROR, "QuickBooks vendor has no name");
	}

	const alreadyMapped = await db.supplier_external_mapping.findFirst({
		where: {
			provider: PROVIDER,
			account_id: accountId,
			external_id: qbVendorId,
			supplier: { organization_id: orgId },
		},
	});
	if (alreadyMapped) {
		throw httpError(409, ErrorCodes.CONFLICT, "This QuickBooks vendor is already linked.");
	}

	return db.$transaction(async (tx) => {
		const existing = await tx.supplier.findFirst({
			where: { organization_id: orgId, name_key: fields.name_key },
		});

		const supplier =
			existing ??
			(await tx.supplier.create({
				data: { organization_id: orgId, ...fields },
			}));

		if (existing) {
			// QBO fills gaps, never overwrites: whoever typed the local record was
			// looking at an invoice, and their account number is the one techs use.
			const patch: Record<string, string | boolean> = {};
			if (!existing.account_number && fields.account_number)
				patch.account_number = fields.account_number;
			if (!existing.phone && fields.phone) patch.phone = fields.phone;
			if (!existing.email && fields.email) patch.email = fields.email;
			// The name_key match can land on a supplier that was deactivated (e.g.
			// merged away) — the unique constraint on (organization_id, name_key)
			// means a second, active row can never be created for the same name, so
			// silently leaving it inactive would hide this import from every picker
			// and report with no error surfaced. Importing it back in is the
			// operator explicitly asserting this vendor is live again.
			if (!existing.is_active) patch.is_active = true;
			if (Object.keys(patch).length > 0) {
				await tx.supplier.update({ where: { id: existing.id }, data: patch });
			}
		}

		try {
			await tx.supplier_external_mapping.create({
				data: {
					supplier_id: supplier.id,
					provider: PROVIDER,
					account_id: accountId,
					external_id: qbVendorId,
				},
			});
		} catch (error) {
			// Two concurrent imports of the same QBO vendor can both pass the
			// alreadyMapped check above before either commits; surface the same
			// friendly conflict linkQBVendor gives instead of a raw 500.
			throwOnMappingConflict(error, "This QuickBooks vendor is already linked.");
		}

		return { supplier, linkedExisting: !!existing };
	});
}

export async function linkQBVendor(orgId: string, supplierId: string, qbVendorId: string) {
	const supplier = await db.supplier.findFirst({
		where: { id: supplierId, organization_id: orgId },
		select: { id: true },
	});
	if (!supplier) throw httpError(404, ErrorCodes.NOT_FOUND, "Supplier not found");

	const accountId = await getOrgRealmId(orgId);
	try {
		await db.supplier_external_mapping.create({
			data: {
				supplier_id: supplierId,
				provider: PROVIDER,
				account_id: accountId,
				external_id: qbVendorId,
			},
		});
	} catch (error) {
		throwOnMappingConflict(error, "This supplier or QuickBooks vendor is already linked.");
	}
}

export async function unlinkQBVendor(orgId: string, supplierId: string) {
	const accountId = await getOrgRealmId(orgId);
	const { count } = await db.supplier_external_mapping.deleteMany({
		where: {
			provider: PROVIDER,
			supplier_id: supplierId,
			account_id: accountId,
			supplier: { organization_id: orgId },
		},
	});
	if (count === 0) throw httpError(404, ErrorCodes.NOT_FOUND, "Vendor mapping not found");
}

/**
 * Push one of our suppliers up as a QBO vendor.
 *
 * Adopts an existing QBO vendor with the same DisplayName rather than creating a
 * second one — QBO rejects duplicate DisplayNames anyway, and a failed push is
 * worse than a link.
 */
export async function pushVendor(orgId: string, supplierId: string): Promise<string> {
	const supplier = await db.supplier.findFirst({
		where: { id: supplierId, organization_id: orgId },
	});
	if (!supplier) throw httpError(404, ErrorCodes.NOT_FOUND, "Supplier not found");

	const accountId = await getOrgRealmId(orgId);
	const existingMapping = await db.supplier_external_mapping.findFirst({
		where: { provider: PROVIDER, supplier_id: supplierId, account_id: accountId },
	});
	if (existingMapping) return existingMapping.external_id;

	const escaped = supplier.name.replace(/'/g, "\\'");
	const found = await qbQueryAll<QBVendor>(orgId, "Vendor", `DisplayName = '${escaped}'`);

	let qbVendorId: string;
	if (found.length) {
		qbVendorId = found[0].Id;
	} else {
		const created = (await qbFetch(orgId, "POST", "/vendor", {
			DisplayName: supplier.name,
			...(supplier.account_number ? { AcctNum: supplier.account_number } : {}),
			...(supplier.phone ? { PrimaryPhone: { FreeFormNumber: supplier.phone } } : {}),
			...(supplier.email ? { PrimaryEmailAddr: { Address: supplier.email } } : {}),
		})) as { Vendor: QBVendor };
		qbVendorId = created.Vendor.Id;
	}

	await db.supplier_external_mapping.create({
		data: {
			supplier_id: supplierId,
			provider: PROVIDER,
			account_id: accountId,
			external_id: qbVendorId,
		},
	});
	return qbVendorId;
}
