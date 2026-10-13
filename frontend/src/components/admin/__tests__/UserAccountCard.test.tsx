import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import UserAccountCard, { UserListHeader } from "../UserAccountCard";

const BASE = {
	kind: "dispatcher" as const,
	name: "sam lee",
	title: "Office Manager",
	roleName: "Billing",
	phone: "6085550101",
	email: "sam@example.com",
	mfaEnabled: true,
	lastLogin: null,
	inactive: false,
};

describe("UserAccountCard", () => {
	it.each(["list", "card"] as const)("%s view shows name, type and role", (viewMode) => {
		render(<UserAccountCard {...BASE} viewMode={viewMode} />);
		expect(screen.getByText("Sam Lee")).toBeInTheDocument();
		expect(screen.getAllByText("Dispatcher").length).toBeGreaterThan(0);
		expect(screen.getByText(/Billing/)).toBeInTheDocument();
	});

	it("list view falls back to dashes for missing role and contact", () => {
		render(
			<UserAccountCard
				{...BASE}
				viewMode="list"
				roleName={null}
				phone={null}
				email=""
				mfaEnabled={false}
			/>
		);
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("card view says when there are no contact details", () => {
		render(<UserAccountCard {...BASE} viewMode="card" phone={null} email="" />);
		expect(screen.getByText("No contact details")).toBeInTheDocument();
	});

	it("opens on Enter and click when onOpen is given", () => {
		const onOpen = vi.fn();
		render(<UserAccountCard {...BASE} viewMode="list" onOpen={onOpen} />);
		const row = screen.getByRole("button", { name: "Open Sam Lee" });
		fireEvent.keyDown(row, { key: "Enter" });
		fireEvent.click(row);
		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("contact links do not open the row", () => {
		const onOpen = vi.fn();
		render(<UserAccountCard {...BASE} viewMode="card" onOpen={onOpen} />);
		fireEvent.click(screen.getByText("sam@example.com"));
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("is not interactive without onOpen", () => {
		render(<UserAccountCard {...BASE} viewMode="card" />);
		expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
	});

	it("shows the Inactive badge", () => {
		render(<UserAccountCard {...BASE} viewMode="list" inactive />);
		expect(screen.getByText("Inactive")).toBeInTheDocument();
	});
});

describe("UserListHeader", () => {
	it("labels the columns", () => {
		render(<UserListHeader />);
		for (const label of ["User", "Type", "Role", "MFA", "Contact", "Last login"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
	});
});
