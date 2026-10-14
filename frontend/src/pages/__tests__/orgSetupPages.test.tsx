import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";
import { passwordProblem } from "../../lib/passwordRules";
import { endOfDayIn, shortDateIn } from "../../lib/trialDays";

vi.mock("../../api/organizations", () => ({
	getBusinessTypes: vi.fn(async () => [
		{ key: "hvac", label: "HVAC" },
		{ key: "general", label: "Other" },
	]),
	registerOrganization: vi.fn(),
	previewOrgInvite: vi.fn(),
	acceptOrgInvite: vi.fn(),
}));
import * as orgApi from "../../api/organizations";
import RegisterPage from "../RegisterPage";
import AcceptInvitePage from "../AcceptInvitePage";
import WelcomePage from "../dispatch/WelcomePage";
import * as entApi from "../../api/entitlements";
import {
	draftChanges,
	initialDraft,
	shouldShowWelcome,
	toggleDraft,
	welcomeReturnPath,
} from "../../lib/welcomeDraft";
import type { EntitlementsData } from "../../lib/permissionAccess";

const api = orgApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

export const apiError = (status: number, code: string, message: string) =>
	new AxiosError(message, String(status), undefined, undefined, {
		status,
		statusText: "",
		headers: {},
		config: { headers: new AxiosHeaders() },
		data: { success: false, data: null, error: { code, message } },
	});

