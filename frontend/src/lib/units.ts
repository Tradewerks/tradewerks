// Single source of presentation for inventory_item.unit. Every surface that
// prints a quantity — dispatch item detail, the inventory list, adjust/receive
// modals, reorder reports, the technician vehicle page — reads from here.
//
// TWIN FILE: backend/src/lib/units.ts carries the same code list and alias
// table (it needs no display metadata). There is no shared package in this
// repo, so the list is duplicated the same way REORDER_FORECAST_WINDOW_DAYS is,
// and both sides' tests assert it against a literal snapshot so drift fails a
// test instead of shipping.
//
// One catalog, one set of formatters, one rule — rather than each call site
// hand-rolling its own `unit.toLowerCase() !== "each"` guard.
//
// NAMING COLLISION: "unit" here means a unit of MEASURE. It is unrelated to a
// serial_unit (one physically tracked item). Do not import this module into
// serial/batch tracking code.
//
// US vs IMPERIAL (D3): gal/qt/floz/pt are US customary and labelled "US ___"
// on purpose — an imperial gallon is ~20% larger. Imperial variants are
// intentionally absent in v1; metric orgs are expected to use l / ml / tonne
// instead of a converted gallon. UN/CEFACT Rec 20 models these as genuinely
// distinct units (GLL = US gallon, GLI = imperial gallon), which is what
// validates offering only the US side rather than pretending one `gal` code
// covers both.
//
// MEASUREMENT SYSTEM (D2): `organization.measurement_system` reorders the
// picker and nothing else. It hides no code, converts no quantity, and is not
// stored on any item or movement — a quantity means what its own `unit` says
// regardless of who is looking. The alternative, filtering the list to the
// org's system, was declined: an HVAC shop in a US org fitting a metric-spec
// mini-split needs `mm` on the same day its measurement system says imperial.
//
// NO MULTI-UOM (D4): a base-unit + purchase-unit + conversion-factor scheme
// (QuickBooks-Enterprise style — buy by the case, stock by the each) was
// considered and declined for v1. It has the highest blast radius of any
// option here: it lands directly on the WAC/cost paths that just stabilized.
// A $475 25-lb refrigerant cylinder stored as unit_cost = 475 against a base
// unit of `lb` makes weighted-average cost wrong by 25x, with no error thrown
// anywhere — silent 25x cost error beats loud failure in exactly the wrong
// direction. Workarounds available today: (a) model the pack and the base as
// separate items, or (b) keep a single unit and put the pack size in the item
// name. If this is ever revisited, the cheap middle step is display-only
// `pack_size` / `pack_unit` fields that never participate in cost math.
//
// REC 20 MAPPING (D5): EN 16931 / Peppol BIS Billing 3.0 mandates a UN/CEFACT
// Recommendation 20 code for the invoiced-quantity unit, and supplier EDI /
// customs paperwork speak the same codes. Nothing in this codebase reads
// `rec20` yet — added now because it is cheap now (~30 lines, zero runtime
// effect) and would be expensive to retrofit under an actual invoicing
// deadline. Every non-null value was verified against the UNECE Rec 20
// Annex II ("by name") table — not transcribed from memory, not transcribed
// from a plan document:
// https://unece.org/fileadmin/DAM/cefact/recommendations/rec20/rec20_rev3_Annex2e.pdf
// (cross-checked via a machine-readable mirror of the same annex,
// https://github.com/CIFConsulting/unece-recommendation-20, plus the Peppol
// BIS unit-code list and a UN/CEFACT-derived OWL vocabulary). `each` maps to
// EA ("each" — Rec 20 category 3.2, "a unit of count defining the number of
// items regarded as separate units"), not the newer EN 16931/Peppol default
// H87 ("piece") — EA is the literal name match for our "each" code, where
// H87 names a different English word and would require an inferential leap
// none of the other rows need.
//
// Containers are Rec 21 package-type codes, not Rec 20 units of measure, and
// get `rec20: null` uniformly — verified case-by-case, not assumed: box,
// case, pack, roll, spool, bag, bucket, tube, cylinder, bundle, sheet, coil,
// can, drum, pallet, tote and bottle are each explicitly annotated "Use
// UN/ECE Recommendation 21" in the Rec 20 table itself. pair, set, kit and
// stick DO have standalone Rec 20 count codes (PR, SET, KT, STC respectively)
// that are NOT deferred to Rec 21 — deliberately left null anyway so "every
// container is null" stays one uninterrupted rule instead of 4 exceptions
// out of 21, and so a partial code doesn't imply e-invoicing readiness this
// catalog doesn't actually have. A separate `rec21` field is the right home
// for genuine package-type codes if that need ever arrives.

