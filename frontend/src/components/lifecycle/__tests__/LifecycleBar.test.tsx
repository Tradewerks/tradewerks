import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LifecycleBar, { LifecycleRule } from "../LifecycleBar";
import { splitActions } from "../overflow";
import type { LifecycleAction } from "../types";

const action = (over: Partial<LifecycleAction> = {}): LifecycleAction => ({
	id: "approve",
	label: "Approve",
	intent: "primary",
	disabled: false,
	onSelect: vi.fn(),
	...over,
});

describe("LifecycleBar", () => {
	it("shows the path with the current step marked", () => {
		render(
			<LifecycleBar
				steps={["Draft", "Issued", "Sent", "Approved"]}
				stage="normal"
				currentStatus="Sent"
				actions={[action()]}
			/>
		);

		expect(screen.getByText("Draft")).toBeTruthy();
		expect(screen.getByText("Approved")).toBeTruthy();
		expect(screen.getByLabelText("Current status: Sent")).toBeTruthy();
	});

	/**
	 * The disabled-with-reason contract, not placement, so the fixture is not
	 * destructive: Rule 1 would send a destructive action to the overflow and
	 * make this unsatisfiable. The reason must be readable text, not a hover
	 * tooltip, which reaches neither keyboard nor touch users.
	 */
	it("carries a disabled action's reason in its accessible description, not a tooltip", () => {
		render(
			<LifecycleBar
				steps={["Draft", "Issued", "Sent", "Approved"]}
				stage="normal"
				currentStatus="Approved"
				actions={[
					action({
						id: "reject",
						label: "Reject",
						intent: "neutral",
						disabled: true,
						disabledReason: "A job already exists for this quote.",
					}),
				]}
			/>
		);

		const button = screen.getByRole("button", { name: "Reject" });
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.hasAttribute("title")).toBe(false);
		// Focusable, so the description is reachable at all.
		expect(button.hasAttribute("disabled")).toBe(false);

		const describedBy = button.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy!)!.textContent).toContain(
			"A job already exists for this quote."
		);
	});

	// aria-disabled does not stop a click the way the disabled attribute does.
	it("does not fire a disabled action's handler", () => {
		const onSelect = vi.fn();
		render(
			<LifecycleBar
				steps={["Draft", "Issued"]}
				stage="normal"
				currentStatus="Draft"
				actions={[
					action({
						id: "reject",
						label: "Reject",
						intent: "neutral",
						disabled: true,
						disabledReason: "Not yet issued.",
						onSelect,
					}),
				]}
			/>
		);

		screen.getByRole("button", { name: "Reject" }).click();
		expect(onSelect).not.toHaveBeenCalled();
	});

	/**
	 * A document-killing button must never be one stray click from the
	 * pointer, and a disabled action keeps its slot so positions do not shift
	 * as state changes.
	 */
	it("keeps destructive actions out of the primary row", () => {
		const withdraw = action({
			id: "withdraw",
			label: "Withdraw",
			intent: "destructive",
		});
		const actions = [action({ id: "approve", label: "Approve" }), withdraw];

		render(
			<LifecycleBar
				steps={["Draft", "Issued", "Sent", "Approved"]}
				stage="normal"
				currentStatus="Sent"
				actions={actions}
			/>
		);

		expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
		// The bar has no menu of its own: Withdraw goes to the header kebab's
		// Lifecycle group, asserted in overflow.test.ts.
		expect(splitActions("normal", actions).overflow).toContain(withdraw);
	});

	/**
	 * On a Rejected quote the keep-your-slot rule would show Issue / Email /
	 * Approve, all dead, and bury Create Revision — the only live action — in
	 * the menu. A stopped document has no muscle memory to protect.
	 */
	it("promotes the live action into view on a terminal stage", () => {
		render(
			<LifecycleBar
				steps={["Draft", "Issued", "Sent", "Approved"]}
				stage="terminal"
				currentStatus="Rejected"
				actions={[
					action({
						id: "issue",
						label: "Mark as Issued",
						disabled: true,
					}),
					action({
						id: "send",
						label: "Email to Client",
						disabled: true,
					}),
					action({
						id: "approve",
						label: "Mark as Approved",
						disabled: true,
					}),
					action({
						id: "revise",
						label: "Create Revision",
						intent: "neutral",
					}),
				]}
				detail={<span>Rejected</span>}
			/>
		);

		expect(screen.getByRole("button", { name: "Create Revision" })).toBeTruthy();
	});

	// The normal stage keeps the strict positional rule, so a button does not
	// move under the pointer as the document advances.
	it("keeps a disabled action in its slot on the normal stage", () => {
		render(
			<LifecycleBar
				steps={["Draft", "Issued", "Sent", "Approved"]}
				stage="normal"
				currentStatus="Draft"
				actions={[
					action({
						id: "issue",
						label: "Mark as Issued",
						disabled: true,
					}),
					action({
						id: "send",
						label: "Email to Client",
						disabled: true,
					}),
					action({
						id: "approve",
						label: "Mark as Approved",
						disabled: true,
					}),
					action({
						id: "revise",
						label: "Create Revision",
						intent: "neutral",
					}),
				]}
			/>
		);

		expect(screen.queryByRole("button", { name: "Create Revision" })).toBeNull();
		expect(screen.getByRole("button", { name: "Mark as Issued" })).toBeTruthy();
	});

	it("replaces the stepper with the detail slot on a dispute stage", () => {
		render(
			<LifecycleBar
				steps={["Draft", "Issued", "Sent", "PartiallyPaid", "Paid"]}
				stage="dispute"
				currentStatus="Disputed"
				actions={[action({ id: "adjust", label: "Issue Adjustment" })]}
				detail={<span>labor double-quoted</span>}
			/>
		);

		expect(screen.getByText("labor double-quoted")).toBeTruthy();
		expect(screen.queryByText("Draft")).toBeNull();
	});
});

