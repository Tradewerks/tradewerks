import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CustomerMessagesSection from "../CustomerMessagesSection";

const state = vi.hoisted(() => ({
	smsAvailable: false,
	reminderEmailOn: false,
	sequences: [] as Array<{ is_active: boolean; trigger_type: string }>,
	followupsOn: true,
	smsOn: true,
	template: "ok" as "ok" | "loading" | "error",
	reviewUrl: null as string | null,
	reviewEmailOn: false,
	templateHtml: "<p>Hello {{client_name}}</p>",
	save: vi.fn(),
}));

const event = (key: string, label: string) => ({
	event: key,
	label,
	description: `${label} description`,
	email_enabled:
		key === "visit_reminder"
			? state.reminderEmailOn
			: key === "review_request"
				? state.reviewEmailOn
				: false,
	sms_enabled: false,
	config:
		key === "visit_reminder"
			? { lead_hours: [24] }
			: key === "tech_running_late"
				? { threshold_minutes: 20 }
				: {},
	sms_available: state.smsAvailable,
	...(key === "review_request" ? { review_url: state.reviewUrl } : {}),
});

vi.mock("../../../hooks/useCustomerComms", () => ({
	useCustomerCommsSettings: () => ({
		isLoading: false,
		error: null,
		data: [
			event("visit_confirmed", "Visit confirmed"),
			event("visit_reminder", "Visit reminder"),
			event("tech_running_late", "Technician running late"),
			event("review_request", "Review request"),
		],
	}),
	useUpdateCustomerCommsSetting: () => ({ mutateAsync: state.save, isPending: false }),
	useCustomerTemplate: () => ({
		error: state.template === "error" ? new Error("Boom") : null,
		data:
			state.template !== "ok"
				? undefined
				: {
						category: "visit_confirmed",
						name: "Visit confirmed",
						subject: "Your appointment is confirmed",
						html: state.templateHtml,
						text: "Hello plain",
						sms_body: "{{brand.name}}: see you soon",
						is_customized: false,
						updated_at: null,
					},
	}),
	useCustomerTemplateContext: () => ({ data: undefined }),
	useUpdateCustomerTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useResetCustomerTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useFollowups", () => ({
	useSequencesQuery: () => ({ data: state.sequences }),
}));
vi.mock("../../../hooks/useEntitlements", () => ({
	useModuleOn: (key: string) => (key === "sms" ? state.smsOn : state.followupsOn),
}));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../sms/SmsSetupCard", () => ({ default: () => <div>Text messaging card</div> }));

const renderSection = () =>
	render(
		<MemoryRouter>
			<CustomerMessagesSection />
		</MemoryRouter>
	);

beforeEach(() => {
	state.smsAvailable = false;
	state.reminderEmailOn = false;
	state.sequences = [];
	state.followupsOn = true;
	state.smsOn = true;
	state.template = "ok";
	state.reviewUrl = null;
	state.reviewEmailOn = false;
	state.templateHtml = "<p>Hello {{client_name}}</p>";
	state.save.mockReset().mockResolvedValue({});
});