import i18n from "../i18n";

export const DEFAULT_UNIT_CODE = "each";

export const UNIT_CODES = [
	"each",
	"ft",
	"in",
	"yd",
	"m",
	"cm",
	"mm",
	"sqft",
	"sqyd",
	"sqm",
	"lb",
	"oz",
	"ton",
	"kg",
	"g",
	"tonne",
	"gal",
	"qt",
	"floz",
	"pt",
	"cuft",
	"l",
	"ml",
	"cbm",
	"box",
	"case",
	"pack",
	"pair",
	"set",
	"roll",
	"spool",
	"bag",
	"bucket",
	"tube",
	"cylinder",
	"bundle",
	"sheet",
	"coil",
	"can",
	"kit",
	"drum",
	"pallet",
	"tote",
	"bottle",
	"stick",
] as const;

export type UnitCode = (typeof UNIT_CODES)[number];

export type UnitKind = "count" | "length" | "area" | "weight" | "volume" | "container";

/**
 * Which measurement system a code belongs to, for picker ORDERING only (D2).
 * Nothing is ever hidden and nothing is ever converted — a US org still reaches
 * `mm` and a metric org still reaches `ft`, one scroll further down the same
 * group.
 *
 * `neutral` is not "unknown": `each` and every container are genuinely
 * system-free (a box is a box in both systems), so they must not be reordered
 * by either preference. Keeping them a named third value rather than defaulting
 * an untagged code to one side means a new code cannot silently inherit a
 * system it was never assigned.
 */
export type UnitSystem = "imperial" | "metric" | "neutral";

export interface UnitDef {
	/** Canonical stored value. Never shown to a user raw — pick a field below. */
	code: UnitCode;
	/** Title-case name for the picker and the detail page's "Unit" field. */
	label: string;
	/** Rendered after a quantity of exactly 1. */
	singular: string;
	/**
	 * Rendered after any other quantity — including 0 and fractions, which take
	 * the plural in English ("0.42 units") — and as a bare axis label.
	 */
	plural: string;
	kind: UnitKind;
	/**
	 * Measurement system, used only to order the picker for the org's region.
	 * Required, so adding a code forces the question rather than letting it
	 * default silently. See `UnitSystem` and `unitGroupsForSystem`.
	 */
	system: UnitSystem;
	/**
	 * Lowercased, trimmed spellings that normalize onto `code`. Never contains
	 * `code` itself, and no spelling appears twice across the catalog; a
	 * duplicate would silently route to whichever code was reached last.
	 * units.test.ts asserts both.
	 */
	aliases: readonly string[];
	/**
	 * UN/CEFACT Recommendation 20 code for e-invoicing (EN 16931 / Peppol) and
	 * supplier EDI/customs, or null when this code isn't a Rec 20 unit of
	 * measure — every container is null because those are Rec 21 package-type
	 * codes instead. See the header comment for the verification sources and
	 * the EA-vs-H87 / container reasoning. Nothing reads this field today.
	 */
	rec20: string | null;
}

