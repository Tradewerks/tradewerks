import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./openapi/shared.js";
// Registration order is the spec order.
import "./openapi/org.js";
import "./openapi/clients.js";
import "./openapi/search.js";
import "./openapi/requestsQuotes.js";
import "./openapi/jobs.js";
import "./openapi/invoices.js";
import "./openapi/disputes.js";
import "./openapi/reports.js";
import "./openapi/projects.js";
import "./openapi/followups.js";
import "./openapi/purchases.js";
import "./openapi/suppliers.js";
import "./openapi/fieldPurchases.js";
import "./openapi/inventory.js";
import "./openapi/inventoryReconcile.js";
import "./openapi/inventoryImports.js";
import "./openapi/technicians.js";
import "./openapi/dispatchers.js";
import "./openapi/tax.js";
import "./openapi/timesheets.js";
import "./openapi/vehicles.js";
import "./openapi/recurringPlans.js";
import "./openapi/oauth.js";

export const openApiDocument = new OpenApiGeneratorV31(
	registry.definitions,
).generateDocument({
	openapi: "3.1.0",
	info: {
		title: "TradeWerks API",
		version: "1.0.0",
		description: `
REST API for TradeWerks dispatch data. All data is scoped to the caller's organization.

## Authentication

Send an access token as \`Authorization: Bearer <token>\`. Integrations get one through OAuth 2.0
(\`GET /oauth/authorize\`, then \`POST /oauth/token\`). Access tokens expire after 15 minutes;
refresh tokens last 90 days and are rotated on every refresh.

## Responses

Every JSON response uses the same envelope:

\`\`\`json
{ "success": true, "data": { }, "error": null, "meta": { "timestamp": "…", "count": 3 } }
\`\`\`

On failure \`success\` is \`false\`, \`data\` is \`null\` and \`error\` holds \`{ "code", "message" }\`.

## Common errors

| Status | Meaning |
|---|---|
| 401 | Missing, invalid or expired token (\`INVALID_TOKEN\`) |
| 403 | Missing permission (\`FORBIDDEN\`), or the module is off or not in the plan (\`MODULE_DISABLED\`, \`MODULE_NOT_IN_PLAN\`) |
| 500 | Unexpected server error (\`SERVER_ERROR\`) |
`,
	},
});

type Schema = {
	type?: string | string[];
	format?: string;
	enum?: unknown[];
	items?: Schema;
	properties?: Record<string, Schema>;
	required?: string[];
	$ref?: string;
	anyOf?: Schema[];
	oneOf?: Schema[];
	allOf?: Schema[];
	description?: string;
	example?: unknown;
};

// `z.string().or(z.literal(""))` becomes anyOf [string, ""], which Scalar shows as separate options.
const isEmptyString = (s: Schema) => s.enum?.length === 1 && s.enum[0] === "";
const collapseStringUnions = (node: unknown) => {
	if (!node || typeof node !== "object") return;
	Object.values(node).forEach(collapseStringUnions);
	const s = node as Schema & { minLength?: number };
	const types = s.anyOf?.map((v) => v.type);
	if (!s.anyOf || !types!.every((t) => t === "string" || t === "null"))
		return;
	const base = s.anyOf.find((v) => v.type === "string" && !isEmptyString(v));
	if (!base) return;
	const allowsEmpty = s.anyOf.some(isEmptyString);
	Object.assign(s, base, {
		type: types!.includes("null") ? ["string", "null"] : "string",
	});
	delete s.anyOf;
	if (allowsEmpty) {
		delete s.minLength;
		s.description = [s.description, "Empty string allowed."]
			.filter(Boolean)
			.join(" ");
	}
};
collapseStringUnions(openApiDocument);

// `.default(() => new Date())` would otherwise show the time the spec was built.
const hireDate = (
	openApiDocument.components!.schemas!.CreateTechnician as Schema
).properties!.hire_date;
delete (hireDate as { default?: unknown }).default;
hireDate.description = "Defaults to now";

const schemas = openApiDocument.components!.schemas as Record<string, Schema>;
const deref = (s: Schema): Schema =>
	s.$ref ? deref(schemas[s.$ref.split("/").pop()!]) : s;
const variant = (s: Schema): Schema =>
	deref(s.anyOf?.[0] ?? s.oneOf?.[0] ?? s.allOf?.[0] ?? s);
const baseType = (s: Schema) =>
	[s.type ?? "object"].flat().find((t) => t !== "null") ?? "null";

const sample = (raw: Schema): unknown => {
	const s = variant(raw);
	if (s.example !== undefined) return s.example;
	const e = s.enum?.find((v) => v !== null);
	if (e !== undefined) return e;
	const t = baseType(s);
	if (t === "object")
		return Object.fromEntries(
			Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]),
		);
	if (t === "array") return s.items ? [sample(s.items)] : [];
	if (t === "number" || t === "integer") return 0;
	if (t === "boolean") return true;
	if (s.description === "Decimal as a string") return "0.00";
	return (
		{
			uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
			"date-time": "2026-01-01T00:00:00.000Z",
			date: "2026-01-01",
			email: "user@example.com",
		}[s.format ?? ""] ?? "string"
	);
};

const typeLabel = (raw: Schema): string => {
	const ref = (raw.anyOf?.[0] ?? raw).$ref?.split("/").pop();
	const s = variant(raw);
	const nullable =
		[s.type].flat().includes("null") ||
		raw.anyOf?.some((a) => a.type === "null");
	const t = baseType(s);
	const base = ref
		? ref
		: t === "array"
			? `${typeLabel(s.items ?? {})}[]`
			: s.format
				? `${t} (${s.format})`
				: t;
	const values = s.enum?.filter((v) => v !== null);
	return `${base}${values?.length ? `: ${values.join(", ")}` : ""}${nullable ? ", nullable" : ""}`;
};

