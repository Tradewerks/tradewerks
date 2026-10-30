import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../lib/requirePermissions.js";
import { createSuccessResponse, createErrorResponse, ErrorCodes } from "../types/responses.js";
import {
	getAuthUrl,
	disconnectOrg,
	getQBStatus,
	getOrgRealmId,
	isQBConnected,
	QB_ENABLED,
} from "../services/quickbooksService.js";
import { 
	pushInvoice,
	sendInvoiceEmail,
} from "../services/qb/qbInvoices.js"
import { qbFaultDetail } from "../services/qb/qbCreditMemos.js";
import { findAllQBCustomers, pushClient } from "../services/qb/qbCustomers.js"
import {
	getQBItems,
	getMappedQBItems,
	linkQBItem,
	unlinkQBItem,
	pushItem,
	importQBItem
} from "../services/qb/qbItems.js";
import {
	getQBTaxCodes,
	getQBTaxPrefs,
	linkTaxCode
} from "../services/qb/qbTax.js"
import {
	getImportableQBInvoices,
	getQBInvoicePrefill,
	importQBInvoices
} from "../services/qb/qbInvoices.js"
import {
	getQBVendors,
	getMappedQBVendors,
	linkQBVendor,
	unlinkQBVendor,
	importQBVendor,
	pushVendor,
} from "../services/qb/qbVendors.js";
import {
	getQBEmployees,
	getMappedQBEmployees,
	linkQBEmployee,
	unlinkQBEmployee,
	pushEmployee,
} from "../services/qb/qbEmployees.js";
import { linkQBEmployeeSchema, linkQBItemSchema, linkQBVendorSchema, qbReportQuerySchema, qbReportTypeSchema } from "../lib/validate/quickbooks.js"
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { queryProfitAndLossQBReport, queryQBReport } from "../services/qb/qbReports.js";
import type { ProfitAndLossQuery } from "../services/qb/qbReports.js";
import { pushPurchase, queryQBPurchaseOrders, getQBPurchaseOrderAsPDF, pushFieldPurchase } from "../services/qb/qbPurchases.js";
import { pushTimesheet } from "../services/qb/qbTimeActivity.js";
import { listUnsynced, syncUnsynced } from "../services/qb/qbUnsynced.js";
import { setQBPassthroughTaxCode } from "../controllers/taxSettingsController.js";
import { sendTaxResult } from "./tax.js";
import { log } from "../services/appLogger.js";

const router = Router();

// QuickBooks temporarily disabled (see quickbooksService.QB_ENABLED). The
// connection-status probe still answers { connected: false } so every QB
// consumer cleanly hides its UI; every other QB route short-circuits with 404.
router.use((req, res, next) => {
	if (QB_ENABLED) return next();
	if (req.method === "GET" && req.path === "/connection") {
		return res.json(createSuccessResponse({ connected: false }));
	}
	return res
		.status(404)
		.json(createErrorResponse(ErrorCodes.NOT_FOUND, "QuickBooks is disabled"));
});

// Connection status for this org (the QB "connection" resource)
router.get("/connection", async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id!;
		const status = await getQBStatus(orgId);
		res.json(createSuccessResponse(status));
	} catch (err) {
		next(err);
	}
});

// OAuth URL the frontend opens to begin the connect flow
router.get("/connection/auth-url", requirePermission("manage_organization"), (req, res, next) => {
	try {
		const orgId = req.user!.organization_id!;
		const url = getAuthUrl(orgId, req.user!.uid);
		res.json(createSuccessResponse({ url }));
	} catch (err) {
		next(err);
	}
});

