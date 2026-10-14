import { Router, type Response } from "express";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import { getUserContext } from "../lib/context.js";
import {
	listSuppliers,
	createSupplier,
	updateSupplier,
	mergeSuppliers,
	getSupplierDetail,
	getSupplierMovements,
	getSupplierBatches,
} from "../controllers/suppliersController.js";
import { requirePermission, requireAnyPermission } from "../lib/requirePermissions.js";

const router = Router();

// Same mapping as routes/inventory.ts, with one addition: a name collision
// carries the existing supplier in `details` so the caller can adopt it instead
// of making the user retype.
function sendControllerErr(
	res: Response,
	result: { err?: string; conflict?: boolean; supplier?: unknown },
) {
	const err = result.err ?? "";
	if (result.conflict) {
		return res
			.status(409)
			.json(createErrorResponse(ErrorCodes.CONFLICT, err, result.supplier));
	}
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

// Read is view_inventory OR manage_inventory: the capture typeahead runs on
// every intake path, including the technician-side ones.
router.get("/", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await listSuppliers(orgId, req.query);
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse(result.suppliers, { count: result.suppliers!.length }));
	} catch (err) {
		next(err);
	}
});

// Explicit creation is manage_inventory. Create-on-write from an intake path is
// a different door (resolveSupplier, inside the receive transaction) and stays
// open to whoever is already allowed to record that receipt.
router.post("/", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await createSupplier(req.body, orgId, context);
		if (result.err) return sendControllerErr(res, result);
		res.status(201).json(createSuccessResponse(result.supplier));
	} catch (err) {
		next(err);
	}
});

router.patch("/:id", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const context = getUserContext(req);
		const result = await updateSupplier(id, req.body, orgId, context);
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse(result.supplier));
	} catch (err) {
		next(err);
	}
});

// Read-only detail page: full row + usage counts, purchase ledger, and lots.
// Same permission split as the list — view_inventory can look, only
// manage_inventory can edit (handled by the PATCH above).
router.get(
	"/:id",
	requireAnyPermission("view_inventory", "manage_inventory"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const id = req.params.id as string;
			const result = await getSupplierDetail(id, orgId);
			if (result.err) return sendControllerErr(res, result);
			res.json(createSuccessResponse(result.supplier));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/movements",
	requireAnyPermission("view_inventory", "manage_inventory"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const id = req.params.id as string;
			const { cursor, limit } = req.query as { cursor?: string; limit?: string };
			const result = await getSupplierMovements(
				id,
				orgId,
				cursor,
				limit ? parseInt(limit, 10) : 25,
			);
			if (result.err) return sendControllerErr(res, result);
			res.json(
				createSuccessResponse({ movements: result.movements, nextCursor: result.nextCursor }),
			);
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/batches",
	requireAnyPermission("view_inventory", "manage_inventory"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const id = req.params.id as string;
			const result = await getSupplierBatches(id, orgId);
			if (result.err) return sendControllerErr(res, result);
			res.json(createSuccessResponse({ batches: result.batches }));
		} catch (err) {
			next(err);
		}
	},
);

router.post("/:id/merge", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const context = getUserContext(req);
		const result = await mergeSuppliers(id, req.body, orgId, context);
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse({ moved: result.moved, target: result.target }));
	} catch (err) {
		next(err);
	}
});

export default router;
