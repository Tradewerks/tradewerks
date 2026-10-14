import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../../test/testUtils";
import type { UiMessage } from "../../../types/assistant";
import MessageBubble from "../MessageBubble";

const assistant = (content: string): UiMessage => ({
	id: "m1",
	role: "assistant",
	content,
	toolCalls: [],
	streaming: false,
});

describe("MessageBubble", () => {
	it("renders assistant emphasis as markup rather than asterisks", () => {
		render(<MessageBubble message={assistant("Visit **JOB-1042** is unassigned.")} />);

		expect(screen.getByText("JOB-1042").tagName).toBe("STRONG");
		expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
	});

	it("renders a GFM table as a table", () => {
		const table = ["| Job | Tech |", "| --- | --- |", "| 1042 | Dana |"].join("\n");
		render(<MessageBubble message={assistant(table)} />);

		expect(screen.getByRole("table")).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Job" })).toBeInTheDocument();
		expect(screen.getByRole("cell", { name: "Dana" })).toBeInTheDocument();
	});

	it("renders a list as list items", () => {
		render(<MessageBubble message={assistant("- First\n- Second")} />);
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	// Markdown folds soft breaks into a space; the panel used to preserve them
	// with whitespace-pre-wrap, so remark-breaks keeps that behaviour.
	it("keeps single line breaks in prose", () => {
		const { container } = render(
			<MessageBubble message={assistant("Visit one\nVisit two")} />
		);
		expect(container.querySelector("br")).toBeInTheDocument();
	});

	// Tool results carry client-written text; none of it should become markup.
	it("does not render raw HTML from the model", () => {
		const { container } = render(
			<MessageBubble message={assistant("<img src=x onerror=alert(1)>")} />
		);
		expect(container.querySelector("img")).not.toBeInTheDocument();
	});

	it("leaves an underscored identifier alone", () => {
		render(<MessageBubble message={assistant("Serial AC_1200_X shipped.")} />);
		expect(screen.getByText(/AC_1200_X/)).toBeInTheDocument();
	});

	it("shows what the user typed verbatim, without markdown", () => {
		render(
			<MessageBubble
				message={{ id: "m2", role: "user", content: "**not bold**" }}
			/>
		);
		expect(screen.getByText("**not bold**")).toBeInTheDocument();
	});
});
