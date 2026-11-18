import { Router, Request, Response, NextFunction } from "express";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import { checkToken } from "../controllers/authenticationController.js";
import { setRefreshToken, verifyPendingToken } from "../services/jwtService.js";
import {
	setupTotp,
	enableTotp,
	verifyMfa,
	disableTotp,
	getMfaStatus,
} from "../controllers/mfaController.js";

const router = Router();

interface MfaEnrollAuth {
	userId: string;
	role: string;
	viaEnroll: boolean;
}

function requireAccess(req: Request, res: Response, next: NextFunction) {
	const token = req.headers.authorization?.split(" ")[1];
	if (!token) {
		return res
			.status(401)
			.json(createErrorResponse(ErrorCodes.INVALID_TOKEN, "No token provided"));
	}
	try {
		const decoded = checkToken(token);
		if ((decoded as { stage?: string }).stage) throw new Error("stage token");
		req.user = { ...decoded, permissions: decoded.permissions ?? null };
		next();
	} catch {
		return res
			.status(401)
			.json(createErrorResponse(ErrorCodes.INVALID_TOKEN, "Invalid or expired token"));
	}
}

function requireEnrollOrAccess(req: Request, res: Response, next: NextFunction) {
	const token = req.headers.authorization?.split(" ")[1];
	if (token) {
		try {
			const decoded = checkToken(token);
			if (!(decoded as { stage?: string }).stage) {
				(req as Request & { mfaAuth: MfaEnrollAuth }).mfaAuth = {
					userId: decoded.uid,
					role: decoded.role,
					viaEnroll: false,
				};
				return next();
			}
		} catch {
			/* fall through to pending-token check */
		}
		try {
			const pt = verifyPendingToken(token);
			if (pt.stage === "pending_mfa_enroll") {
				(req as Request & { mfaAuth: MfaEnrollAuth }).mfaAuth = {
					userId: pt.userId,
					role: pt.role,
					viaEnroll: true,
				};
				return next();
			}
		} catch {
			/* fall through to 401 */
		}
	}
	return res
		.status(401)
		.json(createErrorResponse(ErrorCodes.INVALID_TOKEN, "Unauthorized"));
}

router.post("/setup", requireEnrollOrAccess, async (req, res, next) => {
	try {
		const { userId, role } = (req as Request & { mfaAuth: MfaEnrollAuth }).mfaAuth;
		const result = await setupTotp(userId, role);
		res.json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.post("/enable", requireEnrollOrAccess, async (req, res, next) => {
	try {
		const { userId, role, viaEnroll } = (req as Request & { mfaAuth: MfaEnrollAuth }).mfaAuth;
		const { code } = req.body;
		const result = await enableTotp(userId, role, code, viaEnroll, res);
		if ("error" in result) return res.status(400).json(result);
		res.json(createSuccessResponse(result.data));
	} catch (err) {
		next(err);
	}
});

router.post("/verify", async (req, res, next) => {
	try {
		const pendingToken = req.headers.authorization?.split(" ")[1];
		if (!pendingToken) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Missing session token"));
		}
		const { code, backupCode } = req.body;
		const result = await verifyMfa(res, pendingToken, code, backupCode);
		if (!result || "error" in result) {
			return res
				.status(400)
				.json(result ?? createErrorResponse(ErrorCodes.SERVER_ERROR, "Error verifying MFA"));
		}
		res.json(createSuccessResponse(result.data));
	} catch (err) {
		next(err);
	}
});

router.post("/disable", requireAccess, async (req, res, next) => {
	try {
		const { password, code, backupCode } = req.body;
		const result = await disableTotp(req.user!.uid, req.user!.role, password, code, backupCode);
		if (result && "error" in result) return res.status(400).json(result);
		setRefreshToken(res, result.data.refreshToken);
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

router.get("/status", requireAccess, async (req, res, next) => {
	try {
		const result = await getMfaStatus(req.user!.uid, req.user!.role);
		res.json(createSuccessResponse(result.data));
	} catch (err) {
		next(err);
	}
});

export default router;