// `each` is the only code whose display words differ from the code itself: a
// count has no unit of measure to name, so the quantity is counting "units".
// Measurements read the same at any count (14 ft, 1 ft); containers pluralize.
export const UNITS: Record<UnitCode, UnitDef> = {
	each: {
		code: "each",
		label: "Each",
		singular: "unit",
		plural: "units",
		kind: "count",
		system: "neutral",
		aliases: [
			"ea",
			"ea.",
			"pc",
			"pcs",
			"piece",
			"pieces",
			"unit",
			"units",
			"count",
			"ct",
			"qty",
			"item",
			"items",
		],
		rec20: "EA",
	},
	ft: {
		code: "ft",
		label: "Feet",
		singular: "ft",
		plural: "ft",
		kind: "length",
		system: "imperial",
		aliases: ["foot", "feet", "'", "lf", "linear ft", "linear foot", "linear feet"],
		rec20: "FOT",
	},
	in: {
		code: "in",
		label: "Inches",
		singular: "in",
		plural: "in",
		kind: "length",
		system: "imperial",
		aliases: ["inch", "inches", '"'],
		rec20: "INH",
	},
	yd: {
		code: "yd",
		label: "Yards",
		singular: "yd",
		plural: "yd",
		kind: "length",
		system: "imperial",
		aliases: ["yard", "yards"],
		rec20: "YRD",
	},
	m: {
		code: "m",
		label: "Meters",
		singular: "m",
		plural: "m",
		kind: "length",
		system: "metric",
		aliases: ["meter", "meters", "metre", "metres", "mtr"],
		rec20: "MTR",
	},
	cm: {
		code: "cm",
		label: "Centimeters",
		singular: "cm",
		plural: "cm",
		kind: "length",
		system: "metric",
		aliases: ["centimeter", "centimeters"],
		rec20: "CMT",
	},
	mm: {
		code: "mm",
		label: "Millimeters",
		singular: "mm",
		plural: "mm",
		kind: "length",
		system: "metric",
		aliases: ["millimeter", "millimeters", "millimetre", "millimetres"],
		rec20: "MMT",
	},
	sqft: {
		code: "sqft",
		label: "Square Feet",
		singular: "sq ft",
		plural: "sq ft",
		kind: "area",
		system: "imperial",
		aliases: ["sq ft", "sq. ft.", "ft2", "ft²", "square feet", "square foot"],
		rec20: "FTK",
	},
	sqyd: {
		code: "sqyd",
		label: "Square Yards",
		singular: "sq yd",
		plural: "sq yd",
		kind: "area",
		system: "imperial",
		aliases: ["sq yd", "sq. yd.", "yd2", "yd²", "square yard", "square yards"],
		rec20: "YDK",
	},
	sqm: {
		code: "sqm",
		label: "Square Meters",
		singular: "m²",
		plural: "m²",
		kind: "area",
		system: "metric",
		aliases: [
			"sq m",
			"sq. m.",
			"m2",
			"m²",
			"square meter",
			"square meters",
			"square metre",
			"square metres",
		],
		rec20: "MTK",
	},
	lb: {
		code: "lb",
		label: "Pounds",
		singular: "lb",
		plural: "lb",
		kind: "weight",
		system: "imperial",
		aliases: ["lbs", "pound", "pounds", "#"],
		rec20: "LBR",
	},
	oz: {
		code: "oz",
		label: "Ounces",
		singular: "oz",
		plural: "oz",
		kind: "weight",
		system: "imperial",
		aliases: ["ounce", "ounces"],
		rec20: "ONZ",
	},
	ton: {
		code: "ton",
		label: "Tons (US)",
		singular: "tons",
		plural: "tons",
		kind: "weight",
		system: "imperial",
		aliases: ["short ton", "tons"],
		rec20: "STN",
	},
	kg: {
		code: "kg",
		label: "Kilograms",
		singular: "kg",
		plural: "kg",
		kind: "weight",
		system: "metric",
		aliases: ["kilo", "kilos", "kilogram", "kilograms", "kgs"],
		rec20: "KGM",
	},
	g: {
		code: "g",
		label: "Grams",
		singular: "g",
		plural: "g",
		kind: "weight",
		system: "metric",
		aliases: ["gram", "grams"],
		rec20: "GRM",
	},
	tonne: {
		code: "tonne",
		label: "Tonnes",
		singular: "tonne",
		plural: "tonne",
		kind: "weight",
		system: "metric",
		aliases: ["metric ton", "metric tons", "tonnes"],
		rec20: "TNE",
	},
	gal: {
		code: "gal",
		label: "US Gallons",
		singular: "US gal",
		plural: "US gal",
		kind: "volume",
		system: "imperial",
		aliases: ["gallon", "gallons"],
		rec20: "GLL",
	},
	qt: {
		code: "qt",
		label: "US Quarts",
		singular: "US qt",
		plural: "US qt",
		kind: "volume",
		system: "imperial",
		aliases: ["quart", "quarts"],
		rec20: "QTL",
	},
	floz: {
		code: "floz",
		label: "US Fluid Ounces",
		singular: "US fl oz",
		plural: "US fl oz",
		kind: "volume",
		system: "imperial",
		aliases: ["fl oz", "fl. oz.", "fluid ounce", "fluid ounces"],
		rec20: "OZA",
	},
	pt: {
		code: "pt",
		label: "US Pints",
		singular: "US pt",
		plural: "US pt",
		kind: "volume",
		system: "imperial",
		aliases: ["pint", "pints"],
		rec20: "PTL",
	},
	cuft: {
		code: "cuft",
		label: "Cubic Feet",
		singular: "cu ft",
		plural: "cu ft",
		kind: "volume",
		system: "imperial",
		aliases: ["cu ft", "cu. ft.", "ft3", "ft³", "cubic feet", "cubic foot"],
		rec20: "FTQ",
	},
	l: {
		code: "l",
		label: "Liters",
		singular: "L",
		plural: "L",
		kind: "volume",
		system: "metric",
		aliases: ["liter", "liters", "litre", "litres", "ltr"],
		rec20: "LTR",
	},
	ml: {
		code: "ml",
		label: "Milliliters",
		singular: "mL",
		plural: "mL",
		kind: "volume",
		system: "metric",
		aliases: ["milliliter", "milliliters"],
		rec20: "MLT",
	},
	cbm: {
		code: "cbm",
		label: "Cubic Meters",
		singular: "m³",
		plural: "m³",
		kind: "volume",
		system: "metric",
		aliases: [
			"cu m",
			"cu. m.",
			"m3",
			"m³",
			"cubic meter",
			"cubic meters",
			"cubic metre",
			"cubic metres",
		],
		rec20: "MTQ",
	},
	box: {
		code: "box",
		label: "Boxes",
		singular: "box",
		plural: "boxes",
		kind: "container",
		system: "neutral",
		aliases: ["bx", "boxes", "carton"],
		rec20: null,
	},
	case: {
		code: "case",
		label: "Cases",
		singular: "case",
		plural: "cases",
		kind: "container",
		system: "neutral",
		aliases: ["cs", "cases"],
		rec20: null,
	},
	pack: {
		code: "pack",
		label: "Packs",
		singular: "pack",
		plural: "packs",
		kind: "container",
		system: "neutral",
		aliases: ["pk", "pkg", "package", "packages", "packs"],
		rec20: null,
	},
	pair: {
		code: "pair",
		label: "Pairs",
		singular: "pair",
		plural: "pairs",
		kind: "container",
		system: "neutral",
		aliases: ["pr", "pairs"],
		rec20: null,
	},
	set: {
		code: "set",
		label: "Sets",
		singular: "set",
		plural: "sets",
		kind: "container",
		system: "neutral",
		aliases: ["sets"],
		rec20: null,
	},
	roll: {
		code: "roll",
		label: "Rolls",
		singular: "roll",
		plural: "rolls",
		kind: "container",
		system: "neutral",
		aliases: ["rl", "rolls"],
		rec20: null,
	},
	spool: {
		code: "spool",
		label: "Spools",
		singular: "spool",
		plural: "spools",
		kind: "container",
		system: "neutral",
		aliases: ["spools", "reel"],
		rec20: null,
	},
	bag: {
		code: "bag",
		label: "Bags",
		singular: "bag",
		plural: "bags",
		kind: "container",
		system: "neutral",
		aliases: ["bags"],
		rec20: null,
	},
	bucket: {
		code: "bucket",
		label: "Buckets",
		singular: "bucket",
		plural: "buckets",
		kind: "container",
		system: "neutral",
		aliases: ["pail", "pails", "buckets"],
		rec20: null,
	},
	tube: {
		code: "tube",
		label: "Tubes",
		singular: "tube",
		plural: "tubes",
		kind: "container",
		system: "neutral",
		aliases: ["tubes"],
		rec20: null,
	},
	cylinder: {
		code: "cylinder",
		label: "Cylinders",
		singular: "cylinder",
		plural: "cylinders",
		kind: "container",
		system: "neutral",
		aliases: ["cyl", "cylinders", "tank", "tanks"],
		rec20: null,
	},
	bundle: {
		code: "bundle",
		label: "Bundles",
		singular: "bundle",
		plural: "bundles",
		kind: "container",
		system: "neutral",
		aliases: ["bdl", "bundles"],
		rec20: null,
	},
	sheet: {
		code: "sheet",
		label: "Sheets",
		singular: "sheet",
		plural: "sheets",
		kind: "container",
		system: "neutral",
		aliases: ["sht", "sheets"],
		rec20: null,
	},
	coil: {
		code: "coil",
		label: "Coils",
		singular: "coil",
		plural: "coils",
		kind: "container",
		system: "neutral",
		aliases: ["coils"],
		rec20: null,
	},
	can: {
		code: "can",
		label: "Cans",
		singular: "can",
		plural: "cans",
		kind: "container",
		system: "neutral",
		aliases: ["cans"],
		rec20: null,
	},
	kit: {
		code: "kit",
		label: "Kits",
		singular: "kit",
		plural: "kits",
		kind: "container",
		system: "neutral",
		aliases: ["kits"],
		rec20: null,
	},
	drum: {
		code: "drum",
		label: "Drums",
		singular: "drum",
		plural: "drums",
		kind: "container",
		system: "neutral",
		aliases: ["drums"],
		rec20: null,
	},
	pallet: {
		code: "pallet",
		label: "Pallets",
		singular: "pallet",
		plural: "pallets",
		kind: "container",
		system: "neutral",
		aliases: ["pallets"],
		rec20: null,
	},
	tote: {
		code: "tote",
		label: "Totes",
		singular: "tote",
		plural: "totes",
		kind: "container",
		system: "neutral",
		aliases: ["totes"],
		rec20: null,
	},
	bottle: {
		code: "bottle",
		label: "Bottles",
		singular: "bottle",
		plural: "bottles",
		kind: "container",
		system: "neutral",
		aliases: ["bottles"],
		rec20: null,
	},
	stick: {
		code: "stick",
		label: "Sticks",
		singular: "stick",
		plural: "sticks",
		kind: "container",
		system: "neutral",
		aliases: ["sticks"],
		rec20: null,
	},
};

