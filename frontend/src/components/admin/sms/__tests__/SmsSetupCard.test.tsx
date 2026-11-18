import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SmsSetupCard from "../SmsSetupCard";
import type { SmsAccount } from "../../../../api/smsAccount";
import { fieldErrors } from "../registrationSchema";

const state = vi.hoisted(() => ({ acct: null as SmsAccount | null }));

vi.mock("../../../../hooks/useSmsAccount", () => ({
	useSmsAccount: () => ({ data: state.acct, isLoading: false, error: null }),
	useSaveSmsRegistration: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
	useSubmitSmsRegistration: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

const account = (over: Partial<SmsAccount>): SmsAccount => ({
	status: "draft",
	phone_number: null,
	failure_reason: null,
	registration: null,
	submitted_at: null,
	usage: { used: 0, limit: 500 },
	...over,
});

const renderCard = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<SmsSetupCard />
		</QueryClientProvider>
	);

const steps = () =>
	within(screen.getByRole("list", { name: "Registration progress" })).getAllByRole(
		"listitem"
	);

beforeEach(() => {
	state.acct = null;
});

describe("SmsSetupCard", () => {
	test('SmsSetupCard shows the status as a 4-step track (Details, Business check, Campaign check, Active), the failure reason when failed, and "This usually takes about two weeks" while pending', () => {
		state.acct = account({
			status: "brand_pending",
			submitted_at: "2026-11-16T12:00:00Z",
		});
		const { unmount } = renderCard();
		// The step number is decorative (aria-hidden); read what a screen reader gets.
		expect(
			steps().map(
				(li) => li.querySelector("span:not([aria-hidden])")?.textContent
			)
		).toEqual([
			"Details (done)",
			"Business check (in progress)",
			"Campaign check",
			"Active",
		]);
		expect(steps().map((li) => li.dataset.state)).toEqual([
			"done",
			"current",
			"todo",
			"todo",
		]);
		expect(screen.getByText(/This usually takes about two weeks/)).toBeInTheDocument();
		unmount();

		state.acct = account({ status: "campaign_pending" });
		const second = renderCard();
		expect(steps().map((li) => li.dataset.state)).toEqual([
			"done",
			"done",
			"current",
			"todo",
		]);
		expect(screen.getByText(/This usually takes about two weeks/)).toBeInTheDocument();
		second.unmount();

		state.acct = account({
			status: "failed",
			failure_reason: "Legal name does not match the EIN",
		});
		const third = renderCard();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Legal name does not match the EIN"
		);
		expect(steps()[0].dataset.state).toBe("error");
		expect(screen.queryByText(/about two weeks/)).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Edit and resubmit" })
		).toBeInTheDocument();
		third.unmount();

		state.acct = account({
			status: "active",
			phone_number: "+15125550199",
			usage: { used: 42, limit: 500 },
		});
		renderCard();
		expect(steps().map((li) => li.dataset.state)).toEqual([
			"done",
			"done",
			"done",
			"done",
		]);
		expect(screen.getByText("+15125550199")).toBeInTheDocument();
		expect(screen.getByText("42 of 500 text segments")).toBeInTheDocument();
	});

	test("Set up opens the registration form, which blocks submit until the fields are valid", () => {
		state.acct = account({ status: "draft" });
		renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Set up" }));
		fireEvent.click(screen.getByRole("button", { name: "Submit registration" }));
		expect(
			screen.getByText("Fix the highlighted fields to submit.")
		).toBeInTheDocument();
		expect(screen.getByLabelText("Legal business name")).toHaveAttribute(
			"aria-invalid",
			"true"
		);
	});

	test("the form needs an EIN or a sole-proprietor mobile, like the server", () => {
		const base = {
			legal_name: "Cool Air LLC",
			dba: "",
			ein: "",
			entity_type: "Corporation" as const,
			vertical: "CONSTRUCTION",
			address: {
				street: "1 Main St",
				street_secondary: "",
				city: "Austin",
				region: "TX",
				postal_code: "78701",
				iso_country: "US" as const,
			},
			website: "https://coolair.example",
			support_email: "help@coolair.example",
			support_phone: "(512) 555-0100",
			rep_name: "Dana Reyes",
			rep_title: "Owner",
			rep_email: "dana@coolair.example",
			rep_phone: "512-555-0101",
			sole_prop_mobile: "",
			privacy_url: "https://coolair.example/privacy",
			terms_url: "https://coolair.example/terms",
			area_code: "512",
		};
		expect(Object.keys(fieldErrors(base))).toEqual(["ein"]);
		expect(fieldErrors({ ...base, ein: "12-3456789" })).toEqual({});
		expect(fieldErrors({ ...base, sole_prop_mobile: "512 555 0102" })).toEqual({});
		expect(
			fieldErrors({ ...base, ein: "12-3456789", area_code: "112" })
		).toHaveProperty("area_code");
	});
});
