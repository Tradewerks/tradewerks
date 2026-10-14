import { test, expect, Page } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

/**
 * Not an assertion suite — a screenshot harness with a measurement attached.
 * The rule it verifies ("do the two columns finish level?") is ultimately a
 * judgement about whether a gap reads as a gutter or a hole, so this produces
 * the images and the numbers and leaves the call to a human.
 *
 * Records are discovered from the list pages rather than hard-coded, so it
 * keeps working against a reseeded database.
 */

const TOLERANCE_PX = 80;
const PER_PAGE = 2;
/** Backend origin (VITE_BACKEND_URL), which is not the page origin. */
const BACKEND_PORT = "3000";
/** Most seeded jobs have no visits, so the pool to hunt through is wider. */
const JOB_POOL = 8;

type Target = { page: string; path: string };

/** Column bottoms, measured off the live Overview grid. */
type Balance = {
	main: number;
	rail: number;
	delta: number;
	clientCardComplete: boolean;
	/** Which column the relation block ended up in. */
	placement: "main" | "rail";
};

/**
 * AdaptableTable rows navigate from an onClick handler, not an href
 * (`AdaptableTable.tsx:240`), so there is no link to scrape — the paths have to
 * be collected by clicking a row and reading where it landed.
 */
async function collectPaths(
	page: Page,
	listPath: string,
	pattern: RegExp,
	limit: number,
	rowSelector = "tbody tr"
) {
	const found: string[] = [];

	for (let i = 0; i < limit; i++) {
		await page.goto(listPath);
		await expect(page.locator("main")).toBeVisible({ timeout: 15000 });

		const rows = page.locator(rowSelector);
		await rows.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
		if ((await rows.count()) <= i) break;

		await rows.nth(i).click();
		await page.waitForURL(pattern, { timeout: 10000 }).catch(() => undefined);

		const path = new URL(page.url()).pathname;
		if (pattern.test(path) && !found.includes(path)) found.push(path);
	}

	return found;
}

/**
 * The seed gives every client an address and a primary contact, so the short
 * end of the rail's height range is unreachable from real data. Blanking those
 * two fields in the API response on the way past renders the real component
 * against a bare record without touching the database.
 *
 * Matched by origin, not by a path glob: the backend is a separate host
 * (`VITE_BACKEND_URL`) whose routes are not under /api, so an api-path glob
 * matches Vite's own source-module requests and no backend call at all.
 */
const isBackend = (url: URL) => url.port === BACKEND_PORT;

/**
 * A long description is the state this whole rule exists for, and the seed has
 * none — so it is injected on the way past, same trick as withBareClient.
 */
const TALL_DESCRIPTION = Array.from(
	{ length: 14 },
	(_, i) =>
		`Line ${i + 1}: rooftop unit inspected, compressor amperage logged, filters swapped and the economiser linkage re-seated after the tech found it binding.`
).join(" ");

async function withTallInfo(page: Page, run: () => Promise<void>) {
	await page.route(isBackend, async (route) => {
		const response = await route.fetch();
		const type = response.headers()["content-type"] ?? "";
		if (!type.includes("application/json")) return route.fulfill({ response });

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return route.fulfill({ response });
		}

		const data = (body as { data?: Record<string, unknown> })?.data;
		if (data && "description" in data) data.description = TALL_DESCRIPTION;
		return route.fulfill({ response, body: JSON.stringify(body) });
	});

	try {
		await run();
	} finally {
		await page.unroute(isBackend);
	}
}

async function withBareClient(page: Page, run: () => Promise<void>) {
	await page.route(isBackend, async (route) => {
		const response = await route.fetch();
		const type = response.headers()["content-type"] ?? "";
		if (!type.includes("application/json")) {
			return route.fulfill({ response });
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return route.fulfill({ response });
		}

		const client = (body as { data?: { client?: Record<string, unknown> } })?.data?.client;
		if (client) {
			client.address = null;
			client.contacts = [];
			console.log(`[column-balance] stripped client on ${new URL(route.request().url()).pathname}`);
		}
		return route.fulfill({ response, body: JSON.stringify(body) });
	});

	try {
		await run();
	} finally {
		await page.unroute(isBackend);
	}
}

