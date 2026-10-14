import { test, expect, Page } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

/**
 * Measurement harness for the dashboard Technicians widget.
 *
 * The thing under test is a px budget — "does one row of technicians fit in the
 * height a minH:3 card leaves?" — so this measures the live box rather than
 * asserting on markup. The roster is injected by intercepting GET /technicians,
 * because the seeded org has a fixed headcount and the interesting cases are
 * 0, 1, and "more than fits".
 */

/** Roster sizes to drive. 1 is the reported bug; 30 is the auto-grow ceiling. */
const ROSTER_SIZES = [0, 1, 4, 9, 30];

/** All eight, so every underline branch is exercised — not just the mapped ones. */
const STATUSES = [
	"Available", "Working", "OnSite", "EnRoute",
	"Paused", "WrappingUp", "Break", "Offline",
] as const;

/** getActiveCols() switches on container width: <500 → 4 cols, <800 → 8, else 12. */
const VIEWPORTS = [
	{ label: "wide", width: 1600, height: 1000 },
	{ label: "narrow", width: 1100, height: 1000 },
];

type Measurement = {
	tiles: number;
	/** Distinct tile top offsets — how many rows the auto-fill grid actually made. */
	rows: number;
	/** px the body wants beyond what it has. >2 is what auto-grow calls overflow. */
	overflow: number;
	scrollable: boolean;
	widgetPx: number;
	bodyClientPx: number;
	tilePx: number | null;
	badgeBg: string | null;
	badgeBorder: string | null;
	badgeCollision: boolean;
};

function makeRoster(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: `tech-${i}`,
		name: `Tech ${String.fromCharCode(65 + (i % 26))}${i} Lastname`,
		email: `tech${i}@example.test`,
		phone: "555-0100",
		title: "Technician",
		description: "",
		coords: { lat: 0, lon: 0 },
		// Cycle every status so the underline map is fully exercised. Offline is
		// filtered out by the widget, which is itself worth observing.
		status: STATUSES[i % STATUSES.length],
		hire_date: "2024-01-01T00:00:00.000Z",
		last_login: null,
		current_vehicle_id: null,
		visit_techs: [],
		role_id: null,
		organization_role: null,
		permissions: [],
		theme: "dark",
	}));
}

async function installRoster(page: Page, n: number) {
	await page.route("**/technicians", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				data: makeRoster(n),
				error: null,
				meta: { timestamp: new Date().toISOString(), count: n },
			}),
		});
	});
}

/** index.html reads theme-preference from localStorage before React boots. */
async function forceTheme(page: Page, theme: "dark" | "light") {
	await page.addInitScript((t) => {
		window.localStorage.setItem("theme-preference", JSON.stringify({ state: { theme: t } }));
	}, theme);
}

function widgetLocator(page: Page) {
	return page
		.locator(".react-grid-item")
		.filter({ has: page.getByRole("heading", { name: "Technicians", exact: true }) });
}

async function measure(page: Page): Promise<Measurement> {
	const widget = widgetLocator(page);
	await widget.waitFor({ state: "visible", timeout: 15000 });

	return widget.evaluate((el) => {
		const card = el.firstElementChild as HTMLElement;
		const body = card.lastElementChild as HTMLElement;
		const tiles = Array.from(body.querySelectorAll<HTMLElement>(":scope > div > div"));
		const firstTile = tiles[0] ?? null;
		const badge = firstTile?.firstElementChild as HTMLElement | undefined;

		const cs = badge ? getComputedStyle(badge) : null;
		const bg = cs?.backgroundColor ?? null;
		const border = cs?.borderBottomColor ?? null;

		return {
			tiles: tiles.length,
			rows: new Set(tiles.map((t) => t.offsetTop)).size,
			overflow: body.scrollHeight - body.clientHeight,
			scrollable: body.scrollHeight > body.clientHeight,
			widgetPx: Math.round(el.getBoundingClientRect().height),
			bodyClientPx: body.clientHeight,
			tilePx: firstTile ? Math.round(firstTile.getBoundingClientRect().height) : null,
			badgeBg: bg,
			badgeBorder: border,
			// The reported defect: underline indistinguishable from the fill.
			badgeCollision: !!bg && !!border && bg === border,
		};
	});
}

/** Width settle timer is 400ms; auto-grow runs on a ResizeObserver after that. */
async function settle(page: Page) {
	await page.waitForTimeout(1500);
}

for (const theme of ["dark", "light"] as const) {
	for (const vp of VIEWPORTS) {
		for (const size of ROSTER_SIZES) {
			test(`${theme} / ${vp.label} / ${size} techs — fits without scrolling`, async ({ page }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height });
				await forceTheme(page, theme);
				await installRoster(page, size);
				await loginAsDispatcher(page);
				await page.goto("/dispatch");
				await settle(page);

				const m = await measure(page);
				test.info().annotations.push({ type: "measurement", description: JSON.stringify(m) });

				// The reported defect: a scrollbar with nothing to scroll to. Up to
				// one row of tiles must fit the default card outright. Beyond that
				// the card scrolls, and should — the dashboard's fit-to-content pass
				// is dormant (DashboardPage), so a widget cannot grow itself.
				// Keyed off the rows the grid actually made, not the roster size: a
				// 4-col widget on a wide viewport fits several tiles side by side.
				if (m.rows <= 1) {
					expect(m.overflow, `overflow px (rows ${m.rows}, widget ${m.widgetPx}px, body ${m.bodyClientPx}px, tile ${m.tilePx}px)`)
						.toBeLessThanOrEqual(2);
				} else {
					// Guard the other direction: if a multi-row case ever stops
					// overflowing, the budget changed and one row needs re-measuring.
					expect(m.overflow, `rows ${m.rows} should not fit in ${m.bodyClientPx}px`).toBeGreaterThan(2);
				}

				// Offline is filtered out, so the rendered count trails the roster.
				const expectedVisible = size - Math.floor(size / STATUSES.length);
				if (size > 0) expect(m.tiles).toBe(expectedVisible);

				if (m.badgeBg && m.badgeBorder) {
					expect(m.badgeCollision, `badge fill ${m.badgeBg} vs underline ${m.badgeBorder}`).toBe(false);
				}
			});
		}
	}
}

test("a large roster never pushes the widget past its configured height", async ({ page }) => {
	await page.setViewportSize({ width: 1600, height: 1000 });
	await installRoster(page, 30);
	await loginAsDispatcher(page);
	await page.goto("/dispatch");
	await settle(page);

	const m = await measure(page);
	test.info().annotations.push({ type: "measurement", description: JSON.stringify(m) });

	// autoGrowMaxH is 6 → 45*6 + 16*5 = 350px. Anything taller means a roster has
	// shoved the widgets below it off the fold. This also fails loudly if the
	// dormant fit-to-content pass is ever switched back on without its clamp.
	expect(m.widgetPx).toBeLessThanOrEqual(352);
});
