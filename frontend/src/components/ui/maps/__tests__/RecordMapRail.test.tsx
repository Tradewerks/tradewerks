import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordMapTechRow } from "../../../../lib/recordMap";

const perms = vi.hoisted(() => ({ manage: false }));
vi.mock("../../../../hooks/usePermission", () => ({
	usePermission: () => perms.manage,
}));

import RecordMapRail, {
	groupCrewByVisit,
	type RailVisit,
	type RecordMapRailProps,
} from "../RecordMapRail";

function row(over: Partial<RecordMapTechRow> = {}): RecordMapTechRow {
	return {
		techId: "t1",
		name: "Ana",
		status: "EnRoute",
		visitId: "v1",
		visitTechStatus: "EnRoute",
		activeHere: true,
		drivingElsewhere: false,
		etaSeconds: 300,
		distanceMeters: 3218.7,
		coords: { lat: 43.85, lon: -91.25 },
		color: "var(--color-tech-1)",
		positionHidden: false,
		...over,
	};
}

function renderRail(over: Partial<RecordMapRailProps> = {}) {
	const onLocate = vi.fn();
	const utils = render(
		<MemoryRouter>
			<RecordMapRail
				siteLabel="Acme"
				address="123 Main St"
				siteCoords={{ lat: 43.9, lon: -91.3 }}
				techRows={[row()]}
				isLoading={false}
				orgName="HQ"
				orgCoords={{ lat: 44.5, lon: -90.1 }}
				orgMissing={false}
				onLocate={onLocate}
				{...over}
			/>
		</MemoryRouter>,
	);
	return { onLocate, ...utils };
}

beforeEach(() => {
	perms.manage = false;
});

describe("RecordMapRail — zones", () => {
	test("site, crew and office are separate labelled regions", () => {
		renderRail();
		expect(screen.getByRole("region", { name: "Site" })).toHaveTextContent("Acme");
		expect(screen.getByRole("region", { name: "Crew" })).toHaveTextContent("Ana");
		expect(screen.getByRole("region", { name: "Office" })).toHaveTextContent("HQ");
	});

	test("crew heading carries the tech count", () => {
		renderRail({ techRows: [row(), row({ techId: "t2", name: "Bo" })] });
		const crew = screen.getByRole("region", { name: "Crew" });
		expect(within(crew).getByRole("heading", { name: "Crew" })).toBeInTheDocument();
		expect(crew).toHaveTextContent("2");
	});

	test("address is plain text, not a link", () => {
		renderRail();
		expect(screen.getByText("123 Main St")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /123 Main St/ })).toBeNull();
	});

	test("site, tech and office Locate buttons report their coords", async () => {
		const { onLocate } = renderRail();
		await userEvent.click(screen.getByRole("button", { name: "Show Acme on map" }));
		expect(onLocate).toHaveBeenLastCalledWith({ lat: 43.9, lon: -91.3 });
		await userEvent.click(screen.getByRole("button", { name: "Show Ana on map" }));
		expect(onLocate).toHaveBeenLastCalledWith({ lat: 43.85, lon: -91.25 });
		await userEvent.click(screen.getByRole("button", { name: "Show HQ on map" }));
		expect(onLocate).toHaveBeenLastCalledWith({ lat: 44.5, lon: -90.1 });
	});
});

