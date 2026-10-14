import "dotenv/config";
import cors from "cors";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "./types/responses.js";
import * as notificationsController from "./controllers/notificationsController.js";
import { startVisitReminderInterval } from "./services/notifications.js";
import { startInvoiceSchedulerInterval } from "./services/invoiceScheduler.js";
import { startFollowupSchedulerInterval } from "./services/followupScheduler.js";
import { startMaintenanceReminderInterval } from "./services/vehicleMaintenanceScheduler.js";
import { startLateArrivalInterval } from "./services/lateArrivalScheduler.js";
import { startTrialSchedulerInterval } from "./services/trialScheduler.js";
import { rearmWrappingUpTimers } from "./services/wrappingUpTimer.js";
import multer from "multer";
import {
	login,
	logout,
	checkToken,
	issueAuthTokens,
	resetPassword,
	checkResetToken,
} from "./controllers/authenticationController.js";
import { verifyOTP } from "./services/otpServce.js";
import { log } from "./services/appLogger.js";
import { recentActivityRoute } from "./controllers/logsController.js";
import {
	httpMetricsMiddleware,
	prometheusExporter,
} from "./services/metricsService.js";
import pinoHttp from "pino-http";
import http from "http";
import { Server } from "socket.io";
import { initSocket } from "./services/socketService.js";
import { refreshAccessToken, verifyToken as verifyAccessToken } from "./services/jwtService.js";

// ============================================
// Routers
// ============================================
import clientsContactsRouter from "./routes/clientsContacts.js";
import dispatchersRouter from "./routes/dispatchers.js";
import disputesRouter from "./routes/disputes.js";
import draftsRouter from "./routes/drafts.js";
import emailRouter from "./routes/email.js";
import inventoryRouter from "./routes/inventory.js";
import invoicesRouter from "./routes/invoices.js";
import jobsRouter from "./routes/jobs.js";
import jobVisitsRouter from "./routes/jobVisits.js";
import occurrencesRouter from "./routes/occurrences.js";
import orgRouter from "./routes/org.js";
import organizationsRouter from "./routes/organizations.js";
import quotesRouter from "./routes/quotes.js";
import recurringPlansRouter from "./routes/recurringPlans.js";
import reportsRouter from "./routes/reports.js";
import requestsRouter from "./routes/requests.js";
import suppliersRouter from "./routes/suppliers.js";
import supplierItemsRouter from "./routes/supplierItems.js";
import fieldPurchasesRouter from "./routes/fieldPurchases.js";
import purchasesRouter from "./routes/purchases.js";
import techniciansRouter from "./routes/technicians.js";
import vehiclesRouter from "./routes/vehicles.js";
import notificationsRouter, { dispatcherNotificationsRouter } from "./routes/notifications.js";
import taxRouter from "./routes/tax.js";
import organizationRolesRouter from "./routes/organizationRoles.js";
import quickbooksRouter from "./routes/quickbooks.js";
import oauthRouter from "./routes/oauth.js";
import mfaRouter from "./routes/mfa.js";
import platformRouter from "./routes/platform/index.js";
import { platformProxyWarning, trustProxySetting } from "./platform/staffToken.js";
import ssoRouter from "./routes/sso.js"
import followupsRouter from "./routes/followups.js";
import projectsRouter from "./routes/projects.js";
import searchRouter from "./routes/search.js";
import assistantRouter from "./routes/assistant.js";
import timesheetsRouter from "./routes/timesheets.js";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 15;

// ============================================
// MIDDLEWARE
// ============================================
import { handleCallback, QB_ENABLED } from "./services/quickbooksService.js";
import { handleQBWebhook } from "./services/qb/qbWebhook.js"
import { handlePostmarkWebhook } from "./services/postmarkWebhook.js";
import { isUserActive } from "./services/userActiveCache.js";
import { assertRegistry } from "./lib/entitlements/registry.js";
import { assertBusinessTypes } from "./lib/entitlements/businessTypes.js";
import { requireModule } from "./lib/entitlements/requireModule.js";
import { registerEntitlementBlockers } from "./lib/entitlements/blockers.js";
import orgEntitlementsRouter from "./routes/orgEntitlements.js";
import moduleNoticesRouter from "./routes/moduleNotices.js";

