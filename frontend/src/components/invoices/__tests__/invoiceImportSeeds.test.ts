import { describe, it, expect } from "vitest";
import { jobLineSeed, visitLineSeed } from "../invoiceImportSeeds";
import type { JobLineItem, VisitLineItem } from "../../../types/jobs";

const base = {
	name: "Coil",
	description: null,
	quantity: 1,
	unit_price: 100,
	total: 100,
	item_type: "material" as const,
	taxable: true,
	tax_amount: null,
};

describe("invoice import seeds", () => {
	it("a job line carries its tax group onto the invoice", () => {
		const item: JobLineItem = { ...base, id: "l1", tax_group_id: "g-job" } as JobLineItem;
		expect(jobLineSeed(item, "job-1")).toMatchObject({
			tax_group_id: "g-job",
			taxable: true,
			source_job_id: "job-1",
			source_visit_id: null,
		});
	});

	it("a visit line carries its tax group, and an ungrouped one stays ungrouped", () => {
		const grouped: VisitLineItem = { ...base, tax_group_id: "g-visit" };
		const ungrouped: VisitLineItem = { ...base, tax_group_id: null, taxable: false };
		expect(visitLineSeed(grouped, "v1", "job-1")).toMatchObject({
			tax_group_id: "g-visit",
			source_visit_id: "v1",
			source_job_id: "job-1",
		});
		expect(visitLineSeed(ungrouped, "v1", null)).toMatchObject({
			tax_group_id: null,
			taxable: false,
		});
	});
});
