import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ mutate: vi.fn(), reset: vi.fn() }));
vi.mock("../../../../hooks/useUpgradeRequests", () => ({
	useRequestableTiers: () => ({
		data: [
			{
				key: "pro",
				label: "Pro",
				modules: [{ key: "ai_assistant", label: "AI assistant" }],
			},
		],
		isLoading: false,
	}),
	useFileUpgradeRequest: () => ({
		mutate: h.mutate,
		isPending: false,
		error: null,
		reset: h.reset,
	}),
}));

import RequestChangeDialog from "../RequestChangeDialog";

const locked = [{ key: "quickbooks", label: "QuickBooks" }];

describe("RequestChangeDialog", () => {
	it("lists requestable subscriptions and locked features", () => {
		render(<RequestChangeDialog open onClose={vi.fn()} lockedModules={locked} />);
		expect(screen.getByRole("radio", { name: /Pro/ })).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Keep current" })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: "QuickBooks" })).toBeInTheDocument();
	});

	it("requires a note when nothing is picked", () => {
		render(<RequestChangeDialog open onClose={vi.fn()} lockedModules={locked} />);
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));
		expect(screen.getByText(/Tell us what you need/)).toBeInTheDocument();
		expect(h.mutate).not.toHaveBeenCalled();
	});

	it("sends the picked subscription, features and note", () => {
		render(
			<RequestChangeDialog
				open
				onClose={vi.fn()}
				lockedModules={locked}
				initialModules={["quickbooks"]}
			/>
		);
		fireEvent.click(screen.getByRole("radio", { name: /Pro/ }));
		fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "Growing" } });
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));
		expect(h.mutate).toHaveBeenCalledWith(
			{ planKey: "pro", modules: ["quickbooks"], note: "Growing" },
			expect.anything()
		);
	});

	it("prefills a seat note", () => {
		render(
			<RequestChangeDialog
				open
				onClose={vi.fn()}
				lockedModules={locked}
				initialNote="We need more technician seats."
			/>
		);
		expect(screen.getByLabelText(/Note/)).toHaveValue("We need more technician seats.");
	});
});
