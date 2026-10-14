import { Router } from "express";
import { createErrorResponse, createSuccessResponse, ErrorCodes } from "../types/responses.js";
import {
	allowedSearchTypes,
	DEFAULT_SEARCH_LIMIT,
	isSearchableType,
	MAX_SEARCH_LIMIT,
	MIN_QUERY_LENGTH,
	searchRecords,
	type SearchEntityType,
} from "../services/searchService.js";
import { getAllPermissions } from "../lib/permissionCatalogs.js";

const router = Router();

/**
 * Effective permissions for search visibility.
 *
 * Mirrors `requirePermissions.resolvePerms`, but resolves the admin bypass into
 * a concrete list instead of a `null` sentinel — `allowedSearchTypes` needs a
 * set to intersect, and "admin sees everything" is expressed by handing it
 * everything rather than by skipping the check.
 */
const effectivePermissions = (role: string | undefined, permissions: string[] | null | undefined): string[] =>
	role === "admin" ? getAllPermissions("dispatcher") : (permissions ?? []);

/**
 * GET /search?q=&types=job,client&limit=10
 *
 * Deliberately has no single permission gate: each type is filtered by its own,
 * so a technician with only `view_assigned_jobs` gets jobs and nothing else
 * rather than a blanket 403.
 */
router.get("/", async (req, res, next) => {
	try {
		const q = typeof req.query.q === "string" ? req.query.q : "";
		if (q.trim().length < MIN_QUERY_LENGTH) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						`q must be at least ${MIN_QUERY_LENGTH} characters`,
						undefined,
						"q",
					),
				);
		}

		const rawLimit = req.query.limit;
		let limit = DEFAULT_SEARCH_LIMIT;
		if (rawLimit !== undefined) {
			const parsed = Number(rawLimit);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_LIMIT) {
				return res
					.status(400)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
							undefined,
							"limit",
						),
					);
			}
			limit = parsed;
		}

		const permitted = allowedSearchTypes(
			effectivePermissions(req.user?.role, req.user?.permissions),
		);

		let types: SearchEntityType[] = permitted;
		if (typeof req.query.types === "string" && req.query.types.length) {
			const requested = req.query.types.split(",").map((t) => t.trim()).filter(Boolean);
			const unknown = requested.filter((t) => !isSearchableType(t));
			if (unknown.length) {
				return res
					.status(400)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							`Unknown search type(s): ${unknown.join(", ")}`,
							undefined,
							"types",
						),
					);
			}
			// Intersect rather than replace: an explicit ?types= narrows what the
			// caller may see, it never widens it.
			const wanted = new Set(requested);
			types = permitted.filter((t) => wanted.has(t));
		}

		if (!types.length) {
			return res.json(createSuccessResponse({ hits: [], truncated: false, types: [] }, { count: 0 }));
		}

		const orgId = req.user!.organization_id as string;
		const outcome = await searchRecords(orgId, { query: q, types, limit });

		res.json(createSuccessResponse(outcome, { count: outcome.hits.length, hasMore: outcome.truncated }));
	} catch (err) {
		next(err);
	}
});

export default router;
