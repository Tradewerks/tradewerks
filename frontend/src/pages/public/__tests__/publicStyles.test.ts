import { describe, it, expect } from "vitest";
import {
	brandButtonStyle,
	contrastRatio,
	formatPublicDay,
	formatPublicInstant,
} from "../publicStyles";

const org = (color: string) => ({ name: "Acme", logo_url: null, color, phone: null, email: null });
const DARK = "#18181b";
const WHITE = "#ffffff";

describe("brandButtonStyle", () => {
	it.each(["#3b82f6", "#f97316", "#0f766e", "#fde68a", "#ffffff", "#808080"])(
		"brand %s gets whichever of white or dark text has the higher contrast",
		(color) => {
			const style = brandButtonStyle(org(color));
			const white = contrastRatio(color, WHITE);
			const dark = contrastRatio(color, DARK);
			expect(style.backgroundColor).toBe(color);
			expect(style.color).toBe(white >= dark ? WHITE : DARK);
			// #808080 is the case where neither reaches 4.5:1; the better one still wins.
			if (Math.max(white, dark) >= 4.5)
				expect(
					contrastRatio(color, style.color as string)
				).toBeGreaterThanOrEqual(4.5);
		}
	);

	it("mid-tone blue and orange get dark text, which clears 4.5:1 where white does not", () => {
		for (const color of ["#3b82f6", "#f97316"]) {
			expect(contrastRatio(color, WHITE)).toBeLessThan(4.5);
			expect(brandButtonStyle(org(color)).color).toBe(DARK);
		}
	});

	it("a deep brand colour keeps white text, and a non-hex colour falls back to blue", () => {
		expect(brandButtonStyle(org("#1e3a8a")).color).toBe(WHITE);
		expect(brandButtonStyle(org("red; x")).backgroundColor).toBe("#3b82f6");
	});
});

// Tests run in America/Chicago (vite.config.ts).
describe("public date formatting", () => {
	it("a date-only field stored as UTC midnight shows its own calendar day", () => {
		expect(formatPublicDay("2026-12-01T00:00:00.000Z")).toBe("Dec 1, 2026");
	});

	it("an instant shows the local day it falls on", () => {
		// Nov 20 Chicago midnight, and 02:00 UTC Nov 21 = 8pm Nov 20 in Chicago.
		expect(formatPublicInstant("2026-11-20T06:00:00.000Z")).toBe("Nov 20, 2026");
		expect(formatPublicInstant("2026-11-21T02:00:00.000Z")).toBe("Nov 20, 2026");
	});
});
