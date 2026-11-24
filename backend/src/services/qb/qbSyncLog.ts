import { db } from "../../db.js"

export async function logExternalSync(entry: {
    provider: string;        // "quickbooks"
    entity_type: string;     
    external_id: string;
    action: string;
    payload: unknown;
    organization_id?: string;
}): Promise<void> {
    try {
        await db.external_sync_log.create({
            data: {
                ...entry, payload: entry.payload as any
            }
        })
    } catch (error) {
        console.error("Error logging external sync:", error)
    }
}

// Written by qbPayments' push on a definitive 4xx rejection.
const PAYMENT_PUSH_HTTP_FAILED = "push_http_failed";

/** Pushes of this payment that QuickBooks definitively rejected (4xx other than 401/408/429). */
export async function countPaymentPushHttpFailures(
    paymentId: string,
    organizationId: string,
): Promise<number> {
    return db.external_sync_log.count({
        where: {
            provider: "quickbooks",
            entity_type: "payment",
            external_id: paymentId,
            action: PAYMENT_PUSH_HTTP_FAILED,
            organization_id: organizationId,
        },
    });
}