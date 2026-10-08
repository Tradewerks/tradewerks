import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { EntitlementsData } from "../../../../lib/permissionAccess";

const h = vi.hoisted(() => ({ reset: vi.fn(), mutate: vi.fn() }));
vi.mock("../../../../hooks/useUpgradeRequests", () => ({
	useUpgradeRequests: (enabled: boolean) =>
		enabled ? { data: [], isSuccess: true } : { data: undefined, isSuccess: false },
	useWithdrawUpgradeRequest: () => ({
		mutate: h.mutate,
		reset: h.reset,
		isPending: false,
		error: null,
	}),
}));
vi.mock("../RequestChangeDialog", () => ({
	default: ({ open, initialNote }: { open: boolean; initialNote?: string }) =>
		open ? <p>dialog: {initialNote}</p> : null,
}));

import SubscriptionRail from "../SubscriptionRail";

const data: EntitlementsData = {
	plan: { key: "starter", label: "Starter", version: 1, trialActive: false },
	modules: [],
	permissionMap: {},
	limits: {},
	usage: null,
};

function Search() {
	return <p data-testid="search">{useLocation().search}</p>;
}

const renderAt = (canManage: boolean) =>
	render(
		<MemoryRouter initialEntries={["/admin?tab=entitlements&request=technicians"]}>
			<SubscriptionRail data={data} canManage={canManage} />
			<Search />
		</MemoryRouter>
	);

describe("SubscriptionRail seat request link", () => {
	it("opens the request dialog with the seat note for a manager", () => {
		renderAt(true);
		expect(screen.getByText("dialog: We need more technician seats.")).toBeInTheDocument();
		expect(screen.getByTestId("search")).toHaveTextContent("?tab=entitlements");
	});

	it("drops the request param for someone who cannot manage the subscription", () => {
		renderAt(false);
		expect(screen.queryByText(/dialog:/)).not.toBeInTheDocument();
		expect(screen.getByTestId("search")).toHaveTextContent("?tab=entitlements");
		expect(screen.getByTestId("search")).not.toHaveTextContent("request=");
	});
});
