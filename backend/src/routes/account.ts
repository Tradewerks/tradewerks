import { Router } from "express";
import { createSuccessResponse } from "../types/responses.js";
import { accountDeletionLimiter } from "../platform/rateLimit.js";
import { deleteOwnAccount, getDeletionPreview } from "../services/accountDeletion.js";

// The signed-in person's own account. No permission check on purpose: deleting
// your own account is not something an org role can take away.
const router = Router();

// What deleting this account would do, so the UI can say it before anyone confirms.
router.get("/deletion", async (req, res, next) => {
	try {
		res.json(createSuccessResponse(await getDeletionPreview(req.user!)));
	} catch (err) {
		next(err);
	}
});

router.post("/delete", accountDeletionLimiter, async (req, res, next) => {
	try {
		const result = await deleteOwnAccount(req.user!, req.body, {
			userAgent: req.headers["user-agent"] || undefined,
		});
		res.clearCookie("refreshToken");
		res.json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

export default router;
