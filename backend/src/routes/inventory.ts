import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router, type Response } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
} from "../types/responses.js";
import { getUserContext } from '../lib/context.js';
import {
    getAllInventory,
    getLowStockInventory,
    createInventoryItem,
    updateInventoryItem,
    deleteInventoryItem,
    adjustInventoryStock,
    receiveInventoryItem,
    updateItemTracking,
    updateInventoryThreshold,
    importInventoryFromFile,
    exportLowStockToXlsx,
    getInventoryImportTemplate,
    getInventoryItemById,
    getInventoryMovements,
    getItemUsage,
    getItemConsumptionTrend,
    getItemForecast,
    getItemValueHistory,
    getItemPriceHistory,
    listItemSerials,
    listItemBatches,
    getItemTrackingSummary,
    getItemVehicleStock,
    getTrackingEligibility,
    scanInventoryByCode,
    resolveInventoryCode,
    ensureItemCode,
    updateBatch,
    deleteBatch,
    getBatchImpact,
    exportBatchImpactToXlsx,
    getSerialHistory,
    updateSerial,
    deleteSerial,
    getTrackingReconciliation,
    getLinkageAudit,
    applyLinkageMatch,
    getReconcileQueue,
    getReconcileLines,
    getReconcileTargets,
    applyLinkageMatchBulk,
    type ReconcileSort,
    dismissUnmappedName,
    restoreUnmappedName,
    createProvisionalItemForLine,
    listProvisionalItems,
    approveProvisionalItem,
    mergeProvisionalItem,
    rejectProvisionalItem,
} from '../controllers/inventoryController.js';
import {
    getOrgTags,
    createTag,
    updateTag,
    deleteTag,
    setItemTags,
} from '../controllers/inventoryTagController.js';
import { uploadFile, signImageUrl, signImageUrls, toRawUrl } from "../services/wasabiService.js";
import { imageUpload, spreadsheetUpload } from "../lib/upload.js";
import { requirePermission, requireAnyPermission } from '../lib/requirePermissions.js';
import { scanQuerySchema, forecastQuerySchema } from '../lib/validate/inventory.js';



const router = Router();

type WithImageUrls<T> = T & { image_urls: string[] };

async function signItem<T extends { image_urls: string[] }>(item: T): Promise<WithImageUrls<T>> {
    return {
        ...item,
        image_urls: await signImageUrls(item.image_urls),
    };
}

function normalizeImageUrls(body: unknown): void {
    if (!body || typeof body !== "object") return;
    const b = body as { image_urls?: unknown };
    if (Array.isArray(b.image_urls)) {
        b.image_urls = b.image_urls.map((u) => (typeof u === "string" ? toRawUrl(u) : u));
    }
}

// Central error→status mapping so every handler in this file agrees: conflict
// is 409, a "not found" message is 404 (with NOT_FOUND, not VALIDATION_ERROR),
// else 400 VALIDATION_ERROR.
function sendControllerErr(res: Response, result: { err?: string; conflict?: boolean }) {
    const err = result.err ?? "";
    if (result.conflict) {
        return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, err));
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

router.get("/", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const { low_stock, sort } = req.query;
        const orgId = req.user!.organization_id as string;
        const items =
            low_stock === "true"
                ? await getLowStockInventory(orgId)
                : await getAllInventory(orgId, sort as string | undefined);
        const signed = await Promise.all(items.map(signItem));
        res.json(createSuccessResponse(signed, { count: signed.length }));
    } catch (err) {
        next(err);
    }
});

router.post("/", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        normalizeImageUrls(req.body);
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await createInventoryItem(req.body, orgId, context);

        if (result.err) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});

// ── Barcode scan lookup ───────────────────────────────────────────────────────
// NOTE: /scan must be registered BEFORE any /:id routes to avoid param collision.
// view_inventory is held by both dispatcher and technician permission catalogs.