/**
 * The Overview terminal block is the grid whose main cell carries
 * `lg:col-span-2`. Tailwind keeps that literal string in the class attribute,
 * which makes it the only stable handle the layout exposes.
 */
async function measure(page: Page): Promise<Balance | null> {
	return page.evaluate(() => {
		const main = document.querySelector('[class*="lg:col-span-2"]');
		if (!main) return null;
		const grid = main.parentElement;
		const rail = grid?.querySelector('[class*="lg:col-span-1"]');
		if (!rail) return null;

		// The CELLS are useless as a measurement: a grid item with the default
		// `stretch` alignment always spans the row, so cell bottoms are equal by
		// definition the moment `self-start` comes off. What a dispatcher sees is
		// the last painted CARD in each column, so measure that.
		const lastCardBottom = (cell: Element) => {
			const cards = cell.querySelectorAll(":scope > *, :scope > * > *");
			let bottom = 0;
			cards.forEach((c) => {
				const box = c.getBoundingClientRect();
				// Ignore zero-height wrappers; a painted card has a border box.
				if (box.height > 8) bottom = Math.max(bottom, box.bottom);
			});
			return bottom || cell.getBoundingClientRect().bottom;
		};

		const mainBottom = lastCardBottom(main);
		const railBottom = lastCardBottom(rail);
		const text = rail.textContent ?? "";
		// The relation cards are the only thing in either column carrying a
		// "RELATED …" / "LINKED JOB" eyebrow, so their column is observable.
		const placement = /related |linked job/i.test(text) ? "rail" : "main";
		return {
			main: Math.round(mainBottom),
			rail: Math.round(railBottom),
			delta: Math.round(Math.abs(mainBottom - railBottom)),
			// Both empty states present means the client record is bare — the
			// tall end and short end of the rail's old height swing.
			clientCardComplete:
				!text.includes("No address on file") && !text.includes("No primary contact"),
			placement: placement as "main" | "rail",
		};
	});
}

async function captureOverview(page: Page, target: Target, index: number, labelOverride?: string) {
	await page.goto(target.path);
	await expect(page.locator("main")).toBeVisible({ timeout: 15000 });
	// The tab strip renders before its panel's data; the stat row is the last
	// thing to settle, so give the grid a beat to reach final height.
	await page.waitForTimeout(1200);

	const balance = await measure(page);
	const label = labelOverride ?? (balance?.clientCardComplete === false ? "bare" : "full");
	const name = `${target.page}-${index + 1}-${label}`;

	await page.screenshot({
		path: `test-results/column-balance/${name}.png`,
		fullPage: true,
	});

	console.log(
		balance
			? `[column-balance] ${name} ${target.path} main=${balance.main} rail=${balance.rail} delta=${balance.delta}px block=${balance.placement} ${
					balance.delta <= TOLERANCE_PX ? "OK" : "OVER"
				}`
			: `[column-balance] ${name} ${target.path} — no two-column Overview grid found`
	);
	return balance;
}

