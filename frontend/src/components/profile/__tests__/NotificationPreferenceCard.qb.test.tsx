import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../../auth/authStore", () => ({
	useAuthStore: () => ({
		user: { userId: "u1", permissions: ["manage_taxes", "edit_invoices", "manage_organization"] },
	}),
}));
vi.mock("../../../hooks/useDispatchers", () => ({
	useDispatcherByIdQuery: () => ({ data: { muted_notification_types: [] } }),
	useUpdateDispatcherMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

import NotificationPreferenceCard from "../NotificationPreferenceCard";

describe("NotificationPreferenceCard QuickBooks types", () => {
	it("offers a toggle for each QuickBooks notification type", () => {
		render(<NotificationPreferenceCard />);
		for (const label of ["QuickBooks tax codes", "QuickBooks sync problems", "QuickBooks disconnected"]) {
			expect(screen.getByRole("switch", { name: label })).toBeInTheDocument();
		}
		expect(screen.getByText(/QuickBooks no longer matches/)).toBeInTheDocument();
	});
});