export function wrap(ui: ReactNode, path: string | { pathname: string; state: unknown }) {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/register" element={ui} />
					<Route path="/accept-invite" element={ui} />
					<Route path="/dispatch/welcome" element={ui} />
					<Route path="/login" element={<p>login page</p>} />
					<Route path="/dispatch" element={<p>dashboard</p>} />
					<Route path="/dispatch/admin" element={<p>admin page</p>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

async function fillRegister() {
	const u = userEvent.setup();
	await u.type(screen.getByLabelText(/organization name/i), "Acme");
	await u.selectOptions(await screen.findByLabelText(/what kind of business/i), "hvac");
	await u.type(screen.getByLabelText(/your name/i), "Pat");
	await u.type(screen.getByLabelText(/^email/i), "pat@acme.test");
	await u.type(screen.getByLabelText(/^password/i), "Sup3r$ecret");
	await u.type(screen.getByLabelText(/confirm password/i), "Sup3r$ecret");
	return u;
}

beforeEach(() => vi.clearAllMocks());

describe("passwordProblem", () => {
	it.each([
		["Sup3r$ecret", "Sup3r$ecret", null],
		["Sup3r$ecret", "other", "Passwords do not match."],
		["S3$a", "S3$a", "Password must be at least 8 characters."],
		["sup3r$ecret", "sup3r$ecret", "Password must contain at least one capital letter."],
	])("%s", (p, c, want) => expect(passwordProblem(p, c)).toBe(want));
});

describe("trial dates in the org's timezone", () => {
	it.each([
		["2026-10-23", "America/New_York", "2026-10-24T03:59:59.000Z"],
		["2026-10-23", "Pacific/Honolulu", "2026-10-24T09:59:59.000Z"],
		["2026-11-01", "America/Chicago", "2026-11-02T05:59:59.000Z"], // DST ends that morning
		["2026-03-08", "America/Chicago", "2026-03-09T04:59:59.000Z"], // DST starts that morning
	])("endOfDayIn(%s, %s)", (d, tz, want) => expect(endOfDayIn(d, tz)).toBe(want));

	it("names the org's calendar day, not the viewer's", () => {
		const iso = "2026-10-24T03:59:59.000Z"; // Oct 23 in New York, Oct 24 in UTC
		expect(shortDateIn(iso, "America/New_York")).toMatch(/23/);
		expect(shortDateIn(iso, "UTC")).toMatch(/24/);
	});
});

describe("RegisterPage", () => {
	it("sends the chosen business type", async () => {
		api.registerOrganization.mockResolvedValue({});
		wrap(<RegisterPage />, "/register");
		const u = await fillRegister();
		await u.click(screen.getByRole("button", { name: /create/i }));
		await waitFor(() =>
			expect(api.registerOrganization.mock.calls[0][0].business_type).toBe("hvac"),
		);
	});

	it("shows the paused notice for SIGNUPS_PAUSED", async () => {
		api.registerOrganization.mockRejectedValue(
			apiError(503, "SIGNUPS_PAUSED", "Signups are paused. Contact TradeWerks."),
		);
		wrap(<RegisterPage />, "/register");
		const u = await fillRegister();
		await u.click(screen.getByRole("button", { name: /create/i }));
		expect(await screen.findByText("Signups are paused. Contact TradeWerks.")).toBeInTheDocument();
	});

	it("shows the limiter's message on 429", async () => {
		api.registerOrganization.mockRejectedValue(
			apiError(429, "TOO_MANY_REQUESTS", "Too many signups from this network. Try again later."),
		);
		wrap(<RegisterPage />, "/register");
		const u = await fillRegister();
		await u.click(screen.getByRole("button", { name: /create/i }));
		expect(await screen.findByText("Too many signups from this network. Try again later.")).toBeInTheDocument();
	});
});

describe("AcceptInvitePage", () => {
	const PATH = `/accept-invite?token=${"t".repeat(43)}`;

	it("previews, accepts and sends the user to sign in", async () => {
		api.previewOrgInvite.mockResolvedValue({ company: "Acme", email: "pat@acme.test" });
		api.acceptOrgInvite.mockResolvedValue({ email: "pat@acme.test" });
		wrap(<AcceptInvitePage />, PATH);
		expect(await screen.findByText("Welcome to Acme")).toBeInTheDocument();
		const u = userEvent.setup();
		await u.type(screen.getByLabelText(/^password/i), "Sup3r$ecret");
		await u.type(screen.getByLabelText(/confirm password/i), "Sup3r$ecret");
		await u.click(screen.getByRole("button", { name: /set password/i }));
		expect(await screen.findByText("login page")).toBeInTheDocument();
		expect(api.acceptOrgInvite).toHaveBeenCalledWith("t".repeat(43), "Sup3r$ecret");
	});

	it("an expired link shows the resend guidance", async () => {
		api.previewOrgInvite.mockRejectedValue(
			apiError(404, "NOT_FOUND", "This invite link is invalid or has expired"),
		);
		wrap(<AcceptInvitePage />, PATH);
		expect(await screen.findByText("This invite expired. Ask TradeWerks to resend it.")).toBeInTheDocument();
	});

	it("a rate-limited preview shows the server's message and a retry, not expiry", async () => {
		api.previewOrgInvite.mockRejectedValueOnce(
			apiError(429, "TOO_MANY_REQUESTS", "Too many attempts. Try again later."),
		);
		api.previewOrgInvite.mockResolvedValueOnce({ company: "Acme", email: "pat@acme.test" });
		wrap(<AcceptInvitePage />, PATH);
		expect(await screen.findByText("Too many attempts. Try again later.")).toBeInTheDocument();
		expect(screen.queryByText("This invite expired. Ask TradeWerks to resend it.")).toBeNull();
		await userEvent.setup().click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findByText("Welcome to Acme")).toBeInTheDocument();
	});

	it("a network failure on preview does not claim the link expired", async () => {
		api.previewOrgInvite.mockRejectedValue(new AxiosError("Network Error", "ERR_NETWORK"));
		wrap(<AcceptInvitePage />, PATH);
		expect(await screen.findByText("Could not check this invite. Try again.")).toBeInTheDocument();
		expect(screen.queryByText("This invite expired. Ask TradeWerks to resend it.")).toBeNull();
	});

	it("a missing token shows the same guidance without calling the server", async () => {
		wrap(<AcceptInvitePage />, "/accept-invite");
		expect(await screen.findByText("This invite expired. Ask TradeWerks to resend it.")).toBeInTheDocument();
		expect(api.previewOrgInvite).not.toHaveBeenCalled();
	});
});

const mod = (
	key: string,
	label: string,
	state: "on" | "off_by_org" | "not_in_plan",
	requires: string[] = [],
) => ({
	key,
	label,
	description: `${label} description`,
	kind: "optional" as const,
	requires,
	state,
});
const MODS = [
	mod("inventory", "Inventory", "off_by_org"),
	mod("fleet", "Fleet", "on"),
	mod("vehicle_stock", "Vehicle Stock", "off_by_org", ["inventory", "fleet"]),
	mod("purchasing", "Purchasing", "on", ["inventory"]),
	mod("projects", "Projects", "not_in_plan"),
];

describe("welcome draft", () => {
	it("starts from current state and leaves out modules outside the tier", () => {
		expect(initialDraft(MODS)).toEqual({
			inventory: false,
			fleet: true,
			vehicle_stock: false,
			purchasing: true,
		});
	});
	it("turning a module on turns its dependencies on and names them", () => {
		const { next, also } = toggleDraft(MODS, initialDraft(MODS), "vehicle_stock");
		expect(next).toMatchObject({ vehicle_stock: true, inventory: true, fleet: true });
		expect(also).toEqual(["Inventory"]);
	});
	it("turning a module off turns its dependents off and names them", () => {
		const start = { ...initialDraft(MODS), inventory: true, vehicle_stock: true };
		const { next, also } = toggleDraft(MODS, start, "inventory");
		expect(next).toMatchObject({ inventory: false, vehicle_stock: false, purchasing: false });
		expect([...also].sort()).toEqual(["Purchasing", "Vehicle Stock"]);
	});
	it("a module outside the tier cannot be toggled", () => {
		expect(toggleDraft(MODS, initialDraft(MODS), "projects").next).toEqual(initialDraft(MODS));
	});
	it("draftChanges lists only differences from the server state", () => {
		expect(draftChanges(MODS, { ...initialDraft(MODS), fleet: false })).toEqual({ fleet: false });
	});
});

describe("shouldShowWelcome", () => {
	const ent = (setup: EntitlementsData["setup"]) => ({ setup }) as EntitlementsData;
	const open = { templateKey: "hvac", modulesReviewed: false, trial: null };
	it.each([
		["new org, can manage", ent(open), true, true],
		["already reviewed", ent({ ...open, modulesReviewed: true }), true, false],
		["cannot manage", ent(open), false, false],
		["snapshot from before build plan 4", ent(undefined), true, false],
		["setup unavailable", ent(null), true, false],
		["not loaded", undefined, true, false],
	])("%s", (_name, e, canManage, want) => expect(shouldShowWelcome(e, canManage)).toBe(want));
});

describe("welcomeReturnPath", () => {
	it.each([
		[{ from: "/dispatch/admin?tab=entitlements" }, "/dispatch/admin?tab=entitlements"],
		[{ from: "/dispatch/welcome" }, "/dispatch"],
		[{ from: "https://evil.test/x" }, "/dispatch"],
		[{ from: "/technician" }, "/dispatch"],
		[null, "/dispatch"],
		[undefined, "/dispatch"],
	])("%j → %s", (state, want) => expect(welcomeReturnPath(state)).toBe(want));
});

const entState = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("../../hooks/useEntitlements", async (orig) => ({
	...(await orig<typeof import("../../hooks/useEntitlements")>()),
	useEntitlements: () => ({ data: entState.data, isLoading: false }),
}));
vi.mock("../../api/entitlements", async (orig) => ({
	...(await orig<typeof import("../../api/entitlements")>()),
	updateModuleChoices: vi.fn(async () => ({})),
	markModulesReviewed: vi.fn(async () => {}),
}));

const ent = entApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("WelcomePage", () => {
	beforeEach(() => {
		ent.updateModuleChoices.mockReset();
		ent.markModulesReviewed.mockReset();
		entState.data = {
			plan: { key: "starter", version: 1, trialActive: false },
			modules: MODS,
			permissionMap: {},
			limits: {},
			usage: null,
			setup: { templateKey: "general", modulesReviewed: false, trial: null },
		};
	});

	it("names the business type", async () => {
		wrap(<WelcomePage />, "/dispatch/welcome");
		expect(
			await screen.findByRole("heading", { name: "Here's what's on for Other" }),
		).toBeInTheDocument();
	});

	it("Looks good saves the changes, then marks reviewed, then goes to the dashboard", async () => {
		const order: string[] = [];
		ent.updateModuleChoices.mockImplementation(async () => {
			order.push("save");
			return {};
		});
		ent.markModulesReviewed.mockImplementation(async () => {
			order.push("mark");
		});
		wrap(<WelcomePage />, "/dispatch/welcome");
		const u = userEvent.setup();
		await u.click(await screen.findByRole("switch", { name: "Fleet" }));
		await u.click(screen.getByRole("button", { name: "Looks good" }));
		expect(await screen.findByText("dashboard")).toBeInTheDocument();
		expect(ent.updateModuleChoices).toHaveBeenCalledWith({ fleet: false });
		expect(order).toEqual(["save", "mark"]);
	});

	it("Skip only marks reviewed", async () => {
		wrap(<WelcomePage />, "/dispatch/welcome");
		await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
		expect(await screen.findByText("dashboard")).toBeInTheDocument();
		expect(ent.updateModuleChoices).not.toHaveBeenCalled();
		expect(ent.markModulesReviewed).toHaveBeenCalledTimes(1);
	});

	it("Skip continues to the deep link the welcome step interrupted", async () => {
		wrap(<WelcomePage />, {
			pathname: "/dispatch/welcome",
			state: { from: "/dispatch/admin?tab=entitlements" },
		});
		await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
		expect(await screen.findByText("admin page")).toBeInTheDocument();
	});

	it("a failed save shows the error and does not mark reviewed", async () => {
		ent.updateModuleChoices.mockRejectedValue(
			apiError(409, "CONFLICT", "Turn off Vehicle Stock first; it needs Fleet"),
		);
		wrap(<WelcomePage />, "/dispatch/welcome");
		const u = userEvent.setup();
		await u.click(await screen.findByRole("switch", { name: "Fleet" }));
		await u.click(screen.getByRole("button", { name: "Looks good" }));
		expect(
			await screen.findByText("Turn off Vehicle Stock first; it needs Fleet"),
		).toBeInTheDocument();
		expect(ent.markModulesReviewed).not.toHaveBeenCalled();
	});

	it("a module outside the subscription shows Request a change instead of a switch", async () => {
		wrap(<WelcomePage />, "/dispatch/welcome");
		expect(await screen.findByRole("link", { name: /request a change/i })).toBeInTheDocument();
		expect(screen.queryByRole("switch", { name: "Projects" })).toBeNull();
	});
});
