import { getScopedDb } from "../../lib/context.js";
import { qbFetch, qbFetchBinary, getOrgRealmId } from "../quickbooksService.js";
import { qbQueryAll, getAccountId } from "./qbQuery.js";
import { httpError, ErrorCodes } from "../../types/responses.js";
import { findOrCreateQBCustomer } from "./qbCustomers.js";
import { pushVendor } from "./qbVendors.js";
import { pushItem } from "./qbItems.js";
import type { Prisma } from "../../../generated/prisma/client.js";

/** QuickBooks reference object, e.g. VendorRef / APAccountRef. */
export interface QBRef {
    value: string;
    name?: string;
}

export interface QBMetaData {
    CreateTime: string;
    LastUpdatedTime: string;
}

/** A QBO postal address (ShipAddr / VendorAddr). Line1-5 are free-form, printable lines. */
export interface QBAddress {
    Id?: string;
    Line1?: string;
    Line2?: string;
    Line3?: string;
    Line4?: string;
    Line5?: string;
    City?: string;
    Country?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
    Lat?: string;
    Long?: string;
}

export interface QBEmailAddress {
    Address: string;
}

export interface QBCustomField {
    DefinitionId: string;
    Name: string;
    Type: string; // "StringType", etc.
    StringValue?: string;
}

export interface QBItemBasedExpenseLineDetail {
    ItemRef: QBRef;
    CustomerRef?: QBRef;
    ClassRef?: QBRef;
    TaxCodeRef?: QBRef;
    PriceLevelRef?: QBRef;
    MarkupInfo?: { Percent?: number; PriceLevelRef?: QBRef };
    Qty?: number;
    UnitPrice?: number;
    BillableStatus?: "Billable" | "NotBillable" | "HasBeenBilled";
}

export interface QBAccountBasedExpenseLineDetail {
    AccountRef: QBRef;
    CustomerRef?: QBRef;
    ClassRef?: QBRef;
    TaxCodeRef?: QBRef;
    BillableStatus?: "Billable" | "NotBillable" | "HasBeenBilled";
}

export interface QBPurchaseOrderLine {
    Id?: string;
    LineNum?: number;
    Description?: string;
    Amount: number;
    DetailType: "ItemBasedExpenseLineDetail" | "AccountBasedExpenseLineDetail";
    ProjectRef?: QBRef;
    ItemBasedExpenseLineDetail?: QBItemBasedExpenseLineDetail;
    AccountBasedExpenseLineDetail?: QBAccountBasedExpenseLineDetail;
}

export interface QBPurchaseOrder {
    Id: string;
    SyncToken: string;
    domain: string;
    sparse: boolean;
    DocNumber?: string;
    TxnDate: string;
    TotalAmt: number;
    POStatus?: "Open" | "Closed";
    EmailStatus?: "NotSet" | "NeedToSend" | "EmailSent";
    POEmail?: QBEmailAddress;
    APAccountRef: QBRef;
    CurrencyRef?: QBRef;
    VendorRef: QBRef;
    ShipAddr?: QBAddress;
    VendorAddr?: QBAddress;
    Line: QBPurchaseOrderLine[];
    CustomField?: QBCustomField[];
    MetaData: QBMetaData;
}

/** Response wrapper returned by GET/POST on the QB PurchaseOrder entity. */
export interface QBPurchaseOrderResponse {
    PurchaseOrder: QBPurchaseOrder;
    time: string;
}

interface PushableLine {
    description: string;
    quantity: number | string | Prisma.Decimal;
    unit_price: number | string | Prisma.Decimal;
    line_total: number | string | Prisma.Decimal;
    inventory_item_id: string | null;
}

const inFlightPushes = new Map<string, Promise<string>>();

async function buildPurchaseOrderPayload (
    orgId: string,
    supplierId: string | null,
    lines: PushableLine[],
    taxAmount: number | string | Prisma.Decimal,
    txnDate: Date,
): Promise<Pick<QBPurchaseOrder, "VendorRef" | "APAccountRef" | "TxnDate" | "Line">> {
    if (!supplierId) throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Link a supplier before pushing to QuickBooks");

    const vendorId = await pushVendor(orgId, supplierId);
    const apAccountId = await getAccountId(orgId, "Accounts Payable");

    let expenseAccountId: string | undefined;
    const qbLines: QBPurchaseOrderLine[] = [];
    for (const l of lines) {
        if (l.inventory_item_id) {
            const itemId = await pushItem(orgId, l.inventory_item_id);
            qbLines.push({
                DetailType: "ItemBasedExpenseLineDetail",
                Description: l.description,
                Amount: Number(l.line_total),
                ItemBasedExpenseLineDetail: { ItemRef: { value: itemId }, Qty: Number(l.quantity), UnitPrice: Number(l.unit_price) },
            });
        } else {
            expenseAccountId ??= await getAccountId(orgId, "Expense");
            qbLines.push({
                DetailType: "AccountBasedExpenseLineDetail",
                Description: l.description,
                Amount: Number(l.line_total),
                AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } },
            })
        }
    }

    if (Number(taxAmount) > 0) {
        expenseAccountId ??= await getAccountId(orgId, "Expense");
        qbLines.push({
            DetailType: "AccountBasedExpenseLineDetail",
            Description: "Sales Tax",
            Amount: Number(taxAmount),
            AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } },
        });
    }

    return {
        VendorRef: { value: vendorId },
        APAccountRef: { value: apAccountId },
        TxnDate: txnDate.toISOString().slice(0, 10),
        Line: qbLines,
    };
}

