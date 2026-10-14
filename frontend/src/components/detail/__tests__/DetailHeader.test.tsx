import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DetailHeader, { type DetailMenuGroup } from "../DetailHeader";

const groups = (over: Partial<DetailMenuGroup>[] = []): DetailMenuGroup[] => [
	{
		id: "lifecycle",
		label: "Lifecycle",
		items: [
			{ id: "withdraw", label: "Withdraw", onSelect: vi.fn() },
			{
				id: "reject",
				label: "Reject",
				disabled: true,
				disabledReason: "A job already exists for this quote.",
				onSelect: vi.fn(),
			},
		],
		...over[0],
	},
	{
		id: "document",
		label: "Document",
		items: [
			{
				id: "delete",
				label: "Delete Quote",
				intent: "destructive",
				onSelect: vi.fn(),
			},
		],
		...over[1],
	},
];

describe("DetailHeader", () => {
	/** One options button for the page, not one per surface. */
	it("exposes exactly one options button, named", () => {
		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={groups()}
				menuLabel="Quote actions"
			/>
		);

		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Quote actions" })).toBeTruthy();
	});

	// With lifecycle buttons in inlineActions, a non-wrapping row squeezes the
	// title to zero width at 640px, so the cluster must drop below it.
	it("lets the action cluster wrap below the title rather than crush it", () => {
		const { container } = render(
			<DetailHeader
				title="Weekly Filter Checks — Anderson Office Complex"
				inlineActions={<button type="button">Generate Next Occurrence</button>}
				menuGroups={groups()}
				menuLabel="Plan actions"
			/>
		);

		const row = container.firstElementChild as HTMLElement;
		const [identity, cluster] = Array.from(row.children) as HTMLElement[];
		expect(row.className).toContain("flex-wrap");
		expect(identity.className).toMatch(/basis-|flex-\[/);
		expect(cluster.className).not.toContain("flex-shrink-0");
	});

	// One menu, but the lifecycle/utility split survives as the grouping.
	it("keeps lifecycle and utility actions in separate labeled groups", async () => {
		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={groups()}
				menuLabel="Quote actions"
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));

		const menuGroups = screen.getAllByRole("group");
		expect(menuGroups).toHaveLength(2);
		expect(menuGroups[0].getAttribute("aria-labelledby")).toBe("docmenu-lifecycle");
		expect(document.getElementById("docmenu-lifecycle")?.textContent).toBe("Lifecycle");
		expect(document.getElementById("docmenu-document")?.textContent).toBe("Document");
	});

	/**
	 * `aria-disabled` rather than a native `disabled`, so the item stays
	 * focusable and its reason is reachable without a hover a keyboard or touch
	 * user never gets.
	 */
	it("renders an unavailable action disabled, with its reason visible", async () => {
		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={groups()}
				menuLabel="Quote actions"
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));

		const reject = screen.getByRole("menuitem", { name: /Reject/ });
		expect(reject.getAttribute("aria-disabled")).toBe("true");
		expect(screen.getByText("A job already exists for this quote.")).toBeTruthy();
	});

	/**
	 * The reason is a description, not part of the name: inside the button's
	 * content it is otherwise folded into the accessible name as a run-on label.
	 */
	it("exposes the reason as a description, not as part of the name", async () => {
		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={groups()}
				menuLabel="Quote actions"
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));

		const reject = screen.getByRole("menuitem", { name: "Reject" });
		expect(reject.hasAttribute("title")).toBe(false);
		const describedBy = reject.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy!)?.textContent).toBe(
			"A job already exists for this quote."
		);
	});

	// Real roving tabindex: the tab stop follows focus rather than sitting on
	// the first item forever.
	it("moves the single tab stop with focus", async () => {
		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={groups()}
				menuLabel="Quote actions"
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));

		const stops = () =>
			screen.getAllByRole("menuitem").map((el) => el.getAttribute("tabindex"));
		expect(stops()).toEqual(["0", "-1", "-1"]);

		await userEvent.keyboard("{End}");
		expect(stops()).toEqual(["-1", "-1", "0"]);
	});

	it("does not fire a disabled action", async () => {
		const onSelect = vi.fn();
		const menuGroups = groups([
			{
				items: [
					{
						id: "reject",
						label: "Reject",
						disabled: true,
						disabledReason: "closed",
						onSelect,
					},
				],
			},
		]);

		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={menuGroups}
				menuLabel="Quote actions"
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));
		await userEvent.click(screen.getByRole("menuitem", { name: /Reject/ }));

		expect(onSelect).not.toHaveBeenCalled();
	});

	it("closes on Escape and reports it, so a page can disarm a confirm", async () => {
		const onMenuClose = vi.fn();
		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={groups()}
				menuLabel="Quote actions"
				onMenuClose={onMenuClose}
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));
		await userEvent.keyboard("{Escape}");

		expect(screen.queryByRole("menu")).toBeNull();
		expect(onMenuClose).toHaveBeenCalled();
	});

	it("moves focus across groups with the arrow keys", async () => {
		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={groups()}
				menuLabel="Quote actions"
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));

		// Opening focuses the first item; End reaches the last, which lives in
		// the other group.
		expect(document.activeElement).toBe(
			screen.getByRole("menuitem", { name: "Withdraw" })
		);
		await userEvent.keyboard("{End}");
		expect(document.activeElement).toBe(
			screen.getByRole("menuitem", { name: "Delete Quote" })
		);
	});

	it("keeps a two-step item's menu open", async () => {
		const onSelect = vi.fn();
		const menuGroups = groups([
			{},
			{
				items: [
					{
						id: "delete",
						label: "Delete Quote",
						intent: "destructive",
						keepOpen: true,
						onSelect,
					},
				],
			},
		]);

		render(
			<DetailHeader
				title="Q-0008"
				menuGroups={menuGroups}
				menuLabel="Quote actions"
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: "Quote actions" }));
		await userEvent.click(screen.getByRole("menuitem", { name: "Delete Quote" }));

		expect(onSelect).toHaveBeenCalled();
		expect(screen.getByRole("menu")).toBeTruthy();
	});
});
