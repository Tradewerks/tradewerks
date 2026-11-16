import {
	OpenAPIRegistry,
	type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import z from "zod";

export {
	registry,
	envelope,
	errorEnvelope,
	json,
	decimal,
	idName,
	client,
	authed,
	historyQuery,
	historyResponses,
	moduleOff,
};

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
	type: "http",
	scheme: "bearer",
});

const envelope = (data: z.ZodType) =>
	z.object({
		success: z.boolean(),
		data,
		error: z.null(),
		meta: z.object({ timestamp: z.string(), count: z.number().optional() }),
	});

const errorEnvelope = z
	.object({
		success: z.literal(false),
		data: z.null(),
		error: z.object({ code: z.string(), message: z.string() }),
	})
	.meta({ id: "Error" });

const json = (schema: z.ZodType, description: string) => ({
	description,
	content: { "application/json": { schema } },
});

const decimal = z.string().describe("Decimal as a string");
const idName = z.object({ id: z.uuid(), name: z.string() });

const client = z
	.object({
		id: z.uuid(),
		name: z.string(),
		address: z.string(),
		coords: z.object({ lat: z.number(), lon: z.number() }),
		is_active: z.boolean(),
		is_tax_exempt: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "Client" });

const authed = (
	method: "get" | "post" | "put" | "patch" | "delete",
	path: string,
	tag: string,
	permission: string | null,
	rest: Omit<RouteConfig, "method" | "path">,
	also403?: string,
) => {
	const forbidden = [
		permission && `Missing \`${permission}\` permission`,
		also403,
	]
		.filter(Boolean)
		.join("; ");
	registry.registerPath({
		method,
		path,
		tags: [tag],
		security: [{ bearerAuth: [] }],
		...rest,
		responses: {
			...rest.responses,
			401: json(errorEnvelope, "Missing or invalid token"),
			...(forbidden && { 403: json(errorEnvelope, forbidden) }),
		},
	});
};

const historyEntry = z
	.object({
		id: z.uuid(),
		event_type: z
			.string()
			.describe('e.g. "client_note.created", "job.status_changed"'),
		action: z
			.string()
			.describe('"created", "updated", "deleted", "sent", …'),
		entity_type: z.string(),
		entity_id: z.uuid(),
		actor_type: z
			.string()
			.describe('"technician", "dispatcher" or "system"'),
		actor_id: z.string().nullable(),
		actor_name: z.string().nullable(),
		changes: z
			.record(
				z.string(),
				z.object({ old: z.unknown(), new: z.unknown() }),
			)
			.nullable(),
		timestamp: z.iso.datetime(),
		ip_address: z.string().nullable(),
		user_agent: z.string().nullable(),
		reason: z.string().nullable(),
	})
	.meta({ id: "HistoryEntry" });

const historyQuery = z.object({
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe("Entries to return, newest first. Default 20"),
});

const historyResponses = {
	200: json(
		envelope(z.array(historyEntry)).extend({
			meta: z.object({
				timestamp: z.string(),
				count: z.number(),
				hasMore: z.boolean(),
				total: z.number(),
			}),
		}),
		"History, newest first. Login, MFA and OAuth events are never included, and password fields are removed from `changes`",
	),
	400: json(
		errorEnvelope,
		"`limit` isn't an integer between 1 and 200 (`VALIDATION_ERROR`)",
	),
	500: json(errorEnvelope, "The lookup failed (`SERVER_ERROR`)"),
};

const moduleOff = (module: string) =>
	`The \`${module}\` module is off or not in the plan (\`MODULE_DISABLED\`, \`MODULE_NOT_IN_PLAN\`)`;
