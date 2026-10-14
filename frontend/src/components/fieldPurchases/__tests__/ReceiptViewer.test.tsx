import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReceiptViewer from "../ReceiptViewer";

const sheet = () => within(screen.getByRole("dialog", { name: /receipt from dana ruiz/i }));

describe("ReceiptViewer", () => {
	it("says so when there is no photo", () => {
		render(<ReceiptViewer url={null} technicianName="Dana Ruiz" />);
		expect(screen.getByText(/no receipt image on this one/i)).toBeInTheDocument();
	});

	it("still steps zoom in its own toolbar", async () => {
		render(<ReceiptViewer url="https://bucket/r.jpg" technicianName="Dana Ruiz" />);
		expect(screen.getByText("100%")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /zoom out/i })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: /zoom in/i }));
		expect(screen.getByText("150%")).toBeInTheDocument();
	});

	// Asserted on the sheet's OWN controls, which the overlay this replaced did not
	// have — a dialog with a matching label existed before and proves nothing.
	it("opens the shared lightbox full screen", async () => {
		render(<ReceiptViewer url="https://bucket/r.jpg" technicianName="Dana Ruiz" />);
		expect(screen.queryByRole("dialog")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /view full screen/i }));
		expect(sheet().getByRole("button", { name: /rotate/i })).toBeInTheDocument();
		expect(sheet().getByRole("button", { name: /zoom in/i })).toBeInTheDocument();
	});

	// Both images read one rotation, which is why the lightbox does not own it.
	it("carries the card's rotation into the sheet", async () => {
		render(<ReceiptViewer url="https://bucket/r.jpg" technicianName="Dana Ruiz" />);
		await userEvent.click(screen.getByRole("button", { name: /rotate/i }));
		await userEvent.click(screen.getByRole("button", { name: /view full screen/i }));
		const inSheet = sheet().getByRole("img", { name: /receipt from dana ruiz/i });
		expect(inSheet.style.transform).toContain("rotate(90deg)");
		// Turned on its side the long edge is horizontal, so height is what "fit" means.
		expect(inSheet.style.height).toBe("100%");
		expect(inSheet.style.width).toBe("auto");
	});

	// An Escape reaching the panel behind it would close the sheet and act on the
	// panel in the same keystroke.
	it("does not let Escape reach the panel behind it", async () => {
		const behind = vi.fn();
		render(
			<div onKeyDown={behind}>
				<ReceiptViewer
					url="https://bucket/r.jpg"
					technicianName="Dana Ruiz"
				/>
			</div>
		);
		await userEvent.click(screen.getByRole("button", { name: /view full screen/i }));
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(behind).not.toHaveBeenCalled();
	});

	// A caller keeps its own shortcut standdown in this, not in `full` — which is
	// private to this component — so every transition has to actually reach it.
	it("tells the caller when the sheet opens and closes from its own buttons", async () => {
		const onFullscreenChange = vi.fn();
		render(
			<ReceiptViewer
				url="https://bucket/r.jpg"
				technicianName="Dana Ruiz"
				onFullscreenChange={onFullscreenChange}
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: /view full screen/i }));
		expect(onFullscreenChange).toHaveBeenLastCalledWith(true);
		await userEvent.click(sheet().getByRole("button", { name: /^close$/i }));
		expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
	});

	// A new receipt replacing the open one is exactly the scenario a stale "still
	// full screen" flag would misreport as covering a purchase it no longer does.
	it("reports closed when a new receipt replaces the one on screen", async () => {
		const onFullscreenChange = vi.fn();
		const { rerender } = render(
			<ReceiptViewer
				url="https://bucket/r.jpg"
				technicianName="Dana Ruiz"
				onFullscreenChange={onFullscreenChange}
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: /view full screen/i }));
		onFullscreenChange.mockClear();

		rerender(
			<ReceiptViewer
				url="https://bucket/other.jpg"
				technicianName="Dana Ruiz"
				onFullscreenChange={onFullscreenChange}
			/>
		);
		expect(onFullscreenChange).toHaveBeenCalledWith(false);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// If the caller swaps this component out entirely (no photo on the newly
	// selected record, say) while the sheet is open, nothing else will ever call
	// the callback again — the caller's flag would stick "open" forever.
	it("reports closed on unmount if the sheet was open", async () => {
		const onFullscreenChange = vi.fn();
		const { unmount } = render(
			<ReceiptViewer
				url="https://bucket/r.jpg"
				technicianName="Dana Ruiz"
				onFullscreenChange={onFullscreenChange}
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: /view full screen/i }));
		onFullscreenChange.mockClear();

		unmount();
		expect(onFullscreenChange).toHaveBeenCalledWith(false);
	});
});
