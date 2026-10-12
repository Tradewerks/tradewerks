import type { Router } from "express";
import { z } from "zod";
import { createSuccessResponse } from "../../types/responses.js";
import {
	createTier,
	createVersion,
	listTiers,
	MOVE_MAX,
	moveOrgs,
	patchTier,
	previewMove,
	tierHistory,
	type TierPatch,
} from "../../platform/tiersService.js";
import { moduleCatalog } from "../../lib/entitlements/registry.js";
import { actor, note, param, parse, reason, staff } from "./shared.js";

const limits = z.record(
	z.string(),
	z.number().int().min(0).max(1_000_000_000).nullable(),
);
const contents = z.object({
	modules: z.array(z.string().min(1)).max(50),
	limits,
	note,
});
const label = z.string().trim().min(1).max(60);
const tierKey = z
	.string()
	.regex(
		/^[a-z][a-z0-9_]{1,30}$/,
		"Key: lowercase letters, digits and _ (2–31 characters)",
	);
const patchSchema = z.union([
	z.object({ label, reason }).strict(),
	z.object({ archived: z.boolean(), reason }).strict(),
	z.object({ signupDefault: z.literal(true), reason }).strict(),
]);

export function registerTiers(router: Router): void {
	router.get("/plans", ...staff, async (_req, res) => {
		res.json(createSuccessResponse(await listTiers()));
	});

	router.get("/plans/catalog", ...staff, (_req, res) => {
		res.json(createSuccessResponse(moduleCatalog()));
	});

	router.post("/plans", ...staff, async (req, res) => {
		const body = parse(contents.extend({ key: tierKey, label }), req.body);
		res.status(201).json(
			createSuccessResponse(await createTier(actor(req), body)),
		);
	});

	router.patch("/plans/:key", ...staff, async (req, res) => {
		const { reason: why, ...patch } = parse(patchSchema, req.body);
		res.json(
			createSuccessResponse(
				await patchTier(
					actor(req),
					param(req, "key"),
					patch as TierPatch,
					why,
				),
			),
		);
	});

	router.post("/plans/:key/versions", ...staff, async (req, res) => {
		const body = parse(contents, req.body);
		res.status(201).json(
			createSuccessResponse(
				await createVersion(actor(req), param(req, "key"), body),
			),
		);
	});

	router.get("/plans/:key/history", ...staff, async (req, res) => {
		res.json(createSuccessResponse(await tierHistory(param(req, "key"))));
	});

	router.get("/plans/:key/move-orgs/preview", ...staff, async (req, res) => {
		const from = parse(
			z.string().min(1, "Choose a version to move from"),
			req.query.from,
		);
		res.json(
			createSuccessResponse(await previewMove(param(req, "key"), from)),
		);
	});

	router.post("/plans/:key/move-orgs", ...staff, async (req, res) => {
		const body = parse(
			z.object({
				fromVersionId: z.string().min(1),
				orgIds: z
					.array(z.string().min(1))
					.min(1)
					.max(MOVE_MAX, `Move at most ${MOVE_MAX} orgs at a time`),
				reason,
			}),
			req.body,
		);
		const result = await moveOrgs(
			actor(req),
			param(req, "key"),
			body.fromVersionId,
			body.orgIds,
			body.reason,
		);
		res.json(createSuccessResponse(result));
	});
}
