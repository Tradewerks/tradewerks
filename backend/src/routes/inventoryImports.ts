import { Router, type RequestHandler } from "express";
import multer from "multer";
import {
	approveFinancial,
	cancelImport,
	commitImport,
	createImport,
	getImport,
	listCandidates,
	listImports,
	patchCandidate,
	retryImport,
	undoImport,
} from "../controllers/inventoryImportsController.js";
import { requireAnyPermission, requirePermission } from "../lib/requirePermissions.js";
import { InventoryImportError } from "../services/inventoryImport/types.js";

const router = Router();
const acceptedExtensions = new Set(["xlsx", "xls", "csv", "pdf", "png", "jpg", "jpeg", "webp", "heic", "heif"]);
const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: Number(process.env.INVENTORY_IMPORT_MAX_FILE_BYTES ?? 10 * 1024 * 1024),
		files: Number(process.env.INVENTORY_IMPORT_MAX_FILES ?? 20),
	},
	fileFilter: (_req, file, callback) => {
		const extension = file.originalname.split(".").pop()?.toLowerCase() ?? "";
		if (acceptedExtensions.has(extension)) callback(null, true);
		else callback(new Error(`Unsupported import file: ${file.originalname}`));
	},
});
const receiveFiles: RequestHandler = (req, res, next) => {
	upload.array("files[]", Number(process.env.INVENTORY_IMPORT_MAX_FILES ?? 20))(req, res, (error) => {
		if (!error) return next();
		if (error instanceof multer.MulterError) {
			const message = error.code === "LIMIT_FILE_SIZE"
				? `Import source exceeds the ${Number(process.env.INVENTORY_IMPORT_MAX_FILE_BYTES ?? 10 * 1024 * 1024)} byte limit`
				: error.code === "LIMIT_FILE_COUNT"
					? `Import accepts at most ${Number(process.env.INVENTORY_IMPORT_MAX_FILES ?? 20)} files`
					: error.message;
			return next(new InventoryImportError(message, "UPLOAD_LIMIT_EXCEEDED", 413));
		}
		return next(new InventoryImportError(
			error instanceof Error ? error.message : "The import source could not be uploaded",
			"INVALID_IMPORT_SOURCE",
			400,
		));
	});
};

router.post("/", requirePermission("manage_inventory"), receiveFiles, createImport);
router.get("/", requireAnyPermission("view_inventory", "manage_inventory"), listImports);
router.get("/:id", requireAnyPermission("view_inventory", "manage_inventory"), getImport);
router.get("/:id/candidates", requireAnyPermission("view_inventory", "manage_inventory"), listCandidates);
router.patch("/:id/candidates/:candidateId", requirePermission("manage_inventory"), patchCandidate);
router.post("/:id/financial-approval", requirePermission("manage_inventory"), approveFinancial);
router.post("/:id/retry", requirePermission("manage_inventory"), retryImport);
router.post("/:id/commit", requirePermission("manage_inventory"), commitImport);
router.post("/:id/undo", requirePermission("manage_inventory"), undoImport);
router.post("/:id/cancel", requirePermission("manage_inventory"), cancelImport);

export default router;
