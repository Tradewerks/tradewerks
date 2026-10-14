import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "../../../test/testUtils";
import Composer from "../Composer";

const setup = (over: Partial<Parameters<typeof Composer>[0]> = {}) => {
	const onSend = vi.fn();
	const onStop = vi.fn();
	render(<Composer onSend={onSend} onStop={onStop} streaming={false} {...over} />);
	return { onSend, onStop, input: screen.getByLabelText(/message the assistant/i) };
};

describe("Composer", () => {
	it("sends on Enter and clears the box", async () => {
		const { onSend, input } = setup();
		await userEvent.type(input, "what's on tuesday?{Enter}");
		expect(onSend).toHaveBeenCalledWith("what's on tuesday?");
		expect(input).toHaveValue("");
	});

	it("inserts a newline on Shift+Enter instead of sending", async () => {
		const { onSend, input } = setup();
		await userEvent.type(input, "line one{Shift>}{Enter}{/Shift}line two");
		expect(onSend).not.toHaveBeenCalled();
		expect(input).toHaveValue("line one\nline two");
	});

	it("ignores whitespace-only input", async () => {
		const { onSend, input } = setup();
		await userEvent.type(input, "   {Enter}");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("trims before sending", async () => {
		const { onSend, input } = setup();
		await userEvent.type(input, "  hello  {Enter}");
		expect(onSend).toHaveBeenCalledWith("hello");
	});

	it("offers stop instead of send while streaming", async () => {
		const { onStop, onSend } = setup({ streaming: true });
		expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /stop generating/i }));
		expect(onStop).toHaveBeenCalledOnce();
		expect(onSend).not.toHaveBeenCalled();
	});

	it("cannot be used when the assistant is unavailable", async () => {
		const { onSend, input } = setup({ disabled: true });
		expect(input).toBeDisabled();
		await userEvent.type(input, "hi{Enter}");
		expect(onSend).not.toHaveBeenCalled();
	});
});
