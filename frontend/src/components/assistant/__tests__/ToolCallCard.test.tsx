import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "../../../test/testUtils";
import type { UiToolCall } from "../../../types/assistant";
import ToolCallCard from "../ToolCallCard";

const call = (over: Partial<UiToolCall> = {}): UiToolCall => ({
	id: "t1",
	name: "get_schedule",
	input: { start_date: "2026-08-25" },
	state: "ok",
	summary: "Read the schedule — 3 visits",
	durationMs: 42,
	...over,
});

describe("ToolCallCard", () => {
	it("leads with the plain-language summary, not the tool name", () => {
		render(<ToolCallCard call={call()} />);
		expect(screen.getByText("Read the schedule — 3 visits")).toBeInTheDocument();
	});

	it("falls back to a readable form of the tool name while running", () => {
		render(<ToolCallCard call={call({ state: "running", summary: undefined, durationMs: undefined })} />);
		expect(screen.getByText("Get schedule")).toBeInTheDocument();
	});

	it("shows the arguments only after the card is expanded", async () => {
		render(<ToolCallCard call={call()} />);
		expect(screen.queryByText(/start_date/)).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button"));

		expect(screen.getByText(/start_date/)).toBeInTheDocument();
		expect(screen.getByText("get_schedule")).toBeInTheDocument();
	});

	it("states the reason for a failure without being expanded", async () => {
		// Regression: a real failure reached a user as "propose_draft failed" with
		// the cause one click away, so nobody saw that the model had sent {}.
		render(
			<ToolCallCard
				call={call({
					state: "error",
					summary: "Propose draft failed",
					errorMessage: "Input did not validate",
				})}
			/>,
		);
		expect(screen.getByText("Input did not validate")).toBeInTheDocument();
	});

	it("shows what the model sent when expanded", async () => {
		render(<ToolCallCard call={call({ state: "error", errorMessage: "gone" })} />);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText("Sent")).toBeInTheDocument();
		expect(screen.getByText(/start_date/)).toBeInTheDocument();
	});

	it("does not repeat the error twice when expanded", async () => {
		render(<ToolCallCard call={call({ state: "error", errorMessage: "gone" })} />);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getAllByText("gone")).toHaveLength(1);
	});

	it.each([
		[42, "42ms"],
		[1500, "1.5s"],
	])("formats a %ims duration as %s", (ms, expected) => {
		render(<ToolCallCard call={call({ durationMs: ms })} />);
		expect(screen.getByText(expected)).toBeInTheDocument();
	});
});
