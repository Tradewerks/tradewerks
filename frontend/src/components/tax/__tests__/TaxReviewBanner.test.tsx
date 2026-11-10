import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, type AxiosResponse } from "axios";

const axiosError = (message: string) =>
	new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
		status: 422,
		data: { error: { message } },
	} as AxiosResponse);

const mutateAsync = vi.fn();
vi.mock("../../../hooks/useTaxSettings", () => ({
	useAcknowledgeTaxReview: () => ({ mutateAsync, isPending: false }),
}));

import TaxReviewBanner from "../TaxReviewBanner";

const props = {
	kind: "quote" as const,
	id: "q1",
	needsReview: true,
	reason: "Lookup returned a stale rate.",
	ackAt: null,
	canAcknowledge: true,
};

describe("TaxReviewBanner", () => {
	beforeEach(() => {
		mutateAsync.mockReset();
	});

	it("renders nothing when no review is needed", () => {
		const { container } = render(<TaxReviewBanner {...props} needsReview={false} />);
		expect(container.firstChild).toBeNull();
	});

	it("shows the reason and an Acknowledge button", () => {
		render(<TaxReviewBanner {...props} />);
		expect(screen.getByText("Check the tax on this quote")).toBeInTheDocument();
		expect(screen.getByText("Lookup returned a stale rate.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Acknowledge/ })).toBeInTheDocument();
	});

	it("renders a joined review reason verbatim", () => {
		const reason = "Not registered to collect in WI; Lookup returned a stale rate.";
		render(<TaxReviewBanner {...props} reason={reason} />);
		expect(screen.getByText(reason)).toBeInTheDocument();
	});

	it("falls back to the generic body", () => {
		render(<TaxReviewBanner {...props} reason={null} />);
		expect(
			screen.getByText("The tax rate could not be confirmed automatically.")
		).toBeInTheDocument();
	});

	it("hides the button without permission but keeps the reason", () => {
		render(<TaxReviewBanner {...props} canAcknowledge={false} />);
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.getByText("Lookup returned a stale rate.")).toBeInTheDocument();
		expect(screen.getByText(/needs to confirm the tax/)).toBeInTheDocument();
	});

	it("names the next step for someone who can acknowledge", () => {
		render(<TaxReviewBanner {...props} />);
		expect(
			screen.getByText("Confirm the tax is right for this address, then acknowledge.")
		).toBeInTheDocument();
	});

	it("shows a muted line once acknowledged", () => {
		render(<TaxReviewBanner {...props} ackAt="2026-10-14T15:30:00Z" />);
		expect(screen.getByText(/Tax review acknowledged ·/)).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("acknowledges with kind and id", () => {
		mutateAsync.mockResolvedValue({});
		render(<TaxReviewBanner {...props} />);
		fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
		expect(mutateAsync).toHaveBeenCalledWith({ kind: "quote", id: "q1" });
	});

	it("shows an inline error when acknowledging fails", async () => {
		mutateAsync.mockImplementation(() => Promise.reject(axiosError("Nope")));
		render(<TaxReviewBanner {...props} />);
		fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
		expect(await screen.findByText("Nope")).toBeInTheDocument();
	});
});
