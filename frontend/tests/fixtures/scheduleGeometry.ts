import { expect, type Page } from "@playwright/test";
import { loginAsDispatcher } from "./auth";

/** Dashboard schedule widget root. */
export const STRIP = "[data-schedule-strip]";

export function todayKey(): string {
	const d = new Date();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

export async function openDashboard(page: Page, width = 1440) {
	await page.setViewportSize({ width, height: 900 });
	await loginAsDispatcher(page);
	await page.goto("/dispatch");
	await expect(page.locator(STRIP)).toBeVisible({ timeout: 15000 });
}

export async function openSchedule(page: Page, width = 1440) {
	await page.setViewportSize({ width, height: 900 });
	await loginAsDispatcher(page);
	await page.goto("/dispatch/schedule");
}

type SeedVisit = { arrival_constraint: string } & Record<string, unknown>;
type SeedJob = { visits?: SeedVisit[]; client?: unknown } & Record<string, unknown>;

/**
 * Replace GET /jobs with `build`'s jobs, cloned from a real job that has a timed visit so the
 * synthetic rows carry every field the UI reads. The seeded org's schedule churns between runs;
 * counts must be deterministic.
 */
export async function interceptJobs(
	page: Page,
	build: (base: SeedJob, template: SeedVisit) => SeedJob[]
) {
	await page.route(/\/jobs(\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const res = await route.fetch();
		const body = await res.json();
		const base = (body.data as SeedJob[]).find((j) =>
			(j.visits ?? []).some((v) => v.arrival_constraint !== "anytime")
		);
		const template = base?.visits?.find((v) => v.arrival_constraint !== "anytime");
		if (!base || !template) throw new Error("seed data has no job with a timed visit to clone");
		await route.fulfill({ response: res, json: { ...body, data: build(base, template) } });
	});
}

/** One job carrying `n` timed visits today (08:00 + i min, local), plus optional anytime ones. */
export async function seedToday(
	page: Page,
	n: number,
	name?: string,
	opts: { anytime?: number } = {}
) {
	await interceptJobs(page, (base, template) => {
		const now = new Date();
		const visits = Array.from({ length: n }, (_, i) => {
			const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, i);
			return {
				...template,
				id: `synthetic-visit-${i}`,
				status: "Scheduled",
				// The template's own arrival fields would override the label with a DB-dependent time.
				arrival_constraint: "at",
				arrival_time: `08:${String(i).padStart(2, "0")}`,
				arrival_window_start: null,
				arrival_window_end: null,
				scheduled_start_at: start.toISOString(),
				scheduled_end_at: new Date(start.getTime() + 3_600_000).toISOString(),
			};
		});
		const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const anytime = Array.from({ length: opts.anytime ?? 0 }, (_, i) => ({
			...template,
			id: `synthetic-anytime-${i}`,
			status: "Scheduled",
			arrival_constraint: "anytime",
			arrival_time: null,
			arrival_window_start: null,
			arrival_window_end: null,
			scheduled_start_at: midnight.toISOString(),
			scheduled_end_at: new Date(midnight.getTime() + 3_600_000).toISOString(),
		}));
		return [
			{
				...base,
				id: "synthetic-job",
				name: name ?? base.name,
				visits: [...anytime, ...visits],
				recurring_plan: null,
			},
		];
	});
}

/** Day keys of the headers under `scope`, in display order. */
export async function dayKeys(page: Page, scope = "") {
	return page
		.locator(`${scope} [data-day-header]`)
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-day-header") ?? ""));
}

/** Day columns animate width over 180ms; measurements taken earlier read a stale width. */
export const settle = (page: Page) => page.waitForTimeout(260);

/** Enabled, non-draggable buttons under `scope` whose computed cursor is not pointer. */
export async function nonPointerButtons(page: Page, scope: string) {
	return page.locator(scope).first().evaluate((root) =>
		[...root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
			.filter((b) => b.getAttribute("draggable") !== "true")
			.filter((b) => getComputedStyle(b).cursor !== "pointer")
			.map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "?")
	);
}

/** Geometry of the first day header under `scope` — compared across surfaces. */
export async function headerGeometry(page: Page, scope: string) {
	return page.locator(`${scope} [data-day-header]`).first().evaluate((h) => {
		const wd = h.querySelector("[data-day-weekday]")!;
		const num = h.querySelector("[data-day-num]")!;
		const btn = h.querySelector("button[aria-pressed]")!;
		const wdCs = getComputedStyle(wd);
		const numCs = getComputedStyle(num);
		return {
			gap: Math.round(num.getBoundingClientRect().left - wd.getBoundingClientRect().right),
			inset: Math.round(h.getBoundingClientRect().right - btn.getBoundingClientRect().right),
			align: getComputedStyle(wd.parentElement!).alignItems,
			weekday: `${wdCs.fontSize}/${wdCs.fontWeight}/${wdCs.textTransform}`,
			num: `${numCs.fontSize}/${numCs.fontWeight}`,
		};
	});
}

export const headerBtn = (page: Page, day: string) =>
	page.locator(`${STRIP} [data-day-header="${day}"] button[aria-pressed]`);

export async function zoomDay(page: Page, day: string) {
	await page.locator(`${STRIP} [data-day-header="${day}"]`).hover();
	await headerBtn(page, day).click();
}

/** Force the widget's width so its ResizeObserver switches column mode. */
export async function setStripWidth(page: Page, px: number) {
	await page
		.locator(STRIP)
		.evaluate((el, w) => el.style.setProperty("width", `${w}px`, "important"), px);
}

export async function toolbarStyles(page: Page, scope: string) {
	return page.locator(`${scope} [data-schedule-toolbar]`).first().evaluate((tb) => {
		const named = (n: string) =>
			[...tb.querySelectorAll("button")].find(
				(b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === n
			)!;
		return ["Today", "Previous week", "Next week", "Visits", "Recurring"].map((n) => {
			const cs = getComputedStyle(named(n));
			return {
				n,
				bw: cs.borderTopWidth,
				bs: cs.borderTopStyle,
				h: cs.height,
				fs: cs.fontSize,
				fw: cs.fontWeight,
				r: cs.borderTopLeftRadius,
			};
		});
	});
}

export async function setStripHeight(page: Page, px: number) {
	await page
		.locator(STRIP)
		.evaluate((el, h) => el.style.setProperty("height", `${h}px`, "important"), px);
	await page.waitForTimeout(150);
}

export async function fitState(page: Page, day: string) {
	return page.locator(`${STRIP} [data-strip-day="${day}"] [data-strip-body]`).evaluate((body) => {
		const items = body.querySelectorAll(":scope > [data-fit-item]");
		const more = body.querySelector<HTMLElement>("[data-show-more]");
		const pad = parseFloat(getComputedStyle(body).paddingBottom);
		const bodyBottom = body.getBoundingClientRect().bottom - pad;
		const last = items[items.length - 1]?.getBoundingClientRect();
		return {
			visible: items.length,
			more: more ? Number(more.textContent!.replace(/\D/g, "")) : 0,
			lastBottom: last?.bottom ?? 0,
			moreBottom: more?.getBoundingClientRect().bottom ?? 0,
			bodyBottom,
			hOverflow: body.scrollWidth - body.clientWidth,
		};
	});
}

export async function unzoomToday(page: Page) {
	await headerBtn(page, todayKey()).click();
	await expect(page.locator(`${STRIP} [data-day-agenda]`)).toHaveCount(0);
	await settle(page);
}
