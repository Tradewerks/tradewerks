import { isModuleOn } from "../entitlementService.js";
import crypto from "crypto";
import { db } from "../../db.js";
import { isQBConnected } from "../quickbooksService.js";
import { logExternalSync } from "./qbSyncLog.js";
import { handleInboundPaymentEvent } from "./qbPayments.js";
import type { Request, Response } from "express";

export function verifyQBWebhookSignature(rawBody?: Buffer, signature?: string): boolean {
    const token = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
    if (!token || !rawBody || !signature) return false;
    const digest = crypto.createHmac("sha256", token).update(rawBody).digest("base64");
    const a = Buffer.from(digest);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

async function processQBNotifications(body: any) {
    for (const notification of body?.eventNotifications ?? []){
        const realmId = notification.realmId;
        const org = await db.organization.findFirst({ where: { qb_realm_id: realmId } });
        if (!org) {
            await logExternalSync({ 
                provider: "quickbooks",
                entity_type: "payment",
                external_id: realmId,
                action: "webhook_skipped_no_org",
                payload: {realmId},
            });
            continue;
        }
        if (!(await isModuleOn(org.id, "quickbooks"))) continue;
        if (!(await isQBConnected(org.id))) {
            await logExternalSync({ 
                provider: "quickbooks",
                entity_type: "payment",
                external_id: realmId,
                action: "webhook_skipped_disconnected",
                payload: {realmId},
            });
            continue;
        }
        for (const e of notification.dataChangeEvent?.entities ?? []) {
            if (e.name !== "Payment") continue;
            await handleInboundPaymentEvent(org.id, realmId, e.id, e.operation);
        }
    }
}

export async function handleQBWebhook(req: Request, res: Response) {
    if (!verifyQBWebhookSignature(req.rawBody, req.header("intuit-signature"))) {
        return res.sendStatus(401);
    }
    res.sendStatus(200); // ack for Intuit
    setImmediate(() => {
        processQBNotifications(req.body).catch((e) =>{
            logExternalSync({ 
                provider: "quickbooks",
                entity_type: "payment",
                external_id: "",
                action: "webhook_failed",
                payload: { message: String(e) },
            });
        })
    });
}