import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	exchange: vi.fn(async (_t: string) => ({ pendingToken: "pending-1" })),
	login: vi.fn(async (_e: string, _p: string) => ({ stage: "enroll_email" as const })),
}));
vi.mock("../api", async (orig) => ({
	...(await orig<typeof import("../api")>()),
	platform: {
		setupAvailable: () => Promise.resolve({ available: false }),
		login: h.login,
		exchangeEnrollLink: h.exchange,
	},
}));
vi.mock("../components/MfaStep", () => ({
	default: ({ stage, pendingToken }: { stage: string; pendingToken: string }) => (
		<p>
			mfa-step {stage} {pendingToken}
		</p>
	),
}));

import EnrollPage from "../pages/EnrollPage";
import LoginPage from "../pages/LoginPage";

beforeEach(() => vi.clearAllMocks());

const at = (url: string, page: React.ReactElement) =>
	render(<MemoryRouter initialEntries={[url]}>{page}</MemoryRouter>);

describe("EnrollPage", () => {
	it("spends the link only on Continue, then starts setup", async () => {
		at("/platform/enroll?token=abc", <EnrollPage />);
		expect(h.exchange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByText("mfa-step enroll pending-1")).toBeInTheDocument();
		expect(h.exchange).toHaveBeenCalledTimes(1);
		expect(h.exchange).toHaveBeenCalledWith("abc");
	});

	it("shows the invalid-link message without a token", () => {
		at("/platform/enroll", <EnrollPage />);
		expect(screen.getByText(/setup link is invalid or has expired/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
	});
});

describe("LoginPage without MFA set up", () => {
	it("tells the member to check their email instead of opening setup", async () => {
		at("/platform/login", <LoginPage />);
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "x@t.test" } });
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "right-password-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
		expect(await screen.findByText("Check your email")).toBeInTheDocument();
		expect(screen.queryByText(/mfa-step/)).toBeNull();
	});
});
