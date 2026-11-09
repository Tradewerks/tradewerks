/**
 * The AWS Textract AnalyzeExpense adapter: provider selection, the field mapping,
 * printed-date parsing, what survives into `ocr_raw`, and the SDK call. The fixture
 * follows the documented response shape; it is not a recording of a live account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	AnalyzeExpenseCommand,
	TextractClient,
} from "@aws-sdk/client-textract";
import { getReceiptOcrProvider } from "../receiptOcr/index.js";
import { OcrProviderError } from "../receiptOcr/normalize.js";
import { Slots } from "../receiptOcr/slots.js";
import {
	cleanVendor,
	clientFor,
	extractWithTextract,
	textractSlots,
	handwrittenShare,
	mapTextract,
	parsePrintedDate,
	parsePrintedMoney,
	printedLines,
	retainable,
} from "../receiptOcr/textract.js";
import { remapHeader } from "../receiptOcr/remap.js";
import { buildOcrFlags } from "../receiptOcr/flags.js";

const mockLogWarn = vi.hoisted(() => vi.fn());
vi.mock("../appLogger.js", () => ({
	log: { warn: mockLogWarn, error: vi.fn(), info: vi.fn() },
}));

const ENV_KEYS = [
	"RECEIPT_OCR_PROVIDER",
	"TEXTRACT_REGION",
	"TEXTRACT_ACCESS_KEY_ID",
	"TEXTRACT_SECRET_ACCESS_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const GEOMETRY = {
	BoundingBox: { Width: 0.1, Height: 0.02, Left: 0.1, Top: 0.1 },
	Polygon: [{ X: 0.1, Y: 0.1 }],
};

const field = (
	type: string,
	text: string,
	confidence = 98,
	extra: Record<string, unknown> = {},
) => ({
	Type: { Text: type, Confidence: 99 },
	LabelDetection: {
		Text: type.toLowerCase(),
		Confidence: 90,
		Geometry: GEOMETRY,
	},
	ValueDetection: { Text: text, Confidence: confidence, Geometry: GEOMETRY },
	PageNumber: 1,
	...extra,
});

const lineItem = (...fields: ReturnType<typeof field>[]) => ({
	LineItemExpenseFields: fields,
});

const TEXTRACT_RECEIPT = {
	$metadata: { httpStatusCode: 200, requestId: "req-1" },
	DocumentMetadata: { Pages: 1 },
	ExpenseDocuments: [
		{
			ExpenseIndex: 1,
			SummaryFields: [
				field("NAME", "JOHNSTONE SUPPLY #114", 95, {
					GroupProperties: [{ Types: ["VENDOR"], Id: "g1" }],
				}),
				field("VENDOR_NAME", "Johnstone Supply", 97),
				field("VENDOR_PHONE", "(555) 555-0188", 95),
				field("INVOICE_RECEIPT_ID", "884213", 93),
				field("INVOICE_RECEIPT_DATE", "10/14/26 1:42 PM", 99),
				field("SUBTOTAL", "$52.50", 98),
				field("TAX", "4.20", 60),
				field("TOTAL", "$56.70", 98, {
					Currency: { Code: "USD", Confidence: 90 },
				}),
				field("TOTAL", "56.00", 40),
				field("AMOUNT_PAID", "$56.70", 97),
				field("OTHER", "VISA ************4242", 90),
				field("OTHER", "AUTH 019283", 90),
			],
			LineItemGroups: [
				{
					LineItemGroupIndex: 1,
					LineItems: [
						lineItem(
							field("ITEM", "Capacitor 45/5 MFD", 93),
							field("QUANTITY", "2", 95),
							field("UNIT_PRICE", "18.75", 95),
							field("PRICE", "37.50", 95),
							field(
								"EXPENSE_ROW",
								"Capacitor 45/5 MFD 2 @ 18.75 37.50",
								90,
							),
						),
						lineItem(
							field("ITEM", "Contractor discount", 50),
							field("PRICE", "-3.00", 80),
						),
						lineItem(
							field("ITEM", "Wire nuts", 88),
							field("PRICE", "$18.00", 90),
						),
						lineItem(field("PRICE", "1.00", 90)),
					],
				},
			],
			Blocks: [{ BlockType: "LINE", Text: "VISA ************4242" }],
		},
	],
};

const withFields = (
	fields: ReturnType<typeof field>[],
	extra: Record<string, unknown> = {},
) => ({
	ExpenseDocuments: [
		{
			...TEXTRACT_RECEIPT.ExpenseDocuments[0]!,
			SummaryFields: fields,
			...extra,
		},
	],
});

describe("getReceiptOcrProvider (textract)", () => {
	it("returns null rather than a half-configured provider", () => {
		process.env.RECEIPT_OCR_PROVIDER = "textract";
		expect(getReceiptOcrProvider()).toBeNull();
		process.env.TEXTRACT_REGION = "us-east-1";
		process.env.TEXTRACT_ACCESS_KEY_ID = "AKIA";
		expect(getReceiptOcrProvider()).toBeNull();
	});

	it("resolves textract once the region and both keys are set", () => {
		process.env.RECEIPT_OCR_PROVIDER = "Textract";
		process.env.TEXTRACT_REGION = "us-east-1";
		process.env.TEXTRACT_ACCESS_KEY_ID = "AKIA";
		process.env.TEXTRACT_SECRET_ACCESS_KEY = "secret";
		expect(getReceiptOcrProvider()?.name).toBe("textract");
	});
});

describe("parsePrintedDate", () => {
	it.each([
		["10/14/2026", "2026-10-14"],
		["10/14/26", "2026-10-14"],
		["03/04/26", "2026-03-04"],
		["25/12/2026", "2026-12-25"],
		["10-14-2026", "2026-10-14"],
		["2026-10-14", "2026-10-14"],
		["Oct 14, 2026", "2026-10-14"],
		["OCTOBER 14 2026", "2026-10-14"],
		["14-Oct-2026", "2026-10-14"],
		["10/14/26 1:42 PM", "2026-10-14 13:42:00"],
		["10/14/2026 12:05:09 AM", "2026-10-14 00:05:09"],
		["10/14/2026 18:30", "2026-10-14 18:30:00"],
	])("reads %s as %s", (text, expected) => {
		expect(parsePrintedDate(text)).toBe(expected);
	});

	it.each([[""], ["no date here"], ["13/13/2026"], [null], [42]])(
		"returns null for %s",
		(text) => {
			expect(parsePrintedDate(text)).toBeNull();
		},
	);
});

describe("mapTextract", () => {
	it("maps the header from the most confident reading of each type", () => {
		const out = mapTextract(TEXTRACT_RECEIPT);
		expect(out).toMatchObject({
			vendor_name: "Johnstone Supply",
			receipt_number: "884213",
			vendor_phone: "(555) 555-0188",
			subtotal: 52.5,
			tax_amount: 4.2,
			total: 56.7,
			currency: "USD",
			document_type: null,
		});
		expect(out.purchased_at?.toISOString()).toBe(
			"2026-10-14T13:42:00.000Z",
		);
		expect(out.field_confidence).toEqual({
			vendor_name: 0.97,
			receipt_number: 0.93,
			purchased_at: 0.99,
			subtotal: 0.98,
			tax_amount: 0.6,
			total: 0.98,
		});
	});

	it("falls back to the vendor-group NAME and to AMOUNT_PAID", () => {
		const doc = TEXTRACT_RECEIPT.ExpenseDocuments[0]!;
		const fields = doc.SummaryFields.filter(
			(f) => !["VENDOR_NAME", "TOTAL"].includes(f.Type.Text),
		);
		const out = mapTextract({
			ExpenseDocuments: [{ ...doc, SummaryFields: fields }],
		});
		expect(out.vendor_name).toBe("JOHNSTONE SUPPLY #114");
		expect(out.total).toBe(56.7);
	});

	it("keeps a negative line, derives omitted fields, and skips a line with no description", () => {
		expect(mapTextract(TEXTRACT_RECEIPT).lines).toEqual([
			{
				description: "Capacitor 45/5 MFD",
				quantity: 2,
				unit_price: 18.75,
				line_total: 37.5,
				confidence: 0.93,
			},
			{
				description: "Contractor discount",
				quantity: 1,
				unit_price: -3,
				line_total: -3,
				confidence: 0.5,
			},
			{
				description: "Wire nuts",
				quantity: 1,
				unit_price: 18,
				line_total: 18,
				confidence: 0.88,
			},
		]);
	});

	it("field_source: read fields are source read", () => {
		const out = mapTextract(TEXTRACT_RECEIPT);
		for (const key of [
			"vendor_name",
			"receipt_number",
			"purchased_at",
			"subtotal",
			"tax_amount",
			"total",
		] as const) {
			expect(out.field_source[key]).toEqual({ source: "read" });
		}
	});

	it("yields an empty extraction rather than throwing on a payload with no documents", () => {
		const out = mapTextract({});
		expect(out).toMatchObject({
			vendor_name: null,
			total: null,
			document_type: null,
			lines: [],
		});
		expect(out.field_confidence).toEqual({});
	});
});

describe("retainable", () => {
	it("drops the full text, geometry, OTHER fields and expense rows before storage", () => {
		const text = JSON.stringify(retainable(TEXTRACT_RECEIPT));
		expect(text).not.toContain("4242");
		expect(text).not.toContain("AUTH");
		expect(text).not.toContain("Geometry");
		expect(text).not.toContain("Blocks");
		expect(text).not.toContain("EXPENSE_ROW");
		expect(text).not.toContain("requestId");
	});

	it("keeps everything the mapping reads, so a stored payload maps the same", () => {
		const { raw: _a, ...fromFull } = mapTextract(TEXTRACT_RECEIPT);
		const { raw: _b, ...fromKept } = mapTextract(
			retainable(TEXTRACT_RECEIPT),
		);
		expect(fromKept).toEqual(fromFull);
	});

	const keptOf = (
		summary: ReturnType<typeof field>[],
		items: ReturnType<typeof field>[] = [],
	) =>
		(
			retainable({
				ExpenseDocuments: [
					{
						SummaryFields: summary,
						LineItemGroups: [{ LineItems: [lineItem(...items)] }],
					},
				],
			}) as {
				ExpenseDocuments: {
					SummaryFields: Record<string, unknown>[];
					LineItemGroups: {
						LineItems: {
							LineItemExpenseFields: Record<string, unknown>[];
						}[];
					}[];
				}[];
			}
		).ExpenseDocuments[0]!;

	it("keeps a NAME only when it is the vendor's, never a bill-to or ship-to customer", () => {
		const text = JSON.stringify(
			keptOf([
				field("NAME", "JOHNSTONE SUPPLY", 95, {
					GroupProperties: [{ Types: ["VENDOR"] }],
				}),
				field("NAME", "PAT CUSTOMER", 95, {
					GroupProperties: [{ Types: ["RECEIVER_BILL_TO"] }],
				}),
				field("NAME", "SAM SHIPTO", 95, {
					GroupProperties: [{ Types: ["RECEIVER_SHIP_TO"] }],
				}),
				field("NAME", "NO GROUP", 95),
			]),
		);
		expect(text).toContain("JOHNSTONE SUPPLY");
		expect(text).not.toContain("PAT CUSTOMER");
		expect(text).not.toContain("SAM SHIPTO");
		expect(text).not.toContain("NO GROUP");
	});

	it("keeps the printed label only on receipt numbers, the one place it is read", () => {
		const doc = keptOf(
			[field("INVOICE_RECEIPT_ID", "01771"), field("TOTAL", "12.00")],
			[field("ITEM", "Cap")],
		);
		const [id, total] = doc.SummaryFields;
		expect(id!.LabelDetection).toBeDefined();
		expect(total!.LabelDetection).toBeUndefined();
		expect(
			doc.LineItemGroups[0]!.LineItems[0]!.LineItemExpenseFields[0]!
				.LabelDetection,
		).toBeUndefined();
	});

	it("drops a field whose text looks like card data, and keeps ordinary values", () => {
		const doc = keptOf(
			[
				field("INVOICE_RECEIPT_ID", "4242424242424242"),
				field("INVOICE_RECEIPT_ID", "01771"),
			],
			[
				field("ITEM", "XXXXXXXXXXXX9749"),
				field("ITEM", "**** 1234 VISA"),
				field("ITEM", "Capacitor 45/5"),
			],
		);
		const text = JSON.stringify(doc);
		expect(text).not.toContain("4242424242424242");
		expect(text).not.toContain("9749");
		expect(text).not.toContain("1234 VISA");
		expect(text).toContain("01771");
		expect(text).toContain("Capacitor 45/5");
	});

	it("keeps a long receipt number that is not a card number", () => {
		// 16 digits that fail the Luhn check: a ticket number, not a PAN.
		expect(
			JSON.stringify(
				keptOf([field("INVOICE_RECEIPT_ID", "1234567890123456")]),
			),
		).toContain("1234567890123456");
	});

	it("caps retained text", () => {
		const doc = keptOf([field("VENDOR_NAME", "A".repeat(500))]);
		const value = doc.SummaryFields[0]!.ValueDetection as { Text: string };
		expect(value.Text.length).toBe(200);
	});

	it("records the handwritten share of a value box without keeping Blocks or Geometry", () => {
		const box = {
			BoundingBox: { Left: 0.48, Top: 0.48, Width: 0.1, Height: 0.1 },
		};
		const pen = (Id: string) => ({
			Id,
			BlockType: "WORD",
			TextType: "HANDWRITING",
			Page: 1,
			Geometry: {
				BoundingBox: { Left: 0.5, Top: 0.5, Width: 0.03, Height: 0.03 },
			},
		});
		const kept = retainable({
			ExpenseDocuments: [
				{
					SummaryFields: [
						{
							...field("TOTAL", "336.99", 88),
							ValueDetection: {
								Text: "336.99",
								Confidence: 88,
								Geometry: box,
							},
						},
					],
					Blocks: [pen("a"), pen("b")],
				},
			],
		}) as {
			ExpenseDocuments: { SummaryFields: Record<string, unknown>[] }[];
		};
		expect(kept.ExpenseDocuments[0]!.SummaryFields[0]!.Handwritten).toBe(1);
		const text = JSON.stringify(kept);
		expect(text).not.toContain('"Blocks"');
		expect(text).not.toContain('"Geometry"');
	});

	it("keeps a stored share when an already-retained payload is retained again", () => {
		const doc = keptOf([
			field("TOTAL", "12.00", 98, { Handwritten: 0.67 }),
		]);
		expect(doc.SummaryFields[0]!.Handwritten).toBe(0.67);
	});

	it("replays through remapHeader under the textract provider name", () => {
		expect(
			remapHeader("textract", retainable(TEXTRACT_RECEIPT)),
		).toMatchObject({
			vendor_name: "Johnstone Supply",
			total: 56.7,
		});
	});
});

describe("handwrittenShare", () => {
	const box = (Left: number, Top: number, Width = 0.1, Height = 0.05) => ({
		BoundingBox: { Left, Top, Width, Height },
	});
	const word = (
		id: string,
		TextType: string,
		g = box(0.5, 0.5, 0.03, 0.03),
		Page = 1,
	) => ({
		Id: id,
		BlockType: "WORD",
		TextType,
		Page,
		Geometry: g,
	});
	const value = {
		Text: "336.99",
		Confidence: 88,
		Geometry: box(0.48, 0.48, 0.1, 0.1),
	};

	it("all handwritten words inside the value box -> 1", () => {
		expect(
			handwrittenShare(value, 1, [
				word("a", "HANDWRITING"),
				word("b", "HANDWRITING"),
			]),
		).toBe(1);
	});
	it("one pen word among three printed -> below the threshold", () => {
		const blocks = [
			word("a", "HANDWRITING"),
			word("b", "PRINTED"),
			word("c", "PRINTED"),
		];
		expect(handwrittenShare(value, 1, blocks)).toBeCloseTo(0.33, 2);
	});
	it("ignores words outside the box and words on another page", () => {
		const blocks = [
			word("a", "PRINTED"),
			word("b", "HANDWRITING", box(0.1, 0.1, 0.03, 0.03)),
			word("c", "HANDWRITING", undefined, 2),
		];
		expect(handwrittenShare(value, 1, blocks)).toBe(0);
	});
	it("null when the value has no geometry or no word overlaps", () => {
		expect(
			handwrittenShare({ Text: "1" }, 1, [word("a", "HANDWRITING")]),
		).toBeNull();
		expect(handwrittenShare(value, 1, [])).toBeNull();
	});
});

describe("remapHeader receipt_number", () => {
	it("remapHeader('textract', raw) includes receipt_number", () => {
		const expected = mapTextract(TEXTRACT_RECEIPT).receipt_number;
		expect(
			remapHeader("textract", retainable(TEXTRACT_RECEIPT)),
		).toHaveProperty("receipt_number", expected);
	});
});

describe("parsePrintedMoney", () => {
	it.each([
		["9.00 T", 9],
		["USD$ 391.69", 391.69],
		["$38,987.48", 38987.48],
		["1 49", 1.49],
		["5,99 P", 5.99],
		["0.30-F", -0.3],
		["2.00-N", -2],
		["-3.00", -3],
		["(1.50)", -1.5],
		[".50", 0.5],
		["1,234", 1234],
	])("reads %j as %d", (text, amount) => {
		expect(parsePrintedMoney(text)).toBe(amount);
	});

	it("passes numbers through and refuses text with no amount", () => {
		expect(parsePrintedMoney(12.5)).toBe(12.5);
		expect(parsePrintedMoney("")).toBeNull();
		expect(parsePrintedMoney(null)).toBeNull();
	});
});

describe("cleanVendor", () => {
	it("drops slogans, stray letters and the street address", () => {
		expect(cleanVendor("FredMeyer\nH\nWhat's on your list today?")).toBe(
			"FredMeyer",
		);
		expect(
			cleanVendor("Burlington\nW Osceola Pkwy 300, Kissimmee, FL"),
		).toBe("Burlington");
		expect(cleanVendor("HOME CENTERS, LLC\nLOWE'S")).toBe(
			"HOME CENTERS, LLC LOWE'S",
		);
	});

	it("returns one line, never a newline", () => {
		expect(cleanVendor("Sam's\nCLUB")).toBe("Sam's CLUB");
		expect(cleanVendor("H\nX")).toBe("H X");
	});

	it("keeps the reading when every line would go", () => {
		expect(cleanVendor("H")).toBe("H");
		expect(cleanVendor(null)).toBeNull();
	});
});

describe("mapTextract corrections", () => {
	const doc = TEXTRACT_RECEIPT.ExpenseDocuments[0]!;
	const withLabel = (f: ReturnType<typeof field>, label: string) => ({
		...f,
		LabelDetection: { Text: label, Confidence: 90 },
	});

	it("prefers a transaction-labelled receipt number over a more confident ID", () => {
		const out = mapTextract(
			withFields([
				withLabel(
					field("INVOICE_RECEIPT_ID", "7N8BRK6F3HG", 83),
					"ID #:",
				),
				withLabel(field("INVOICE_RECEIPT_ID", "01771", 71), "TR#"),
			]),
		);
		expect(out.receipt_number).toBe("01771");
		expect(out.field_confidence.receipt_number).toBe(0.71);
	});

	it("takes the total that equals subtotal plus tax over a more confident one", () => {
		const out = mapTextract(
			withFields([
				field("SUBTOTAL", "119.26"),
				field("TAX", "8.35"),
				field("TOTAL", "$38,987.48", 99),
				field("TOTAL", "$127.61", 90),
			]),
		);
		expect(out.total).toBe(127.61);
		expect(out.field_confidence.total).toBe(0.9);
	});

	it("derives a blank total from subtotal plus tax, flagged for review", () => {
		const out = mapTextract(
			withFields([
				field("SUBTOTAL", "396.94"),
				field("TAX", "33.63"),
				field("TOTAL", ""),
			]),
		);
		expect(out.total).toBe(430.57);
		expect(out.field_confidence.total).toBeLessThan(0.75);
	});

	it("field_source marks derived total", () => {
		const out = mapTextract(
			withFields([
				field("SUBTOTAL", "396.94"),
				field("TAX", "33.63"),
				field("TOTAL", ""),
			]),
		);
		expect(out.field_source.total).toEqual({ source: "derived" });
	});

	it("field_source marks hint vendor/receipt as rule", () => {
		const out = mapTextract(
			withFields(
				[field("SUBTOTAL", "119.26"), field("TOTAL", "127.61")],
				{
					Blocks: [
						{ BlockType: "LINE", Text: "How doers" },
						{
							BlockType: "LINE",
							Text: "6977 00002 70991 09/18/20 11:06 AM",
						},
					],
				},
			),
		);
		expect(out.field_source.vendor_name).toEqual({
			source: "rule",
			rule: "The Home Depot",
		});
		expect(out.field_source.receipt_number).toEqual({
			source: "rule",
			rule: "The Home Depot",
		});
	});

	it("reads a Home Depot vendor and ticket from the printed text, and keeps only those", () => {
		const blocks = [
			{ BlockType: "LINE", Text: "How doers" },
			{ BlockType: "LINE", Text: "6977 00002 70991 09/18/20 11:06 AM" },
			{ BlockType: "LINE", Text: "XXXXXXXXXXXX2019 DEBIT" },
		];
		const raw = withFields(
			[field("SUBTOTAL", "119.26"), field("TOTAL", "127.61")],
			{ Blocks: blocks },
		);
		const out = mapTextract(raw);
		expect(out).toMatchObject({
			vendor_name: "The Home Depot",
			receipt_number: "70991",
		});
		expect(out.field_confidence.vendor_name).toBeLessThan(0.75);

		const kept = retainable(raw);
		expect(JSON.stringify(kept)).not.toContain("2019 DEBIT");
		expect(mapTextract(kept)).toMatchObject({
			vendor_name: "The Home Depot",
			receipt_number: "70991",
		});
		expect(mapTextract(retainable(kept)).receipt_number).toBe("70991");
	});

	it("leaves an unknown chain's header numbers alone", () => {
		const raw = withFields([field("INVOICE_RECEIPT_ID", "2449", 80)], {
			Blocks: [{ BlockType: "LINE", Text: "6977 00002 70991 09/18/20" }],
		});
		expect(mapTextract(raw)).toMatchObject({
			vendor_name: null,
			receipt_number: "2449",
		});
	});
});

describe("mapTextract document kind", () => {
	const doc = TEXTRACT_RECEIPT.ExpenseDocuments[0]!;
	const withLines = (...texts: string[]) => ({
		ExpenseDocuments: [
			{
				...doc,
				Blocks: texts.map((Text) => ({ BlockType: "LINE", Text })),
			},
		],
	});

	it("standalone STATEMENT header -> document_type statement", () => {
		expect(
			mapTextract(withLines("ACME SUPPLY", "STATEMENT")).document_type,
		).toBe("statement");
		expect(
			mapTextract(withLines("Statement of Account")).document_type,
		).toBe("statement");
	});

	it("ESTIMATE header -> estimate", () => {
		expect(
			mapTextract(withLines("ACME SUPPLY", "ESTIMATE")).document_type,
		).toBe("estimate");
	});

	it("CREDIT MEMO / CREDIT NOTE header -> credit_memo", () => {
		expect(
			mapTextract(withLines("LITTLETON LUMBER", "CREDIT MEMO"))
				.document_type,
		).toBe("credit_memo");
		expect(
			mapTextract(withLines("ACME", "CREDIT NOTE")).document_type,
		).toBe("credit_memo");
	});

	it("CREDIT MEMO # 1234 label line does not flag", () => {
		expect(
			mapTextract(withLines("CREDIT MEMO # 1234")).document_type,
		).toBeNull();
	});

	it("INVOICE # 45512 label line does not flag", () => {
		const out = mapTextract(
			withLines(
				"LOWE'S HOME CENTERS",
				"INVOICE # 45512",
				"INVOICE NO",
				"INVOICE: 5571",
			),
		);
		expect(out.document_type).toBeNull();
	});

	it("BALANCE DUE on a statement flags, on a receipt with TOTAL/CHANGE does not", () => {
		expect(
			mapTextract(withLines("ACME", "BALANCE DUE $120.00")).document_type,
		).toBe("statement");
		const receipt = withLines(
			"ACME",
			"TOTAL 120.00",
			"CHANGE 0.00",
			"BALANCE DUE 0.00",
		);
		expect(mapTextract(receipt).document_type).toBeNull();
	});

	it("only scans the first 12 lines for a header", () => {
		const filler = Array.from({ length: 12 }, (_, i) => `ITEM ${i}`);
		expect(
			mapTextract(withLines(...filler, "STATEMENT")).document_type,
		).toBeNull();
	});

	it("stored TextHints without document_kind -> null", () => {
		const raw = {
			ExpenseDocuments: [
				{ ...doc, TextHints: { vendor: null, receipt_number: null } },
			],
		};
		expect(mapTextract(raw).document_type).toBeNull();
	});

	it("retainable keeps document_kind and the mapper reads it back", () => {
		const kept = retainable(withLines("STATEMENT")) as {
			ExpenseDocuments: { TextHints: { document_kind: string | null } }[];
		};
		expect(kept.ExpenseDocuments[0]!.TextHints.document_kind).toBe(
			"statement",
		);
		expect(JSON.stringify(kept)).not.toContain("Blocks");
		expect(mapTextract(kept).document_type).toBe("statement");
	});
});

describe("mapTextract holdout fixes", () => {
	const doc = TEXTRACT_RECEIPT.ExpenseDocuments[0]!;
	const build = (fields: ReturnType<typeof field>[], ...texts: string[]) => ({
		ExpenseDocuments: [
			{
				...doc,
				SummaryFields: fields,
				Blocks: texts.map((Text) => ({ BlockType: "LINE", Text })),
			},
		],
	});

	it("O'Reilly logo split across lines -> vendor O'Reilly Auto Parts (rule)", () => {
		for (const lines of [
			[
				"AUTO PARTS®",
				"Reilly",
				"PRO SSIONAL PARTS PEOPLE",
				"www.oreillyauto.com",
			],
			["Reilly", "AUTO PARTS", "K2 TAX"],
		]) {
			const out = mapTextract(
				build(
					[field("VENDOR_NAME", "PRO SSIONAL PARTS PEOPLE", 97)],
					...lines,
				),
			);
			expect(out.vendor_name).toBe("O'Reilly Auto Parts");
			expect(out.field_source.vendor_name).toEqual({
				source: "rule",
				rule: "O'Reilly Auto Parts",
			});
			expect(out.field_confidence.vendor_name).toBeLessThan(0.75);
		}
	});

	it("correct read vendor not overridden by chain hint", () => {
		const out = mapTextract(
			build(
				[field("VENDOR_NAME", "O'REILLY AUTO PARTS", 97)],
				"www.oreillyauto.com",
			),
		);
		expect(out.vendor_name).toBe("O'REILLY AUTO PARTS");
		expect(out.field_source.vendor_name).toEqual({ source: "read" });
		const hd = mapTextract(
			build([field("VENDOR_NAME", "Home Depot", 97)], "How doers"),
		);
		expect(hd.field_source.vendor_name).toEqual({ source: "read" });
	});

	it("subtotal missing decimal (482 vs 4.82) -> derived from total - tax", () => {
		const out = mapTextract(
			build([
				field("SUBTOTAL", "482", 99),
				field("TAX", "0.34", 99),
				field("TOTAL", "5.16", 99),
			]),
		);
		expect(out.subtotal).toBe(4.82);
		expect(out.field_source.subtotal).toEqual({ source: "derived" });
		expect(out.field_confidence.subtotal).toBe(0.5);
	});

	it("goods-only subtotal with core charge -> derived final subtotal", () => {
		const out = mapTextract(
			build([
				field("SUBTOTAL", "101.99"),
				field("TAX", "7.14"),
				field("TOTAL", "139.13"),
			]),
		);
		expect(out.subtotal).toBe(131.99);
		expect(out.field_source.subtotal).toEqual({ source: "derived" });
	});

	it("consistent subtotal stays read; null tax leaves subtotal alone", () => {
		const ok = mapTextract(
			build([
				field("SUBTOTAL", "119.26"),
				field("TAX", "8.35"),
				field("TOTAL", "127.61"),
			]),
		);
		expect(ok.subtotal).toBe(119.26);
		expect(ok.field_source.subtotal).toEqual({ source: "read" });
		const noTax = mapTextract(
			build([field("SUBTOTAL", "100"), field("TOTAL", "139.13")]),
		);
		expect(noTax.subtotal).toBe(100);
		expect(noTax.field_source.subtotal).toEqual({ source: "read" });
	});

	it("QUOTE ONLY banner -> document_type quote", () => {
		expect(
			mapTextract(build([], "O'Reilly", "********* QUOTE ONLY *********"))
				.document_type,
		).toBe("quote");
		expect(
			mapTextract(build([], "O'Reilly", "Quote Total 52.10"))
				.document_type,
		).toBe("quote");
	});

	it("Invoice # 2985-Quote alone does not flag", () => {
		expect(
			mapTextract(build([], "O'Reilly", "Invoice #: 2985-Quote"))
				.document_type,
		).toBeNull();
	});

	it("stored TextHints without chain/document_kind still replay", () => {
		const raw = {
			ExpenseDocuments: [
				{
					...doc,
					TextHints: { vendor: "Lowe's", receipt_number: null },
					SummaryFields: [],
				},
			],
		};
		expect(mapTextract(raw).vendor_name).toBe("Lowe's");
	});
});

describe("extractWithTextract", () => {
	const CFG = {
		region: "us-east-1",
		accessKeyId: "AKIA",
		secretAccessKey: "secret",
	};
	const FILE = {
		buffer: Buffer.from("receipt-bytes"),
		mimetype: "image/jpeg",
		filename: "r.jpg",
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the bytes to AnalyzeExpense and stores only the retained payload", async () => {
		const send = vi
			.spyOn(TextractClient.prototype, "send")
			.mockResolvedValue(TEXTRACT_RECEIPT as never);
		const out = await extractWithTextract(FILE, CFG);

		const command = send.mock.calls[0]![0] as AnalyzeExpenseCommand;
		expect(command).toBeInstanceOf(AnalyzeExpenseCommand);
		expect(command.input.Document?.Bytes).toBe(FILE.buffer);
		expect(out.total).toBe(56.7);
		expect(JSON.stringify(out.raw)).not.toContain("4242");
	});

	it("refuses WebP bytes before calling AWS, whatever the upload is tagged", async () => {
		const send = vi.spyOn(TextractClient.prototype, "send");
		const webp = Buffer.concat([
			Buffer.from("RIFF"),
			Buffer.alloc(4),
			Buffer.from("WEBPVP8 "),
		]);
		await expect(
			extractWithTextract(
				{ ...FILE, buffer: webp, mimetype: "image/heic" },
				CFG,
			),
		).rejects.toThrow(/cannot read WebP/);
		expect(send).not.toHaveBeenCalled();
	});

	it.each([
		[
			"UnrecognizedClientException",
			/Receipt reading isn't set up correctly/,
		],
		["AccessDeniedException", /Receipt reading isn't set up correctly/],
		["ThrottlingException", /rate limiting - retry the receipt shortly/],
		["UnsupportedDocumentException", /would not accept this receipt/],
		["DocumentTooLargeException", /too large/],
		["TimeoutError", /did not answer in time/],
		["InternalServerError", /Textract could not read this receipt/],
	])(
		"turns %s into a message that says what to do about it",
		async (name, match) => {
			vi.spyOn(TextractClient.prototype, "send").mockRejectedValue(
				Object.assign(new Error("nope"), { name }),
			);
			await expect(extractWithTextract(FILE, CFG)).rejects.toThrow(match);
		},
	);

	it.each([
		"AccessDeniedException",
		"ThrottlingException",
		"BadDocumentException",
		"InternalServerError",
	])(
		"keeps AWS's own wording of %s out of what the technician sees, and logs it",
		async (name) => {
			const detail =
				"User: arn:aws:iam::123456789012:user/hvac-ocr is not authorized to perform: textract:AnalyzeExpense";
			vi.spyOn(TextractClient.prototype, "send").mockRejectedValue(
				Object.assign(new Error(detail), { name }),
			);
			const err = await extractWithTextract(FILE, CFG).catch(
				(e: Error) => e,
			);
			expect((err as Error).message).not.toContain("123456789012");
			expect((err as Error).message).not.toContain("hvac-ocr");
			expect(mockLogWarn).toHaveBeenCalledWith(
				expect.objectContaining({ name, message: detail }),
				expect.any(String),
			);
		},
	);
});

describe("handwritten fields", () => {
	const hw = { Handwritten: 1 };
	it("a handwritten read total is flagged unsure with the handwritten rule", () => {
		const out = mapTextract(
			withFields([
				field("TOTAL", "$336 99", 88, hw),
				field("TAX", "$29 99", 99, hw),
			]),
		);
		expect(out.total).toBe(336.99);
		expect(out.field_source.total).toEqual({
			source: "rule",
			rule: "handwritten",
		});
		expect(out.field_source.tax_amount).toEqual({
			source: "rule",
			rule: "handwritten",
		});
		expect(buildOcrFlags(out).fields.total).toMatchObject({
			kind: "unsure",
			rule: "handwritten",
		});
	});
	it("handwritten date and receipt number are flagged; a printed serial is not", () => {
		const out = mapTextract(
			withFields([
				field("INVOICE_RECEIPT_DATE", "7-23-24", 98, hw),
				field("INVOICE_RECEIPT_ID", "64915778", 99, { Handwritten: 0 }),
			]),
		);
		expect(out.field_source.purchased_at).toEqual({
			source: "rule",
			rule: "handwritten",
		});
		expect(out.field_source.receipt_number).toEqual({ source: "read" });
	});
	it("a handwritten receipt number is flagged", () => {
		const out = mapTextract(
			withFields([field("INVOICE_RECEIPT_ID", "1177", 99, hw)]),
		);
		expect(out.field_source.receipt_number).toEqual({
			source: "rule",
			rule: "handwritten",
		});
	});
	it("a derived total stays calculated even when its inputs are handwritten", () => {
		const out = mapTextract(
			withFields([
				field("SUBTOTAL", "100.00", 99, hw),
				field("TAX", "7.00", 99, hw),
			]),
		);
		expect(out.field_source.total).toEqual({ source: "derived" });
	});
	it("a handwritten line amount drops below the line cutoff", () => {
		const out = mapTextract({
			ExpenseDocuments: [
				{
					LineItemGroups: [
						{
							LineItems: [
								lineItem(
									field("ITEM", "Parts-Labor", 95, hw),
									field("PRICE", "97", 95, hw),
								),
							],
						},
					],
				},
			],
		});
		expect(out.lines[0]!.confidence).toBe(0.5);
	});
	it("a payload without Handwritten maps exactly as before", () => {
		const out = mapTextract(
			withFields([field("TOTAL", "34.85", 99), field("TAX", "2.13", 99)]),
		);
		expect(out.field_source.total).toEqual({ source: "read" });
	});
});

describe("printed-only hints", () => {
	const doc = TEXTRACT_RECEIPT.ExpenseDocuments[0]!;
	let n = 0;
	/** One LINE with its child WORDs, every word of the given TextType. */
	const line = (text: string, TextType: "HANDWRITING" | "PRINTED") => {
		const words = text.split(" ").map((Text) => ({
			Id: `w${++n}`,
			BlockType: "WORD",
			Text,
			TextType,
		}));
		return [
			{
				Id: `l${++n}`,
				BlockType: "LINE",
				Text: text,
				Relationships: [{ Type: "CHILD", Ids: words.map((w) => w.Id) }],
			},
			...words,
		];
	};
	const withBlocks = (...blocks: unknown[][]) => ({
		ExpenseDocuments: [{ ...doc, Blocks: blocks.flat() }],
	});
	const hintsOf = (raw: unknown) =>
		(
			retainable(raw) as {
				ExpenseDocuments: { TextHints: { chain: string | null } }[];
			}
		).ExpenseDocuments[0]!.TextHints;

	it("a handwritten chain name is not a chain hint", () => {
		const raw = withBlocks(line("DROVE TO HOME DEPOT", "HANDWRITING"));
		expect(mapTextract(raw).vendor_name).not.toBe("The Home Depot");
		expect(hintsOf(raw).chain).toBeNull();
	});
	it("the same text printed is a chain hint", () => {
		const raw = withBlocks(line("DROVE TO HOME DEPOT", "PRINTED"));
		expect(hintsOf(raw).chain).toBe("The Home Depot");
	});
	it("a handwritten BALANCE DUE does not make a statement", () => {
		expect(
			mapTextract(
				withBlocks(
					line("Balance due week before delivery", "HANDWRITING"),
				),
			).document_type,
		).toBeNull();
	});
	it("a LINE without child words counts as printed", () => {
		const raw = {
			ExpenseDocuments: [
				{ ...doc, Blocks: [{ BlockType: "LINE", Text: "STATEMENT" }] },
			],
		};
		expect(mapTextract(raw).document_type).toBe("statement");
	});
	it("printedLines keeps printed and unlinked lines in order", () => {
		const blocks = [
			...line("ACME", "PRINTED"),
			...line("paid cash", "HANDWRITING"),
			{ BlockType: "LINE", Text: "TOTAL" },
		];
		expect(printedLines(blocks)).toEqual(["ACME", "TOTAL"]);
	});
});