const KIND_LABELS: Record<UnitKind, string> = {
	count: "Count",
	length: "Length",
	area: "Area",
	weight: "Weight",
	volume: "Volume",
	container: "Container",
};

const KIND_ORDER: readonly UnitKind[] = ["count", "length", "area", "weight", "volume", "container"];

/**
 * Picker groups, derived from UNITS rather than restated — every code lands in
 * exactly one group by construction, so a new unit can't be added to the
 * catalog and forgotten in the dropdown.
 */
export const UNIT_GROUPS: { kind: UnitKind; label: string; codes: UnitCode[] }[] = KIND_ORDER.map(
	(kind) => ({
		kind,
		label: KIND_LABELS[kind],
		codes: UNIT_CODES.filter((code) => UNITS[code].kind === kind),
	}),
);

/**
 * `UNIT_GROUPS` reordered so the org's own measurement system comes first
 * inside each group (D2). Derived from `UNIT_GROUPS`, not restated, for the
 * same reason `UNIT_GROUPS` is derived from `UNITS`: a code added to the
 * catalog cannot go missing from the picker.
 *
 * The partition is STABLE — within the preferred half and within the rest,
 * catalog order survives — so `ft, in, yd` never becomes `yd, ft, in` just
 * because a metric org flipped the halves.
 *
 * Nothing is removed: `codes.length` is identical for every system, which the
 * tests assert directly. A metric org that buys a US-spec part still picks
 * `ft`; it is simply further down.
 *
 * `neutral` codes sort with "the rest" rather than getting a third bucket.
 * They only ever occupy the Count and Container groups, where every member is
 * neutral and the partition is therefore a no-op — a third bucket would be
 * dead machinery. If a mixed group ever gains a neutral member, revisit.
 *
 * Passing `undefined` (settings still loading) returns `UNIT_GROUPS` as-is,
 * which is already imperial-first by catalog order. That makes the loading
 * state indistinguishable from the majority case instead of flashing an
 * arbitrary order and then reshuffling under the user's cursor.
 */