describe("LifecycleBar steps prop", () => {
	it("renders the steps it is given rather than looking them up", () => {
		render(
			<LifecycleBar
				steps={["Unscheduled", "Scheduled", "InProgress", "Completed"]}
				stage="normal"
				currentStatus="Scheduled"
				actions={[action()]}
			/>
		);

		expect(screen.getByText("Unscheduled")).toBeTruthy();
		expect(screen.getByText("Completed")).toBeTruthy();
		expect(screen.getByLabelText("Current status: Scheduled")).toBeTruthy();
	});

	/**
	 * An off-ramp status is absent from the step list, so indexOf returns -1 and
	 * the rail must claim nothing: no step current, none complete.
	 */
	it("marks no step current when the status is off the path", () => {
		render(
			<LifecycleBar
				steps={["New", "Reviewing", "Quoted", "QuoteApproved"]}
				stage="normal"
				currentStatus="QuoteRejected"
				actions={[action()]}
			/>
		);

		expect(screen.queryByLabelText(/^Current status:/)).toBeNull();
		expect(screen.getByText("New")).toBeTruthy();
	});
});

describe("LifecycleBar state variant", () => {
	it("renders the current state as one chip instead of a path", () => {
		render(
			<LifecycleBar
				variant="state"
				stage="normal"
				currentStatus="Paused"
				actions={[action({ id: "resume", label: "Resume Plan" })]}
			/>
		);

		expect(screen.getByLabelText("Current status: Paused")).toBeTruthy();
		expect(screen.getByText("Resume Plan")).toBeTruthy();
	});

	it("still routes destructive actions to the overflow", () => {
		const actions = [
			action({ id: "pause", label: "Pause Plan" }),
			action({ id: "cancel", label: "Cancel Plan", intent: "destructive" }),
		];

		render(
			<LifecycleBar
				variant="state"
				stage="normal"
				currentStatus="Active"
				actions={actions}
			/>
		);

		expect(screen.getByText("Pause Plan")).toBeTruthy();
		expect(screen.queryByText("Cancel Plan")).toBeNull();
		expect(splitActions("normal", actions).overflow.map((a) => a.id)).toEqual([
			"cancel",
		]);
	});
});

