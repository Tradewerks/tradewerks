import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DispatcherActionsMenu from "../DispatcherActionsMenu";
import type { Dispatcher } from "../../../types/dispatchers";

const perms = vi.hoisted(() => ({ current: {} as Record<string, boolean> }));

vi.mock("../../../hooks/usePermission", () => ({
	usePermission: (p: string) => perms.current[p] ?? true,
}));
vi.mock("../../../hooks/useDispatchers", () => ({
	useDeleteDispatcherMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeactivateDispatcherMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useReactivateDispatcherMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useMfa", () => ({
	useResetMfaMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../ui/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const D = {
	id: "d1",
	name: "Sam Lee",
	role: "dispatcher",
	email: "sam@example.com",
	mfaEnabled: true,
	deactivated_at: null,
} as unknown as Dispatcher;

function open(dispatcher: Dispatcher) {
	render(
		<MemoryRouter>
			<DispatcherActionsMenu
				dispatcher={dispatcher}
				displayName="Sam Lee"
				onEdit={vi.fn()}
				onAssignRole={vi.fn()}
			/>
		</MemoryRouter>
	);
	fireEvent.click(screen.getByRole("button", { name: "More actions for Sam Lee" }));
}

describe("DispatcherActionsMenu", () => {
	beforeEach(() => {
		perms.current = {};
	});

	it("shows the full set for a manager", () => {
		open(D);
		for (const label of [
			"Open Profile",
			"Edit Details",
			"Assign Role",
			"Send Password Reset",
			"Reset MFA",
			"Deactivate",
			"Delete Dispatcher",
		]) {
			expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
		}
	});

	it("hides Assign Role and Delete for system admins", () => {
		open({ ...D, role: "admin" } as Dispatcher);
		expect(screen.queryByRole("button", { name: /Assign Role/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Delete Dispatcher/ })).toBeNull();
	});

	it("shows only Open Profile without manage permission", () => {
		perms.current = { manage_dispatchers: false };
		open(D);
		expect(screen.getByRole("button", { name: "Open Profile" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Edit Details|Deactivate|Send Password Reset/ })
		).toBeNull();
	});

	it("renders nothing without view or manage permission", () => {
		perms.current = { manage_dispatchers: false, view_dispatchers: false };
		render(
			<MemoryRouter>
				<DispatcherActionsMenu dispatcher={D} displayName="Sam Lee" />
			</MemoryRouter>
		);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("does not bubble clicks to the row", () => {
		const onRow = vi.fn();
		render(
			<MemoryRouter>
				<div onClick={onRow}>
					<DispatcherActionsMenu dispatcher={D} displayName="Sam Lee" />
				</div>
			</MemoryRouter>
		);
		fireEvent.click(screen.getByRole("button", { name: "More actions for Sam Lee" }));
		expect(onRow).not.toHaveBeenCalled();
	});

	it("Escape closes and returns focus to the trigger", () => {
		open(D);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("button", { name: "Open Profile" })).toBeNull();
		expect(screen.getByRole("button", { name: "More actions for Sam Lee" })).toHaveFocus();
	});
});
