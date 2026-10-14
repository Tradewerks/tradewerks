import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Pagination from "../Pagination";
import { pageList } from "../pageList";

describe("pageList", () => {
	it("lists every page when there are few", () => {
		expect(pageList(1, 3)).toEqual([1, 2, 3]);
	});

	it("keeps first, last and current ±1 with gaps between", () => {
		expect(pageList(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
	});

	it("adds no gap where the current window touches the first page", () => {
		expect(pageList(1, 10)).toEqual([1, 2, "gap", 10]);
		expect(pageList(3, 10)).toEqual([1, 2, 3, 4, "gap", 10]);
	});
});

describe("Pagination", () => {
	const base = { page: 1, pageSize: 12, total: 40, onPageChange: vi.fn() };

	it("renders nothing without rows", () => {
		const { container } = render(<Pagination {...base} total={0} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the visible range", () => {
		render(<Pagination {...base} page={2} />);
		expect(screen.getByText("Showing 13–24 of 40")).toBeInTheDocument();
	});

	it("marks the current page and disables Previous on page 1", () => {
		render(<Pagination {...base} />);
		expect(screen.getByRole("button", { name: "1" })).toHaveAttribute("aria-current", "page");
		expect(screen.getByRole("button", { name: "2" })).not.toHaveAttribute("aria-current");
		expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
	});

	it("disables Next on the last page", () => {
		render(<Pagination {...base} page={4} />);
		expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
	});

	it("clamps a page past the end to the last page", () => {
		render(<Pagination {...base} page={9} />);
		expect(screen.getByText("Showing 37–40 of 40")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "4" })).toHaveAttribute("aria-current", "page");
	});

	it("navigates via prev/next and page buttons", () => {
		const onPageChange = vi.fn();
		render(<Pagination {...base} page={2} onPageChange={onPageChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
		fireEvent.click(screen.getByRole("button", { name: "4" }));
		expect(onPageChange.mock.calls).toEqual([[3], [1], [4]]);
	});

	it("renders nothing when one page holds everything and no size would split it", () => {
		const { container } = render(<Pagination {...base} total={7} onPageSizeChange={vi.fn()} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("offers only sizes smaller than the total, plus All", () => {
		render(<Pagination {...base} total={30} onPageSizeChange={vi.fn()} />);
		const sizes = screen.getByRole("group", { name: "Rows per page" });
		expect([...sizes.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
			"12",
			"24",
			"All",
		]);
	});

	it("treats a page size at or above the total as All", () => {
		render(<Pagination {...base} total={30} pageSize={48} onPageSizeChange={vi.fn()} />);
		expect(screen.getByText("Showing all 30")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
	});

	it("keeps the size picker on a single page when a smaller size would split it", () => {
		render(<Pagination {...base} total={20} pageSize={0} onPageSizeChange={vi.fn()} />);
		expect(screen.getByRole("group", { name: "Rows per page" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
	});

	it("offers All as page size 0 and shows every row", () => {
		const onPageSizeChange = vi.fn();
		const { rerender } = render(<Pagination {...base} onPageSizeChange={onPageSizeChange} />);
		fireEvent.click(screen.getByRole("button", { name: "All" }));
		expect(onPageSizeChange).toHaveBeenCalledWith(0);
		rerender(<Pagination {...base} pageSize={0} onPageSizeChange={onPageSizeChange} />);
		expect(screen.getByText("Showing all 40")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
	});

	it("omits the size picker without onPageSizeChange", () => {
		render(<Pagination {...base} />);
		expect(screen.queryByRole("group", { name: "Rows per page" })).toBeNull();
	});

	it("exposes a labelled navigation landmark", () => {
		render(<Pagination {...base} />);
		expect(screen.getByRole("navigation", { name: "Pagination" })).toBeInTheDocument();
	});
});