test.describe("detail page column balance", () => {
	test.describe.configure({ mode: "serial", timeout: 900_000 });

	test("captures every in-scope detail page", async ({ page }) => {
		await loginAsDispatcher(page);
		await page.setViewportSize({ width: 1440, height: 1200 });

		const targets: Target[] = [];

		for (const [name, list, pattern] of [
			["request", "/dispatch/requests", /^\/dispatch\/requests\/[^/]+$/],
			["quote", "/dispatch/quotes", /^\/dispatch\/quotes\/[^/]+$/],
			["job", "/dispatch/jobs", /^\/dispatch\/jobs\/[^/]+$/],
			[
				"recurring-plan",
				"/dispatch/jobs?view=templates",
				/^\/dispatch\/recurring-plans\/[^/]+$/,
			],
			// Excluded from the layout rule, but it renders ClientDetailsCard,
			// so it is the collateral-damage check (plan Task 7 Step 4).
			["invoice", "/dispatch/invoices", /^\/dispatch\/invoices\/[^/]+$/],
		] as const) {
			const paths = await collectPaths(page, list, pattern, PER_PAGE);
			for (const path of paths) targets.push({ page: name, path });
		}

		// Visits are reachable only from a job's Visits tab, those cards are
		// buttons (JobDetailPage.tsx:830), and most seeded jobs have none — so
		// walk a wider pool than the two jobs being screenshotted.
		const jobPool = await collectPaths(
			page,
			"/dispatch/jobs",
			/^\/dispatch\/jobs\/[^/]+$/,
			JOB_POOL
		);
		for (const jobPath of jobPool) {
			const visits = await collectPaths(
				page,
				`${jobPath}?tab=visits`,
				/^\/dispatch\/jobs\/[^/]+\/visits\/[^/]+$/,
				2,
				// Visit cards are links, not table rows.
				"#tabpanel-visits a[href*=\"/visits/\"]"
			);
			for (const path of visits) targets.push({ page: "job-visit", path });
			if (targets.some((t) => t.page === "job-visit")) break;
		}

		console.log(`[column-balance] ${targets.length} records discovered`);
		expect(targets.length).toBeGreaterThan(0);

		const over: string[] = [];
		const seen = new Map<string, number>();

		for (const target of targets) {
			const index = seen.get(target.page) ?? 0;
			seen.set(target.page, index + 1);
			const balance = await captureOverview(page, target, index);
			if (balance && balance.delta > TOLERANCE_PX && target.page !== "invoice") {
				over.push(`${target.page} ${target.path} delta=${balance.delta}px`);
			}
		}

		// Second pass: the same records with a bare client, which is the short
		// end of the rail's height range and the case the old fork existed for.
		await withBareClient(page, async () => {
			const bareSeen = new Map<string, number>();
			for (const target of targets) {
				const index = bareSeen.get(target.page) ?? 0;
				bareSeen.set(target.page, index + 1);
				if (index > 0) continue; // one bare capture per page type is enough
				const balance = await captureOverview(page, target, index);
				if (balance && balance.delta > TOLERANCE_PX && target.page !== "invoice") {
					over.push(`${target.page} (bare client) ${target.path} delta=${balance.delta}px`);
				}
			}
		});

		// Third pass: a very long info card, which is the case the placement rule
		// exists for. The block is expected to move into the rail here.
		await withTallInfo(page, async () => {
			const tallSeen = new Map<string, number>();
			for (const target of targets) {
				if (target.page === "invoice" || target.page === "job-visit") continue;
				const index = tallSeen.get(target.page) ?? 0;
				tallSeen.set(target.page, index + 1);
				if (index > 0) continue;

				const balance = await captureOverview(page, target, index, "tall");

				// Oscillation guard: the placement must be stable once decided.
				await page.waitForTimeout(900);
				const again = await measure(page);
				if (again && balance && again.placement !== balance.placement) {
					over.push(
						`${target.page} (tall) ${target.path} FLIPPED ${balance.placement} -> ${again.placement}`
					);
				}
				if (balance && balance.delta > TOLERANCE_PX) {
					over.push(`${target.page} (tall) ${target.path} delta=${balance.delta}px`);
				}
			}
		});

		// Reported, not thrown: a real record can legitimately overrun (four or
		// more technicians on a visit is the declared extreme case), and the
		// screenshots are what settle it.
		if (over.length > 0) {
			console.log(`[column-balance] over ${TOLERANCE_PX}px:\n  ${over.join("\n  ")}`);
		}
	});
});
