import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TierContentsForm from "../components/TierContentsForm";

const catalog = [
	{ key: "quickbooks", label: "QuickBooks", kind: "plan_gated" as const },
	{ key: "ai_assistant", label: "AI assistant", kind: "plan_gated" as const },
];
const initial = {
	modules: ["quickbooks"],
	limits: {
		dispatchers: 10,
		technicians: null,
		ai_calls_month: 500,
		tax_lookups_month: 0,
		receipt_scans_month: 300,
	},
};
const renderForm = (onSubmit = vi.fn()) =>
	render(
		<TierContentsForm
			open
			mode="version"
			title="New version of Pro"
			catalog={catalog}
			initial={initial}
			pending={false}
			error={null}
			onSubmit={onSubmit}
			onClose={vi.fn()}
		/>
	);

describe("TierContentsForm", () => {
	it("starts from the latest version and blocks saving until something changes", () => {
		renderForm();
		expect(screen.getByRole("checkbox", { name: "QuickBooks" })).toBeChecked();
		expect(screen.getByLabelText("Technicians")).toHaveValue("");
		fireEvent.change(screen.getByLabelText(/Note/), {
			target: { value: "Raise seats" },
		});
		expect(screen.getByRole("button", { name: "Save new version" })).toBeDisabled();
	});

	it("submits the changed contents with the note", () => {
		const onSubmit = vi.fn();
		renderForm(onSubmit);
		fireEvent.click(screen.getByRole("checkbox", { name: "AI assistant" }));
		fireEvent.change(screen.getByLabelText("Technicians"), { target: { value: "25" } });
		fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "Add AI" } });
		fireEvent.click(screen.getByRole("button", { name: "Save new version" }));
		expect(onSubmit).toHaveBeenCalledWith({
			modules: ["ai_assistant", "quickbooks"],
			limits: {
				dispatchers: 10,
				technicians: 25,
				ai_calls_month: 500,
				tax_lookups_month: 0,
				receipt_scans_month: 300,
			},
			note: "Add AI",
		});
	});
});

describe("TierContentsForm re-render", () => {
	it("keeps edits when the parent re-renders with an equal initial (e.g. Save pending)", () => {
		const props = {
			open: true,
			mode: "version" as const,
			title: "New version of Pro",
			catalog,
			error: null,
			onSubmit: vi.fn(),
			onClose: vi.fn(),
		};
		const { rerender } = render(
			<TierContentsForm {...props} initial={initial} pending={false} />
		);
		fireEvent.change(screen.getByLabelText("Technicians"), { target: { value: "25" } });
		fireEvent.change(screen.getByLabelText(/Note/), {
			target: { value: "Raise seats" },
		});
		rerender(<TierContentsForm {...props} initial={{ ...initial }} pending />);
		expect(screen.getByLabelText("Technicians")).toHaveValue("25");
		expect(screen.getByLabelText(/Note/)).toHaveValue("Raise seats");
	});
});
