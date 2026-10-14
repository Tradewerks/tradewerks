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

describe("SubscriptionRail trial line (build plan 4)", () => {
	const dayLabel = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	const renderRail = (d: EntitlementsData) =>
		render(
			<MemoryRouter>
				<SubscriptionRail data={d} canManage />
			</MemoryRouter>
		);

	it("shows when an active trial ends", () => {
		const endsAt = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
		renderRail({
			...data,
			plan: { ...data.plan, label: "Enterprise", trialActive: true },
			setup: {
				templateKey: "hvac",
				modulesReviewed: true,
				trial: { tierLabel: "Enterprise", endsAt },
			},
		});
		expect(
			screen.getByText(`Trial ends ${dayLabel(endsAt)} · 3 days left`)
		).toBeInTheDocument();
	});

	it("says 1 day, singular, on the last day", () => {
		const endsAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
		renderRail({
			...data,
			setup: { templateKey: "hvac", modulesReviewed: true, trial: { tierLabel: "Pro", endsAt } },
		});
		expect(screen.getByText(`Trial ends ${dayLabel(endsAt)} · 1 day left`)).toBeInTheDocument();
	});

	it("shows no trial line without setup data", () => {
		renderRail({ ...data, setup: undefined });
		expect(screen.queryByText(/^Trial ends/)).toBeNull();
	});
});
