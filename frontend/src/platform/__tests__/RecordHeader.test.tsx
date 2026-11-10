import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RecordHeader from "../components/RecordHeader";

describe("RecordHeader", () => {
	it("renders the title as a level-1 heading", () => {
		render(<RecordHeader title="Acme HVAC" />);
		expect(screen.getByRole("heading", { level: 1, name: "Acme HVAC" })).toBeInTheDocument();
	});

	it("renders badges, meta, actions and subtitle when given", () => {
		render(
			<RecordHeader
				title="Pro"
				subtitle="pro_key"
				badges={<span>Badge</span>}
				meta={<span>Meta</span>}
				actions={<button type="button">Act</button>}
			/>
		);
		expect(screen.getByText("pro_key")).toBeInTheDocument();
		expect(screen.getByText("Badge")).toBeInTheDocument();
		expect(screen.getByText("Meta")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Act" })).toBeInTheDocument();
	});

	it("omits the optional wrappers when not given", () => {
		const { container } = render(<RecordHeader title="Bare" />);
		expect(container.querySelector("button")).toBeNull();
		expect(screen.queryByText("Badge")).toBeNull();
		expect(screen.queryByText("Meta")).toBeNull();
		expect(container.querySelector("h1 > span")).toBeNull();
		expect(container).toHaveTextContent(/^Bare$/);
	});
});