export function unitGroupsForSystem(
	system: UnitSystem | undefined,
): { kind: UnitKind; label: string; codes: UnitCode[] }[] {
	if (!system || system === "neutral") return UNIT_GROUPS;
	return UNIT_GROUPS.map((group) => ({
		...group,
		codes: [
			...group.codes.filter((code) => UNITS[code].system === system),
			...group.codes.filter((code) => UNITS[code].system !== system),
		],
	}));
}

const BY_SPELLING: Map<string, UnitCode> = (() => {
	const map = new Map<string, UnitCode>();
	for (const code of UNIT_CODES) {
		map.set(code, code);
		for (const alias of UNITS[code].aliases) map.set(alias, code);
	}
	return map;
})();

/**
 * Canonical code for a freetext unit, or null when nothing matches. Used to
 * pre-select a real option when editing an item saved before the catalog
 * existed.
 */
export function normalizeUnitCode(raw: unknown): UnitCode | null {
	if (typeof raw !== "string") return null;
	const key = raw.trim().toLowerCase();
	if (!key) return null;
	return BY_SPELLING.get(key) ?? null;
}

/**
 * A stored unit outside the catalog — a pre-catalog freetext value such as
 * "gallon" that no alias maps onto. Rendered VERBATIM: the row's quantity means
 * what that string says, and re-reading it as `each` (the old fallback) is the
 * same silent re-denomination the stamped ledger unit exists to prevent.
 * `label`/`singular`/`plural` are all the raw string, since nothing is known
 * about it. Carries `legacy` so a surface can offer a catalog pick.
 */
