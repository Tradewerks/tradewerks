import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";

vi.mock("../../../api/publicLinks", () => ({
	getPublicLink: vi.fn(),
	markPublicLinkViewed: vi.fn(async () => {}),
	respondToPublicQuote: vi.fn(),
	getPublicDocumentPdf: vi.fn(),
}));
import * as linksApi from "../../../api/publicLinks";
import type { QuoteLinkData } from "../../../api/publicLinks";
import QuoteView from "../QuoteView";
import PublicLinkPage from "../PublicLinkPage";

const respond = linksApi.respondToPublicQuote as unknown as ReturnType<typeof vi.fn>;
const getLink = linksApi.getPublicLink as unknown as ReturnType<typeof vi.fn>;
const markViewed = linksApi.markPublicLinkViewed as unknown as ReturnType<typeof vi.fn>;

const org = {
	name: "Acme HVAC",
	logo_url: null,
	color: "#0f766e",
	phone: "(555) 010-2000",
	email: null,
};

const quote = (over: Partial<QuoteLinkData> = {}): QuoteLinkData => ({
	purpose: "quote",
	org,
	number: "Q-1001",
	title: "Furnace replacement",
	status: "Sent",
	line_items: [
		{
			name: "Furnace",
			description: "96% AFUE",
			quantity: 1,
			unit_price: 1000,
			total: 1000,
		},
	],
	subtotal: 1000,
	discount_amount: 0,
	tax_amount: 80,
	total: 1080,
	valid_until: null,
	can_respond: true,
	superseded: false,
	approved_at: null,
	approved_by_name: null,
	...over,
});

beforeEach(() => vi.clearAllMocks());

describe("QuoteView", () => {
	it("QuoteView disables Approve until a name of 2+ characters is typed", async () => {
		const user = userEvent.setup();
		render(<QuoteView token="tok" data={quote()} />);
		const approve = screen.getByRole("button", { name: "Approve quote" });
		expect(approve).toBeDisabled();
		const name = screen.getByLabelText("Your full name");
		await user.type(name, "J");
		expect(approve).toBeDisabled();
		await user.type(name, " ");
		expect(approve).toBeDisabled();
		await user.type(name, "o");
		expect(approve).toBeEnabled();
		expect(markViewed).toHaveBeenCalledTimes(1);
		expect(markViewed).toHaveBeenCalledWith("tok");
	});

	it('after approve the page shows "Approved by <name> on <date>" and no buttons', async () => {
		const user = userEvent.setup();
		respond.mockResolvedValueOnce({
			...quote({
				status: "Approved",
				can_respond: false,
				approved_by_name: "Jane Customer",
				approved_at: "2026-11-17T18:00:00.000Z",
			}),
		});
		render(<QuoteView token="tok" data={quote()} />);
		await user.type(screen.getByLabelText("Your full name"), "  Jane Customer ");
		await user.click(screen.getByRole("button", { name: "Approve quote" }));
		expect(respond).toHaveBeenCalledWith("tok", "approve", "Jane Customer", undefined);
		expect(await screen.findByRole("status")).toHaveTextContent(
			"Approved by Jane Customer on Nov 17, 2026"
		);
		expect(screen.queryByRole("button", { name: /approve|decline/i })).toBeNull();
		expect(screen.queryByLabelText("Your full name")).toBeNull();
	});

	it('a superseded quote shows "This quote was replaced. Contact <org> for the current version."', () => {
		render(
			<QuoteView
				token="tok"
				data={quote({
					status: "Revised",
					superseded: true,
					can_respond: false,
				})}
			/>
		);
		expect(
			screen.getByText(
				"This quote was replaced. Contact Acme HVAC for the current version."
			)
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve|decline/i })).toBeNull();
	});

	it("Enter in the name field approves the quote", async () => {
		const user = userEvent.setup();
		respond.mockResolvedValueOnce(
			quote({
				status: "Approved",
				can_respond: false,
				approved_by_name: "Jo Lee",
			})
		);
		render(<QuoteView token="tok" data={quote()} />);
		await user.type(screen.getByLabelText("Your full name"), "J{Enter}");
		expect(respond).not.toHaveBeenCalled();
		await user.type(screen.getByLabelText("Your full name"), "o Lee{Enter}");
		expect(respond).toHaveBeenCalledWith("tok", "approve", "Jo Lee", undefined);
		expect(await screen.findByRole("status")).toHaveTextContent("Approved by Jo Lee");
	});

	it("decline sends the name and reason, shows a pending label, then the declined line", async () => {
		const user = userEvent.setup();
		let resolve!: (v: unknown) => void;
		respond.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		render(<QuoteView token="tok" data={quote()} />);
		await user.type(screen.getByLabelText("Your full name"), "Jane Customer");
		await user.click(screen.getByRole("button", { name: "Decline" }));
		await user.type(screen.getByLabelText("Reason (optional)"), " Too pricey ");
		await user.click(screen.getByRole("button", { name: "Decline quote" }));
		expect(respond).toHaveBeenCalledWith(
			"tok",
			"decline",
			"Jane Customer",
			"Too pricey"
		);
		expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
		resolve(quote({ status: "Rejected", can_respond: false }));
		expect(await screen.findByRole("status")).toHaveTextContent(
			"This quote was declined."
		);
		expect(screen.queryByRole("button", { name: /approve|decline/i })).toBeNull();
	});

	it("a failed answer shows an error and keeps the form and the typed name", async () => {
		const user = userEvent.setup();
		respond.mockRejectedValueOnce(new Error("network"));
		render(<QuoteView token="tok" data={quote()} />);
		await user.type(screen.getByLabelText("Your full name"), "Jane Customer");
		await user.click(screen.getByRole("button", { name: "Approve quote" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not send your answer. Try again."
		);
		expect(screen.getByLabelText("Your full name")).toHaveValue("Jane Customer");
		expect(screen.getByRole("button", { name: "Approve quote" })).toBeEnabled();
	});

	it("a disputed quote asks the customer to contact the org", () => {
		render(
			<QuoteView
				token="tok"
				data={quote({ status: "Disputed", can_respond: false })}
			/>
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Contact Acme HVAC about this quote."
		);
	});

	it("an expired or unknown link shows one neutral message and the org-less shell", async () => {
		getLink.mockRejectedValueOnce(
			new AxiosError("Not found", "ERR_BAD_REQUEST", undefined, undefined, {
				status: 404,
				statusText: "Not Found",
				data: {
					success: false,
					data: null,
					error: {
						code: "NOT_FOUND",
						message: "This link is no longer valid.",
					},
				},
				headers: {},
				config: { headers: new AxiosHeaders() },
			})
		);
		render(
			<QueryClientProvider client={new QueryClient()}>
				<MemoryRouter initialEntries={["/c/dead-token"]}>
					<Routes>
						<Route
							path="/c/:token"
							element={<PublicLinkPage />}
						/>
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>
		);
		expect(
			await screen.findByRole("heading", { name: "Link not available" })
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"This link has expired or is no longer valid. Contact the company that sent it."
			)
		).toBeInTheDocument();
		expect(screen.queryByRole("banner")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});
});
