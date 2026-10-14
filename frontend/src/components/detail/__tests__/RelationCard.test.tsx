import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RelationCard from "../RelationCard";

function renderCard(ui: React.ReactElement) {
	return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("RelationCard", () => {
	/**
	 * A Link, not a button: middle-click, cmd-click and "copy link address" all
	 * do nothing on a button, and it announces itself as the wrong role.
	 */
	it("renders a link to the related entity, not a button", () => {
		renderCard(
			<RelationCard
				eyebrow="Related Quote"
				to="/dispatch/quotes/q1"
				emptyLabel="No quote created yet"
				title="Q-1042"
			/>
		);

		const link = screen.getByRole("link", { name: /Q-1042/ });
		expect(link.getAttribute("href")).toBe("/dispatch/quotes/q1");
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders subtitle, meta and trailing content where given", () => {
		renderCard(
			<RelationCard
				eyebrow="Related Quote"
				to="/dispatch/quotes/q1"
				emptyLabel="No quote created yet"
				title="Q-1042"
				subtitle="Rooftop unit replacement"
				meta={<span>Sep 3, 2026</span>}
				trailing={<span>$4,820.00</span>}
			/>
		);

		expect(screen.getByText("Rooftop unit replacement")).toBeInTheDocument();
		expect(screen.getByText("Sep 3, 2026")).toBeInTheDocument();
		expect(screen.getByText("$4,820.00")).toBeInTheDocument();
	});

	it("omits subtitle, meta and trailing where not given", () => {
		renderCard(
			<RelationCard
				eyebrow="Related Job"
				to="/dispatch/jobs/j1"
				emptyLabel="No job created yet"
				title="J-2201"
			/>
		);

		expect(screen.getByRole("link", { name: /J-2201/ })).toBeInTheDocument();
		expect(screen.queryByText("Sep 3, 2026")).toBeNull();
	});

	// The eyebrow survives into the empty state: a dashed box saying only "No
	// quote created yet" does not say what slot is empty.
	it("renders the empty state with its eyebrow and no link when there is no target", () => {
		renderCard(
			<RelationCard eyebrow="Related Quote" emptyLabel="No quote created yet" />
		);

		expect(screen.getByText("Related Quote")).toBeInTheDocument();
		expect(screen.getByText("No quote created yet")).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("renders the empty state when a target is given without a title", () => {
		renderCard(
			<RelationCard
				eyebrow="Related Quote"
				to="/dispatch/quotes/q1"
				emptyLabel="No quote created yet"
			/>
		);

		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("No quote created yet")).toBeInTheDocument();
	});

	// The Quote page offers "Convert to Job" from inside the empty Related Job
	// box. It is the same action the lifecycle bar carries, so it is a shortcut
	// rather than the only route — but it is one a dispatcher reaches for, and a
	// primitive that cannot hold it would have quietly deleted it.
	it("renders an action inside the empty state when one is given", () => {
		render(
			<RelationCard
				eyebrow="Related Job"
				emptyLabel="No job created yet"
				emptyAction={<button>Convert to Job</button>}
			/>
		);

		expect(screen.getByText("No job created yet")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Convert to Job" })).toBeInTheDocument();
	});

	it("ignores emptyAction once the slot is filled", () => {
		render(
			<MemoryRouter>
				<RelationCard
					eyebrow="Related Job"
					to="/dispatch/jobs/j1"
					emptyLabel="No job created yet"
					title="JOB-0001"
					emptyAction={<button>Convert to Job</button>}
				/>
			</MemoryRouter>
		);

		expect(screen.queryByRole("button", { name: "Convert to Job" })).toBeNull();
	});
});
