import { isModuleOn } from "../services/entitlementService.js";
import { Router } from "express";
import { imageUpload } from "../lib/upload.js";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import { requirePermission } from '../lib/requirePermissions.js';
// This file does not use the getScopedDb
// but uses where { organization_id: orgId } on thin ice here
import { db } from "../db.js";
import {
	uploadFile,
	deleteFile,
	signImageUrl,
} from "../services/wasabiService.js";
import { z } from "zod";
import { coordsSchema as orgCoordsSchema } from "../lib/validate/shared.js";
import { Prisma } from "../../generated/prisma/client.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { getUserContext } from "../lib/context.js";

const router = Router();

const orgSelect = {
	id: true,
	name: true,
	logo_url: true,
	phone: true,
	address: true,
	coords: true,
	email: true,
	website: true,
	tax_rate: true,
	// UX default only — which restock workflow the UI leads with.
	// Never read by any backend guard (capability is permission-driven).
	restock_mode: true,
	// Orders the unit picker for the org's region. Hides nothing, converts
	// nothing — see schema.prisma for the full rationale.
	measurement_system: true,
	mfa_required: true,
	brand_color: true,
	// null disables the control entirely - see the second sign-off routing in
	// fieldPurchasesController.
	field_purchase_second_signoff_threshold: true,
} as const;

// Everything PATCH can write. mfa_required is logged like the rest; the read
// side (logsController SENSITIVE_CHANGE_KEY) keeps it out of every view.
const AUDITED_FIELDS = [
	"name",
	"phone",
	"address",
	"coords",
	"email",
	"website",
	"restock_mode",
	"measurement_system",
	"mfa_required",
	"brand_color",
	"field_purchase_second_signoff_threshold",
] as const;

async function withSignedLogo<T extends { logo_url: string | null }>(
	org: T,
): Promise<T> {
	return { ...org, logo_url: await signImageUrl(org.logo_url) };
}

router.get("/", async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id;
		if (!orgId)
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Organization not found",
					),
				);
		const org = await db.organization.findUnique({
			where: { id: orgId },
			select: orgSelect,
		});
		if (!org)
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Organization not found",
					),
				);
		res.json(createSuccessResponse(await withSignedLogo(org)));
	} catch (err) {
		next(err);
	}
});

router.patch("/", requirePermission("manage_organization"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id;
		if (!orgId)
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Organization not found",
					),
				);
		const coordsSchema = orgCoordsSchema.nullable().optional();
		const schema = z.object({
			name: z.string().min(1).max(100).optional(),
			phone: z.string().max(30).nullable().optional(),
			address: z.string().max(200).nullable().optional(),
			coords: coordsSchema,
			email: z.string().email().nullable().optional(),
			website: z.string().max(100).nullable().optional(),
			restock_mode: z.enum(["tech_self_serve", "dispatch_prepared"]).optional(),
			measurement_system: z.enum(["imperial", "metric"]).optional(),
			mfa_required: z.boolean().optional(),
			brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #1e3a5f").nullable().optional(),
			field_purchase_second_signoff_threshold: z
				.number()
				.nonnegative()
				.max(99999999.99)
				.nullable()
				.optional(),
		});
		const parsed = schema.safeParse(req.body);
		if (!parsed.success)
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						parsed.error.issues[0].message,
					),
				);
		if (parsed.data.mfa_required === true && !(await isModuleOn(orgId, "security_plus"))) {
			return res
				.status(403)
				.json(
					createErrorResponse(
						ErrorCodes.MODULE_NOT_IN_PLAN,
						"Required two-step login needs Security+, which is not included in your plan",
					),
				);
		}
		const existing = await db.organization.findUnique({
			where: { id: orgId },
			select: orgSelect,
		});
		if (!existing)
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Organization not found",
					),
				);
		const { coords, ...rest } = parsed.data;
		const org = await db.organization.update({
			where: { id: orgId },
			data: {
				...rest,
				...(coords !== undefined
					? { coords: coords ?? Prisma.JsonNull }
					: {}),
			},
			select: orgSelect,
		});
		const changes = buildChanges(existing, parsed.data, AUDITED_FIELDS);
		if (Object.keys(changes).length > 0) {
			const context = getUserContext(req);
			await logActivity({
				event_type: "organization.settings_updated",
				action: "updated",
				entity_type: "organization",
				entity_id: orgId,
				organization_id: orgId,
				actor_type: "dispatcher",
				actor_id: context.dispatcherId ?? null,
				changes,
				ip_address: context.ipAddress,
				user_agent: context.userAgent,
			});
		}
		res.json(createSuccessResponse(await withSignedLogo(org)));
	} catch (err) {
		next(err);
	}
});