// Clears QB tokens — org must reconnect to sync again
router.delete("/connection", requirePermission("manage_organization"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id!;
		await disconnectOrg(orgId);
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

router.get("/unsynced", requirePermission("manage_organization"), async (req, res, next) => {
	try {
		res.json(createSuccessResponse(await listUnsynced(req.user!.organization_id as string)));
	} catch (err) {
		next(err);
	}
});

// Explicit and sequential: re-enabling QuickBooks must never start a burst on its
// own, and QuickBooks rate-limits parallel writes.
router.post("/unsynced/sync", requirePermission("manage_organization"), async (req, res, next) => {
	try {
		res.json(createSuccessResponse(await syncUnsynced(req.user!.organization_id as string)));
	} catch (err) {
		next(err);
	}
});

// Manual sync — push a single invoice to QB (or retry a failed one)
router.post("/invoices/:id/sync", requirePermission("edit_invoices"), async (req, res, next) => {
	const invoiceId = req.params.id as string;
	const orgId = req.user!.organization_id!;
	try {
		const pushed = await pushInvoice(invoiceId, orgId);
		res.json(createSuccessResponse({ synced: pushed !== undefined }));
	} catch (err) {
		// Scoped: the id comes from the URL, so it may belong to another org.
		await getScopedDb(orgId)
			.invoice.updateMany({ where: { id: invoiceId }, data: { qb_sync_status: "failed" } })
			.catch(() => {});
		const detail = qbFaultDetail(err);
		if (detail) {
			return res
				.status(502)
				.json(
					createErrorResponse(
						ErrorCodes.QB_SYNC_FAILED,
						`QuickBooks rejected this document: ${detail}`,
					),
				);
		}
		next(err);
	}
});

// Gated on send_invoices, not edit_invoices: mailing the invoice through
// QuickBooks is the same business act as mailing it through Postmark, so it
// cannot be the one door that skips the permission. This route carried no gate
// at all before — the router is mounted with verifyToken alone.
router.post("/invoices/:id/email", requirePermission("send_invoices"), async (req, res, next) =>{
	try {
		const invoiceId = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const { sendTo } = req.body;

		if (!sendTo){
			return res.status(400).json(
				createErrorResponse(ErrorCodes.VALIDATION_ERROR, "sendTo email is required")
			);
		}
		await sendInvoiceEmail(invoiceId, orgId, sendTo);
		res.json(createSuccessResponse({sent: true}));
	} catch(err) {
		next(err);
	}
});

// Returns every client already mapped to a QB customer in this org
router.get("/customers/mappings", async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const sdb = getScopedDb(orgId);
		const accountId = await getOrgRealmId(orgId);
		const mappings = await sdb.client_external_mapping.findMany({
			where: {
				provider: "quickbooks",
				client: { organization_id: orgId },
				account_id: accountId,
			},
			select: { client_id: true, external_id: true },
		});
		return res.json(createSuccessResponse(mappings));
	} catch (e) {
		next(e);
	}
});

router.get("/customers", async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const response = await findAllQBCustomers(orgId);

		if (!response) {
			return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, "Could not get QB Customers"));
		}
		return res.json(createSuccessResponse(response));
	} catch (e) {
		next(e);
	}
});

router.post("/customers/:clientId/sync", requirePermission("edit_clients"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const clientId = req.params.clientId as string;
		const qbCustomerId = await pushClient(orgId, clientId);

		if (!qbCustomerId) {
			return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, "Could not sync client"));
		}
		return res.json(createSuccessResponse({ synced: true, qb_customer_id: qbCustomerId }));
	} catch (e) {
		next(e);
	}
})

router.get("/items", requireModule("inventory"), requirePermission("view_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const response = await getQBItems(orgId);

		return res.json(createSuccessResponse(response));
	} catch (e) {
		next(e);
	}
});

router.get("/items/mappings", requireModule("inventory"), requirePermission("view_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const response = await getMappedQBItems(orgId);

		return res.json(createSuccessResponse(response));
	} catch (e) {
		next(e);
	}
});

