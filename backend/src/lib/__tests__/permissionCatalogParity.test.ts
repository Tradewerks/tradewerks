import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getAllPermissions } from "../permissionCatalogs.js";

/**
 * The frontend catalog supplies the labels the roles editor renders; the
 * backend catalog is what grants and gates read. A permission in one and not
 * the other is a broken control either way — a grantable checkbox no route
 * reads, or a gate no admin can satisfy.
 *
 * The old check was backend ⊆ frontend, by substring over the whole file: no
 * frontend→backend direction, no per-tier scoping (a dispatcher permission
 * matched a technician-catalog entry), and a hit inside a comment counted.
 * This parses `{ id: "…", label: "…" }` inside each tier's catalog block and
 * asserts set equality both directions, per tier, plus non-empty labels (DW-22).
 *
 * The frontend file is read as text, not imported: it lives in another package
 * with its own tsconfig, and pulling it into the backend module graph to
 * assert two lists would be the more fragile coupling.
 */
const frontendSource = readFileSync(
	resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../../../frontend/src/lib/permissionCatalogs.ts",
	),
	"utf8",
);

const TIER_EXPORT: Record<"dispatcher" | "technician", string> = {
	dispatcher: "DISPATCHER_CATALOG",
	technician: "TECHNICIAN_CATALOG",
};

/** The `export const <NAME> = [ … ]` slice, up to the next top-level export. */
function catalogBlock(source: string, exportName: string): string {
	const start = source.indexOf(`export const ${exportName}`);
	if (start === -1) throw new Error(`${exportName} not found in frontend catalog`);
	const rest = source.slice(start + exportName.length);
	const next = rest.indexOf("\nexport const ");
	return next === -1 ? rest : rest.slice(0, next);
}

/** Every `{ id: "…", label: "…" }` pair in a catalog block. */
function parseEntries(block: string): { id: string; label: string }[] {
	const entries: { id: string; label: string }[] = [];
	const re = /id:\s*"([^"]+)"\s*,\s*label:\s*"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(block)) !== null) {
		entries.push({ id: m[1], label: m[2] });
	}
	return entries;
}

describe("permission catalog parity", () => {
	for (const tier of ["dispatcher", "technician"] as const) {
		const entries = parseEntries(catalogBlock(frontendSource, TIER_EXPORT[tier]));
		const frontendIds = entries.map((e) => e.id);
		const backendIds = getAllPermissions(tier);

		it(`${tier}: parsed a non-trivial frontend catalog`, () => {
			expect(frontendIds.length).toBeGreaterThan(3);
		});

		it(`${tier}: same permission ids on both sides, both directions`, () => {
			expect([...frontendIds].sort()).toEqual([...backendIds].sort());
		});

		it(`${tier}: no id appears twice in the frontend catalog`, () => {
			expect(new Set(frontendIds).size).toBe(frontendIds.length);
		});

		it(`${tier}: every frontend entry has a non-empty label`, () => {
			expect(entries.filter((e) => e.label.trim() === "")).toEqual([]);
		});
	}
});