const costingSelect = {
	monthly_overhead: true,
	cost_per_mile: true,
	overhead_rate_per_hour: true,
} as const;

router.get("/costing", requirePermission("view_reports"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id;
		if (!orgId)
			return res
				.status(404)
				.json(createErrorResponse(ErrorCodes.NOT_FOUND, "Organization not found"));
		const org = await db.organization.findUnique({
			where: { id: orgId },
			select: costingSelect,
		});

		if (!org)
			return res
				.status(404)
				.json(createErrorResponse(ErrorCodes.NOT_FOUND, "Organization not found"));
		res.json(createSuccessResponse(org));
	} catch (err) {
		next(err);
	}
});

router.patch("/costing", requirePermission("manage_organization"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id;
		if (!orgId)
			return res
				.status(404)
				.json(createErrorResponse(ErrorCodes.NOT_FOUND, "Organization not found"));
		// coerce, because the form sends these as strings
		const schema = z
			.object({
				monthly_overhead: z.coerce.number().min(0).optional(),
				cost_per_mile: z.coerce.number().min(0).optional(),
				// Nullable unlike the other two: 0 prices overhead as free, null means
				// "not set" and dashes the column. Send null to clear — "" coerces to 0.
				overhead_rate_per_hour: z.coerce.number().min(0).nullable().optional(),
			})
			.refine((d) => Object.values(d).some((v) => v !== undefined), {
				message: "At least one field must be provided",
			});
		const parsed = schema.safeParse(req.body);
		if (!parsed.success)
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						parsed.error.issues[0].message,
					),
				);
		const org = await db.organization.update({
			where: { id: orgId },
			data: parsed.data,
			select: costingSelect,
		});
		await logActivity({
			event_type: "organization_costing_updated",
			action: "update",
			entity_type: "organization",
			entity_id: orgId,
			organization_id: orgId,
			actor_type: "user",
			actor_id: req.user!.uid,
		});
		res.json(createSuccessResponse(org));
	} catch (err) {
		next(err);
	}
});

router.post("/logo", requirePermission("manage_organization"), imageUpload.single("image"), async (req, res, next) => {
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
		const orgId = req.user!.organization_id;
		if (!orgId)
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Organization not found",
					),
				);

		const rawUrl = await uploadFile(
			req.file.buffer,
			req.file.mimetype,
			req.file.originalname,
			"org",
		);
		await db.organization.update({
			where: { id: orgId },
			data: { logo_url: rawUrl },
		});
		const signedUrl = await signImageUrl(rawUrl);
		res.json(createSuccessResponse({ url: signedUrl }));
	} catch (err) {
		next(err);
	}
});

router.delete("/logo", requirePermission("manage_organization"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id;
		if (!orgId)
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Organization not found",
					),
				);
		const org = await db.organization.findUnique({
			where: { id: orgId },
			select: { logo_url: true },
		});
		if (org?.logo_url) {
			await deleteFile(org.logo_url);
		}
		await db.organization.update({
			where: { id: orgId },
			data: { logo_url: null },
		});
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

export default router;
