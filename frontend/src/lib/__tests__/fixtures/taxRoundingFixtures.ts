// Verbatim copy of backend/src/services/__tests__/fixtures/taxRoundingFixtures.ts; keep in sync.
/**
 * Shared rounding fixtures (spec §0 item 6). JSON-able on purpose: the frontend mirror of the
 * engine copies this table verbatim and must produce the same cents. Expected values were
 * worked by hand, not generated from the engine.
 */

type Rate = { id: string; name: string; rate: number };
type Group = { id: string; name: string; rates: Rate[] };

export interface RoundingFixture {
	name: string;
	client_exempt: boolean;
	input: {
		line_items: {
			id: string;
			total_cents: number;
			taxable: boolean;
			tax_group: Group | null;
		}[];
		discount_type?: "percent" | "amount" | null;
		discount_value?: number | null;
	};
	expected: {
		line_floor: Record<string, number>;
		jurisdiction_half_up: Record<string, number>;
		/** Group id → tax_amount_cents under jurisdiction_half_up. */
		half_up_groups: Record<string, number>;
	};
}

const r = (id: string, rate: number): Rate => ({ id, name: id, rate });
const G5: Group = { id: "g5", name: "5%", rates: [r("st", 0.05)] };
const G7: Group = { id: "g7", name: "7%", rates: [r("st7", 0.07)] };
const G55: Group = { id: "g55", name: "5% + 0.5%", rates: [r("st", 0.05), r("co", 0.005)] };
const line = (id: string, total_cents: number, tax_group: Group | null, taxable = true) => ({
	id,
	total_cents,
	taxable,
	tax_group,
});

