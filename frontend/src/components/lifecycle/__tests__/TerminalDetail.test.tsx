import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TerminalDetail from "../TerminalDetail";

describe("TerminalDetail", () => {
	it("renders the recorded reason", () => {
		render(
			<TerminalDetail
				reason="Client went with another contractor."
				noReasonLabel="No reason recorded."
			/>
		);

		expect(screen.getByText("Client went with another contractor.")).toBeTruthy();
	});

	// The strip must not collapse to an empty row when nothing was recorded.
	it("falls back to the page's copy when there is no reason", () => {
		render(
			<TerminalDetail reason={null} noReasonLabel="Superseded by a newer version." />
		);

		expect(screen.getByText("Superseded by a newer version.")).toBeTruthy();
	});

	it("shows the date only when the document stores one", () => {
		const { unmount } = render(
			<TerminalDetail
				reason="Withdrawn."
				at="2026-09-06T12:00:00Z"
				noReasonLabel="none"
			/>
		);
		expect(screen.getByText(/Recorded/)).toBeTruthy();
		unmount();

		render(<TerminalDetail reason="Withdrawn." noReasonLabel="none" />);
		expect(screen.queryByText(/Recorded/)).toBeNull();
	});
});