router.get("/scan", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const parsed = scanQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? "Invalid code"));
        }
        const result = await scanInventoryByCode(orgId, parsed.data.code);
        if (result.err === "NOT_FOUND") {
            return res
                .status(404)
                .json(createErrorResponse(ErrorCodes.NOT_FOUND, "No item found for this barcode"));
        }
        if (result.err) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }
        res.json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});

// ── Scan-anything resolve (item, serial, or batch) ─────────────────────────────
// NOTE: /resolve must be registered BEFORE any /:id routes to avoid param collision.

router.get("/resolve", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const parsed = scanQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? "Invalid code"));
        }
        const result = await resolveInventoryCode(orgId, parsed.data.code);
        if (result.err === "NOT_FOUND") {
            return res
                .status(404)
                .json(createErrorResponse(ErrorCodes.NOT_FOUND, "No match found for this code"));
        }
        if (result.err) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }
        if (result.type === "serial") {
            return res.json(
                createSuccessResponse({
                    type: "serial" as const,
                    code: result.code,
                    serialUnitId: result.serialUnitId,
                    status: result.status,
                    item: await signItem(result.item),
                }),
            );
        }
        if (result.type === "batch") {
            return res.json(
                createSuccessResponse({
                    type: "batch" as const,
                    code: result.code,
                    batchId: result.batchId,
                    batchNumber: result.batchNumber,
                    item: await signItem(result.item),
                }),
            );
        }
        res.json(createSuccessResponse({ type: "item" as const, item: await signItem(result.item!) }));
    } catch (err) {
        next(err);
    }
});

// ── Recall + reconciliation ────────────────────────────────────────────────────
// Literal-prefixed paths (serials/, batches/, tracking/) — same "before any
// /:id routes" convention as /scan, /resolve, /provisional above, though none
// of these actually collide (segment shapes differ from every /:id route).

router.get("/serials/:id/history", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await getSerialHistory(id, orgId);
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        res.json(createSuccessResponse({ serial: result.serial, timeline: result.timeline }));
    } catch (err) {
        next(err);
    }
});

router.patch("/serials/:serialId", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const serialId = req.params.serialId as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await updateSerial(serialId, req.body, orgId, context);
        if (result.err) {
            return sendControllerErr(res, result);
        }
        res.json(createSuccessResponse(result.serial));
    } catch (err) {
        next(err);
    }
});

router.delete("/serials/:serialId", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const serialId = req.params.serialId as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await deleteSerial(serialId, orgId, context);
        if (result.err) {
            return sendControllerErr(res, result);
        }
        res.json(createSuccessResponse(null));
    } catch (err) {
        next(err);
    }
});

router.patch("/batches/:batchId", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const batchId = req.params.batchId as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await updateBatch(batchId, req.body, orgId, context);
        if (result.err) {
            return sendControllerErr(res, result);
        }
        res.json(createSuccessResponse(result.batch));
    } catch (err) {
        next(err);
    }
});

router.delete("/batches/:batchId", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const batchId = req.params.batchId as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await deleteBatch(batchId, orgId, context);
        if (result.err) {
            return sendControllerErr(res, result);
        }
        res.json(createSuccessResponse(null));
    } catch (err) {
        next(err);
    }
});

router.get("/batches/:batchId/impact", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const batchId = req.params.batchId as string;
        const result = await getBatchImpact(batchId, orgId);
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        res.json(
            createSuccessResponse({
                batch: result.batch,
                remaining: result.remaining,
                affected_serials: result.affected_serials,
                affected_jobs: result.affected_jobs,
            }),
        );
    } catch (err) {
        next(err);
    }
});

router.get("/batches/:batchId/export", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const batchId = req.params.batchId as string;
        const result = await exportBatchImpactToXlsx(batchId, orgId);
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        res.setHeader("Content-Disposition", 'attachment; filename="batch-recall-report.xlsx"');
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.send(result.buffer);
    } catch (err) {
        next(err);
    }
});

router.get("/tracking/reconciliation", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const result = await getTrackingReconciliation(orgId);
        res.json(createSuccessResponse({ drifts: result.drifts, gaps: result.gaps }));
    } catch (err) {
        next(err);
    }
});

