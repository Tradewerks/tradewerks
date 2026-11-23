import { expect, it } from "vitest";
import en from "./en.json";
import es from "./es.json";

const keys = (o: object, prefix = ""): string[] =>
	Object.entries(o).flatMap(([k, v]) =>
		typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
	);

it("en.json and es.json have the same keys", () => {
	expect(keys(es).sort()).toEqual(keys(en).sort());
});
