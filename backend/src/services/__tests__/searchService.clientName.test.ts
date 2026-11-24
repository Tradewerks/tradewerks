import { beforeEach, describe, expect, it, vi } from "vitest";

const { job, quote, request, job_visit } = vi.hoisted(() => {
	const mk = () => ({ findMany: vi.fn(async (_args: unknown) => [] as unknown[]) });
	return { job: mk(), quote: mk(), request: mk(), job_visit: mk() };
});

vi.mock("../../lib/context.js", () => ({
	getScopedDb: () => ({ job, quote, request, job_visit }),
}));
vi.mock("../../lib/entitlements/ownership.js", () => ({
	ENTITY_MODULE: {},
	namesWithModuleOn: async (_o: string, names: readonly string[]) => [...names],
}));

import { searchRecords } from "../searchService.js";

const ci = { contains: "acme", mode: "insensitive" };
const whereOf = (m: { findMany: ReturnType<typeof vi.fn> }) =>
	(m.findMany.mock.calls[0][0] as { where: { OR: unknown[] } & Record<string, unknown> }).where;

beforeEach(() => [job, quote, request, job_visit].forEach((m) => m.findMany.mockClear()));

describe("client-name matching", () => {
	it("searching a client name returns that client's jobs, quotes and requests", async () => {
		await searchRecords("o", { query: "acme", types: ["job", "quote", "request"] });
		for (const m of [job, quote, request]) {
			expect(whereOf(m).OR).toContainEqual({ client: { name: ci } });
		}
	});

	it("a visit is found by its job name and client name", async () => {
		await searchRecords("o", { query: "acme", types: ["visit"] });
		const or = whereOf(job_visit).OR;
		expect(or).toContainEqual({ job: { name: ci } });
		expect(or).toContainEqual({ job: { client: { name: ci } } });
	});

	it("client-name search does not widen an assigned-only caller's jobs", async () => {
		await searchRecords("o", { query: "acme", types: ["job", "visit"], assignedTechId: "t1" });
		const jw = whereOf(job);
		expect(jw.OR).toContainEqual({ client: { name: ci } });
		expect(jw.visits).toEqual({ some: { visit_techs: { some: { tech_id: "t1" } } } });
		expect(JSON.stringify(jw.OR)).not.toContain("tech_id");
		const vw = whereOf(job_visit);
		expect(vw.visit_techs).toEqual({ some: { tech_id: "t1" } });
		expect(JSON.stringify(vw.OR)).not.toContain("tech_id");
	});
});
