import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../../api/publicLinks", () => ({ setPublicConsent: vi.fn() }));
import * as linksApi from "../../../api/publicLinks";
import UnsubscribeView from "../UnsubscribeView";

const setConsent = linksApi.setPublicConsent as unknown as ReturnType<typeof vi.fn>;

const data = {
	purpose: "unsubscribe" as const,
	org: { name: "Acme HVAC", logo_url: null, color: "#123456", phone: null, email: null },
	contact_email_masked: "j***@example.com",
	email: "subscribed" as const,
	sms: "unsubscribed" as const,
};

beforeEach(() => vi.clearAllMocks());

describe("UnsubscribeView", () => {
	it("UnsubscribeView shows the preferences heading, unsubscribes on click, and offers resubscribe", async () => {
		const user = userEvent.setup();
		setConsent
			.mockResolvedValueOnce({ email: "unsubscribed", sms: "unsubscribed" })
			.mockResolvedValueOnce({ email: "subscribed", sms: "unsubscribed" });
		render(<UnsubscribeView token="tok" data={data} />);

		expect(
			screen.getByRole("heading", { name: "Email preferences" })
		).toBeInTheDocument();
		expect(screen.getByText("j***@example.com")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Unsubscribe" }));
		expect(setConsent).toHaveBeenCalledWith("tok", "email", "unsubscribed");
		expect(await screen.findByRole("status")).toHaveTextContent("You are unsubscribed");

		await user.click(screen.getByRole("button", { name: "Resubscribe" }));
		expect(setConsent).toHaveBeenLastCalledWith("tok", "email", "subscribed");
		expect(
			await screen.findByRole("button", { name: "Unsubscribe" })
		).toBeInTheDocument();
	});

	it("shows an error and keeps the choice when saving fails", async () => {
		const user = userEvent.setup();
		setConsent.mockRejectedValueOnce(new Error("boom"));
		render(<UnsubscribeView token="tok" data={data} />);
		await user.click(screen.getByRole("button", { name: "Unsubscribe" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
		expect(screen.getByRole("button", { name: "Unsubscribe" })).toBeInTheDocument();
	});
});