export const queryQBPurchaseOrders = async (orgId: string, params?: string): Promise<QBPurchaseOrder[]> => {
    const purchaseOrders = await qbQueryAll<QBPurchaseOrder>(orgId, "PurchaseOrder", params);

    return purchaseOrders;
};

export const getQBPurchaseOrderById = async (orgId: string, purchaseId: string): Promise<QBPurchaseOrder> => {
    const purchaseOrder = await qbFetch(orgId, "GET", `/purchaseorder/${purchaseId}`) as QBPurchaseOrder;

    return purchaseOrder;
}

export const getQBPurchaseOrderAsPDF = async (orgId: string, purchaseId: string): Promise<Buffer> => {
    const sdb = getScopedDb(orgId);
    const purchase = await sdb.purchase.findFirst({ where: { id: purchaseId }});
    if (!purchase) throw httpError(404, ErrorCodes.NOT_FOUND, "Purchase not found");
    if (!purchase.qb_purchase_id || purchase.qb_sync_status !== "synced") {
        throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Push or re-sync this purchase to QuickBooks before viewing the PDF");
    }

    return qbFetchBinary(orgId, `/purchaseorder/${purchase.qb_purchase_id}/pdf`);
}

export async function pushPurchase(purchaseId: string, orgId: string): Promise<string> {
    const prior = inFlightPushes.get(purchaseId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => doPushPurchase(purchaseId, orgId));
    const tracked = run.finally(() => {
        if (inFlightPushes.get(purchaseId) === tracked) {
            inFlightPushes.delete(purchaseId);
        }
    });
    // Bookkeeping-only chain — the caller reads failure off the returned `run`.
    // Left unhandled, a rejected `run` leaves this one an unhandled rejection
    // with nobody listening, which crashes the process.
    tracked.catch(() => {});
    inFlightPushes.set(purchaseId, tracked);
    return run;
};

async function doPushPurchase(purchaseId: string, orgId: string): Promise<string> {
    const sdb = getScopedDb(orgId);

    const purchase = await sdb.purchase.findFirst({
        where: { id: purchaseId },
        include: { lines: true }
    });
    if (!purchase) throw httpError(404, ErrorCodes.NOT_FOUND, "Purchase not found");
    if (purchase.kind !== "purchase") throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Only a purchase can be pushed, not a refund");

    // A purchase that was cancelled without ever being ordered never had a real
    // vendor commitment — nothing to record in QuickBooks either way.
    const neverOrdered = purchase.status === "draft" || (purchase.status === "cancelled" && !purchase.submitted_at);
    if (neverOrdered) {
        throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Order the purchase before pushing to QuickBooks");
    }

    const accountId = await getOrgRealmId(orgId);
    const qbPurchaseId = purchase.qb_purchase_id && purchase.account_id === accountId ? purchase.qb_purchase_id : null;

    if (purchase.status === "cancelled") {
        if (!qbPurchaseId) {
            throw httpError(400, ErrorCodes.VALIDATION_ERROR, "This purchase was never pushed to QuickBooks — nothing to update");
        }
        // QBO's PurchaseOrder entity has no void/delete-by-operation support (unlike
        // Invoice) — "POStatus" is the only lifecycle field it exposes, so closing it
        // is the correct analog to reflecting a local cancellation.
        const existing = (await qbFetch(orgId, "GET", `/purchaseorder/${qbPurchaseId}`)) as QBPurchaseOrderResponse;
        await qbFetch(orgId, "POST", "/purchaseorder", {
            sparse: true,
            Id: qbPurchaseId,
            SyncToken: existing.PurchaseOrder.SyncToken,
            POStatus: "Closed",
        });
        await sdb.purchase.update({
            where: { id: purchaseId },
            data: { qb_purchase_id: qbPurchaseId, account_id: accountId, qb_sync_status: "synced" },
        });
        return qbPurchaseId;
    }

    if (purchase.status === "received") {
        if (!qbPurchaseId) {
            throw httpError(400, ErrorCodes.VALIDATION_ERROR, "This purchase was never pushed to QuickBooks — nothing to update");
        }
        // Fully received - nothing left to arrive against this PO, same closure as a cancellation.
        const existing = (await qbFetch(orgId, "GET", `/purchaseorder/${qbPurchaseId}`)) as QBPurchaseOrderResponse;
        await qbFetch(orgId, "POST", "/purchaseorder", {
            sparse: true,
            Id: qbPurchaseId,
            SyncToken: existing.PurchaseOrder.SyncToken,
            POStatus: "Closed",
        });
        await sdb.purchase.update({
            where: { id: purchaseId },
            data: { qb_purchase_id: qbPurchaseId, account_id: accountId, qb_sync_status: "synced" },
        });
        return qbPurchaseId;
    }

    const payload = await buildPurchaseOrderPayload(orgId, purchase.supplier_id, purchase.lines, purchase.tax_amount, purchase.purchased_at ?? purchase.created_at);

    if (qbPurchaseId) {
        const existing = (await qbFetch(orgId, "GET", `/purchaseorder/${qbPurchaseId}`)) as QBPurchaseOrderResponse;
        await qbFetch(orgId, "POST", "/purchaseorder", {
            sparse: true,
            Id: qbPurchaseId,
            SyncToken: existing.PurchaseOrder.SyncToken,
            ...payload,
        });
        await sdb.purchase.update({
            where: { id: purchaseId },
            data: { account_id: accountId, qb_sync_status: "synced" },
        });
        return qbPurchaseId;
    }

    const created = await qbFetch(orgId, "POST", "/purchaseorder", payload) as QBPurchaseOrderResponse;
    await sdb.purchase.update({
        where: { id: purchaseId },
        data: {
            qb_purchase_id: created.PurchaseOrder.Id,
            account_id: accountId,
            qb_sync_status: "synced",
        }
    });

    return created.PurchaseOrder.Id;
}