// Mirrors QuickBooks' per-entity "Sample object" block at the top of each tag.
const tagModels: Record<string, [string, string?]> = {
	Org: ["Organization"],
	Clients: ["Client", "CreateClient"],
	Contacts: ["Contact", "CreateContact"],
	Search: ["SearchHit"],
	Requests: ["Request", "CreateRequest"],
	Quotes: ["Quote", "CreateQuote"],
	Jobs: ["Job", "CreateJob"],
	Visits: ["JobVisit", "CreateJobVisit"],
	Invoices: ["Invoice", "CreateInvoice"],
	Disputes: ["OpenDispute"],
	Reports: ["PaymentReportRow"],
	Projects: ["Project", "CreateProject"],
	Followups: ["FollowupEnrollment", "EnrollFollowup"],
	Purchases: ["Purchase", "CreatePurchase"],
	Suppliers: ["Supplier", "CreateSupplier"],
	"Field Purchases": ["FieldPurchase"],
	Inventory: ["InventoryItem"],
	Technicians: ["Technician"],
	Dispatchers: ["Dispatcher", "CreateDispatcher"],
	Tax: ["TaxRate", "CreateTaxRate"],
	Vehicles: ["Vehicle"],
	"Recurring Plans": ["RecurringPlan"],
};

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

const modelBlock = (name: string, createName?: string) => {
	const s = deref(schemas[name]);
	const onCreate = new Set(
		createName ? deref(schemas[createName]).required : [],
	);
	const rows = Object.entries(s.properties ?? {}).map(([key, prop]) => {
		const notes = [
			onCreate.has(key) && "**Required on create.**",
			variant(prop).description,
		].filter(Boolean);
		return `| \`${key}\` | ${cell(typeLabel(prop))} | ${cell(notes.join(" "))} |`;
	});
	return `### The ${name} object

| Attribute | Type | Description |
|---|---|---|
${rows.join("\n")}

\`\`\`json
${JSON.stringify(sample(s), null, 2)}
\`\`\``;
};

openApiDocument.tags = [
	...new Set(
		Object.values(openApiDocument.paths ?? {}).flatMap((p) =>
			Object.values(p).flatMap(
				(op: { tags?: string[] }) => op.tags ?? [],
			),
		),
	),
].map((tag) => ({
	name: tag,
	...(tagModels[tag] && { description: modelBlock(...tagModels[tag]) }),
}));

// Mirrors frontend/src/styles/theme.css tokens.
export const docsCss = `
.light-mode {
	--scalar-background-1: #ffffff;
	--scalar-background-2: #f0f3f7;
	--scalar-background-3: #dde2ea;
	--scalar-background-accent: rgba(59, 130, 246, 0.1);
	--scalar-color-1: #0f172a;
	--scalar-color-2: #334155;
	--scalar-color-3: #64748b;
	--scalar-color-accent: #3b82f6;
	--scalar-border-color: #d0d6df;
}
.dark-mode {
	--scalar-background-1: #18181b;
	--scalar-background-2: #111115;
	--scalar-background-3: #3f3f46;
	--scalar-background-accent: rgba(59, 130, 246, 0.2);
	--scalar-color-1: #ffffff;
	--scalar-color-2: #e4e4e7;
	--scalar-color-3: #a1a1aa;
	--scalar-color-accent: #93c5fd;
	--scalar-border-color: #52525b;
}
.light-mode,
.dark-mode {
	--scalar-color-green: #059669;
	--scalar-color-red: #ef4444;
	--scalar-color-yellow: #d97706;
	--scalar-color-blue: #3b82f6;
	--scalar-color-orange: #d97706;
	--scalar-button-1: #3b82f6;
	--scalar-button-1-hover: #2563eb;
	--scalar-button-1-color: #ffffff;
}

/* QuickBooks-style: dark code panels, attributes table beside its sample object. */
.response-card,
.markdown pre {
	--scalar-background-1: #18181b;
	--scalar-background-2: #111115;
	--scalar-background-3: #3f3f46;
	--scalar-color-1: #ffffff;
	--scalar-color-2: #e4e4e7;
	--scalar-color-3: #a1a1aa;
	--scalar-border-color: #52525b;
}
.response-card {
	color: var(--scalar-color-1);
}
.markdown pre {
	background: var(--scalar-background-2);
	color: var(--scalar-color-1);
	border: 1px solid var(--scalar-border-color);
}
.tag-section-container .section-columns:has(.markdown table) {
	display: block;
}
.tag-section-container .section-columns:has(.markdown table) > .section-column:last-child {
	display: none;
}
.tag-section-container .markdown:has(table) {
	display: grid;
	grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
	gap: 0 24px;
	align-items: start;
}
.tag-section-container .markdown:has(table) > h3 {
	grid-column: 1 / -1;
}
.tag-section-container .markdown:has(table) > pre {
	position: sticky;
	top: 16px;
	margin: 0;
	max-height: calc(100vh - 32px);
	overflow: auto;
	border-radius: 12px;
}
.tag-section-container .markdown table code {
	white-space: nowrap;
}
@media (max-width: 1000px) {
	.tag-section-container .markdown:has(table) {
		display: block;
	}
}
`;
