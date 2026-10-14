import { Router, type Request, type RequestHandler, type Response } from "express";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import { getUserContext } from "../lib/context.js";
import {
	createPurchase,
	listPurchases,
	getPurchase,
	updatePurchase,
	replacePurchaseLines,
	orderPurchase,
	cancelPurchase,
	deletePurchase,
	receivePurchase,
} from "../controllers/purchasesController.js";
import { requireAnyPermission, requirePermission } from "../lib/requirePermissions.js";
import { generatePurchaseOrderPdf } from "../lib/pdf/pdfService.js";

const router = Router();

// Same shape as routes/fieldPurchases.ts's sendControllerErr.
function sendControllerErr(res: Response, err: string) {
	const notFound = err.includes("not found");
	const status = notFound ? 404 : 400;
	return res
		.status(status)
		.json(createErrorResponse(notFound ? ErrorCodes.NOT_FOUND : ErrorCodes.VALIDATION_ERROR, err));
}

const view = requireAnyPermission("view_purchases", "manage_purchases");
const manage = requirePermission("manage_purchases");

router.get("/", view, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const query = req.query;
		const result = await listPurchases(orgId, query);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(200).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.post("/", manage, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await createPurchase(orgId, req.body, context);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(201).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.get("/:id", view, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const result = await getPurchase(orgId, id);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(200).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.patch("/:id", manage, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const data = req.body;
		const context = getUserContext(req);
		const result = await updatePurchase(orgId, id, data, context);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(200).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.put("/:id/lines", manage, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const data = req.body;
		const context = getUserContext(req)
		const result = await replacePurchaseLines(orgId, id, data, context);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(200).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/order", manage, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const context = getUserContext(req);
		const result = await orderPurchase(orgId, id, context);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(200).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/cancel", manage, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const data = req.body;
		const context = getUserContext(req);
		const result = await cancelPurchase(orgId, id, data, context);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(200).json(createSuccessResponse(result)); 
	} catch (err) {
		next(err);
	}
});

router.delete("/:id", manage, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const context = getUserContext(req);
		const result = await deletePurchase(orgId, id, context);
		if (result.err) {
			return sendControllerErr(res, result.err)
		}

		res.status(200).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.get("/:id/pdf", view, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const buffer = await generatePurchaseOrderPdf(id, orgId);
		res.setHeader("Content-Type", "application/pdf");
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="purchase-${id}.pdf"`,
		);
		res.send(buffer);
	} catch (err: any) {
		if (err?.status === 404)
			return res
				.status(404)
				.json(createErrorResponse(ErrorCodes.NOT_FOUND, "Purchase not found"));
		next(err);
	}
});

router.post("/:id/receive", manage, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const context = getUserContext(req);
		const result = await receivePurchase(orgId, id, req.body, context);
		if (result.err) return sendControllerErr(res, result.err);
		res.status(200).json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
})

export default router;