const inFlightFieldPurchasePushes = new Map<string, Promise<string>>();

export async function pushFieldPurchase (purchaseId: string, orgId: string) {
    const prior = inFlightFieldPurchasePushes.get(purchaseId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => doPushFieldPurchase(purchaseId, orgId));
    const tracked = run.finally(() => {
        if (inFlightFieldPurchasePushes.get(purchaseId) === tracked) {
            inFlightFieldPurchasePushes.delete(purchaseId);
        }
    });
    tracked.catch(() => {});
    inFlightFieldPurchasePushes.set(purchaseId, tracked);
    return run;
}

async function doPushFieldPurchase (purchaseId: string, orgId: string): Promise<string> {
    const sdb = getScopedDb(orgId);
    const purchase = await sdb.field_purchase.findFirst({
        where: { id: purchaseId },
        include: { lines: true }
    });
    if (!purchase) throw httpError(404, ErrorCodes.NOT_FOUND, "Field purchase not found");
    if (purchase.kind !== "purchase") throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Only purchases can be pushed, not a refund");
    if (purchase.status !== "approved") throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Only approved purchases can be pushed to QuickBooks");

    const accountId = await getOrgRealmId(orgId);
    // silient skip if its already synced
    if (purchase.qb_purchase_id && purchase.account_id === accountId && purchase.qb_sync_status === "synced") return purchase.qb_purchase_id;

    const qbPurchaseId = purchase.qb_purchase_id && purchase.account_id === accountId ? purchase.qb_purchase_id : null;
    const payload = await buildPurchaseOrderPayload(orgId, purchase.supplier_id, purchase.lines, purchase.tax_amount, purchase.purchased_at ?? purchase.created_at);

    if (qbPurchaseId) {
        const existing = (await qbFetch(orgId, "GET", `/purchaseorder/${qbPurchaseId}`)) as QBPurchaseOrderResponse;
        await qbFetch(orgId, "POST", "/purchaseorder", {
            sparse: true,
            Id: qbPurchaseId,
            SyncToken: existing.PurchaseOrder.SyncToken,
            ...payload,
        });
        await sdb.field_purchase.update({
            where: { id: purchaseId },
            data: { account_id: accountId, qb_sync_status: "synced" },
        });
        return qbPurchaseId;
    }

    const created = await qbFetch(orgId, "POST", "/purchaseorder", payload) as QBPurchaseOrderResponse;

    await sdb.field_purchase.update({
        where: { id: purchaseId },
        data: {
            qb_purchase_id: created.PurchaseOrder.Id,
            account_id: accountId,
            qb_sync_status: "synced",
        }
    });

    return created.PurchaseOrder.Id;
}

/* 
* if email is emtpy sends to PurchaseOrder.POEmail.Address
* Sets emailstatus to EmailSent 
*/
export async function sendQBPurchaseOrder(purchaseId: string, orgId: string, email?: string) {
    const sendPurchaseOrder = await qbFetch(orgId, "POST", `/purchaseorder/${purchaseId}/send${email ? `?sendTo=${email}`: ""}`) as QBPurchaseOrder;
    // probably should add error handling 🤷‍♂️
}


