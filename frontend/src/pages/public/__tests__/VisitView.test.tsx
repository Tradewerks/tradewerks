import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	getPublicLink,
	markPublicLinkViewed,
	type VisitLinkData,
} from "../../../api/publicLinks";
import PublicLinkPage from "../PublicLinkPage";
import VisitView from "../VisitView";

vi.mock("../../../api/publicLinks", () => ({
	getPublicLink: vi.fn(),
	markPublicLinkViewed: vi.fn(),
}));

const visit = (over: Partial<VisitLinkData> = {}): VisitLinkData => ({
	purpose: "visit",
	org: { name: "Acme HVAC", logo_url: null, color: "#0f766e", phone: null, email: null },
	date: "Tuesday, November 17",
	window: "1:00 PM – 3:00 PM",
	address: "12 Elm St, Springfield",
	status_label: "On the way",
	phase: "driving",
	tech_first_names: ["Sam"],
	eta: "2:15 PM",
	tech_photo_url: null,
	summary: null,
	photos: [],
	...over,
});

describe("VisitView", () => {
	it("VisitView shows the ETA line only when eta is present", () => {
		const { unmount } = render(<VisitView data={visit()} />);
		expect(screen.getByText("Estimated arrival 2:15 PM")).toBeInTheDocument();
		expect(screen.getByText("On the way")).toBeInTheDocument();
		unmount();

		render(<VisitView data={visit({ eta: null, status_label: "Arrived", phase: "arrived" as const })} />);
		expect(screen.queryByText(/Estimated arrival/)).toBeNull();
		expect(screen.getByText("Arrived")).toBeInTheDocument();
	});
});

describe("VisitView completion summary", () => {
	it("shows what was done and the shared photos, lazily loaded with alt text", () => {
		render(
			<VisitView
				data={visit({
					phase: "done",
					status_label: "Completed",
					eta: null,
					summary: { name: "Furnace tune-up", description: "Replaced the filter" },
					photos: [
						{ url: "https://signed.test/a.jpg?sig=1", label: "After", name: "New filter" },
						{ url: "https://signed.test/b.jpg?sig=1", label: "Before", name: null },
					],
				})}
			/>
		);
		expect(screen.getByText("Furnace tune-up")).toBeInTheDocument();
		expect(screen.getByText("Replaced the filter")).toBeInTheDocument();
		const named = screen.getByRole("img", { name: "New filter" });
		expect(named).toHaveAttribute("loading", "lazy");
		expect(named).toHaveAttribute("src", "https://signed.test/a.jpg?sig=1");
		expect(screen.getByRole("img", { name: "Before photo" })).toHaveAttribute("loading", "lazy");
	});

	it("shows the technician's photo when set and nothing in its place when not", () => {
		const { unmount } = render(
			<VisitView data={visit({ tech_photo_url: "https://signed.test/sam.jpg?sig=1" })} />
		);
		expect(screen.getByRole("img", { name: "Sam" })).toHaveAttribute(
			"src",
			"https://signed.test/sam.jpg?sig=1"
		);
		unmount();
		render(<VisitView data={visit()} />);
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.queryByText("Photos")).toBeNull();
	});

	it("hides the technician photo when more than one technician is on the visit", () => {
		render(
			<VisitView
				data={visit({
					tech_first_names: ["Sam", "Ann"],
					tech_photo_url: "https://signed.test/sam.jpg?sig=1",
				})}
			/>
		);
		expect(screen.getByText("Sam and Ann")).toBeInTheDocument();
		expect(screen.queryByRole("img")).toBeNull();
	});
});

describe("VisitView live ETA", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function renderPage() {
		const qc = new QueryClient();
		return render(
			<QueryClientProvider client={qc}>
				<MemoryRouter initialEntries={["/p/tok"]}>
					<Routes>
						<Route path="/p/:token" element={<PublicLinkPage />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>
		);
	}

	it("VisitView refetches every 60 s while status is Driving and stops when it is not", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.mocked(getPublicLink)
			.mockResolvedValueOnce(visit())
			.mockResolvedValueOnce(visit({ eta: "2:10 PM" }))
			.mockResolvedValue(visit({ eta: null, status_label: "Arrived", phase: "arrived" as const }));
		renderPage();
		await screen.findByText("Estimated arrival 2:15 PM");
		expect(getPublicLink).toHaveBeenCalledTimes(1);

		await act(() => vi.advanceTimersByTimeAsync(59_000));
		expect(getPublicLink).toHaveBeenCalledTimes(1);
		await act(() => vi.advanceTimersByTimeAsync(2_000));
		await screen.findByText("Estimated arrival 2:10 PM");
		expect(getPublicLink).toHaveBeenCalledTimes(2);

		await act(() => vi.advanceTimersByTimeAsync(60_000));
		await screen.findByText("Sam has arrived");
		expect(getPublicLink).toHaveBeenCalledTimes(3);

		await act(() => vi.advanceTimersByTimeAsync(300_000));
		expect(getPublicLink).toHaveBeenCalledTimes(3);
		expect(markPublicLinkViewed).not.toHaveBeenCalled();
	});

	it("a refetch that 404s after a good Driving load shows Link not available", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const gone = Object.assign(new Error("nf"), {
			isAxiosError: true,
			response: { status: 404 },
		});
		vi.mocked(getPublicLink)
			.mockResolvedValueOnce(visit())
			.mockRejectedValue(gone);
		renderPage();
		await screen.findByText("Estimated arrival 2:15 PM");
		await act(() => vi.advanceTimersByTimeAsync(61_000));
		await screen.findByText("Link not available");
	});

	it("a non-404 refetch failure keeps the last good page", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.mocked(getPublicLink)
			.mockResolvedValueOnce(visit())
			.mockRejectedValue(new Error("boom"));
		renderPage();
		await screen.findByText("Estimated arrival 2:15 PM");
		await act(() => vi.advanceTimersByTimeAsync(61_000));
		expect(getPublicLink).toHaveBeenCalledTimes(2);
		expect(screen.getByText("Estimated arrival 2:15 PM")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it('after arrive the page reads "<first name> has arrived" with no ETA', () => {
		const arrived = { eta: null, status_label: "Arrived", phase: "arrived" as const };
		const { unmount } = render(<VisitView data={visit(arrived)} />);
		expect(screen.getByText("Sam has arrived")).toBeInTheDocument();
		expect(screen.queryByText(/Estimated arrival/)).toBeNull();
		unmount();

		const { unmount: u2 } = render(
			<VisitView data={visit({ ...arrived, tech_first_names: ["Ann", "Bo"] })} />
		);
		expect(screen.getByText("Ann has arrived")).toBeInTheDocument();
		u2();

		render(<VisitView data={visit({ ...arrived, tech_first_names: [] })} />);
		expect(screen.getByText("Your technician has arrived")).toBeInTheDocument();
	});
});
