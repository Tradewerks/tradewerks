import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { QUOTE_TRANSITIONS } from "../statusTransitions.js";

/**
 * frontend/src/lib/quoteTransitions.ts is a hand-maintained mirror of this
 * file's QUOTE_TRANSITIONS. The frontend's own test only compared it to a THIRD
 * literal inside that test file — so a backend-only edit (the authoritative
 * side) sailed past every suite while the UI kept offering a button that 422s.
 * This reads the frontend table as text and deep-equals it against the backend
 * one, both directions (DW-21). Same technique as permissionCatalogParity.
 */
const frontendSource = readFileSync(
	resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../../../frontend/src/lib/quoteTransitions.ts",
	),
	"utf8",
);

/** Pull `export const QUOTE_TRANSITIONS ... = { ... };` and parse the literal. */
function parseFrontendTable(source: string): Record<string, string[]> {
	const block = source.match(
		/export const QUOTE_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\};/,
	);
	if (!block) throw new Error("QUOTE_TRANSITIONS literal not found in frontend file");
	const table: Record<string, string[]> = {};
	for (const line of block[1].split("\n")) {
		const row = line.match(/^\s*(\w+):\s*\[([^\]]*)\]/);
		if (!row) continue;
		table[row[1]] = row[2]
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter((s) => s.length > 0);
	}
	return table;
}

const normalize = (t: Record<string, readonly string[]>) =>
	Object.fromEntries(
		Object.entries(t).map(([from, tos]) => [from, [...tos].sort()]),
	);

describe("QUOTE_TRANSITIONS frontend/backend parity", () => {
	const frontend = parseFrontendTable(frontendSource);

	it("parsed a non-trivial frontend table", () => {
		expect(Object.keys(frontend).length).toBeGreaterThan(5);
	});

	it("has the same from-states on both sides", () => {
		expect(Object.keys(frontend).sort()).toEqual(
			Object.keys(QUOTE_TRANSITIONS).sort(),
		);
	});

	it("has the same allowed targets for every from-state, both directions", () => {
		expect(normalize(frontend)).toEqual(normalize(QUOTE_TRANSITIONS));
	});
});