// Per-item serial/batch rollups for the Serials & Batches page header. The
// :itemId/tracking-summary shape has a distinct 2nd segment, so it never
// collides with the literal 2-segment reads above or the /:id mutations below;
// registered here (before /:id) to keep all tracking reads grouped. Same read
// permission as the sibling /:id/serials + /:id/batches listings.
router.get("/:itemId/tracking-summary", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const itemId = req.params.itemId as string;
        const result = await getItemTrackingSummary(itemId, orgId);
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        res.json(createSuccessResponse(result.summary));
    } catch (err) {
        next(err);
    }
});

// Per-vehicle qty breakdown for the Overview tab's "on vehicles" drill-in —
// same 2nd-segment reasoning and read permission as tracking-summary above.
router.get("/:itemId/vehicle-stock", requireModule("vehicle_stock"), requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const itemId = req.params.itemId as string;
        const result = await getItemVehicleStock(itemId, orgId);
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        res.json(createSuccessResponse({ rows: result.rows }));
    } catch (err) {
        next(err);
    }
});

// Whether tracking can be turned on/off/switched right now, and what's blocking
// it. Read by the edit form's Stock & Pricing step so the toggles lock (and
// explain themselves) using the same arithmetic PATCH /:id/tracking enforces.
// Same 2nd-segment reasoning and read permission as tracking-summary above.
router.get("/:itemId/tracking-eligibility", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const itemId = req.params.itemId as string;
        const result = await getTrackingEligibility(itemId, orgId);
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        res.json(createSuccessResponse(result.eligibility));
    } catch (err) {
        next(err);
    }
});

// Literal first segment, so it must be registered before /:id.
router.get("/linkage-audit", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await getLinkageAudit(orgId);
		if (result.err) return sendControllerErr(res, result);
		res.json(
			createSuccessResponse({
				counts: result.counts,
				candidates: result.candidates,
				candidate_total: result.candidate_total,
			}),
		);
	} catch (err) {
		next(err);
	}
});

// Rewrites historical billing rows, so it stays at manage_inventory.
router.post("/linkage-audit/apply", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await applyLinkageMatch(req.body, orgId, context);
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse({ updated: result.updated }));
	} catch (err) {
		next(err);
	}
});

// Literal-first-segment rule again: must precede /:id.
router.get("/reconcile", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const offset = Number(req.query.offset);
		const limit = Number(req.query.limit);
		const result = await getReconcileQueue(orgId, {
			includeDismissed: req.query.include_dismissed === "true",
			origin: typeof req.query.origin === "string" ? req.query.origin : undefined,
			search: typeof req.query.search === "string" ? req.query.search : undefined,
			sort: typeof req.query.sort === "string" ? (req.query.sort as ReconcileSort) : undefined,
			...(Number.isFinite(offset) ? { offset } : {}),
			...(Number.isFinite(limit) ? { limit } : {}),
		});
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse(result.queue));
	} catch (err) {
		next(err);
	}
});

// Read-only drill-in behind one queue row: which documents bill this name.
router.get("/reconcile/lines", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await getReconcileLines(orgId, {
			name: typeof req.query.name === "string" ? req.query.name : undefined,
			itemId: typeof req.query.item_id === "string" ? req.query.item_id : undefined,
			foldedName:
				typeof req.query.folded_name === "string" ? req.query.folded_name : undefined,
		});
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse({ lines: result.lines, total: result.total }));
	} catch (err) {
		next(err);
	}
});

// The same read, reachable from the field. A technician mapping a receipt line
// needs to search the catalog and does not hold `manage_inventory`, so this is a
// second door rather than a widened guard on the reconcile queue's own route.
// Above "/:id", or Express reads "search" as an item id.
router.get(
	"/search",
	requireAnyPermission("view_inventory", "use_inventory", "request_field_purchase"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const limit = Number(req.query.limit);
			const result = await getReconcileTargets(orgId, {
				search: typeof req.query.q === "string" ? req.query.q : undefined,
				...(Number.isFinite(limit) ? { limit } : {}),
			});
			if (result.err) return sendControllerErr(res, result);
			res.json(createSuccessResponse(result.targets));
		} catch (err) {
			next(err);
		}
	},
);

