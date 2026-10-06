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
		res.json(createSuccessResponse(await withSignedLogo(org)));
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
