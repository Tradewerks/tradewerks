import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientContactLink } from "../../../types/clients";

const { links, updateRelationship, setConsent, consentState, visitsState } = vi.hoisted(() => ({
	links: { current: [] as unknown[] },
	updateRelationship: vi.fn(),
	setConsent: vi.fn(),
	consentState: { current: {} as Record<string, unknown> },
	visitsState: { current: {} as Record<string, unknown> },
}));
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock("../../../hooks/useClients", () => ({
	useClientContactsQuery: () => ({ data: links.current, isLoading: false }),
	useSearchContactsQuery: () => ({ data: [], isLoading: false }),
	useCreateContactMutation: () => idle,
	useUpdateContactMutation: () => idle,
	useUnlinkContactFromClientMutation: () => idle,
	useLinkContactMutation: () => idle,
	useUpdateClientContactMutation: () => ({
		...idle,
		mutate: updateRelationship,
		...visitsState.current,
	}),
	useSetContactConsentMutation: () => ({
		...idle,
		mutate: setConsent,
		...consentState.current,
	}),
}));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => true }));

import ContactManager from "../ContactManager";

const link = (
	over: Partial<ClientContactLink["contact"]["consent"]> = {},
	notify = false
): ClientContactLink =>
	({
		client_id: "c1",
		contact_id: "ct1",
		relationship: "owner",
		is_primary: true,
		is_billing: false,
		notify_visits: notify,
		contact: {
			id: "ct1",
			name: "Pat Smith",
			email: "pat@x.com",
			phone: "555-0100",
			type: null,
			is_active: true,
			created_at: "2026-01-01",
			updated_at: "2026-01-01",
			client_contacts: [],
			consent: {
				email: "subscribed",
				sms: "unsubscribed",
				sms_changed_at: null,
				email_source: null,
				email_resubscribable: false,
				sms_source: null,
				...over,
			},
		},
	}) as ClientContactLink;

beforeEach(() => {
	vi.clearAllMocks();
	consentState.current = {};
	visitsState.current = {};
});

describe("ContactManager consent", () => {
	it('ContactManager shows "Unsubscribed (bounce)" read-only, an "Agreed to texts" switch with its date, and a "Gets visit updates" switch per client', () => {
		links.current = [
			link(
				{
					email: "unsubscribed",
					email_source: "bounce",
					sms: "subscribed",
					sms_changed_at: "2026-11-03T15:00:00.000Z",
				},
				true
			),
		];
		render(<ContactManager clientId="c1" />);

		const status = screen.getByText("Unsubscribed (bounce)");
		expect(status.closest("button")).toBeNull();

		const texts = screen.getByRole("switch", { name: "Agreed to texts" });
		expect(texts).toHaveAttribute("aria-checked", "true");
		expect(screen.getByText(/Nov 3, 2026/)).toBeInTheDocument();

		const visits = screen.getByRole("switch", { name: "Gets visit updates" });
		expect(visits).toHaveAttribute("aria-checked", "true");
	});

	it("toggling the switches saves consent for the contact and notify_visits for the link", () => {
		links.current = [link()];
		render(<ContactManager clientId="c1" />);

		fireEvent.click(screen.getByRole("switch", { name: "Agreed to texts" }));
		expect(setConsent).toHaveBeenCalledWith({
			clientId: "c1",
			contactId: "ct1",
			data: { channel: "sms", status: "subscribed" },
		});

		fireEvent.click(screen.getByRole("switch", { name: "Gets visit updates" }));
		expect(updateRelationship).toHaveBeenCalledWith({
			clientId: "c1",
			contactId: "ct1",
			data: { notify_visits: true },
		});
		expect(screen.queryByText(/Unsubscribed/)).toBeNull();
	});

	it("disables both switches while either save for that contact is pending", () => {
		links.current = [link()];
		consentState.current = {
			isPending: true,
			variables: {
				clientId: "c1",
				contactId: "ct1",
				data: { channel: "sms", status: "subscribed" },
			},
		};
		render(<ContactManager clientId="c1" />);
		expect(screen.getByRole("switch", { name: "Agreed to texts" })).toBeDisabled();
		expect(screen.getByRole("switch", { name: "Gets visit updates" })).toBeDisabled();
	});

	it("shows a failed consent or visit-updates save inline under the switches", () => {
		links.current = [link()];
		consentState.current = {
			isError: true,
			error: new Error("Contact not found"),
			variables: {
				clientId: "c1",
				contactId: "ct1",
				data: { channel: "sms", status: "subscribed" },
			},
		};
		const { unmount } = render(<ContactManager clientId="c1" />);
		expect(screen.getByText("Contact not found")).toBeInTheDocument();
		unmount();

		consentState.current = {};
		visitsState.current = {
			isError: true,
			error: new Error("Network down"),
			variables: {
				clientId: "c1",
				contactId: "ct1",
				data: { notify_visits: true },
			},
		};
		render(<ContactManager clientId="c1" />);
		expect(screen.getByText("Network down")).toBeInTheDocument();
	});

	it("offers Re-subscribe only when the suppressed address has changed", () => {
		links.current = [
			link({
				email: "unsubscribed",
				email_source: "bounce",
				email_resubscribable: true,
			}),
		];
		const { unmount } = render(<ContactManager clientId="c1" />);
		fireEvent.click(screen.getByRole("button", { name: "Re-subscribe" }));
		expect(setConsent).toHaveBeenCalledWith({
			clientId: "c1",
			contactId: "ct1",
			data: { channel: "email", status: "subscribed" },
		});
		unmount();

		links.current = [
			link({
				email: "unsubscribed",
				email_source: "unsubscribe_link",
				email_resubscribable: false,
			}),
		];
		render(<ContactManager clientId="c1" />);
		expect(screen.queryByRole("button", { name: "Re-subscribe" })).toBeNull();
	});

	it("shows a customer SMS opt-out read-only with the switch disabled", () => {
		links.current = [link({ sms_source: "sms_keyword" })];
		render(<ContactManager clientId="c1" />);
		expect(screen.getByText("Replied STOP")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Agreed to texts" })).toBeDisabled();
	});
});