describe("LifecycleBar step labels", () => {
	/**
	 * The step arrays hold status values, since the bar compares them against
	 * currentStatus — so without stepLabels it prints "QuoteApproved".
	 */
	it("prints a step's display label rather than its status value", () => {
		render(
			<LifecycleBar
				steps={["New", "Reviewing", "Quoted", "QuoteApproved"]}
				stepLabels={{ QuoteApproved: "Quote Approved" }}
				stage="normal"
				currentStatus="Quoted"
				actions={[action()]}
			/>
		);

		expect(screen.getByText("Quote Approved")).toBeTruthy();
		expect(screen.queryByText("QuoteApproved")).toBeNull();
	});

	// A map that has fallen behind the step list must degrade to the raw value,
	// not to an empty node.
	it("falls back to the raw status when the map has no entry", () => {
		render(
			<LifecycleBar
				steps={["New", "Reviewing"]}
				stepLabels={{ New: "New" }}
				stage="normal"
				currentStatus="New"
				actions={[action()]}
			/>
		);

		expect(screen.getByText("Reviewing")).toBeTruthy();
	});

	it("names the current status by its display label", () => {
		render(
			<LifecycleBar
				steps={["New", "Reviewing", "Quoted", "QuoteApproved"]}
				stepLabels={{ QuoteApproved: "Quote Approved" }}
				stage="normal"
				currentStatus="QuoteApproved"
				actions={[action()]}
			/>
		);

		expect(screen.getByLabelText("Current status: Quote Approved")).toBeTruthy();
	});
});

describe("LifecycleBar tone", () => {
	/**
	 * A blanket error tone on `terminal` paints a completed recurring plan red:
	 * the plan page sends Completed and Cancelled to the same stage, and only
	 * the page knows which it has.
	 */
	it("distinguishes a terminal stage from normal without claiming it went badly", () => {
		const { container } = render(
			<LifecycleBar
				steps={["Active"]}
				stage="terminal"
				currentStatus="Completed"
				actions={[action()]}
				detail={<span>Completed its term.</span>}
			/>
		);

		const bar = container.firstElementChild as HTMLElement;
		expect(bar.className).toContain("border-border-strong");
		expect(bar.className).not.toContain("border-error-border");
	});

	it("takes the error tone when the page asks for it", () => {
		const { container } = render(
			<LifecycleBar
				steps={["Active"]}
				stage="terminal"
				tone="error"
				currentStatus="Cancelled"
				actions={[action()]}
				detail={<span>Cancelled by Austin.</span>}
			/>
		);

		expect((container.firstElementChild as HTMLElement).className).toContain(
			"border-error-border"
		);
	});

	it("keeps the warning tone on a dispute stage", () => {
		const { container } = render(
			<LifecycleBar
				steps={["Draft", "Issued"]}
				stage="dispute"
				currentStatus="Disputed"
				actions={[action()]}
				detail={<span>labor double-quoted</span>}
			/>
		);

		expect((container.firstElementChild as HTMLElement).className).toContain(
			"border-warning-border"
		);
	});
});