// The map-target picker. Read-only, so it stays at the queue's own permission.
router.get("/reconcile/targets", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const limit = Number(req.query.limit);
		const result = await getReconcileTargets(orgId, {
			search: typeof req.query.q === "string" ? req.query.q : undefined,
			excludeId: typeof req.query.exclude_id === "string" ? req.query.exclude_id : undefined,
			...(Number.isFinite(limit) ? { limit } : {}),
		});
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse(result.targets));
	} catch (err) {
		next(err);
	}
});

// Rewrites historical billing rows in bulk, so it stays at manage_inventory.
// Partial success is a 200 carrying per-name errors — see applyLinkageMatchBulk.
router.post(
	"/reconcile/apply-bulk",
	requirePermission("manage_inventory"),
	async (req, res, next) => {
		try {
			const context = getUserContext(req);
			const orgId = req.user!.organization_id as string;
			const result = await applyLinkageMatchBulk(req.body, orgId, context);
			if (result.err) return sendControllerErr(res, result);
			res.json(createSuccessResponse({ results: result.results, linked: result.linked }));
		} catch (err) {
			next(err);
		}
	},
);

// Reversible on purpose — dismissal is the lazy way out of the queue.
router.post("/reconcile/dismiss", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await dismissUnmappedName(req.body, orgId, context);
		if (result.err) return sendControllerErr(res, result);
		res.status(201).json(createSuccessResponse(result.decision));
	} catch (err) {
		next(err);
	}
});

// Reversible on purpose — dismissal is the lazy way out of the queue.
router.post("/reconcile/restore", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await restoreUnmappedName(req.body, orgId, context);
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

// ── Provisional item management ───────────────────────────────────────────────
// NOTE: /provisional must be registered BEFORE any /:id routes to avoid param collision.

// Deliberately a lower bar than POST /: a dispatcher mid-quote has a name
// and a price, not a full catalog record.
router.post("/provisional", requireAnyPermission("manage_inventory", "edit_quotes", "edit_jobs"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await createProvisionalItemForLine(req.body, orgId, context);
		if (result.err) return sendControllerErr(res, result);
		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.get("/provisional", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await listProvisionalItems(orgId);
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.items));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/approve", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
		const result = await approveProvisionalItem(id, orgId, req.body ?? {}, context);
		// sendControllerErr rather than a flat 404: adopting without a cost
		// basis is a bad request, and the client shows the message inline.
		if (result.err) return sendControllerErr(res, result);
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/merge", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
		const result = await mergeProvisionalItem(id, req.body, orgId, context);
		if (result.err) {
			const status = result.err.includes("Validation")
				? 400
				: result.err.includes("not found")
					? 404
					: 500;
			return res
				.status(status)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/reject", requirePermission("manage_inventory"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
		const result = await rejectProvisionalItem(id, orgId, context);
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

router.patch("/:id", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        normalizeImageUrls(req.body);
        const id = req.params.id as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await updateInventoryItem(id, req.body, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});

router.delete("/:id", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await deleteInventoryItem(id, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse({ message: result.message }));
    } catch (err) {
        next(err);
    }
});

router.patch("/:id/stock", requireAnyPermission("manage_inventory", "use_inventory"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await adjustInventoryStock(id, req.body, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});


router.post(
    "/upload-image",
    requirePermission("manage_inventory"),
    imageUpload.single("image"),
    async (req, res, next) => {
        try {
            if (!req.file) {
                return res
                    .status(400)
                    .json(
                        createErrorResponse(
                            ErrorCodes.VALIDATION_ERROR,
                            "No image file provided",
                        ),
                    );
            }

            const rawUrl = await uploadFile(
                req.file.buffer,
                req.file.mimetype,
                req.file.originalname,
            );
            const signedUrl = await signImageUrl(rawUrl);
            res.json(createSuccessResponse({ url: signedUrl, raw_url: rawUrl }));
        } catch (err) {
            next(err);
        }
    },
);

// ── Bulk import ───────────────────────────────────────────────────────────────

router.post(
    "/import",
    requirePermission("manage_inventory"),
	(req, res, next) => {
		if (["1", "true", "yes", "on"].includes((process.env.INVENTORY_AI_IMPORT_ENABLED ?? "").toLowerCase())) {
			return res
				.status(410)
				.json(createErrorResponse(ErrorCodes.BAD_REQUEST, "Direct inventory imports have been retired. Use /inventory/imports for review and approval."));
		}
		next();
	},
    spreadsheetUpload.single("file"),
    async (req, res, next) => {
        try {
            if (!req.file) {
                return res
                    .status(400)
                    .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "No file provided"));
            }
            const context = getUserContext(req);
            const orgId = req.user!.organization_id as string;
            const result = await importInventoryFromFile(req.file.buffer, orgId, context);
            res.json(createSuccessResponse(result));
        } catch (err) {
            next(err);
        }
    },
);

