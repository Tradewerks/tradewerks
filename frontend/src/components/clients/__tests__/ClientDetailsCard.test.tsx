import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ClientDetailsCard from "../ClientDetailsCard";

function renderCard(ui: React.ReactElement) {
	return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const FULL_CLIENT = {
	name: "Acme HVAC Co.",
	address: "1200 W Oak St, Springfield",
	phone: "(555) 018-4412",
	email: "dispatch@acmehvac.test",
	is_active: true,
	contacts: [
		{
			is_primary: true,
			contact: {
				id: "c1",
				name: "Jane Roe",
				email: "jane@acmehvac.test",
				phone: "(555) 018-4413",
				title: "Ops Manager",
			},
		},
	],
};

describe("ClientDetailsCard", () => {
	it("renders address and primary contact when the client has them", () => {
		renderCard(<ClientDetailsCard client_id="cl1" client={FULL_CLIENT} />);

		expect(screen.getByText("1200 W Oak St, Springfield")).toBeInTheDocument();
		expect(screen.getByText("Jane Roe")).toBeInTheDocument();
	});

	/**
	 * The section labels used to appear and disappear between records, which is
	 * what made the rail's height a function of how complete the client record
	 * is. An incomplete record is also something a dispatcher can act on, so
	 * saying so is information rather than filler.
	 */
	it("keeps the address section and says so when there is no address", () => {
		renderCard(
			<ClientDetailsCard
				client_id="cl1"
				client={{ ...FULL_CLIENT, address: null }}
			/>
		);

		expect(screen.getByText("Address")).toBeInTheDocument();
		expect(screen.getByText("No address on file")).toBeInTheDocument();
	});

	it("keeps the primary contact section and says so when there is none", () => {
		renderCard(
			<ClientDetailsCard
				client_id="cl1"
				client={{ ...FULL_CLIENT, contacts: [] }}
			/>
		);

		expect(screen.getByText("Primary Contact")).toBeInTheDocument();
		expect(screen.getByText("No primary contact")).toBeInTheDocument();
	});

	it("renders both empty states for a bare client record", () => {
		renderCard(<ClientDetailsCard client_id="cl1" client={{ name: "Bare Co." }} />);

		expect(screen.getByText("No address on file")).toBeInTheDocument();
		expect(screen.getByText("No primary contact")).toBeInTheDocument();
	});

	/**
	 * mt-auto is the absorber: it pins the footer to the card base so the slack
	 * a stretched grid cell hands the card collects above the button as one
	 * gutter, rather than pooling under top-aligned content as a hole.
	 */
	it("pins the profile button to the card base", () => {
		renderCard(<ClientDetailsCard client_id="cl1" client={FULL_CLIENT} />);

		const button = screen.getByRole("button", { name: "View Full Client Profile" });
		expect(button.className).toContain("mt-auto");
	});

	it("still hides the profile button when showDispatchLink is false", () => {
		renderCard(
			<ClientDetailsCard
				client_id="cl1"
				client={FULL_CLIENT}
				showDispatchLink={false}
			/>
		);

		expect(
			screen.queryByRole("button", { name: "View Full Client Profile" })
		).toBeNull();
	});

	/**
	 * Only the grid ITEM stretches. Without this the card kept its content
	 * height inside a stretched cell, which is why dropping `self-start` alone
	 * changed nothing a dispatcher could see.
	 */
	it("fills its parent when fill is set, and does not by default", () => {
		const { container: plain } = renderCard(
			<ClientDetailsCard client_id="cl1" client={FULL_CLIENT} />
		);
		const { container: filled } = renderCard(
			<ClientDetailsCard fill client_id="cl1" client={FULL_CLIENT} />
		);

		expect((plain.firstElementChild as HTMLElement).className).not.toContain("flex-1");
		expect((filled.firstElementChild as HTMLElement).className).toContain("flex-1");
	});
});
