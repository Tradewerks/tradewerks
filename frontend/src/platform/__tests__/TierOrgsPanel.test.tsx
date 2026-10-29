import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ useOrgs: vi.fn(), rows: [] as unknown[] }));
vi.mock("../hooks", () => ({
	useOrgs: (...a: unknown[]) => {
		state.useOrgs(...a);
		return {
			isLoading: false,
			error: null,
			data: { rows: state.rows, total: state.rows.length, page: 1, pageSize: 25 },
		};
	},
}));

import TierOrgsPanel from "../components/TierOrgsPanel";
import type { TierRow } from "../types";

const version = (n: number, orgs: number) => ({ id: `v${n}`, version: n, org_count: orgs }) as never;
const TIER = {
	key: "starter",
	label: "Starter",
	versions: [version(2, 3), version(1, 1)],
} as unknown as TierRow;

beforeEach(() => {
	state.useOrgs.mockClear();
	state.rows = [
		{
			id: "o-1",
			name: "Acme Heating",
			timezone: "UTC",
			tier: { key: "starter", label: "Starter", version: 2 },
			trial: null,
		},
	];
});

const renderPanel = (v: number | null, onVersionChange = vi.fn()) =>
	render(
		<MemoryRouter>
			<TierOrgsPanel tier={TIER} version={v} onVersionChange={onVersionChange} />
		</MemoryRouter>
	);

describe("TierOrgsPanel", () => {
	it("lists orgs on the tier and links out to the filtered Organizations page", () => {
		renderPanel(null);
		expect(state.useOrgs).toHaveBeenLastCalledWith("", 1, false, {
			key: "starter",
			version: undefined,
		});
		expect(screen.getByRole("link", { name: "Acme Heating" })).toHaveAttribute(
			"href",
			"/platform/orgs/o-1"
		);
		expect(screen.getByRole("link", { name: "Open in Organizations" })).toHaveAttribute(
			"href",
			"/platform/orgs?tier=starter"
		);
	});

	it("narrows to one version and carries it into the Organizations link", () => {
		const onVersionChange = vi.fn();
		renderPanel(2, onVersionChange);
		expect(state.useOrgs).toHaveBeenLastCalledWith("", 1, false, { key: "starter", version: 2 });
		expect(screen.getByRole("link", { name: "Open in Organizations" })).toHaveAttribute(
			"href",
			"/platform/orgs?tier=starter&version=2"
		);
		fireEvent.click(screen.getByRole("button", { name: /All versions/ }));
		expect(onVersionChange).toHaveBeenCalledWith(null);
	});

	it("says so when nobody is on the tier", () => {
		state.rows = [];
		renderPanel(1);
		expect(screen.getByText("No organizations are on Starter v1.")).toBeInTheDocument();
	});
});