describe("LifecycleBar off-ramp", () => {
	/**
	 * An off-ramp has no position on the path, and the bar is not told which
	 * step was last reached — so it names the state beside a muted rail rather
	 * than claiming a position the data doesn't support.
	 */
	it("names the off-ramp state and keeps its exits in the action row", () => {
		render(
			<LifecycleBar
				steps={["Scheduled", "Driving", "OnSite", "InProgress", "Completed"]}
				stage="normal"
				currentStatus="Paused"
				offRamp={{ label: "Paused" }}
				actions={[action({ id: "resume", label: "Resume", intent: "primary" })]}
			/>
		);

		expect(screen.getByLabelText("Current status: Paused")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
	});

	it("renders the off-ramp note when the page records a reason", () => {
		render(
			<LifecycleBar
				steps={["Scheduled", "Driving"]}
				stage="normal"
				currentStatus="Delayed"
				offRamp={{ label: "Delayed", note: <span>Parts on back order</span> }}
				actions={[action()]}
			/>
		);

		expect(screen.getByText("Parts on back order")).toBeTruthy();
	});

	// The path stays visible — a paused visit is still a visit with five steps —
	// but no step may be marked current or done.
	it("still shows the path with no step claimed", () => {
		render(
			<LifecycleBar
				steps={["Scheduled", "Driving", "OnSite"]}
				stage="normal"
				currentStatus="Paused"
				offRamp={{ label: "Paused" }}
				actions={[action()]}
			/>
		);

		expect(screen.getByText("Scheduled")).toBeTruthy();
		expect(screen.getByText("OnSite")).toBeTruthy();
		expect(screen.queryByLabelText("Current status: OnSite")).toBeNull();
	});

	/**
	 * The visit catalog's shape: Start Driving / Mark On Site / Start Work all
	 * blocked ahead of Resume, the one legal move. The bar inverts Rule 2 off
	 * its own offRamp prop, so pages need not pre-sort actions.
	 */
	it("puts the live exit inline, not a blocked earlier action, when offRamp is set", () => {
		render(
			<LifecycleBar
				steps={["Scheduled", "Driving", "OnSite", "InProgress", "Completed"]}
				stage="normal"
				currentStatus="Paused"
				offRamp={{ label: "Paused" }}
				actions={[
					action({
						id: "drive",
						label: "Start Driving",
						disabled: true,
						disabledReason: "Visit is paused.",
					}),
					action({
						id: "arrive",
						label: "Mark On Site",
						disabled: true,
						disabledReason: "Visit is paused.",
					}),
					action({
						id: "start",
						label: "Start Work",
						disabled: true,
						disabledReason: "Visit is paused.",
					}),
					action({ id: "resume", label: "Resume", intent: "primary" }),
				]}
			/>
		);

		expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start Work" })).toBeNull();
	});
});

describe("LifecycleBar node rail", () => {
	// The rail is the read-out. A done step carries a mark a colour-blind user
	// can still see, which a filled dot alone does not.
	it("marks completed steps with more than colour", () => {
		render(
			<LifecycleBar
				steps={["Draft", "Issued", "Sent", "Approved"]}
				stage="normal"
				currentStatus="Sent"
				actions={[action()]}
			/>
		);

		const list = screen.getByRole("list");
		expect(list.querySelectorAll("[data-step-state='done']").length).toBe(2);
		expect(list.querySelectorAll("[data-step-state='current']").length).toBe(1);
		expect(list.querySelectorAll("[data-step-state='later']").length).toBe(1);
	});
});
describe("LifecycleBar revision", () => {
	// Reasons are for assistive tech only; printed under the buttons they
	// restate what the dead button already shows.
	it("keeps a disabled action's reason out of the visible layout", () => {
		render(
			<LifecycleBar
				steps={["New", "Reviewing"]}
				stage="normal"
				currentStatus="New"
				actions={[
					action({
						id: "review",
						label: "Mark as Reviewing",
						intent: "neutral",
						disabled: true,
						disabledReason: "Being marked automatically.",
					}),
				]}
			/>
		);

		const button = screen.getByRole("button", { name: "Mark as Reviewing" });
		const reason = document.getElementById(button.getAttribute("aria-describedby")!)!;
		expect(reason.textContent).toBe("Being marked automatically.");
		expect(reason.className).toContain("sr-only");
	});

	it("never renders a hidden action", () => {
		render(
			<LifecycleBar
				steps={["New", "Reviewing"]}
				stage="normal"
				currentStatus="Reviewing"
				actions={[
					action({ id: "review", label: "Mark as Reviewing", disabled: true, hidden: true }),
					action({ id: "job", label: "Convert to Job" }),
				]}
			/>
		);

		expect(screen.queryByRole("button", { name: "Mark as Reviewing" })).toBeNull();
		expect(screen.getByRole("button", { name: "Convert to Job" })).toBeTruthy();
	});

	// The header pill already names the mode.
	it("does not print the state a second time on the normal stage", () => {
		render(
			<LifecycleBar
				variant="state"
				stage="normal"
				currentStatus="Active"
				actions={[action({ id: "pause", label: "Pause Plan" })]}
			/>
		);

		expect(screen.getByLabelText("Current status: Active").className).toContain("sr-only");
	});

	it("renders nothing when a state-variant bar has no action to offer", () => {
		const { container } = render(
			<LifecycleBar
				variant="state"
				stage="normal"
				currentStatus="Active"
				actions={[action({ id: "resume", label: "Resume Plan", disabled: true, hidden: true })]}
			/>
		);

		expect(container.firstChild).toBeNull();
	});
});

describe("LifecycleRule", () => {
	const steps = ["Draft", "Issued", "Sent", "Approved"];
	const labels = { Draft: "Draft", Issued: "Issued", Sent: "Sent", Approved: "Approved" };

	// Below sm only the current step is named, so on an equal share it clips:
	// "Partially Paid" printed as "Partiall…".
	it("lets the named step size to its label at phone width", () => {
		const { container } = render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Sent" />
		);

		expect(container.querySelector('[data-step-state="current"]')?.className).toContain(
			"max-sm:flex-auto"
		);
		expect(container.querySelector('[data-step-state="later"]')?.className).not.toContain(
			"max-sm:flex-auto"
		);
	});

	it("marks the current step when the status is on the path", () => {
		render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Sent" />
		);

		expect(screen.getByLabelText("Current status: Sent")).toBeInTheDocument();
	});

	it("claims no position when the status is off the path and nothing halted it", () => {
		const { container } = render(
			<LifecycleRule
				steps={steps}
				stepLabels={labels}
				currentStatus="Disputed"
			/>
		);

		expect(container.querySelectorAll('[data-step-state="later"]')).toHaveLength(4);
	});

	it("lights the run up to haltedAt when the status is off the path", () => {
		const { container } = render(
			<LifecycleRule
				steps={steps}
				stepLabels={labels}
				currentStatus="Disputed"
				haltedAt="Sent"
			/>
		);

		expect(container.querySelectorAll('[data-step-state="done"]')).toHaveLength(2);
		expect(screen.getByLabelText("Stopped at: Sent")).toBeInTheDocument();
	});

	it("announces a halted position as stopped, never as the current status", () => {
		// The page's status pill owns the status word: a rail announcing
		// "Current status: Sent" on a Disputed quote contradicts it.
		render(
			<LifecycleRule
				steps={steps}
				stepLabels={labels}
				currentStatus="Disputed"
				haltedAt="Sent"
				tone="warning"
			/>
		);

		expect(screen.getByLabelText("Stopped at: Sent")).toBeInTheDocument();
		expect(screen.queryByLabelText(/^Current status:/)).toBeNull();
	});

	it("claims no position when haltedAt names a step the path does not have", () => {
		// status_at_open is typed `string`, not a step union, so an unrecognised
		// value must claim nothing rather than throw or light a segment.
		// Behavioural: StepTrack's indexOf already renders an unknown status as
		// all-"later", so LifecycleRule's `steps.includes` is defence in depth.
		const { container } = render(
			<LifecycleRule
				steps={steps}
				stepLabels={labels}
				currentStatus="Disputed"
				haltedAt="SomethingElse"
			/>
		);

		expect(container.querySelectorAll('[data-step-state="later"]')).toHaveLength(4);
	});

	it("colours a halted run in the warning tone, not as ordinary progress", () => {
		const { container } = render(
			<LifecycleRule
				steps={steps}
				stepLabels={labels}
				currentStatus="Disputed"
				haltedAt="Sent"
				tone="warning"
			/>
		);

		const reached = container.querySelector(
			'[data-step-state="done"] span[aria-hidden="true"]'
		);
		expect(reached?.className).toContain("bg-warning");
		expect(reached?.className).not.toContain("bg-primary");
	});

	// A connector is the step's own aria-hidden span. Both glyphs are svgs, so
	// they are told apart by the step state that owns them, not by tag.
	const connectors = (c: HTMLElement) =>
		Array.from(c.querySelectorAll('li > span[aria-hidden="true"]'));
	const markers = (c: HTMLElement) =>
		Array.from(c.querySelectorAll('[data-step-state="current"] svg'));
	const checks = (c: HTMLElement) =>
		Array.from(c.querySelectorAll('[data-step-state="done"] svg'));

	it("ends the track on the final step rather than on a connector", () => {
		const { container } = render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Sent" />
		);

		expect(connectors(container)).toHaveLength(steps.length - 1);
		expect(container.querySelector('li:last-child > span[aria-hidden="true"]')).toBeNull();
	});

	/**
	 * A connector spans the move from one step to the next, so the one after
	 * the current step is a move not yet made. Filled, it read as though the
	 * next status were the live one.
	 */
	it("stops the fill at the current step", () => {
		const { container } = render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Sent" />
		);

		const [draftToIssued, issuedToSent, sentToApproved] = connectors(container);
		expect(draftToIssued.className).toContain("bg-primary");
		expect(issuedToSent.className).toContain("bg-primary");
		expect(sentToApproved.className).toContain("bg-border");
		expect(sentToApproved.className).not.toContain("bg-primary");
	});

	it("fills every connector once the run reaches the final step", () => {
		const { container } = render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Approved" />
		);

		const filled = connectors(container);
		expect(filled).toHaveLength(3);
		filled.forEach((c) => expect(c.className).toContain("bg-primary"));
	});

	// Label weight and brightness alone did not separate the current step from
	// its tertiary and muted neighbours at a glance.
	it("marks the current step with more than label weight", () => {
		const { container } = render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Sent" />
		);

		expect(markers(container)).toHaveLength(1);
		expect(markers(container)[0].getAttribute("aria-hidden")).toBe("true");
	});

	// Green says settled; the blue track is the run itself. A completed step
	// reading in the run's own colour was the two saying the same thing twice.
	it("marks completed steps as settled rather than as more track", () => {
		const { container } = render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Sent" />
		);

		const done = checks(container);
		expect(done).toHaveLength(2);
		done.forEach((c) => expect(c.getAttribute("class")).toContain("text-success-text"));
		expect(markers(container)[0].getAttribute("class")).toContain("text-primary-text");
	});

	it("claims nothing off the path: no marker, no filled connector", () => {
		const { container } = render(
			<LifecycleRule steps={steps} stepLabels={labels} currentStatus="Disputed" />
		);

		expect(markers(container)).toHaveLength(0);
		connectors(container).forEach((c) => expect(c.className).toContain("bg-border"));
	});

	it("takes the warning tone for the marker as well as the fill", () => {
		const { container } = render(
			<LifecycleRule
				steps={steps}
				stepLabels={labels}
				currentStatus="Disputed"
				haltedAt="Sent"
				tone="warning"
			/>
		);

		const [marker] = markers(container);
		expect(marker.getAttribute("class")).toContain("text-warning-text");
		expect(marker.getAttribute("class")).not.toContain("text-primary-text");
		expect(connectors(container)[0].className).toContain("bg-warning");
	});
});

it("aligns a stage's block and its actions to the top, not the middle", () => {
	const { container } = render(
		<LifecycleBar
			steps={["Draft", "Issued", "Sent", "Approved"]}
			stage="terminal"
			currentStatus="Rejected"
			actions={[action({ id: "revise", label: "Create Revision" })]}
			detail={<p>The client rejected this quote.</p>}
		/>
	);

	expect(container.firstElementChild?.className).toContain("items-start");
	expect(container.firstElementChild?.className).not.toContain("items-center");
});

it("keeps a happy-path bar vertically centred", () => {
	const { container } = render(
		<LifecycleBar
			steps={["Draft", "Issued", "Sent", "Approved"]}
			stage="normal"
			currentStatus="Sent"
			actions={[action()]}
		/>
	);

	expect(container.firstElementChild?.className).toContain("items-center");
});