// ── Low-stock export ──────────────────────────────────────────────────────────

router.get("/export/low-stock", requirePermission("view_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const buffer = await exportLowStockToXlsx(orgId);
        res.setHeader("Content-Disposition", 'attachment; filename="low-stock-report.xlsx"');
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.send(buffer);
    } catch (err) {
        next(err);
    }
});

// ── Import template ───────────────────────────────────────────────────────────

router.get("/template", async (_req, res, next) => {
    try {
        const buffer = getInventoryImportTemplate();
        res.setHeader(
            "Content-Disposition",
            'attachment; filename="inventory-import-template.xlsx"',
        );
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.send(buffer);
    } catch (err) {
        next(err);
    }
});

// ── Inventory threshold ───────────────────────────────────────────────────────

router.patch("/:id/threshold", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await updateInventoryThreshold(id, req.body, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});

// ── Label printing ────────────────────────────────────────────────────────────

router.post("/:id/ensure-code", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const result = await ensureItemCode(id, orgId);

        if (result.err) {
            return sendControllerErr(res, result);
        }

        res.json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});

// ── Receive stock (optionally serial/batch tracked) ───────────────────────────

router.post("/:id/receive", requireAnyPermission("manage_inventory", "use_inventory"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await receiveInventoryItem(id, req.body, orgId, context);

        if (result.err) {
            return sendControllerErr(res, result);
        }

        res.json(
            createSuccessResponse({
                item: await signItem(result.item!),
                created_serials: result.created_serials,
                batch: result.batch,
            }),
        );
    } catch (err) {
        next(err);
    }
});

// ── Toggle serialized/batch tracking (gated on zero on-hand stock) ───────────

router.patch("/:id/tracking", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await updateItemTracking(id, req.body, orgId, context);

        if (result.err) {
            return sendControllerErr(res, result);
        }

        res.json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});

// ── Item tags ─────────────────────────────────────────────────────────────────

router.put("/:id/tags", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const context = getUserContext(req);
        const orgId = req.user!.organization_id as string;
        const result = await setItemTags(id, req.body, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// ── Org tags CRUD ─────────────────────────────────────────────────────────────

router.get("/tags", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const tags = await getOrgTags(orgId);
        res.json(createSuccessResponse(tags));
    } catch (err) {
        next(err);
    }
});

router.post("/tags", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const result = await createTag(req.body, orgId);

        if (result.err) {
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }

        res.status(201).json(createSuccessResponse(result.tag));
    } catch (err) {
        next(err);
    }
});

router.patch("/tags/:tagId", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const tagId = req.params.tagId as string;
        const orgId = req.user!.organization_id as string;
        const result = await updateTag(tagId, req.body, orgId);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }

        res.json(createSuccessResponse(result.tag));
    } catch (err) {
        next(err);
    }
});