export interface LegacyUnitDef {
	code: string;
	label: string;
	singular: string;
	plural: string;
	legacy: true;
}

/**
 * The definition for a stored unit value. Never throws. Catalog codes and their
 * aliases resolve to the catalog definition; a nullable/blank value (e.g. the
 * nullable forecast field) degrades to `each` so the surface still renders a
 * sensible quantity instead of interpolating "null"; anything else is a legacy
 * string and comes back as a verbatim `LegacyUnitDef`.
 */
export function unitDef(code: string | null | undefined): UnitDef | LegacyUnitDef {
	const normalized = normalizeUnitCode(code);
	if (normalized) return UNITS[normalized];
	const raw = typeof code === "string" ? code.trim() : "";
	if (!raw) return UNITS[DEFAULT_UNIT_CODE];
	return { code: raw, label: raw, singular: raw, plural: raw, legacy: true };
}

/**
 * The unit word on its own, agreeing with `qty` when one is given. Chart axis
 * labels pass no qty and get the plural, since an axis describes a series
 * rather than a single value.
 *
 * Use this where the number and the unit are styled differently (stat tiles,
 * placement rows). Use formatQty where they belong to one run of text.
 */
// Only unit words are keyed (units.<code>_one/_other); symbols like ft or kg fall back to UNITS.
const tUnit = i18n.t as unknown as (key: string, opts: { count: number; defaultValue: string }) => string;

export function unitLabel(code: string | null | undefined, qty?: number): string {
	const def = unitDef(code);
	const english = qty === 1 ? def.singular : def.plural;
	if ("legacy" in def) return english;
	return tUnit(`units.${def.code}`, { count: qty ?? 2, defaultValue: english });
}

/** "14 units" · "1 unit" · "0.42 units" · "14 ft" · "3 boxes" */
export function formatQty(qty: number, code: string | null | undefined): string {
	return `${qty} ${unitLabel(code, qty)}`;
}
