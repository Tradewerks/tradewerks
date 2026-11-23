import { expect, test, type Page } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

const API = "http://localhost:3000";

async function token(page: Page) {
	return page.evaluate(() => localStorage.getItem("accessToken"));
}

async function api<T>(
	page: Page,
	method: "get" | "post",
	path: string,
	data?: unknown
): Promise<T> {
	const res = await page.request[method](`${API}${path}`, {
		headers: { Authorization: `Bearer ${await token(page)}` },
		...(data === undefined ? {} : { data }),
	});
	expect(res.ok(), `${method} ${path} -> ${res.status()}`).toBe(true);
	return (await res.json()).data as T;
}

// Needs a migrated dev stack: the seed org has customer_comms on, and the outbox
// sweeper and email provider are running. Seed ids change on every reseed.
test("a confirmation switched on and a visit created leaves a sent row in the visit's activity", async ({
	page,
}) => {
	test.setTimeout(180_000);
	await loginAsDispatcher(page);

	await page.goto("/app/dispatch/admin?tab=customer_messages");
	const email = page.getByRole("switch", { name: "Email — Visit confirmed" });
	await expect(email).toBeVisible();
	if ((await email.getAttribute("aria-checked")) !== "true") {
		await email.click();
	}
	await expect(email).toHaveAttribute("aria-checked", "true");

	const jobs = await api<{ id: string }[]>(page, "get", "/jobs");
	expect(jobs.length).toBeGreaterThan(0);

	// Tomorrow 10:00-11:00 local; far enough out that the visit is "future" for every notice.
	const start = new Date();
	start.setDate(start.getDate() + 1);
	start.setHours(10, 0, 0, 0);
	const end = new Date(start.getTime() + 60 * 60 * 1000);

	let visitId: string | null = null;
	for (const job of jobs) {
		const res = await page.request.post(`${API}/job-visits`, {
			headers: { Authorization: `Bearer ${await token(page)}` },
			data: {
				job_id: job.id,
				name: `Notice check ${Date.now()}`,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: start.toISOString(),
				scheduled_end_at: end.toISOString(),
			},
		});
		if (res.ok()) {
			visitId = (await res.json()).data.id as string;
			break;
		}
	}
	expect(visitId, "a visit could be created on a seed job").not.toBeNull();

	await expect
		.poll(
			async () => {
				const rows = await api<{ event: string; status: string }[]>(
					page,
					"get",
					`/customer-comms/messages?entity_type=job_visit&entity_id=${visitId}`
				);
				return rows.find((r) => r.event === "visit_confirmed")?.status;
			},
			{ timeout: 150_000, intervals: [2_000] }
		)
		.toBe("sent");

	// Put the dev org back.
	await page.goto("/app/dispatch/admin?tab=customer_messages");
	const toggle = page.getByRole("switch", { name: "Email — Visit confirmed" });
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
});