router.delete("/tags/:tagId", requirePermission("manage_inventory"), async (req, res, next) => {
    try {
        const tagId = req.params.tagId as string;
        const orgId = req.user!.organization_id as string;
        const result = await deleteTag(tagId, orgId);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }

        res.json(createSuccessResponse({ message: "Tag deleted" }));
    } catch (err) {
        next(err);
    }
});

// ── History tab (item detail page) ────────────────────────────────────────────
// Registered before the single-item GET /:id catch route below, ahead of the
// 2-segment /:id/* reads.
//
// PERMISSIONS — deliberate asymmetry: these five reads require view_inventory
// OR manage_inventory, while the org-wide equivalent
// (/reports/inventory/reorder-forecast) requires view_reports. Drilling into
// ONE item you can already see is an inventory activity; ranking every item
// against each other is a reporting activity.

router.get("/:id/usage", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await getItemUsage(id, orgId, req.query);
        if (result.err) return sendControllerErr(res, result);
        // Spread, not a hand-picked field list: `unitBasis` was silently dropped
        // here, so a mixed-unit item's withheld totals reached the client with no
        // explanation (same lesson as value-history below).
        const { err: _err, ...payload } = result;
        res.json(createSuccessResponse(payload));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/consumption-trend", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await getItemConsumptionTrend(id, orgId, req.query);
        if (result.err) return sendControllerErr(res, result);
        const { err: _err, ...payload } = result;
        res.json(createSuccessResponse(payload));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/forecast", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const query = forecastQuerySchema.safeParse(req.query);
        if (!query.success) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        `Validation failed: ${query.error.issues.map((i) => i.message).join(", ")}`,
                    ),
                );
        }
        const result = await getItemForecast(id, orgId, { lookbackDays: query.data.lookbackDays });
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        // Envelope, not the bare row: a null forecast needs `reason` alongside
        // it to say WHY (inactive vs no forecastable row) — the two read very
        // differently to a dispatcher.
        res.json(createSuccessResponse({ forecast: result.forecast, reason: result.reason }));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/value-history", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await getItemValueHistory(id, orgId, req.query);
        if (result.err) return sendControllerErr(res, result);
        // Everything the controller returned except its error slot. Listing the
        // fields by hand meant a new one silently failed to reach the client.
        const { err: _err, ...payload } = result;
        res.json(createSuccessResponse(payload));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/price-history", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await getItemPriceHistory(id, orgId, req.query);
        if (result.err) return sendControllerErr(res, result);
        const { err: _err, ...payload } = result;
        res.json(createSuccessResponse(payload));
    } catch (err) {
        next(err);
    }
});

// Single-item read for the product/detail page. Registered here — after every
// literal single-segment GET route (/scan, /resolve, /tags, /template,
// /provisional) — so those resolve first and this only catches genuine ids.
// Sits below the History-tab 2-segment reads above and above /:id/movements,
// /:id/serials, /:id/batches below (all distinct depth from /:id, so
// registration order doesn't affect routing).
router.get("/:id", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await getInventoryItemById(id, orgId);
        if (result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
        }
        res.json(createSuccessResponse(await signItem(result.item!)));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/movements", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const { cursor, limit } = req.query as { cursor?: string; limit?: string };
        const result = await getInventoryMovements(
            id,
            orgId,
            cursor,
            limit ? parseInt(limit, 10) : 25,
            req.query,
        );
        if (result.err) return sendControllerErr(res, result);
        res.json(createSuccessResponse({ movements: result.movements, nextCursor: result.nextCursor }));
    } catch (err) {
        next(err);
    }
});

// ── Serial/batch listings ─────────────────────────────────────────────────────

router.get("/:id/serials", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await listItemSerials(id, req.query, orgId);
        if (result.err) return sendControllerErr(res, result);
        res.json(createSuccessResponse({ serials: result.serials, nextCursor: result.nextCursor }));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/batches", requireAnyPermission("view_inventory", "manage_inventory"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await listItemBatches(id, orgId, req.query);
        if (result.err) return sendControllerErr(res, result);
        res.json(createSuccessResponse({ batches: result.batches }));
    } catch (err) {
        next(err);
    }
});

export default router;