describe("handwritten vendor", () => {
	const hw = { Handwritten: 1 };
	it("a printed vendor beats a more confident handwritten one", () => {
		const out = mapTextract(
			withFields([
				field("VENDOR_NAME", "LITTLETON LUMBER", 73),
				field("VENDOR_NAME", "SUNSPACE DESIGN", 100, hw),
			]),
		);
		expect(out.vendor_name).toBe("LITTLETON LUMBER");
		expect(out.field_source.vendor_name).toEqual({ source: "read" });
	});
	it("a printed vendor-group NAME beats a handwritten VENDOR_NAME", () => {
		const out = mapTextract(
			withFields([
				field("VENDOR_NAME", "SUNSPACE DESIGN", 100, hw),
				field("NAME", "LITTLETON LUMBER", 70, {
					GroupProperties: [{ Types: ["VENDOR"] }],
				}),
			]),
		);
		expect(out.vendor_name).toBe("LITTLETON LUMBER");
	});
	it("only a handwritten vendor is kept and flagged", () => {
		const out = mapTextract(
			withFields([field("VENDOR_NAME", "Dale Ostafeld", 95, hw)]),
		);
		expect(out.vendor_name).toBe("Dale Ostafeld");
		expect(out.field_source.vendor_name).toEqual({
			source: "rule",
			rule: "handwritten",
		});
	});
	it("a handwritten vendor phone is dropped; a printed one is kept", () => {
		expect(
			mapTextract(
				withFields([field("VENDOR_PHONE", "914-548-6844", 95, hw)]),
			).vendor_phone,
		).toBeNull();
		expect(
			mapTextract(
				withFields([field("VENDOR_PHONE", "(605) 545-4173", 95)]),
			).vendor_phone,
		).toBe("(605) 545-4173");
	});
});

