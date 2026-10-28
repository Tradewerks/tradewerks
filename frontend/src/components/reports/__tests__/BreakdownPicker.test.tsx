import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BreakdownPicker from "../BreakdownPicker";

function Harness({ onChange = vi.fn() }: { onChange?: (v: string) => void }) {
	const [value, setValue] = useState("status");
	return (
		<>
			<BreakdownPicker
				value={value}
				options={["status", "priority", "type"]}
				onChange={(v) => {
					setValue(v);
					onChange(v);
				}}
			/>
			<p>outside</p>
		</>
	);
}

const trigger = () => screen.getByRole("button", { name: /^Break down by/ });

describe("BreakdownPicker", () => {
	it("names the current grouping on a menu trigger", () => {
		render(<Harness />);
		expect(trigger()).toHaveTextContent("By Status");
		expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
	});

	it("lists every grouping with the current one selected", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
		const options = screen.getAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual(["Status", "Priority", "Type"]);
		expect(screen.getByRole("option", { name: "Status" })).toHaveAttribute("aria-selected", "true");
	});

	it("picks a grouping and closes", async () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("option", { name: "Priority" }));
		expect(onChange).toHaveBeenCalledWith("priority");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(trigger()).toHaveTextContent("By Priority");
	});

	it("closes on Escape and on an outside mousedown", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).toBeNull();
		await userEvent.click(trigger());
		fireEvent.mouseDown(screen.getByText("outside"));
		expect(screen.queryByRole("listbox")).toBeNull();
	});
});
