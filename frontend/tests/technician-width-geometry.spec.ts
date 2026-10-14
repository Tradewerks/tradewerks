import { test, expect } from "@playwright/test";
import { loginAsTechnician } from "./fixtures/auth";

// Pixel diffing these pages is useless — relative timestamps, live inventory and
// map tiles churn between runs. Geometry does not, so assert on the box of the
// element the technician layout renders each route into.
//
// Guards the desktop-width pass: technician content is centered at every width
// and capped, rather than stretching to fill a laptop screen.
const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900 },
	{ name: "1024", width: 1024, height: 768 },
	{ name: "768", width: 768, height: 1024 },
	{ name: "390", width: 390, height: 844 },
];

// max-w-lg, and the dashboard's max-w-4xl once it reaches its lg two-column layout.
const NARROW = 512;
const WIDE = 896;

const ROUTES = [
	{ path: "/technician", tier: "wide" as const },
	{ path: "/technician/visits", tier: "narrow" as const },
	{ path: "/technician/notifications", tier: "narrow" as const },
	{ path: "/technician/vehicles", tier: "narrow" as const },
	{ path: "/technician/mileage", tier: "narrow" as const },
	{ path: "/technician/purchases", tier: "narrow" as const },
];

for (const vp of VIEWPORTS) {
	test.describe(`technician width @ ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test(`content is centered and capped at ${vp.name}`, async ({ page }) => {
			await loginAsTechnician(page);

			for (const route of ROUTES) {
				await page.goto(route.path);
				await page.waitForLoadState("networkidle");
				await page.waitForTimeout(400);

				const box = await page.evaluate(() => {
					const el = document.querySelector("main > div > *") as HTMLElement | null;
					if (!el) return null;
					const r = el.getBoundingClientRect();
					return {
						width: Math.round(r.width),
						left: Math.round(r.left),
						right: Math.round(window.innerWidth - r.right),
					};
				});

				expect(box, `${route.path} renders a content box`).not.toBeNull();
				// Sub-pixel rounding is the only gap allowed between the two gutters.
				expect(Math.abs(box!.left - box!.right), `${route.path} @ ${vp.name} is centered`).toBeLessThanOrEqual(1);

				const cap = route.tier === "wide" && vp.width >= 1024 ? WIDE : NARROW;
				expect(box!.width, `${route.path} @ ${vp.name} is capped`).toBeLessThanOrEqual(cap);
			}
		});
	});
}
