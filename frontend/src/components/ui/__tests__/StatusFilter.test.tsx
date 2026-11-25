import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import StatusFilter, { DropdownFilter } from "../StatusFilter";

const options = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
	{ value: "c", label: "Gamma" },
];

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /Status|Sort/ }));

describe("DropdownFilter trigger label (U6)", () => {
	it("shows the bare placeholder with nothing selected", () => {
		render(<DropdownFilter values={null} onChange={vi.fn()} options={options} placeholder="Status" />);
		expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument();
	});

	it("shows 'Placeholder: Label' for a single selection", () => {
		render(<DropdownFilter values={["b"]} onChange={vi.fn()} options={options} placeholder="Status" />);
		expect(screen.getByRole("button", { name: "Status: Beta" })).toBeInTheDocument();
	});

	it("shows 'Placeholder (n)' for a multi selection", () => {
		render(
			<DropdownFilter values={["a", "c"]} onChange={vi.fn()} options={options} placeholder="Status" />,
		);
		expect(screen.getByRole("button", { name: "Status (2)" })).toBeInTheDocument();
	});

	it("shows the selected value even with hideAll (sort-style callers)", () => {
		render(
			<DropdownFilter values={["a"]} onChange={vi.fn()} options={options} placeholder="Sort" hideAll />,
		);
		expect(screen.getByRole("button", { name: "Sort: Alpha" })).toBeInTheDocument();
	});
});

describe("DropdownFilter close-on-select (U6)", () => {
	it("exclusive: closes the listbox after picking an option and after picking All", () => {
		const onChange = vi.fn();
		render(
			<DropdownFilter
				values={null}
				onChange={onChange}
				options={options}
				placeholder="Sort"
				allLabel="Default"
				exclusive
			/>,
		);
		openMenu();
		expect(screen.getByRole("listbox")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("option", { name: "Beta" }));
		expect(onChange).toHaveBeenCalledWith("b");
		expect(screen.queryByRole("listbox")).toBeNull();

		openMenu();
		fireEvent.click(screen.getByRole("option", { name: "Default" }));
		expect(onChange).toHaveBeenLastCalledWith(null);
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("multi-select: stays open after picking an option so more can be added", () => {
		const onChange = vi.fn();
		render(<DropdownFilter values={["a"]} onChange={onChange} options={options} placeholder="Status" />);
		openMenu();
		fireEvent.click(screen.getByRole("option", { name: "Beta" }));
		expect(onChange).toHaveBeenCalledWith("b");
		expect(screen.getByRole("listbox")).toBeInTheDocument();
	});

	it("multi-select: selecting the last remaining option clears to All", () => {
		const onChange = vi.fn();
		render(
			<DropdownFilter values={["a", "b"]} onChange={onChange} options={options} placeholder="Status" />,
		);
		openMenu();
		fireEvent.click(screen.getByRole("option", { name: "Gamma" }));
		expect(onChange).toHaveBeenCalledWith(null);
	});

	it("Escape and outside mousedown close the listbox", () => {
		render(<DropdownFilter values={null} onChange={vi.fn()} options={options} placeholder="Status" />);
		openMenu();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		openMenu();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("listbox")).toBeNull();
	});
});

describe("StatusFilter url mode with a comma-joined param", () => {
	it("pre-selects every part and rewrites to repeated params on the next pick", () => {
		const Where = () => <div data-testid="where">{useLocation().search}</div>;
		render(
			<MemoryRouter initialEntries={["/x?status=a,b&page=2"]}>
				<StatusFilter paramKey="status" placeholder="Status" options={[...options, { value: "d", label: "Delta" }]} hideAll />
				<Where />
			</MemoryRouter>,
		);
		expect(screen.getByRole("button", { name: "Status (2)" })).toBeInTheDocument();
		openMenu();
		fireEvent.click(screen.getByRole("option", { name: /Gamma/ }));
		const sp = new URLSearchParams(screen.getByTestId("where").textContent ?? "");
		expect(sp.getAll("status")).toEqual(["a", "b", "c"]);
		expect(sp.get("page")).toBe("2");
	});
});
