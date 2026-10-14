import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Avatar } from "../TechnicianBits";

describe("Avatar", () => {
	it("renders initials and a status dot by default", () => {
		const { container, getByText } = render(
			<Avatar technician={{ name: "Maria Rodriguez", status: "Available" }} size="md" />
		);
		expect(getByText("MR")).toBeInTheDocument();
		expect(container.querySelector("span")).not.toBeNull();
	});

	it("omits the status dot when showStatus is false", () => {
		const { container } = render(
			<Avatar technician={{ name: "Sam Lee" }} size="md" showStatus={false} />
		);
		expect(container.querySelector("span")).toBeNull();
	});
});