describe("RecordMapRail — tech rows", () => {
	test("a driving tech shows ETA and distance and links to their page", () => {
		renderRail();
		expect(screen.getByText("~5m · 2.0 mi")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Ana" })).toHaveAttribute(
			"href",
			"/dispatch/technicians/t1",
		);
	});

	test("a tech with no location has a disabled Locate and says so", () => {
		renderRail({
			techRows: [row({ coords: null, etaSeconds: null, distanceMeters: null, activeHere: false })],
		});
		expect(screen.getByText("No location reported")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Show Ana on map" })).toBeDisabled();
	});

	test("driving elsewhere is called out", () => {
		renderRail({
			techRows: [row({ drivingElsewhere: true, etaSeconds: null, distanceMeters: null })],
		});
		expect(screen.getByText("En route elsewhere")).toBeInTheDocument();
	});

	test("an idle tech's account status is visible text, not just a dot", () => {
		renderRail({ techRows: [row({ status: "Break", visitTechStatus: null, activeHere: false })] });
		expect(screen.getByText("Break")).toBeVisible();
	});

	test("with a visit label, the account status stays available to screen readers", () => {
		renderRail();
		expect(screen.getByText("En route")).toBeInTheDocument();
		expect(screen.getByText(", En Route")).toHaveClass("sr-only");
	});

	test("hidden positions: note shown, no location line and no tech Locate", () => {
		renderRail({
			hiddenNote: "Visit closed — live positions hidden.",
			techRows: [
				row({
					coords: null,
					etaSeconds: null,
					distanceMeters: null,
					positionHidden: true,
					visitTechStatus: "Done",
				}),
			],
		});
		expect(screen.getByText("Visit closed — live positions hidden.")).toBeInTheDocument();
		expect(screen.getByText("Done")).toBeInTheDocument();
		expect(screen.queryByText("Last reported location")).toBeNull();
		expect(screen.queryByText("No location reported")).toBeNull();
		expect(screen.queryByRole("button", { name: "Show Ana on map" })).toBeNull();
	});
});

describe("RecordMapRail — empty and loading", () => {
	test("no technicians assigned", () => {
		renderRail({ techRows: [] });
		expect(screen.getByText("No technicians assigned")).toBeInTheDocument();
	});

	test("emptyTechText overrides the empty-crew copy", () => {
		renderRail({ techRows: [], emptyTechText: "Select a visit to see its crew" });
		expect(screen.getByText("Select a visit to see its crew")).toBeInTheDocument();
		expect(screen.queryByText("No technicians assigned")).toBeNull();
	});

	test("loading shows a muted loading line, not the empty state", () => {
		renderRail({ techRows: [], isLoading: true });
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByText("No technicians assigned")).toBeNull();
	});

	test("missing office: settings link only with manage_organization", () => {
		const { unmount } = renderRail({ orgMissing: true, orgCoords: null });
		expect(screen.getByText("No office address on file")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Set office address" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Show HQ on map" })).toBeNull();
		unmount();
		perms.manage = true;
		renderRail({ orgMissing: true, orgCoords: null });
		expect(screen.getByRole("link", { name: "Set office address" })).toHaveAttribute(
			"href",
			"/dispatch/admin?tab=settings",
		);
	});

	test("office row is labelled as the office", () => {
		renderRail();
		expect(
			within(screen.getByRole("region", { name: "Office" })).getByText("Office"),
		).toBeInTheDocument();
	});
});

const TZ = "America/Chicago";
function rv(id: string, name: string, over: Partial<RailVisit> = {}): RailVisit {
	return {
		id,
		name,
		startAt: "2026-10-01T15:00:00Z",
		status: "Scheduled",
		selected: false,
		...over,
	};
}

describe("groupCrewByVisit", () => {
	test("rows go under their selected visit; the rest are 'other'", () => {
		const { byVisit, other } = groupCrewByVisit(
			[rv("v1", "Repair", { selected: true }), rv("v2", "Follow-up")],
			[row(), row({ techId: "t2", visitId: "v2" }), row({ techId: "t3", visitId: null })],
		);
		expect(byVisit.get("v1")!.map((r) => r.techId)).toEqual(["t1"]);
		expect(byVisit.has("v2")).toBe(false);
		expect(other.map((r) => r.techId)).toEqual(["t2", "t3"]);
	});
});