// Create an item mapping
router.post("/item-mappings", requireModule("inventory"), requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const parsed = linkQBItemSchema.safeParse(req.body);
		if (!parsed.success){
			return res.status(400).json(
				createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message)
			);
		}
	const { inventory_item_id, qb_item_id } = parsed.data;
		await linkQBItem(orgId, inventory_item_id, qb_item_id);
		res.status(201).json(createSuccessResponse({ linked: true }));
	} catch (err) {
		next(err);
	}
});

// Remove an item mapping 
router.delete("/item-mappings/:inventoryItemId", requireModule("inventory"), requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const inventoryItemId = req.params.inventoryItemId as string;
		await unlinkQBItem(orgId, inventoryItemId);
		res.json(createSuccessResponse({ linked: false }));
	} catch (err) {
		next(err);
	}
});

// Import a QB item (:id) into this org's inventory
router.post("/items/:id/import", requireModule("inventory"), requirePermission("manage_inventory"), async (req, res, next) => {
	try{
		const orgId = req.user!.organization_id as string;
		const qbItemId = req.params.id as string;
		const result = await importQBItem(orgId, qbItemId, {
			actor_type: "dispatcher",
			actor_id: req.user!.uid,
		});

		res.status(201).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.post("/items/:id/push", requireModule("inventory"), requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const itemId = req.params.id as string;
		await pushItem(orgId, itemId);
		res.json(createSuccessResponse({ pushed: true }));
	} catch (err) {
		next(err);
	}
});

// ── Vendors ──────────────────────────────────────────────────────────────────
// Same permission split as items: vendor identity is inventory metadata, not an
// accounting setting, and the people receiving stock are the ones who notice a
// vendor is missing.

router.get("/vendors", requireModule("inventory"), requirePermission("view_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		res.json(createSuccessResponse(await getQBVendors(orgId)));
	} catch (err) {
		next(err);
	}
});

router.get("/vendors/mappings", requireModule("inventory"), requirePermission("view_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		res.json(createSuccessResponse(await getMappedQBVendors(orgId)));
	} catch (err) {
		next(err);
	}
});

router.post("/vendor-mappings", requireModule("inventory"), requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const parsed = linkQBVendorSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						parsed.error.issues[0].message,
					),
				);
		}
		await linkQBVendor(orgId, parsed.data.supplier_id, parsed.data.qb_vendor_id);
		res.status(201).json(createSuccessResponse({ linked: true }));
	} catch (err) {
		next(err);
	}
});

router.delete(
	"/vendor-mappings/:supplierId",
	requireModule("inventory"),
	requirePermission("manage_inventory"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			await unlinkQBVendor(orgId, req.params.supplierId as string);
			res.json(createSuccessResponse({ unlinked: true }));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/vendors/:id/import",
	requireModule("inventory"),
	requirePermission("manage_inventory"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const result = await importQBVendor(orgId, req.params.id as string);
			res.status(201).json(createSuccessResponse(result));
		} catch (err) {
			next(err);
		}
	},
);

// `:id` here is OUR supplier id, matching /items/:id/push.
router.post("/vendors/:id/push", requireModule("inventory"), requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const qbVendorId = await pushVendor(orgId, req.params.id as string);
		res.json(createSuccessResponse({ pushed: true, qb_vendor_id: qbVendorId }));
	} catch (err) {
		next(err);
	}
});

// ── Employees ────────────────────────────────────────────────────────────────

router.get("/employees", requirePermission("view_technicians"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		res.json(createSuccessResponse(await getQBEmployees(orgId)));
	} catch (err) {
		next(err);
	}
});

router.get("/employees/mappings", requirePermission("view_technicians"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		res.json(createSuccessResponse(await getMappedQBEmployees(orgId)));
	} catch (err) {
		next(err);
	}
});

router.post("/employee-mappings", requirePermission("manage_technicians"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const parsed = linkQBEmployeeSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						parsed.error.issues[0].message,
					),
				);
		}
		await linkQBEmployee(orgId, parsed.data.technician_id, parsed.data.qb_employee_id);
		res.status(201).json(createSuccessResponse({ linked: true }));
	} catch (err) {
		next(err);
	}
});

