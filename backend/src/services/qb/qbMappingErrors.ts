import { httpError, ErrorCodes } from "../../types/responses.js";

/**
 * All external-mapping tables (item_external_mapping, supplier_external_mapping, technician_external_mapping)
 * are unique on (provider, account_id, external_id) and/or the local entity id,
 * so a race between two concurrent link/import calls surfaces as P2002. Shared
 * so qbItems.ts and qbVendors.ts translate it into the same friendly 409 instead
 * of each re-checking the Prisma error code.
 */
export function throwOnMappingConflict(error: unknown, message: string): never {
	if ((error as { code?: string })?.code === "P2002") {
		throw httpError(409, ErrorCodes.CONFLICT, message);
	}
	throw error;
}
