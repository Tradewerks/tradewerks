import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { submitPurchase } from "../fieldPurchases";
import { api } from "../axiosClient";

vi.mock("../axiosClient", () => ({
	api: {
		post: vi.fn(),
		get: vi.fn(),
		patch: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
	},
}));

const mockApi = api as unknown as Record<"post" | "get" | "patch" | "put" | "delete", MockInstance>;

beforeEach(() => {
	vi.clearAllMocks();
	mockApi.post.mockResolvedValue({ data: { success: true, data: {}, error: null } });
});

// `submitSheetSchema` and `lineSchema` are module-private, so this exercises the
// wire boundary through the smallest exported surface that parses through them:
// `submitPurchase`, whose sheet is `submitSheetSchema` and whose `lines` is
// `z.array(lineSchema)`.
describe("submitPurchase", () => {
	it("keeps a line's OCR confidence through the submit sheet's own schema", async () => {
		// The client mirrors the server's lineSchema, and zod strips unknown keys —
		// so a field added on the server is silently dropped here until it is added
		// in both places.
		await submitPurchase("fp-1", {
			lines: [
				{ description: "Capacitor 45/5", quantity: 2, unit_price: 24.99, ocr_confidence: 0.91 },
			],
		});

		const body = mockApi.post.mock.calls[0][1] as { lines: { ocr_confidence?: number }[] };
		expect(body.lines[0].ocr_confidence).toBe(0.91);
	});

	// Drives a sheet through submitPurchase's parse and returns the body axios
	// actually received, the same shortcut the OCR-confidence test above takes.
	async function sendSheet(sheet: Parameters<typeof submitPurchase>[1]) {
		await submitPurchase("fp-1", sheet);
		return mockApi.post.mock.calls[0][1] as {
			lines: { unit_price: number }[];
			total?: number;
		};
	}

	it("sends a printed trade discount, which the server stores as a negative line price", async () => {
		// The OCR fixture's own contractor-discount line is negative, and the server's
		// lineSchema marks unit_price signed for exactly this shape.
		const body = await sendSheet({
			lines: [{ description: "Contractor discount", quantity: 1, unit_price: -32 }],
		});
		expect(body.lines[0].unit_price).toBe(-32);
	});

	it("still refuses a negative receipt total, which is a misread rather than a discount", async () => {
		// Scope guard: only a LINE may be negative. Widening `money` itself would let a
		// whole receipt come through negative.
		await expect(sendSheet({ total: -10, lines: [] })).rejects.toThrow();
	});
});