const errorHandler = (
	err: any,
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
		return res
			.status(400)
			.json(
				createErrorResponse(
					ErrorCodes.VALIDATION_ERROR,
					`File too large. Maximum allowed size is ${MAX_UPLOAD_MB}MB.`,
				),
			);
	}

	log.error(
		{ err, method: req.method, path: req.path },
		"Unhandled request error",
	);

	// httpError carries statusCode; InvalidTransitionError and
	// DocumentRuleError carry status. Reading only one turned a deliberate
	// refusal that reached this handler into a 500.
	const statusCode = err.statusCode || err.status || 500;

	res.status(statusCode).json(
		createErrorResponse(
			err.code ||
				(statusCode < 500 ? ErrorCodes.VALIDATION_ERROR : ErrorCodes.SERVER_ERROR),
			err.message || "An unexpected error occurred",
			process.env.NODE_ENV === "development" ? err.stack : undefined,
		),
	);
};

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	cyan: "\x1b[36m",
	red: "\x1b[31m",
	brightRed: "\x1b[91m",
} as const;

// Docker allocates no TTY for these containers, so process.stdout.isTTY is
// false even though `docker logs` passes ANSI through fine. Gate on an env
// var instead: set LOG_COLOR=0 when capturing logs to a file.
const COLOR_LOGS = process.env["LOG_COLOR"] !== "0";

const statusColor = (status: number) => {
	if (!COLOR_LOGS) return "";
	if (status >= 500) return ANSI.brightRed;
	if (status >= 400) return ANSI.red;
	if (status >= 300) return ANSI.cyan;
	return ANSI.green;
};

const requestLogger = (req: Request, res: Response, next: NextFunction) => {
	const startedAt = process.hrtime.bigint();

	// Log on finish, not on entry (the status code does not exist yet here)
	res.on("finish", () => {
		const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
		const timestamp = new Date().toISOString();
		const color = statusColor(res.statusCode);
		const off = color ? ANSI.reset : "";
		const dim = COLOR_LOGS ? ANSI.dim : "";
		// req.path, not originalUrl (the query string carries OAuth codes)
		console.log(
			`${dim}[${timestamp}]${off} ${color}${res.statusCode}${off} ${req.method} ${req.path} ${dim}${ms.toFixed(1)}ms${off}`,
		);
	});

	next();
};

const notFoundHandler = (req: Request, res: Response) => {
	res.status(404).json(
		createErrorResponse(
			ErrorCodes.NOT_FOUND,
			`Route ${req.method} ${req.path} not found`,
		),
	);
};

const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
	if (req.method === "OPTIONS") return next();

	const token = req.headers.authorization?.split(" ")[1];
	if (!token)
		return res
			.status(401)
			.json(
				createErrorResponse(
					ErrorCodes.INVALID_TOKEN,
					"No token provided",
				),
			);

	try {
		const decoded = checkToken(token);
		if ((decoded as any).stage) {
			return res
				.status(401)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_TOKEN,
						"Invalid or expired token",
					),
				);
		}
		if (!(await isUserActive(decoded.uid, decoded.role))) {
			return res
				.status(401)
				.json(createErrorResponse(ErrorCodes.INVALID_TOKEN, "Invalid or expired token"));
		}
		req.user = { ...decoded, permissions: decoded.permissions ?? null };
		next();
	} catch {
		res.status(401).json(
			createErrorResponse(
				ErrorCodes.INVALID_TOKEN,
				"Invalid or expired token",
			),
		);
	}
};

// replaced with role based permissions, keeping in case its needed at a future date
/*const requireRole = (...roles: string[]) => {
	return (req: Request, res: Response, next: NextFunction) => {
		if (!req.user) {
			return res
				.status(401)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_TOKEN,
						"Not authenticated",
					),
				);
		}
		// adds admin permissions to dispatchers since they have the same UI access
		const effective = roles.includes("dispatcher")
			? [...roles, "admin"]
			: roles;
		if (!effective.includes(req.user.role)) {
			return res
				.status(403)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_CREDENTIALS,
						"Insufficient permissions",
					),
				);
		}
		next();
	};
};*/

// ============================================
// APP SETUP
// ============================================

const app = express();
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
const proxyWarning = platformProxyWarning(process.env);
if (proxyWarning) log.warn(proxyWarning);

