import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toolInputSchema } from "../schema.js";

describe("toolInputSchema", () => {
	it("keeps a property literally named id", () => {
		// Regression: an earlier version dropped every key named `id`, meaning to
		// strip the draft-04 `id` meta keyword. get_record's only parameter is
		// called `id`, so the tool advertised an empty schema and the model had
		// nothing to fill in.
		const schema = toolInputSchema(z.object({ id: z.string().uuid() }));
		expect(schema.properties).toHaveProperty("id");
		expect(schema.required).toEqual(["id"]);
	});

	it("keeps properties whose names collide with JSON Schema keywords", () => {
		const schema = toolInputSchema(
			z.object({ pattern: z.string(), format: z.string(), type: z.string(), items: z.string() }),
		);
		expect(Object.keys(schema.properties as object).sort()).toEqual(["format", "items", "pattern", "type"]);
	});

	it("drops the redundant uuid regex but keeps the format", () => {
		const schema = toolInputSchema(z.object({ id: z.string().uuid() }));
		const id = (schema.properties as Record<string, Record<string, unknown>>).id;
		expect(id.format).toBe("uuid");
		expect(id).not.toHaveProperty("pattern");
	});

	it("keeps a pattern that is not implied by a format", () => {
		const schema = toolInputSchema(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
		const day = (schema.properties as Record<string, Record<string, unknown>>).day;
		expect(day.pattern).toBeDefined();
	});

	it("drops the $schema meta key", () => {
		expect(toolInputSchema(z.object({ a: z.string() }))).not.toHaveProperty("$schema");
	});

	it("represents a schema that ends in .transform() by its input side", () => {
		// Most validators in lib/validate end in .transform(). Asked for the output
		// shape Zod returns a bare {}, which would advertise a tool that takes
		// nothing. Phase 3 reuses those validators directly, so this must hold.
		const schema = toolInputSchema(
			z.object({ name: z.string().min(1).optional() }).transform((d) => ({ ...d, name: d.name || undefined })),
		);
		expect(schema.type).toBe("object");
		expect(schema.properties).toHaveProperty("name");
	});

	describe("refuses a schema it cannot advertise faithfully", () => {
		// Regression: a discriminated union renders as a bare top-level `oneOf`
		// with no `type`. An earlier version quietly substituted an empty object
		// schema, which told the model propose_draft took NO arguments — it called
		// with {}, validation rejected it, and the model invented an explanation
		// for a failure whose cause it could not see. Failing at registration is
		// the only version of this that is debuggable.
		it("throws on a discriminated union rather than emptying it", () => {
			const schema = z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("a"), value: z.string() }),
				z.object({ kind: z.literal("b"), count: z.number() }),
			]);
			expect(() => toolInputSchema(schema)).toThrow(/must be an object schema/);
		});

		it("names what it got, so the fix is obvious", () => {
			expect(() => toolInputSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]))).toThrow(
				/got: anyOf/,
			);
		});

		it.each([
			["array", z.array(z.string())],
			["string", z.string()],
			["number", z.number()],
		])("throws on a top-level %s", (_label, schema) => {
			expect(() => toolInputSchema(schema)).toThrow(/must be an object schema/);
		});

		it("accepts a union nested inside a property", () => {
			// The supported way to express "one of these shapes": keep the top level
			// an object and put the union on a field.
			const schema = toolInputSchema(
				z.object({ payload: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) }),
			);
			expect(schema.type).toBe("object");
			const payload = (schema.properties as Record<string, Record<string, unknown>>).payload;
			expect((payload.anyOf as unknown[]).length).toBe(2);
		});
	});

	it("always yields an object schema, even for a tool taking nothing", () => {
		const schema = toolInputSchema(z.object({}));
		expect(schema.type).toBe("object");
		expect(schema.properties).toEqual({});
	});

	it("preserves descriptions, defaults and enums", () => {
		const schema = toolInputSchema(
			z.object({
				status: z.enum(["Draft", "Sent"]).describe("Which status."),
				limit: z.number().int().min(1).max(50).default(25),
			}),
		);
		const props = schema.properties as Record<string, Record<string, unknown>>;
		expect(props.status.enum).toEqual(["Draft", "Sent"]);
		expect(props.status.description).toBe("Which status.");
		expect(props.limit.default).toBe(25);
	});

	it("recurses into nested objects and arrays", () => {
		const schema = toolInputSchema(
			z.object({ rows: z.array(z.object({ id: z.string().uuid(), qty: z.number() })) }),
		);
		const rows = (schema.properties as Record<string, Record<string, unknown>>).rows;
		const item = rows.items as Record<string, Record<string, Record<string, unknown>>>;
		expect(item.properties.id.format).toBe("uuid");
		expect(item.properties.id).not.toHaveProperty("pattern");
	});
});
