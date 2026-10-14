import { Router, type Response } from "express";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import { getUserContext } from "../lib/context.js";
import {
	listSupplierItems,
	upsertSupplierItem,
	updateSupplierItem,
	setPreferredSupplierItem,
	deleteSupplierItem,
} from "../controllers/supplierItemsController.js";
import { requirePermission, requireAnyPermission } from "../lib/requirePermissions.js";

const router = Router();

// Same mapping as routes/suppliers.ts, without the conflict branch — the
// (vendor, item) pair upserts, so there is no collision to report.
function sendControllerErr(res: Response, err: string) {
	const notFound = err.includes("not found");
	return res
		.status(notFound ? 404 : 400)
		.json(
			createErrorResponse(
				notFound ? ErrorCodes.NOT_FOUND : ErrorCodes.VALIDATION_ERROR,
				err,
			),
		);
}

// Reading a vendor's price is part of reading the item — the reorder forecast
// and the item detail page both show it, and neither requires write access.
router.get(
	"/",
	requireAnyPermission("view_inventory", "manage_inventory"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const result = await listSupplierItems(orgId, req.query);
			if (result.err) return sendControllerErr(res, result.err);
			res.json(
				createSuccessResponse(result.supplierItems, {
					count: result.supplierItems!.length,
				}),
			);
		} catch (err) {
			next(err);
		}
	},
);

router.post("/", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await upsertSupplierItem(req.body, orgId, getUserContext(req));
		if (result.err) return sendControllerErr(res, result.err);
		res.status(201).json(createSuccessResponse(result.supplierItem));
	} catch (err) {
		next(err);
	}
});

router.patch("/:id", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await updateSupplierItem(
			req.params.id as string,
			req.body,
			orgId,
			getUserContext(req),
		);
		if (result.err) return sendControllerErr(res, result.err);
		res.json(createSuccessResponse(result.supplierItem));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/prefer", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await setPreferredSupplierItem(
			req.params.id as string,
			orgId,
			getUserContext(req),
		);
		if (result.err) return sendControllerErr(res, result.err);
		res.json(createSuccessResponse(result.supplierItem));
	} catch (err) {
		next(err);
	}
});

router.delete("/:id", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await deleteSupplierItem(
			req.params.id as string,
			orgId,
			getUserContext(req),
		);
		if (result.err) return sendControllerErr(res, result.err);
		res.json(createSuccessResponse({ id: result.id }));
	} catch (err) {
		next(err);
	}
});

export default router;
