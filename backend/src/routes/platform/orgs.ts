import type { Request, Response, Router } from "express";
import { z } from "zod";
import { createSuccessResponse } from "../../types/responses.js";
import {
	applyStaffChange,
	applyStaffChanges,
	previewStaffChange,
	previewStaffChanges,
	type StaffChange,
} from "../../services/entitlementService.js";
import { LIMIT_KEYS, type LimitKey } from "../../lib/entitlements/registry.js";
import { getOrgDetail, getOrgHistory, listOrgs } from "../../platform/orgsService.js";
import { actor, param, parse, reason, staff } from "./shared.js";

const limitKey = z.enum(LIMIT_KEYS as unknown as [string, ...string[]]);
const override = z.union([
	z.number().int().min(0).max(1_000_000_000),
	z.null(),
	z.literal("tier"),
]);
const trial = z
	.object({ planVersionId: z.string().min(1), endsAt: z.string().datetime() })
	.nullable();
const changeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("plan"), planVersionId: z.string().min(1) }),
	z.object({ kind: z.literal("trial"), trial }),
	z.object({
		kind: z.literal("grant"),
		module: z.string().min(1),
		grant: z.enum(["on", "off"]).nullable(),
	}),
	z.object({ kind: z.literal("limit"), key: limitKey, override }),
]);
const orgId = (req: Request) => param(req, "id");
const changeList = z.array(changeSchema).min(1).max(20);
const applyOptions = z.object({
	expectedUpdatedAt: z.string().datetime().optional(),
	upgradeRequestId: z.string().uuid().optional(),
});

const mutation =
	<S extends z.ZodTypeAny>(
		schema: S,
		toChange: (b: z.infer<S>) => StaffChange,
	) =>
	async (req: Request, res: Response) => {
		const body = parse(schema, req.body) as z.infer<S> & { reason: string };
		const resolved = await applyStaffChange(
			orgId(req),
			toChange(body),
			actor(req),
			body.reason,
			parse(applyOptions, req.body),
		);
		res.json(createSuccessResponse(resolved));
	};

export function registerOrgs(router: Router): void {
	router.get("/orgs", ...staff, async (req, res) => {
		const q =
			typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
		const page = Math.max(
			1,
			Number.parseInt(String(req.query.page ?? "1"), 10) || 1,
		);
		res.json(createSuccessResponse(await listOrgs(q, page)));
	});

	router.get("/orgs/:id", ...staff, async (req, res) => {
		res.json(createSuccessResponse(await getOrgDetail(orgId(req))));
	});

	router.post("/orgs/:id/preview", ...staff, async (req, res) => {
		const { change } = parse(z.object({ change: changeSchema }), req.body);
		res.json(
			createSuccessResponse(
				await previewStaffChange(orgId(req), change as StaffChange),
			),
		);
	});

	router.post("/orgs/:id/changes/preview", ...staff, async (req, res) => {
		const { changes } = parse(z.object({ changes: changeList }), req.body);
		res.json(
			createSuccessResponse(
				await previewStaffChanges(orgId(req), changes as StaffChange[]),
			),
		);
	});

	router.post("/orgs/:id/changes", ...staff, async (req, res) => {
		const body = parse(z.object({ changes: changeList, reason }), req.body);
		const resolved = await applyStaffChanges(
			orgId(req),
			body.changes as StaffChange[],
			actor(req),
			body.reason,
			parse(applyOptions, req.body),
		);
		res.json(createSuccessResponse(resolved));
	});

	router.patch(
		"/orgs/:id/plan",
		...staff,
		mutation(z.object({ planVersionId: z.string().min(1), reason }), (b) => ({
			kind: "plan",
			planVersionId: b.planVersionId,
		})),
	);
	router.patch(
		"/orgs/:id/trial",
		...staff,
		mutation(z.object({ trial, reason }), (b) => ({
			kind: "trial",
			trial: b.trial,
		})),
	);
	router.patch(
		"/orgs/:id/modules",
		...staff,
		mutation(
			z.object({
				module: z.string().min(1),
				grant: z.enum(["on", "off"]).nullable(),
				reason,
			}),
			(b) => ({ kind: "grant", module: b.module, grant: b.grant }),
		),
	);
	router.patch(
		"/orgs/:id/limits",
		...staff,
		mutation(z.object({ key: limitKey, override, reason }), (b) => ({
			kind: "limit",
			key: b.key as LimitKey,
			override: b.override,
		})),
	);

	router.get("/orgs/:id/history", ...staff, async (req, res) => {
		res.json(createSuccessResponse(await getOrgHistory(orgId(req))));
	});
}
