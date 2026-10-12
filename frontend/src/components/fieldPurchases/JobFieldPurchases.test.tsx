/**
 * The panel pairs with Linked Invoices on the Financials tabs, so what is asserted
 * is that it holds its place in every state a viewer can reach — and only vanishes
 * for a viewer who may not see field purchases at all.
 */
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import JobFieldPurchases from "./JobFieldPurchases";

let canSee = true;
let query: { data?: unknown[]; isLoading: boolean; isError: boolean };

vi.mock("../../hooks/usePermission", () => ({
	useAnyPermission: () => canSee,
}));

vi.mock("../../hooks/useFieldPurchases", () => ({
	useFieldPurchases: () => query,
}));

function renderPanel(visitId?: string) {
	return render(
		<MemoryRouter>
			<JobFieldPurchases jobId="job-1" visitId={visitId} />
		</MemoryRouter>
	);
}

describe("JobFieldPurchases", () => {
	beforeEach(() => {
		canSee = true;
		query = { data: [], isLoading: false, isError: false };
	});

	test("renders an empty-state card when nothing was bought", () => {
		renderPanel("visit-1");
		expect(screen.getByRole("heading", { name: "Field Purchases" })).toBeInTheDocument();
		expect(screen.getByText("No field purchases for this visit")).toBeInTheDocument();
	});

	test("names the job when not narrowed to a visit", () => {
		renderPanel();
		expect(screen.getByText("No field purchases for this job")).toBeInTheDocument();
	});

	test("holds its place with a skeleton while loading", () => {
		query = { data: undefined, isLoading: true, isError: false };
		renderPanel();
		expect(screen.getByRole("heading", { name: "Field Purchases" })).toBeInTheDocument();
		expect(screen.getByText("Loading field purchases")).toBeInTheDocument();
	});

	test("says a failed fetch is not an empty list", () => {
		query = { data: undefined, isLoading: false, isError: true };
		renderPanel();
		expect(screen.getByText(/Couldn't load field purchases/)).toBeInTheDocument();
		expect(screen.queryByText(/No field purchases/)).not.toBeInTheDocument();
	});

	test("renders nothing for a viewer without field-purchase permission", () => {
		canSee = false;
		const { container } = renderPanel();
		expect(container).toBeEmptyDOMElement();
	});
});
