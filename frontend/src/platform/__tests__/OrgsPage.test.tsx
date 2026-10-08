import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
	...(await orig<typeof import("react-router-dom")>()),
	useNavigate: () => navigate,
}));
vi.mock("../hooks", () => ({
	useOrgs: () => ({
		isLoading: false,
		error: null,
		data: {
			rows: [
				{
					id: "org-1",
					name: "Acme Heating",
					tier: { key: "pro", label: "Pro", version: 2 },
					trial: null,
					template: "hvac",
					usage: null,
				},
			],
			total: 1,
			page: 1,
			pageSize: 25,
		},
	}),
}));

import OrgsPage from "../pages/OrgsPage";

beforeEach(() => navigate.mockClear());

describe("OrgsPage rows", () => {
	it("clicking anywhere on the row opens the organization", () => {
		render(<OrgsPage />, { wrapper: MemoryRouter });
		fireEvent.click(screen.getAllByText("Pro v2")[0]);
		expect(navigate).toHaveBeenCalledWith("/platform/orgs/org-1");
	});

	it("clicking the name link leaves navigation to the link", () => {
		render(<OrgsPage />, { wrapper: MemoryRouter });
		fireEvent.click(screen.getAllByRole("link", { name: "Acme Heating" })[0]);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("modifier-click on the row does not navigate in place", () => {
		render(<OrgsPage />, { wrapper: MemoryRouter });
		fireEvent.click(screen.getAllByText("Pro v2")[0], { metaKey: true });
		expect(navigate).not.toHaveBeenCalled();
	});
});