describe("CustomerMessagesSection", () => {
	test('each event row has an Email switch and a Text switch; the Text switch is disabled with "Set up text messaging first" until sms_available', () => {
		const { rerender } = renderSection();
		const email = screen.getByRole("switch", { name: "Email — Visit confirmed" });
		const text = screen.getByRole("switch", { name: "Text — Visit confirmed" });
		expect(email).toBeEnabled();
		expect(text).toBeDisabled();
		expect(text).toHaveAccessibleDescription("Set up text messaging first");

		state.smsAvailable = true;
		rerender(
			<MemoryRouter>
				<CustomerMessagesSection />
			</MemoryRouter>
		);
		expect(
			screen.getByRole("switch", { name: "Text — Visit confirmed" })
		).toBeEnabled();
		expect(screen.queryByText("Set up text messaging first")).toBeNull();
	});

	test("no page header repeats the tab name; events sit under stage headings", () => {
		renderSection();
		expect(screen.queryByRole("heading", { name: "Customer messages" })).toBeNull();
		expect(screen.queryByText(/choose which visit updates/i)).toBeNull();
		const scheduling = screen.getByRole("region", { name: "Scheduling" });
		expect(within(scheduling).getByText("Visit reminder")).toBeInTheDocument();
		const after = screen.getByRole("region", { name: "After the visit" });
		expect(within(after).getByText("Review request")).toBeInTheDocument();
	});

	test("the text-messaging hint shows once, not on every row", () => {
		renderSection();
		expect(screen.getAllByText("Set up text messaging first")).toHaveLength(1);
		expect(screen.getByRole("link", { name: /set up texting/i })).toBeInTheDocument();
	});

	test("turning on Email saves that event", async () => {
		renderSection();
		fireEvent.click(screen.getByRole("switch", { name: "Email — Visit confirmed" }));
		await waitFor(() =>
			expect(state.save).toHaveBeenCalledWith({
				event: "visit_confirmed",
				data: { email_enabled: true },
			})
		);
	});

	test('"Edit message" opens TemplateEditorModal with the subject, email body and text-message body for that event', () => {
		renderSection();
		const row = screen.getByText("Visit confirmed").closest("li")!;
		fireEvent.click(within(row).getByRole("button", { name: /edit message/i }));
		expect(
			screen.getByDisplayValue("Your appointment is confirmed")
		).toBeInTheDocument();
		expect(screen.getByDisplayValue("Hello plain")).toBeInTheDocument();
		expect(screen.getByLabelText("Text message")).toHaveValue(
			"{{brand.name}}: see you soon"
		);
		expect(screen.getByTestId("sms-segment-count")).toHaveTextContent(/1 segment/);
	});

	test("a banner links to Followups when the org has an active visit_scheduled sequence and visit_reminder email is on", () => {
		state.reminderEmailOn = true;
		state.sequences = [{ is_active: true, trigger_type: "visit_scheduled" }];
		renderSection();
		expect(screen.getByRole("link", { name: /review followups/i })).toHaveAttribute(
			"href",
			"/dispatch/followups"
		);
	});

	test("no banner when reminder email is off or the sequence is inactive", () => {
		state.sequences = [{ is_active: true, trigger_type: "visit_scheduled" }];
		const { unmount } = renderSection();
		expect(screen.queryByRole("link", { name: /review followups/i })).toBeNull();
		unmount();
		state.reminderEmailOn = true;
		state.sequences = [{ is_active: false, trigger_type: "visit_scheduled" }];
		renderSection();
		expect(screen.queryByRole("link", { name: /review followups/i })).toBeNull();
	});

	test("the editor shows a loading state, then an error with Close, instead of nothing", () => {
		state.template = "loading";
		renderSection();
		const row = screen.getByText("Visit confirmed").closest("li")!;
		fireEvent.click(within(row).getByRole("button", { name: /edit message/i }));
		expect(screen.getByText("Loading message")).toBeInTheDocument();
	});

	test("an editor load failure is shown", () => {
		state.template = "error";
		renderSection();
		const row = screen.getByText("Visit confirmed").closest("li")!;
		fireEvent.click(within(row).getByRole("button", { name: /edit message/i }));
		expect(screen.getByText("Boom")).toBeInTheDocument();
	});

	test("saving reminder times sorts and dedupes them", async () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: /add reminder/i }));
		fireEvent.change(screen.getByLabelText("Reminder 2 hours before"), {
			target: { value: "48" },
		});
		fireEvent.click(screen.getByRole("button", { name: /add reminder/i }));
		fireEvent.change(screen.getByLabelText("Reminder 3 hours before"), {
			target: { value: "24" },
		});
		fireEvent.click(screen.getByRole("button", { name: /save reminders/i }));
		await waitFor(() =>
			expect(state.save).toHaveBeenCalledWith({
				event: "visit_reminder",
				data: { config: { lead_hours: [24, 48] } },
			})
		);
	});
	test("saving the running-late threshold sends minutes and rejects values outside 10-120", async () => {
		renderSection();
		const input = screen.getByLabelText("Minutes late before notifying the customer");
		expect(input).toHaveValue(20);
		fireEvent.change(input, { target: { value: "5" } });
		expect(screen.getByRole("button", { name: /save threshold/i })).toBeDisabled();
		fireEvent.change(input, { target: { value: "45" } });
		fireEvent.click(screen.getByRole("button", { name: /save threshold/i }));
		await waitFor(() =>
			expect(state.save).toHaveBeenCalledWith({
				event: "tech_running_late",
				data: { config: { threshold_minutes: 45 } },
			})
		);
	});
	test("the Text messaging setup card shows only while the sms module is on", () => {
		const { unmount } = renderSection();
		expect(screen.getByText("Text messaging card")).toBeInTheDocument();
		unmount();
		state.smsOn = false;
		renderSection();
		expect(screen.queryByText("Text messaging card")).not.toBeInTheDocument();
	});

	describe("review request", () => {
		const REVIEW = "https://g.page/r/acme/review";

		test("the review request switches stay off until a review link is saved", () => {
			renderSection();
			const email = screen.getByRole("switch", {
				name: "Email — Review request",
			});
			expect(email).toBeDisabled();
			expect(email).toHaveAccessibleDescription("Add your review link first");
			expect(
				screen.getByRole("switch", { name: "Email — Visit confirmed" })
			).toBeEnabled();
		});

		test("saving a review link sends it with the review request", async () => {
			renderSection();
			fireEvent.change(screen.getByLabelText("Review link"), {
				target: { value: ` ${REVIEW} ` },
			});
			fireEvent.click(screen.getByRole("button", { name: /save link/i }));
			await waitFor(() =>
				expect(state.save).toHaveBeenCalledWith({
					event: "review_request",
					data: { review_url: REVIEW },
				})
			);
		});

		test("a review link that is not https cannot be saved", () => {
			renderSection();
			fireEvent.change(screen.getByLabelText("Review link"), {
				target: { value: "http://g.page/r/acme" },
			});
			expect(screen.getByRole("button", { name: /save link/i })).toBeDisabled();
			expect(screen.getByText(/must start with https:\/\//i)).toBeInTheDocument();
		});

		test("with a saved link the switches turn on and the link is shown", async () => {
			state.reviewUrl = REVIEW;
			renderSection();
			expect(screen.getByLabelText("Review link")).toHaveValue(REVIEW);
			expect(screen.queryByRole("button", { name: /save link/i })).toBeNull();
			fireEvent.click(
				screen.getByRole("switch", { name: "Email — Review request" })
			);
			await waitFor(() =>
				expect(state.save).toHaveBeenCalledWith({
					event: "review_request",
					data: { email_enabled: true },
				})
			);
		});

		test("a review request left on after its link was removed elsewhere says to add one", () => {
			state.reviewEmailOn = true;
			renderSection();
			expect(screen.getByText("Add your review link first")).toBeInTheDocument();
			expect(
				screen.getByRole("switch", { name: "Email — Review request" })
			).toBeEnabled();
		});

		test("the message editor names {{brand.review_url}} as Review link", () => {
			state.templateHtml = "<p>Review us: {{brand.review_url}}</p>";
			renderSection();
			const row = screen.getByText("Review request").closest("li")!;
			fireEvent.click(within(row).getByRole("button", { name: /edit message/i }));
			expect(screen.getByTitle("brand.review_url")).toHaveTextContent(
				"Review link"
			);
		});
	});
});
