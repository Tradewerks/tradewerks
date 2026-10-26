// backend/src/services/qb/qbConnectTaxGuard.ts
import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { getScopedDb } from "../../lib/context.js";
import { log } from "../appLogger.js";
import { getQBTaxPrefs } from "./qbTax.js";

const INTEGRATIONS_URL = "/dispatch/admin?tab=integrations";
const UNLINKED =
	"This is a different QuickBooks company, so tax code links from the previous one were removed.";
const NO_PASSTHROUGH =
	"Automatic tax is on, but no pass-through tax code is set. Until one is chosen, QuickBooks calculates its own tax on pushed invoices.";
const RELINK = "Link your tax groups to this company's tax codes.";

/** A first connection (nothing recorded) is not a change: there are no codes to be wrong. */
export function isDifferentCompany(previous: string | null, next: string): boolean {
	return previous !== null && previous !== next;
}

/** Unreadable counts as non-AST, as in the settings refusal: guessing AST would hide the problem. */
async function isAst(orgId: string): Promise<boolean> {
	try {
		return (await getQBTaxPrefs(orgId)).automatedSalesTax;
	} catch (err) {
		log.warn({ err, orgId }, "Could not read QuickBooks tax preferences after connect");
		return false;
	}
}

/**
 * After a QuickBooks connect. The settings switch refuses auto without a pass-through code,
 * but connecting while already in auto, or to another company, bypasses that
 * check; this tells the org instead. Never throws: the connection has already been saved.
 */
export async function notifyTaxCodeNeeds(orgId: string, unlinked: boolean): Promise<void> {
	try {
		const org = await getScopedDb(orgId).organization.findUnique({
			where: { id: orgId },
			select: { tax_mode: true, qb_passthrough_tax_code_id: true },
		});
		const needsPassthrough =
			org?.tax_mode === "auto" && !org.qb_passthrough_tax_code_id && !(await isAst(orgId));
		if (!needsPassthrough && !unlinked) return;
		const body = [unlinked ? UNLINKED : null, needsPassthrough ? NO_PASSTHROUGH : RELINK]
			.filter((s): s is string => s !== null)
			.join(" ");
		await notifyDispatchers(
			{
				type: "qb_tax_code_needed",
				title: needsPassthrough
					? "Choose a QuickBooks tax code for automatic tax"
					: "QuickBooks tax codes need relinking",
				body,
				actionUrl: INTEGRATIONS_URL,
			},
			orgId,
		);
	} catch (err) {
		log.error({ err, orgId }, "QuickBooks tax code check after connect failed");
	}
}