assertRegistry();
assertBusinessTypes();
registerEntitlementBlockers();

app.use(
	express.json({
		// Capture the raw request bytes so inbound webhooks (QuickBooks) can
		// verify an HMAC signature over the exact payload Intuit signed
		verify: (req, _res, buf) => {
			(req as express.Request).rawBody = buf;
		},
	}),
);
// Bearer tokens (staff tokens act on every org) must not reach stdout or Loki.
app.use(pinoHttp({ logger: log, redact: ["req.headers.authorization", "req.headers.cookie"] }));
app.use(httpMetricsMiddleware);

// Expose Prometheus metrics at /metrics
app.get("/metrics", (req, res) =>
	prometheusExporter.getMetricsRequestHandler(req, res),
);
app.use(requestLogger);

let frontend: string | undefined = process.env["FRONTEND_URL"];
if (!frontend) {
	log.warn("No FRONTEND_URL configured, defaulting to http://localhost:5173");
	frontend = "http://localhost:5173";
}

const corsOptions = {
	//origin: process.env.NODE_ENV === "production" ? frontend : "*",
	origin: frontend,
	credentials: true,
};

app.use(cors(corsOptions));

const server = http.createServer(app);
const io = new Server(server, {
	cors: corsOptions,
});
initSocket(io);

// Inject io into notifications so createNotification can emit in real-time
notificationsController.setSocketIo(io);
startVisitReminderInterval();
startInvoiceSchedulerInterval();
startFollowupSchedulerInterval();
startMaintenanceReminderInterval();
startLateArrivalInterval();
startTrialSchedulerInterval();
rearmWrappingUpTimers().catch((e) =>
	log.error(e, "Failed to rearm WrappingUp timers"),
);

// Reject sockets without a valid JWT; room membership must come from verified
// claims, never from client-supplied handshake query params.
io.use(async (socket, next) => {
	const token = socket.handshake.auth?.["token"] as string | undefined;
	if (!token) return next(new Error("Unauthorized"));
	try {
		const claims = verifyAccessToken(token);
		if (!(await isUserActive(claims.uid, claims.role))) return next(new Error("Unauthorized"));
		socket.data.orgId = claims.organization_id ?? undefined;
		socket.data.techId = claims.role === "technician" ? claims.uid : undefined;
		socket.data.dispatcherId =
			claims.role === "dispatcher" || claims.role === "admin" ? claims.uid : undefined;
		next();
	} catch {
		next(new Error("Unauthorized"));
	}
});

// Each technician/dispatcher joins their personal room; all clients join their org room
io.on("connection", (socket) => {
	const { orgId, techId, dispatcherId } = socket.data as {
		orgId?: string;
		techId?: string;
		dispatcherId?: string;
	};
	if (techId) socket.join(`tech:${techId}`);
	if (dispatcherId) socket.join(`dispatcher:${dispatcherId}`);
	if (orgId) socket.join(`org:${orgId}`);
});

let port: string | undefined = process.env["SERVER_PORT"];
if (!port) {
	log.warn("No SERVER_PORT configured, defaulting to 3000");
	port = "3000";
}

// ============================================
// AUTH ROUTES (public — no verifyToken)
// ============================================

app.post("/login", async (req, res, next) => {
	try {
		const { email, password } = req.body;
		const result = await login(res, email, password);
		if (!result) {
			return res
				.status(401)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_CREDENTIALS,
						"Invalid credentials",
					),
				);
		}
		if ("error" in result) {
			return res.status(401).json(result);
		}

		res.json(createSuccessResponse(result.data));
	} catch (err) {
		next(err);
	}
});

app.post("/logout", async (req, res, next) => {
	try {
		const user = req.user || {};
		const token = req.headers.authorization?.split(" ")[1];
		if (!token) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_TOKEN,
						"No token provided",
					),
				);
		}
		await logout(res, user, token);
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