router.delete(
	"/employee-mappings/:technicianId",
	requirePermission("manage_technicians"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			await unlinkQBEmployee(orgId, req.params.technicianId as string);
			res.json(createSuccessResponse({ unlinked: true }));
		} catch (err) {
			next(err);
		}
	},
);

// `:id` here is OUR technician id.
router.post("/employees/:id/push", requirePermission("manage_technicians"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const qbEmployeeId = await pushEmployee(orgId, req.params.id as string);
		res.json(createSuccessResponse({ pushed: true, qb_employee_id: qbEmployeeId }));
	} catch (err) {
		next(err);
	}
});

router.get("/purchase-orders", requireModule("inventory"), requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const qbPurchaseOrders = await queryQBPurchaseOrders(orgId);
		res.json(createSuccessResponse(qbPurchaseOrders));
	} catch (err) {
		next(err);
	}
})

router.post("/purchases/:id/push", requireModule("purchasing"), requirePermission("manage_purchases"), async (req, res, next) => {
    const purchaseId = req.params.id as string;
    const orgId = req.user!.organization_id as string;
    try {
        const qbPurchaseOrderId = await pushPurchase(purchaseId, orgId);
        res.json(createSuccessResponse({ pushed: true, qb_purchase_order_id: qbPurchaseOrderId }));
    } catch (err) {
        await getScopedDb(orgId).purchase.update({ where: { id: purchaseId }, data: { qb_sync_status: "failed" } }).catch(() => {});
        next(err);
    }
});

router.post("/timesheets/:id/push", requirePermission("manage_timesheet"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		await pushTimesheet(orgId, req.params.id as string);
		res.json(createSuccessResponse({ pushed: true }));
	} catch (err) {
		next(err);
	}
});

router.post("/field-purchases/:id/push", requireModule("field_purchases"), requirePermission("review_field_purchases"), async (req, res, next) => {
	const purchaseId = req.params.id as string;
    const orgId = req.user!.organization_id as string;
    try {
        const qbPurchaseOrderId = await pushFieldPurchase(purchaseId, orgId);
        res.json(createSuccessResponse({ pushed: true, qb_purchase_order_id: qbPurchaseOrderId }));
    } catch (err) {
        await getScopedDb(orgId).purchase.update({ where: { id: purchaseId }, data: { qb_sync_status: "failed" } }).catch(() => {});
        next(err);
    }
})