describe("Textract failure classification and throttling", () => {
	const CFG = {
		region: "us-east-1",
		accessKeyId: "AKIA",
		secretAccessKey: "secret",
	};
	const FILE = {
		buffer: Buffer.from("receipt-bytes"),
		mimetype: "image/jpeg",
		filename: "r.jpg",
	};

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TEXTRACT_MAX_CONCURRENCY;
	});

	it.each([
		["ThrottlingException", {}, "throttled"],
		["ProvisionedThroughputExceededException", {}, "throttled"],
		["LimitExceededException", {}, "throttled"],
		["TimeoutError", {}, "timeout"],
		["AbortError", {}, "timeout"],
		["InternalServerError", { $fault: "server" }, "unavailable"],
		["ServiceUnavailable", { $metadata: { httpStatusCode: 503 } }, "unavailable"],
		["Error", { code: "ECONNRESET" }, "unavailable"],
		["AccessDeniedException", {}, "final"],
		["InvalidSignatureException", {}, "final"],
		["BadDocumentException", {}, "final"],
		["UnsupportedDocumentException", {}, "final"],
		["DocumentTooLargeException", {}, "final"],
		["SomethingNew", {}, "final"],
	] as const)("classifies %s as %s", async (name, extra, kind) => {
		vi.spyOn(TextractClient.prototype, "send").mockRejectedValue(
			Object.assign(new Error("x"), { name }, extra),
		);
		const err = await extractWithTextract(FILE, CFG).catch((e) => e);
		expect(err).toBeInstanceOf(OcrProviderError);
		expect((err as OcrProviderError).kind).toBe(kind);
	});

	it("classifies WebP as final, before any slot or call", async () => {
		const webp = Buffer.concat([
			Buffer.from("RIFF"),
			Buffer.alloc(4),
			Buffer.from("WEBPVP8 "),
		]);
		const err = await extractWithTextract({ ...FILE, buffer: webp }, CFG).catch(
			(e) => e,
		);
		expect((err as OcrProviderError).kind).toBe("final");
	});

	it("retries adaptively, three attempts inside the one timeout", async () => {
		const client = clientFor({ ...CFG, accessKeyId: "config-check" });
		expect(await client.config.maxAttempts()).toBe(3);
		const strategy = (await client.config.retryStrategy()) as { mode?: string };
		expect(strategy.mode).toBe("adaptive");
	});

	it("never runs more reads at once than the cap", async () => {
		process.env.TEXTRACT_MAX_CONCURRENCY = "2";
		let active = 0;
		let peak = 0;
		vi.spyOn(TextractClient.prototype, "send").mockImplementation(
			async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active -= 1;
				return TEXTRACT_RECEIPT as never;
			},
		);
		await Promise.all(
			Array.from({ length: 7 }, () => extractWithTextract(FILE, CFG)),
		);
		expect(peak).toBe(2);
		expect(textractSlots.inUse).toBe(0);
	});

	it("frees the slot when the call fails", async () => {
		process.env.TEXTRACT_MAX_CONCURRENCY = "1";
		vi.spyOn(TextractClient.prototype, "send")
			.mockRejectedValueOnce(
				Object.assign(new Error("x"), { name: "ThrottlingException" }),
			)
			.mockResolvedValueOnce(TEXTRACT_RECEIPT as never);
		await extractWithTextract(FILE, CFG).catch(() => null);
		await expect(extractWithTextract(FILE, CFG)).resolves.toBeTruthy();
		expect(textractSlots.inUse).toBe(0);
	});

	it("starts the provider timeout only once a slot is held", async () => {
		process.env.TEXTRACT_MAX_CONCURRENCY = "1";
		const order: string[] = [];
		const timeout = vi.spyOn(AbortSignal, "timeout");
		let releaseFirst!: () => void;
		vi.spyOn(TextractClient.prototype, "send")
			.mockImplementationOnce(async () => {
				order.push("send-1");
				await new Promise<void>((r) => (releaseFirst = r));
				return TEXTRACT_RECEIPT as never;
			})
			.mockImplementationOnce(async () => {
				order.push("send-2");
				return TEXTRACT_RECEIPT as never;
			});
		const first = extractWithTextract(FILE, CFG);
		const second = extractWithTextract(FILE, CFG);
		await new Promise((r) => setTimeout(r, 5));
		// The queued read has not armed its timer while it waits.
		expect(timeout).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["send-1"]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(timeout).toHaveBeenCalledTimes(2);
		expect(order).toEqual(["send-1", "send-2"]);
	});
});

describe("Slots", () => {
	it("gives up on a waiter after maxWait, without leaking its slot", async () => {
		vi.useFakeTimers();
		try {
			const slots = new Slots(1);
			expect(await slots.acquire(10)).toBe(true);
			const waiting = slots.acquire(1_000);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(await waiting).toBe(false);
			slots.release();
			expect(slots.inUse).toBe(0);
			expect(await slots.acquire(10)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("hands slots to waiters first come, first served", async () => {
		const slots = new Slots(1);
		await slots.acquire(10);
		const order: number[] = [];
		const a = slots.acquire(1_000).then(() => order.push(1));
		const b = slots.acquire(1_000).then(() => order.push(2));
		slots.release();
		await a;
		slots.release();
		await b;
		expect(order).toEqual([1, 2]);
	});
});
