import { getOrgRealmId, qbFetch } from "../quickbooksService.js";
import { qbQueryAll } from "./qbQuery.js";
import { db } from "../../db.js";
import { httpError, ErrorCodes } from "../../types/responses.js";
import { normalizeSupplierName as normalizeName, collapseWhitespace } from "../suppliers.js";
import { throwOnMappingConflict } from "./qbMappingErrors.js";

const PROVIDER = "quickbooks";

export interface QBEmployee {
	Id: string;
	DisplayName: string;
	GivenName?: string;
	FamilyName?: string;
	PrimaryPhone?: { FreeFormNumber?: string };
	PrimaryEmailAddr?: { Address?: string };
	Active?: boolean;
}

/** A QBO employee, plus what we already know about it locally. */
export interface QBEmployeeRow extends QBEmployee {
	linkedTechnicianId: string | null;
	/** An UNLINKED technician matching by email, else by name. */
	suggestedTechnicianId: string | null;
	suggestedTechnicianName: string | null;
}

export async function getQBEmployees(orgId: string): Promise<QBEmployeeRow[]> {
	const [employees, accountId] = await Promise.all([
		qbQueryAll<QBEmployee>(orgId, "Employee", "Active = true"),
		getOrgRealmId(orgId),
	]);

	const [mappings, technicians] = await Promise.all([
		db.technician_external_mapping.findMany({
			where: {
				provider: PROVIDER,
				account_id: accountId,
				technician: { organization_id: orgId },
			},
			select: { technician_id: true, external_id: true },
		}),
		db.technician.findMany({
			where: { organization_id: orgId },
			select: { id: true, name: true, email: true },
		}),
	]);

	const linkedByExternal = new Map(mappings.map((m) => [m.external_id, m.technician_id]));
	const linkedTechnicianIds = new Set(mappings.map((m) => m.technician_id));
	const unlinked = technicians.filter((t) => !linkedTechnicianIds.has(t.id));
	const byEmail = new Map(unlinked.map((t) => [t.email.toLowerCase(), t]));
	const byName = new Map(unlinked.map((t) => [normalizeName(t.name), t]));

	return employees.map((e) => {
		const linkedTechnicianId = linkedByExternal.get(e.Id) ?? null;
		const email = e.PrimaryEmailAddr?.Address?.toLowerCase();
		const match = linkedTechnicianId
			? undefined
			: ((email ? byEmail.get(email) : undefined) ??
				byName.get(normalizeName(e.DisplayName ?? "")));
		return {
			...e,
			linkedTechnicianId,
			suggestedTechnicianId: match?.id ?? null,
			suggestedTechnicianName: match?.name ?? null,
		};
	});
}

export async function getMappedQBEmployees(
	orgId: string,
): Promise<{ technician_id: string; external_id: string }[]> {
	const accountId = await getOrgRealmId(orgId);
	return db.technician_external_mapping.findMany({
		where: { provider: PROVIDER, account_id: accountId, technician: { organization_id: orgId } },
		select: { technician_id: true, external_id: true },
	});
}

export async function linkQBEmployee(orgId: string, technicianId: string, qbEmployeeId: string) {
	const technician = await db.technician.findFirst({
		where: { id: technicianId, organization_id: orgId },
		select: { id: true },
	});
	if (!technician) throw httpError(404, ErrorCodes.NOT_FOUND, "Technician not found");

	const accountId = await getOrgRealmId(orgId);
	try {
		await db.technician_external_mapping.create({
			data: {
				technician_id: technicianId,
				provider: PROVIDER,
				account_id: accountId,
				external_id: qbEmployeeId,
			},
		});
	} catch (error) {
		throwOnMappingConflict(error, "This technician or QuickBooks employee is already linked.");
	}
}

export async function unlinkQBEmployee(orgId: string, technicianId: string) {
	const accountId = await getOrgRealmId(orgId);
	const { count } = await db.technician_external_mapping.deleteMany({
		where: {
			provider: PROVIDER,
			technician_id: technicianId,
			account_id: accountId,
			technician: { organization_id: orgId },
		},
	});
	if (count === 0) throw httpError(404, ErrorCodes.NOT_FOUND, "Employee mapping not found");
}

/**
 * Push one of our technicians up as a QBO employee.
 *
 * Adopts an existing QBO employee with the same DisplayName rather than creating a
 * second one — QBO rejects duplicate DisplayNames anyway.
 */
export async function pushEmployee(orgId: string, technicianId: string): Promise<string> {
	const technician = await db.technician.findFirst({
		where: { id: technicianId, organization_id: orgId },
	});
	if (!technician) throw httpError(404, ErrorCodes.NOT_FOUND, "Technician not found");

	const accountId = await getOrgRealmId(orgId);
	const existingMapping = await db.technician_external_mapping.findFirst({
		where: { provider: PROVIDER, technician_id: technicianId, account_id: accountId },
	});
	if (existingMapping) return existingMapping.external_id;

	const name = collapseWhitespace(technician.name);
	const escaped = name.replace(/'/g, "\\'");
	const found = await qbQueryAll<QBEmployee>(orgId, "Employee", `DisplayName = '${escaped}'`);

	let qbEmployeeId: string;
	if (found.length) {
		qbEmployeeId = found[0].Id;
	} else {
		// QBO requires a name part on Employee; DisplayName alone is rejected.
		const [given, ...rest] = name.split(" ");
		const created = (await qbFetch(orgId, "POST", "/employee", {
			DisplayName: name,
			GivenName: given,
			...(rest.length ? { FamilyName: rest.join(" ") } : {}),
			...(technician.phone ? { PrimaryPhone: { FreeFormNumber: technician.phone } } : {}),
			PrimaryEmailAddr: { Address: technician.email },
		})) as { Employee: QBEmployee };
		qbEmployeeId = created.Employee.Id;
	}

	try {
		await db.technician_external_mapping.create({
			data: {
				technician_id: technicianId,
				provider: PROVIDER,
				account_id: accountId,
				external_id: qbEmployeeId,
			},
		});
	} catch (error) {
		throwOnMappingConflict(error, "This QuickBooks employee is already linked to another technician.");
	}
	return qbEmployeeId;
}