router.get("/purchases/:id/pdf", requireModule("purchasing"), requirePermission("view_purchases"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const purchaseId = req.params.id as string;
        const buffer = await getQBPurchaseOrderAsPDF(orgId, purchaseId);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="purchase-order-${purchaseId}.pdf"`);
        res.send(buffer);
    } catch (err) {
        next(err);
    }
});

router.get("/tax-codes", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const taxCodes = await getQBTaxCodes(orgId);
		res.json(createSuccessResponse(taxCodes));
	} catch (err) {
		next(err);
	}
});

// Whether this QB company uses Automated Sales Tax, plus the org's pass-through tax code
router.get("/tax-preferences", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const [prefs, org] = await Promise.all([
			getQBTaxPrefs(orgId),
			db.organization.findUnique({
				where: { id: orgId },
				select: { qb_passthrough_tax_code_id: true },
			}),
		]);
		res.json(
			createSuccessResponse({
				...prefs,
				passthroughTaxCodeId: org?.qb_passthrough_tax_code_id ?? null,
			}),
		);
	} catch (err) {
		next(err);
	}
});

// Whether QuickBooks will recompute tax on invoices (Automated Sales Tax). Open to every role
// because job pages use it to label tax as an estimate. Read live, never cached (see qbInvoices.ts).
router.get("/tax-calculation", async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		let qbCalculatesTax = false;
		if (await isQBConnected(orgId)) {
			try {
				qbCalculatesTax = (await getQBTaxPrefs(orgId)).automatedSalesTax === true;
			} catch (err) {
				log.warn({ err, orgId }, "tax-calculation: could not read QB preferences");
			}
		}
		res.json(createSuccessResponse({ qb_calculates_tax: qbCalculatesTax }));
	} catch (err) {
		next(err);
	}
});

const passthroughTaxCodeSchema = z.object({
	qb_tax_code_id: z.string().trim().min(1).max(64).nullable(),
});

// QB tax code sent on invoices whose tax spans several tax groups (non-AST companies). null clears it.
router.put("/passthrough-tax-code", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const parsed = passthroughTaxCodeSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						"qb_tax_code_id must be a QuickBooks tax code id or null",
					),
				);
		}
		sendTaxResult(res, await setQBPassthroughTaxCode(orgId, parsed.data.qb_tax_code_id));
	} catch (err) {
		next(err);
	}
});

// Link a tax group to a QB tax code 
router.put("/tax-groups/:id/qb-tax-code", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const taxGroupId = req.params.id as string;
		const qbTaxCodeId = req.body?.qb_tax_code_id;
		if (typeof qbTaxCodeId !== "string" || !qbTaxCodeId.trim()) {
			return res.status(400).json(
				createErrorResponse(ErrorCodes.VALIDATION_ERROR, "qb_tax_code_id is required")
			);
		}
		await linkTaxCode(orgId, taxGroupId, qbTaxCodeId);
		res.json(createSuccessResponse({ linked: true }));
	} catch (err) {
		next(err);
	}
});

// Unlink the tax group from its QB tax code
router.delete("/tax-groups/:id/qb-tax-code", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const taxGroupId = req.params.id as string;
		await linkTaxCode(orgId, taxGroupId, null);
		res.json(createSuccessResponse({ linked: false }));
	} catch (err) {
		next(err);
	}
});

// List QB invoices available to import 
router.get("/invoices/importable", requirePermission("create_invoices"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
		const result = await getImportableQBInvoices(orgId, clientId);
		res.json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

// Full detail of one QB invoice, mapped to the create-invoice form shape
router.get("/invoices/:id/prefill", requirePermission("create_invoices"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await getQBInvoicePrefill(orgId, req.params.id as string);
		res.json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

// Import only the selected QB invoices as local Drafts
router.post("/invoices/import", requirePermission("create_invoices"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const ids = req.body?.qb_invoice_ids;
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
			return res.status(400).json(
				createErrorResponse(ErrorCodes.VALIDATION_ERROR, "qb_invoice_ids must be an array of strings"),
			);
		}
		const result = await importQBInvoices(orgId, ids);
		res.status(201).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.get("/reports/profit-and-loss", requireModule("advanced_reporting"), requirePermission("view_reports"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const query = req.query as ProfitAndLossQuery;
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (typeof value === "string" && value !== "") {
				search.set(key, value);
			}
		}
		const report = await queryProfitAndLossQBReport(orgId, search.toString());
		res.json(createSuccessResponse(report));
	} catch (err) {
		next(err);
	}
});

router.get("/reports/:reportType", requirePermission("view_reports"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const typeParsed = qbReportTypeSchema.safeParse(req.params.reportType);
		if (!typeParsed.success) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, "Unknown report type"));
		}
		const queryParsed = qbReportQuerySchema.safeParse(req.query);
		if (!queryParsed.success) {
			return res.status(404).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, queryParsed.error.issues[0].message));
		}
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(queryParsed.data)) {
			if (typeof value === "string" && value !== "") {
				search.set(key, value);
			}
		} 
		const report = await queryQBReport(orgId, typeParsed.data, search.toString());
		res.json(createSuccessResponse(report))
	} catch (err) {
		next(err);
	}
})

export default router;