export const ROUNDING_FIXTURES: RoundingFixture[] = [
	{
		// 16.65 x 3: floor 48; aggregate 49.95 → 50; equal remainders → earlier lines first.
		name: "three $3.33 lines at 5%",
		client_exempt: false,
		input: { line_items: [line("a", 333, G5), line("b", 333, G5), line("c", 333, G5)] },
		expected: {
			line_floor: { a: 16, b: 16, c: 16 },
			jurisdiction_half_up: { a: 17, b: 17, c: 16 },
			half_up_groups: { g5: 50 },
		},
	},
	{
		// 5%: 49.95 → 50 [17,17,16]; 0.5%: 4.995 → 5 [2,2,1].
		name: "two-rate group rounds each rate separately",
		client_exempt: false,
		input: { line_items: [line("a", 333, G55), line("b", 333, G55), line("c", 333, G55)] },
		expected: {
			line_floor: { a: 17, b: 17, c: 17 },
			jurisdiction_half_up: { a: 19, b: 19, c: 17 },
			half_up_groups: { g55: 55 },
		},
	},
	{
		// 0.5 + 0.5 → 1 + 1; the combined 5% (1.0) would give 1.
		name: "per-rate rounding is not combined-rate rounding",
		client_exempt: false,
		input: {
			line_items: [
				line("a", 20, {
					id: "gpair",
					name: "2.5% + 2.5%",
					rates: [r("x", 0.025), r("y", 0.025)],
				}),
			],
		},
		expected: {
			line_floor: { a: 0 },
			jurisdiction_half_up: { a: 2 },
			half_up_groups: { gpair: 2 },
		},
	},
	{
		// -16.65 → -17, the mirror of a +16.65 charge.
		name: "negative credit line alone",
		client_exempt: false,
		input: { line_items: [line("a", -333, G5)] },
		expected: {
			line_floor: { a: -16 },
			jurisdiction_half_up: { a: -17 },
			half_up_groups: { g5: -17 },
		},
	},
	{
		// Mirror of the first fixture: the leftover is -2 and goes to the earlier lines.
		name: "three negative lines at 5%",
		client_exempt: false,
		input: { line_items: [line("a", -333, G5), line("b", -333, G5), line("c", -333, G5)] },
		expected: {
			line_floor: { a: -16, b: -16, c: -16 },
			jurisdiction_half_up: { a: -17, b: -17, c: -16 },
			half_up_groups: { g5: -50 },
		},
	},
	{
		// Shares 16.65, 16.65, -5.55; truncated 27; aggregate 27.75 → 28.
		name: "mixed signs in one group",
		client_exempt: false,
		input: { line_items: [line("a", 333, G5), line("b", 333, G5), line("c", -111, G5)] },
		expected: {
			line_floor: { a: 16, b: 16, c: -5 },
			jurisdiction_half_up: { a: 17, b: 16, c: -5 },
			half_up_groups: { g5: 28 },
		},
	},
	{
		// Shares 0.7, 0.7, -0.9; aggregate 0.5 → 1. By magnitude the cent would land on the
		// credit line (-0.9 → +1); by signed remainder it goes to the first charge.
		name: "mixed signs: leftover never pushes a credit line across zero",
		client_exempt: false,
		input: { line_items: [line("a", 14, G5), line("b", 14, G5), line("c", -18, G5)] },
		expected: {
			line_floor: { a: 0, b: 0, c: 0 },
			jurisdiction_half_up: { a: 1, b: 0, c: 0 },
			half_up_groups: { g5: 1 },
		},
	},
	{
		// 10% of 1000 = 100 split 37/37/26 → bases 333, 333, 234; shares 16.65, 16.65, 11.7;
		// aggregate 45 → leftover 2 to c (.7) then a (.65).
		name: "percent discount",
		client_exempt: false,
		input: {
			line_items: [line("a", 370, G5), line("b", 370, G5), line("c", 260, G5)],
			discount_type: "percent",
			discount_value: 10,
		},
		expected: {
			line_floor: { a: 16, b: 16, c: 11 },
			jurisdiction_half_up: { a: 17, b: 16, c: 12 },
			half_up_groups: { g5: 45 },
		},
	},
	{
		// $1.00 off 1000 → bases 450, 450; shares 31.5 each (float 31.500000000000004);
		// aggregate 63 (float 63.00000000000001).
		name: "amount discount",
		client_exempt: false,
		input: {
			line_items: [line("a", 500, G7), line("b", 500, G7)],
			discount_type: "amount",
			discount_value: 1,
		},
		expected: {
			line_floor: { a: 31, b: 31 },
			jurisdiction_half_up: { a: 32, b: 31 },
			half_up_groups: { g7: 63 },
		},
	},
	{
		// 200 x 0.0725 evaluates to 14.499999999999998; the true 14.5 rounds to 15.
		name: "float noise below a true half",
		client_exempt: false,
		input: {
			line_items: [
				line("a", 200, { id: "g725", name: "7.25%", rates: [r("st", 0.0725)] }),
			],
		},
		expected: {
			line_floor: { a: 14 },
			jurisdiction_half_up: { a: 15 },
			half_up_groups: { g725: 15 },
		},
	},
	{
		name: "exempt client",
		client_exempt: true,
		input: { line_items: [line("a", 333, G5), line("b", 333, G5), line("c", 333, G5)] },
		expected: {
			line_floor: { a: 0, b: 0, c: 0 },
			jurisdiction_half_up: { a: 0, b: 0, c: 0 },
			half_up_groups: {},
		},
	},
	{
		// Non-taxable and ungrouped lines stay at 0 and stay out of the group's base (666).
		name: "non-taxable lines are untouched",
		client_exempt: false,
		input: {
			line_items: [
				line("a", 333, G5),
				line("b", 500, G5, false),
				line("c", 333, G5),
				line("d", 100, null),
			],
		},
		expected: {
			line_floor: { a: 16, b: 0, c: 16, d: 0 },
			jurisdiction_half_up: { a: 17, b: 0, c: 16, d: 0 },
			half_up_groups: { g5: 33 },
		},
	},
	{
		// g5 base 666 → 33 [17,16]; g7 shares 17.5 x 2, base 500 → 35 [18,17].
		name: "interleaved groups allocate within their own lines",
		client_exempt: false,
		input: {
			line_items: [
				line("a", 333, G5),
				line("b", 250, G7),
				line("c", 333, G5),
				line("d", 250, G7),
			],
		},
		expected: {
			line_floor: { a: 16, b: 17, c: 16, d: 17 },
			jurisdiction_half_up: { a: 17, b: 18, c: 16, d: 17 },
			half_up_groups: { g5: 33, g7: 35 },
		},
	},
];
