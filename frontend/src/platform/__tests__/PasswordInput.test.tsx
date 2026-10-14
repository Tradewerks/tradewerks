import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PasswordInput } from "../components/AuthCard";

describe("PasswordInput", () => {
	it("hides the password until the eye button is pressed", () => {
		render(
			<>
				<label htmlFor="pw">Password</label>
				<PasswordInput id="pw" value="hunter22" onChange={() => {}} />
			</>
		);
		const input = screen.getByLabelText("Password");
		expect(input).toHaveAttribute("type", "password");
		fireEvent.click(screen.getByRole("button", { name: "Show password" }));
		expect(input).toHaveAttribute("type", "text");
		fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
		expect(input).toHaveAttribute("type", "password");
	});
});