describe("RecordMapRail — job mode", () => {
	const two = [
		rv("v1", "Repair", { selected: true, status: "Delayed" }),
		rv("v2", "Follow-up", { startAt: "2026-10-08T15:00:00Z" }),
	];

	test("visits are checkboxes in the given order, with status in the name", () => {
		renderRail({ visits: two, onToggleVisit: vi.fn(), tz: TZ });
		const boxes = screen.getAllByRole("checkbox");
		expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
		expect(boxes[0]).toHaveAccessibleName(/Oct 1.* · Repair, Delayed/);
		expect(boxes[1]).toHaveAccessibleName(/Oct 8.* · Follow-up, Scheduled/);
		expect(boxes[0]).toHaveTextContent("Delayed");
	});

	test("heading reads 'Visits' with selected-of-total; no Crew zone", () => {
		renderRail({ visits: two, onToggleVisit: vi.fn(), tz: TZ });
		expect(screen.getByRole("region", { name: "Visits" })).toHaveTextContent("1 of 2");
		expect(screen.queryByRole("region", { name: "Crew" })).toBeNull();
	});

	test("click, Space and Enter all toggle", async () => {
		const onToggle = vi.fn();
		renderRail({ visits: two, onToggleVisit: onToggle, tz: TZ });
		const follow = screen.getByRole("checkbox", { name: /Follow-up/ });
		await userEvent.click(follow);
		expect(onToggle).toHaveBeenLastCalledWith("v2");
		follow.focus();
		await userEvent.keyboard(" ");
		expect(onToggle).toHaveBeenCalledTimes(2);
		await userEvent.keyboard("{Enter}");
		expect(onToggle).toHaveBeenCalledTimes(3);
		expect(follow).toHaveFocus();
	});

	test("a selected visit's crew nests under it, outside the checkbox", () => {
		renderRail({ visits: two, onToggleVisit: vi.fn(), tz: TZ });
		const box = screen.getByRole("checkbox", { name: /Repair/ });
		const link = within(box.closest("li")!).getByRole("link", { name: "Ana" });
		expect(box).not.toContainElement(link);
	});

	test("Locate inside a visit does not toggle it", async () => {
		const onToggle = vi.fn();
		const { onLocate } = renderRail({ visits: two, onToggleVisit: onToggle, tz: TZ });
		expect(screen.getByRole("region", { name: "Visits" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Show Ana on map" }));
		expect(onLocate).toHaveBeenCalled();
		expect(onToggle).not.toHaveBeenCalled();
	});

	test("an unselected visit shows no crew", () => {
		renderRail({
			visits: two,
			onToggleVisit: vi.fn(),
			tz: TZ,
			techRows: [row(), row({ techId: "t2", name: "Bo", visitId: "v2" })],
		});
		const item = screen.getByRole("checkbox", { name: /Follow-up/ }).closest("li")!;
		expect(within(item).queryByRole("link")).toBeNull();
	});

	test("a selected visit with no crew says so", () => {
		renderRail({ visits: two, onToggleVisit: vi.fn(), tz: TZ, techRows: [] });
		const item = screen.getByRole("checkbox", { name: /Repair/ }).closest("li")!;
		expect(within(item).getByText("No technicians assigned")).toBeInTheDocument();
	});

	test("crew loading shows under the selected visit", () => {
		renderRail({ visits: two, onToggleVisit: vi.fn(), tz: TZ, techRows: [], isLoading: true });
		const item = screen.getByRole("checkbox", { name: /Repair/ }).closest("li")!;
		expect(within(item).getByText("Loading…")).toBeInTheDocument();
	});

	test("the hidden note shows only under a visit whose row is hidden", () => {
		renderRail({
			visits: [
				rv("v1", "Install", { selected: true, status: "Completed" }),
				rv("v2", "Repair", { selected: true }),
			],
			onToggleVisit: vi.fn(),
			tz: TZ,
			techRows: [
				row({ visitId: "v1", positionHidden: true, coords: null, etaSeconds: null }),
				row({ techId: "t2", name: "Bo", visitId: "v2" }),
			],
		});
		const notes = screen.getAllByText("Closed visit — live position hidden");
		expect(notes).toHaveLength(1);
		const installItem = screen.getByRole("checkbox", { name: /Install/ }).closest("li")!;
		expect(installItem).toContainElement(notes[0]);
	});

	test("no hidden note when a closed visit's rows are not hidden", () => {
		renderRail({
			visits: [rv("v1", "Install", { selected: true, status: "Completed" })],
			onToggleVisit: vi.fn(),
			tz: TZ,
		});
		expect(screen.getByRole("region", { name: "Visits" })).toBeInTheDocument();
		expect(screen.queryByText("Closed visit — live position hidden")).toBeNull();
	});

	test("unmatched crew land in 'Other visits'", () => {
		renderRail({
			visits: two,
			onToggleVisit: vi.fn(),
			tz: TZ,
			techRows: [row(), row({ techId: "t2", name: "Bo", visitId: null, visitTechStatus: null })],
		});
		expect(screen.getByRole("heading", { name: "Other visits" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Bo" })).toBeInTheDocument();
		expect(screen.getAllByRole("link", { name: "Ana" })).toHaveLength(1);
	});

	test("no 'Other visits' heading when every tech matches a visit", () => {
		renderRail({ visits: two, onToggleVisit: vi.fn(), tz: TZ });
		expect(screen.getByRole("region", { name: "Visits" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Other visits" })).toBeNull();
	});

	test("a job with no visits says so", () => {
		renderRail({ visits: [], onToggleVisit: vi.fn(), tz: TZ, techRows: [] });
		expect(screen.getByText("This job has no visits yet.")).toBeInTheDocument();
	});

	test("nothing selected shows the select hint", () => {
		renderRail({
			visits: [rv("v1", "Repair")],
			onToggleVisit: vi.fn(),
			tz: TZ,
			techRows: [],
			emptyTechText: "Select a visit to see its crew",
		});
		expect(screen.getByRole("region", { name: "Visits" })).toBeInTheDocument();
		expect(screen.getByText("Select a visit to see its crew")).toBeInTheDocument();
	});

	test("long names clamp to two lines with the full text in title", () => {
		const long = "Annual PM — Rooftop Units & VAV Boxes, Building B, North Wing";
		renderRail({ visits: [rv("v1", long)], onToggleVisit: vi.fn(), tz: TZ });
		expect(screen.getByTitle(new RegExp(long))).toHaveClass("line-clamp-2");
	});

	test("an unnamed visit reads 'Visit'", () => {
		renderRail({ visits: [rv("v1", "  ")], onToggleVisit: vi.fn(), tz: TZ });
		expect(screen.getByRole("checkbox")).toHaveAccessibleName(/ · Visit, Scheduled/);
	});
});

describe("RecordMapRail — final review fixes", () => {
	// A tech on several selected visits is listed once (focusAssignment); the
	// other visits are staffed, not empty.
	test("a staffed visit whose tech is listed under another visit says so", () => {
		renderRail({
			visits: [
				rv("v1", "Repair", { selected: true, crewCount: 1 }),
				rv("v2", "Follow-up", { selected: true, crewCount: 1 }),
			],
			onToggleVisit: vi.fn(),
			tz: TZ,
		});
		const follow = screen.getByRole("checkbox", { name: /Follow-up/ }).closest("li")!;
		expect(within(follow).getByText("Crew shown under another visit")).toBeInTheDocument();
		expect(within(follow).queryByText("No technicians assigned")).toBeNull();
	});

	test("a visit with no crew at all still says none are assigned", () => {
		renderRail({
			visits: [rv("v2", "Follow-up", { selected: true, crewCount: 0 })],
			onToggleVisit: vi.fn(),
			tz: TZ,
			techRows: [],
		});
		expect(screen.getByText("No technicians assigned")).toBeInTheDocument();
	});

	// The global unlayered :focus-visible offset draws outside the row and the
	// scrolling zone clips it; the row pulls the ring inside itself.
	test("visit rows draw their focus ring inset", () => {
		renderRail({ visits: [rv("v1", "Repair")], onToggleVisit: vi.fn(), tz: TZ });
		expect(screen.getByRole("checkbox")).toHaveClass("focus-visible:outline-offset-[-2px]!");
	});
});
