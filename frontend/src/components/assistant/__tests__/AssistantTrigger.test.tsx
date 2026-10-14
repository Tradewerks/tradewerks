import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../../test/testUtils";

const { useAssistantStatus } = vi.hoisted(() => ({ useAssistantStatus: vi.fn() }));
vi.mock("../../../hooks/useAssistant", () => ({ useAssistantStatus }));

import AssistantTrigger from "../AssistantTrigger";

describe("AssistantTrigger", () => {
	it("renders when the assistant is available", () => {
		useAssistantStatus.mockReturnValue({ data: { enabled: true } });
		render(<AssistantTrigger onClick={() => {}} />);
		expect(screen.getByRole("button", { name: /open the assistant/i })).toBeInTheDocument();
	});

	it.each([
		["the server has no key configured", { enabled: false, reason: "not configured" }],
		["the status has not loaded yet", undefined],
	])("renders nothing when %s", (_case, data) => {
		// A button that can only apologise is worse than no button.
		useAssistantStatus.mockReturnValue({ data });
		const { container } = render(<AssistantTrigger onClick={() => {}} />);
		expect(container).toBeEmptyDOMElement();
	});
});
