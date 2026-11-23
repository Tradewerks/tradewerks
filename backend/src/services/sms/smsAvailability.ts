import { getScopedDb } from "../../lib/context.js";
import { isModuleOn } from "../entitlementService.js";

/** Whether the org has a text-messaging account that has finished registration. */
export async function isSmsActive(orgId: string): Promise<boolean> {
	const acct = await getScopedDb(orgId).org_sms_account.findFirst({
		where: { organization_id: orgId },
		select: { status: true },
	});
	return acct?.status === "active";
}

/** Why this org cannot text right now, or null when it can. */
export async function smsUnavailableReason(
	orgId: string,
): Promise<"sms_module_off" | "sms_not_active" | null> {
	if (!(await isModuleOn(orgId, "sms"))) return "sms_module_off";
	if (!(await isSmsActive(orgId))) return "sms_not_active";
	return null;
}