app.post("/otp-verify", async (req, res, next) => {
	try {
		const { otp } = req.body;
		const pendingToken = req.headers.authorization?.split(" ")[1];
		if (!pendingToken) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_CREDENTIALS,
						"Missing session token",
					),
				);
		}
		const result = await verifyOTP(otp, pendingToken!);
		if (!result) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_TOKEN,
						"Error verifying OTP",
					),
				);
		}
		// log in user by generating access and refresh tokens
		const userId = result.data?.userId;
		const role = result.data?.role;
		log.info({ userId, role }, "OTP verification successful");
		if (!userId || !role) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_TOKEN,
						"Invalid OTP session data",
					),
				);
		}
		const response = await issueAuthTokens(res, userId, role);
		if (!response) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.SERVER_ERROR,
						"Error issuing auth tokens",
					),
				);
		}

		return res.json(createSuccessResponse(response.data));
	} catch (err) {
		next(err);
	}
});

app.post("/reset-password/check", async (req, res, next) => {
	try {
		const status = await checkResetToken(req.body?.token, req.body?.role);
		res.json(createSuccessResponse({ status }));
	} catch (err) {
		next(err);
	}
});

app.post("/reset-password", async (req, res, next) => {
	try {
		const { token, newPassword, role } = req.body;
		const result = await resetPassword(token, newPassword, role);

		if (result.err || !result.userId || !result.role) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						result.err,
					),
				);
		}
		const authResult = await issueAuthTokens(res, result.userId, result.role);
		res.json(createSuccessResponse(authResult?.data ?? null));
	} catch (err) {
		next(err);
	}
});

app.post("/refresh-token", async (req, res, next) => {
	try {
		const cookieHeader = req.headers.cookie ?? "";
		const match = cookieHeader
			.split(";")
			.find((c) => c.trim().startsWith("refreshToken="));
		const refreshToken = match?.trim().slice("refreshToken=".length);
		if (!refreshToken) {
			return res
				.status(401)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_TOKEN,
						"No refresh token provided",
					),
				);
		}
		const result = await refreshAccessToken(refreshToken);
		if (typeof result !== "string") return res.status(401).json(result);
		res.json(createSuccessResponse({ token: result, expiresIn: 900 }));
	} catch (e) {
		next(e);
	}
});


// ================================================================================
// QUICKBOOKS OAUTH CALLBACK (public — no verifyToken, browser redirect from Intuit)
// ================================================================================
app.get("/integrations/quickbooks/callback", async (req, res, next) => {
	// QuickBooks temporarily disabled (see quickbooksService.QB_ENABLED).
	if (!QB_ENABLED)
		return res.redirect(`${process.env.FRONTEND_URL}/quickbooks/callback?qb=error`);
	try {
		const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
		const realmId = req.query.realmId as string;
		const state = req.query.state as string;
		await handleCallback(fullUrl, state, realmId);
		res.redirect(`${process.env.FRONTEND_URL}/quickbooks/callback?qb=connected`);
	} catch (err) {
		res.redirect(`${process.env.FRONTEND_URL}/quickbooks/callback?qb=error`);
	}
});
app.post("/integrations/quickbooks/webhook", (req, res) => {
	// QuickBooks temporarily disabled (see quickbooksService.QB_ENABLED).
	if (!QB_ENABLED) return res.sendStatus(404);
	return handleQBWebhook(req, res);
});
app.post("/integrations/postmark/webhook", handlePostmarkWebhook);

// ================================================================================
// OAUTH2 AUTHORIZATION SERVER 
// ================================================================================
app.use("/oauth", oauthRouter);

// ================================================================================
// MFA (public mount — the router applies its own per-route auth guards)
// ================================================================================
app.use("/mfa", mfaRouter);
app.use("/platform", platformRouter);

// ================================================================================
// SSO 
// ================================================================================
app.use("/auth/sso", ssoRouter);

// ================================================================================
// ORGANIZATION (unlike org this is used for registration and doesn't require auth)
// ================================================================================
app.use("/organizations", organizationsRouter);

// ================================================================================
// ORGANIZATION ROLES
// ================================================================================
app.use("/organization-roles", verifyToken, organizationRolesRouter);

// ============================================
// DRAFT ROUTES
// ============================================
app.use("/drafts", verifyToken, draftsRouter);

// ============================================
// REQUEST ROUTES
// ============================================
app.use("/requests", verifyToken, requestsRouter);

// ============================================
// QUOTE ROUTES
// ============================================
app.use("/quotes", verifyToken, requireModule("quotes"), quotesRouter);

