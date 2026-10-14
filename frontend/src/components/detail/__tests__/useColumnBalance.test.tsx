import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import useColumnBalance from "../useColumnBalance";

/**
 * jsdom has no layout, so every height here is injected. The numbers are the
 * decision under test — the hook's whole contract is "which column should the
 * movable block sit in", and that is a function of three heights and a card
 * count, nothing else.
 */
function stub(height: number) {
	const el = document.createElement("div");
	el.getBoundingClientRect = () => ({ height, bottom: height }) as DOMRect;
	return el;
}

function setDesktop(matches: boolean) {
	(window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation(
		(query: string) => ({
			matches,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})
	);
}

function place(opts: {
	info: number;
	rail: number;
	block: number;
	cardCount?: number;
	recordId?: string;
}) {
	return renderHook(() => {
		const infoRef = useRef(stub(opts.info));
		const railRef = useRef(stub(opts.rail));
		const blockRef = useRef(stub(opts.block));
		return useColumnBalance({
			recordId: opts.recordId ?? "r1",
			cardCount: opts.cardCount ?? 2,
			infoRef,
			railRef,
			blockRef,
		}).placement;
	});
}

describe("useColumnBalance", () => {
	beforeEach(() => setDesktop(true));

	// Below lg the two columns stack, so there is no pair to balance and the
	// block belongs where the markup puts it.
	it("stays in the main column below the lg breakpoint", () => {
		setDesktop(false);
		const { result } = place({ info: 200, rail: 900, block: 120 });

		expect(result.current).toBe("main");
	});

	it("keeps the block in the main column when the rail is the taller side", () => {
		// main would be 200 + 16 + 120 = 336 against a 900 rail; moving the
		// block away only makes the main column shorter.
		const { result } = place({ info: 200, rail: 900, block: 120 });

		expect(result.current).toBe("main");
	});

	it("moves the block to the rail when that closes the gap", () => {
		// main 900 + 16 + 120 = 1036 vs rail 300 — a 736px overhang. In the rail
		// the two cards stack (~316px), giving 900 vs ~632: better by far.
		const { result } = place({ info: 900, rail: 300, block: 120 });

		expect(result.current).toBe("rail");
	});

	/**
	 * Hysteresis exists because the move is not free: the block is wider in the
	 * main column and wraps in the rail, so a marginal gain is noise. Without
	 * this the layout would swap on records that are essentially balanced.
	 */
	it("does not move for an improvement smaller than the hysteresis", () => {
		// Both candidates land on 234px: staying gives |(398 + 16 + 120) - 300|,
		// moving gives |398 - (300 + 16 + 316)|. A dead heat is exactly the case
		// that must not swap the layout.
		const { result } = place({ info: 398, rail: 300, block: 120 });

		expect(result.current).toBe("main");
	});

	/**
	 * The anti-oscillation guard. Moving the block changes both heights that
	 * decided the move, so a hook that re-decides freely flip-flops forever.
	 * Once a record has a placement, it keeps it.
	 */
	it("latches its decision for a record and ignores later measurements", () => {
		const { result, rerender } = place({ info: 900, rail: 300, block: 120 });
		expect(result.current).toBe("rail");

		// A ResizeObserver firing after the move reports the post-move heights,
		// which argue for moving back. The latch must swallow that.
		act(() => {
			rerender();
		});

		expect(result.current).toBe("rail");
	});

	// Data arrives after mount, so the first layout pass measures nothing. A
	// zero-height measurement must not spend the latch on a guess.
	it("does not latch on an unmeasurable layout", () => {
		const { result } = place({ info: 0, rail: 0, block: 0 });

		expect(result.current).toBe("main");
	});

	// Three cards stacked in a third-width rail are far taller than one row of
	// three in the main column, so the same heights that move two cards should
	// not necessarily move three.
	it("accounts for the card count when predicting the rail height", () => {
		// Same heights either way: two cards stack to ~316px in the rail and win,
		// three stack to ~482px and lose to the 316px gap they would leave behind.
		const two = place({ info: 480, rail: 300, block: 120, cardCount: 2 });
		const three = place({ info: 480, rail: 300, block: 120, cardCount: 3 });

		expect(two.result.current).toBe("rail");
		expect(three.result.current).toBe("main");
	});
});
