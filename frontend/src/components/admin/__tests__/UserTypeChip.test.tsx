import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import UserTypeChip from "../UserTypeChip";
import { userKind } from "../userKind";

describe("userKind", () => {
	it("maps technicians, dispatchers and system admins", () => {
		expect(userKind({ userType: "technician" })).toBe("technician");
		expect(userKind({ userType: "dispatcher", role: "dispatcher" })).toBe("dispatcher");
		expect(userKind({ userType: "dispatcher", role: "admin" })).toBe("admin");
	});
});

describe("UserTypeChip", () => {
	it.each([
		["technician", "Technician"],
		["dispatcher", "Dispatcher"],
		["admin", "Admin"],
	] as const)("%s renders its label", (kind, label) => {
		render(<UserTypeChip kind={kind} />);
		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it("uses neutral tokens, never primary", () => {
		render(<UserTypeChip kind="technician" />);
		const chip = screen.getByText("Technician").closest("span")!;
		expect(chip.className).toContain("border-border");
		expect(chip.className).not.toContain("primary");
	});
});