// ============================================
// JOBS
// ============================================
app.use("/jobs", verifyToken, jobsRouter);

// ============================================
// JOB VISITS
// ============================================
app.use("/job-visits", verifyToken, jobVisitsRouter);

// ============================================
// RECURRING PLANS
// ============================================
app.use("/recurring-plans", verifyToken, requireModule("recurring_plans"), recurringPlansRouter);

// ============================================
// OCCURRENCE ROUTES
// ============================================
app.use("/occurrences", verifyToken, requireModule("recurring_plans"), occurrencesRouter);

// ============================================
// INVOICE ROUTES
// ============================================
app.use("/invoices", verifyToken, invoicesRouter);
app.use("/disputes", verifyToken, requireModule("disputes"), disputesRouter);

// ============================================
// TECHNICIANS
// ============================================
app.use("/technicians", verifyToken, techniciansRouter);
app.use("/technicians", verifyToken, notificationsRouter);
app.use("/timesheets", verifyToken, timesheetsRouter);

// ============================================
// DISPATCHERS
// ============================================
app.use("/dispatchers", verifyToken, dispatchersRouter);
app.use("/dispatchers", verifyToken, dispatcherNotificationsRouter);

// ============================================
// Email
// ============================================
app.use("/email", verifyToken, emailRouter);

// ============================================
// INVENTORY
// ============================================
app.use("/inventory", verifyToken, requireModule("inventory"), inventoryRouter);

// ============================================
// SUPPLIERS (vendor origin for purchased stock)
// ============================================
app.use("/suppliers", verifyToken, requireModule("inventory"), suppliersRouter);
app.use("/supplier-items", verifyToken, requireModule("inventory"), supplierItemsRouter);
app.use(
	"/field-purchases",
	verifyToken,
	requireModule("field_purchases", undefined, { readOnlyPaths: [/^\/limit-check$/] }),
	fieldPurchasesRouter,
);
app.use("/purchases", verifyToken, requireModule("purchasing"), purchasesRouter);

// ── Org settings ─────────────────────────────────────────────────────────────
// Above /org on purpose: that router would otherwise take the path.
app.use(
	"/org/entitlements/notices",
	verifyToken,
	requireModule("inventory", "read"),
	moduleNoticesRouter,
);
app.use("/org/entitlements", verifyToken, orgEntitlementsRouter);
app.use("/org", verifyToken, orgRouter);

// ============================================
// REPORTS
// ============================================
app.use("/reports", verifyToken, reportsRouter);

// ============================================
// VEHICLES
// ============================================
app.use(
	"/vehicles",
	verifyToken,
	requireModule("fleet", undefined, {
		readOnlyPaths: [/^\/[^/]+\/maintenance\/purchase-lines$/],
	}),
	vehiclesRouter,
);

// ============================================
// TAX RATES & GROUPS
// ============================================
app.use("/tax", verifyToken, taxRouter);

// ============================================
// QUICKBOOKS
// ============================================
app.use("/integrations/quickbooks", verifyToken, requireModule("quickbooks"), quickbooksRouter);

// ============================================
// AUTOMATED FOLLOWUPS
// ============================================
app.use("/followups", verifyToken, requireModule("followups"), followupsRouter);

// ============================================
// PROJECTS
// ============================================
app.use("/projects", verifyToken, requireModule("projects"), projectsRouter);

// ============================================
// AI ASSISTANT
// ============================================
app.use("/assistant", verifyToken, requireModule("ai_assistant"), assistantRouter);

// ============================================
// CROSS-ENTITY SEARCH
// ============================================
// Must stay above the clientsContacts mount below: that router is mounted at
// "/" and would otherwise swallow this path.
app.use("/search", verifyToken, searchRouter);

// ============================================
// CLIENTS + CONTACTS
// ============================================
// since its mounted at / everything will be sent here
// which can cause performance issues if scaled
app.use("/", verifyToken, clientsContactsRouter);

// ============================================================
// ACTIVITY FEED
// ============================================================

// Access rules (self / view_* permission / no technicians on the org-wide
// feed) live in logsController.requireFeedAccess.
app.get("/logs/recent", verifyToken, ...recentActivityRoute);
app.use(notFoundHandler);
app.use(errorHandler);

server.listen(port, () => {
	log.info({ port }, "Server started");
});
