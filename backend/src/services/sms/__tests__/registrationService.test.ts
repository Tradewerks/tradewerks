import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const m = vi.hoisted(() => {
	const rows = new Map<string, Row>();

	const matches = (row: Row, where: Row = {}): boolean =>
		Object.entries(where).every(([k, cond]) => {
			if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
			const v = row[k];
			if (cond === null) return v === null || v === undefined;
			if (cond && typeof cond === "object" && !(cond instanceof Date)) {
				const c = cond as { in?: unknown[]; lt?: Date };
				if (c.in) return c.in.includes(v);
				if (c.lt) return v instanceof Date && v < c.lt;
			}
			return v === cond;
		});

	const clean = (data: Row) =>
		Object.fromEntries(
			Object.entries(data).filter(([, v]) => v !== undefined),
		);

	const blank = (id: string): Row => ({
		organization_id: id,
		status: "draft",
		failure_reason: null,
		failed_step: null,
		registration: {},
		subaccount_sid: null,
		auth_token_enc: null,
		profile_sid: null,
		brand_sid: null,
		messaging_service_sid: null,
		campaign_sid: null,
		phone_number: null,
		phone_number_sid: null,
		submitted_at: null,
		activated_at: null,
		last_polled_at: null,
	});

	const org_sms_account = {
		findFirst: vi.fn(
			async ({ where }: { where: Row }) =>
				[...rows.values()].find((r) => matches(r, where)) ?? null,
		),
		findMany: vi.fn(async ({ where }: { where: Row }) =>
			[...rows.values()].filter((r) => matches(r, where)),
		),
		upsert: vi.fn(
			async ({ where, create }: { where: Row; create: Row }) => {
				const id = where.organization_id as string;
				if (!rows.has(id)) rows.set(id, { ...blank(id), ...create });
				return { ...rows.get(id)! };
			},
		),
		update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			const row = rows.get(where.organization_id as string)!;
			Object.assign(row, clean(data));
			return { ...row };
		}),
		updateMany: vi.fn(
			async ({ where, data }: { where: Row; data: Row }) => {
				let count = 0;
				for (const row of rows.values())
					if (matches(row, where)) {
						Object.assign(row, clean(data));
						count++;
					}
				return { count };
			},
		),
	};
	const fakeDb = {
		org_sms_account,
		usage_counter: { findFirst: vi.fn(async () => ({ count: 12 })) },
	};
	return {
		rows,
		fakeDb,
		provider: {
			startRegistration: vi.fn(),
			pollRegistration: vi.fn(),
			createCampaign: vi.fn(),
			deleteCampaign: vi.fn(async () => undefined),
			provisionNumber: vi.fn(),
		},
		notifyDispatchers: vi.fn(async () => []),
	};
});

vi.mock("../../../db.js", () => ({ db: m.fakeDb }));
vi.mock("../../../lib/context.js", () => ({ getScopedDb: () => m.fakeDb }));
vi.mock("../../entitlementService.js", () => ({
	getEntitlements: vi.fn(async () => ({
		limits: { sms_segments_month: 500 },
	})),
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../../controllers/notificationsController.js", () => ({
	notifyDispatchers: m.notifyDispatchers,
}));
vi.mock("../../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../provider.js", async (orig) => ({
	...(await orig<typeof import("../provider.js")>()),
	smsProvider: m.provider,
}));

import {
	SmsAccountError,
	getSmsAccount,
	saveRegistrationDraft,
	submitRegistration,
	SMS_OPT_IN_DESCRIPTION,
	buildCampaignContent,
} from "../registrationService.js";
import { pollSmsAccount, runRegistrationPoll } from "../registrationPoller.js";
import { SmsRegistrationError } from "../errors.js";
import { log } from "../../appLogger.js";

const ORG = "org-1";

const form = (over: Record<string, unknown> = {}) => ({
	legal_name: "Cool Air LLC",
	dba: "Cool Air",
	ein: "12-3456789",
	entity_type: "Limited Liability Corporation",
	vertical: "CONSTRUCTION",
	address: {
		street: "1 Main St",
		city: "Austin",
		region: "TX",
		postal_code: "78701",
		iso_country: "US",
	},
	website: "https://coolair.example",
	support_email: "help@coolair.example",
	support_phone: "(512) 555-0100",
	rep_name: "Dana Reyes",
	rep_title: "CEO",
	rep_email: "dana@coolair.example",
	rep_phone: "512-555-0101",
	privacy_url: "https://coolair.example/privacy",
	terms_url: "https://coolair.example/terms",
	area_code: "512",
	...over,
});

const filed = {
	subaccount_sid: "AC1",
	auth_token_enc: "enc",
	profile_sid: "BU1",
	brand_sid: "BN1",
	messaging_service_sid: "MG1",
};

const row = () => m.rows.get(ORG)!;
const tick = (n: number) => new Date(Date.UTC(2026, 10, 16, 12, 15 * n));

beforeEach(() => {
	m.rows.clear();
	vi.clearAllMocks();
	m.provider.startRegistration.mockResolvedValue(filed);
});

describe("SMS registration", () => {
	it("submit refuses a form with neither ein nor sole_prop_mobile (400)", async () => {
		const err = await submitRegistration(
			ORG,
			form({ ein: "", sole_prop_mobile: "" }),
		).catch((e) => e);
		expect(err).toBeInstanceOf(SmsAccountError);
		expect(err.status).toBe(400);
		expect(err.message).toBe(
			"EIN: Enter your EIN, or a mobile number to register as a sole proprietor",
		);
		expect(m.provider.startRegistration).not.toHaveBeenCalled();
		expect(m.rows.get(ORG)?.status ?? "draft").toBe("draft");
	});

	it("submit is idempotent: a second call while status is submitted returns 409 and creates no second subaccount", async () => {
		const view = await submitRegistration(ORG, form());
		expect(view.status).toBe("submitted");
		expect(view.usage).toEqual({ used: 12, limit: 500 });
		expect(row().subaccount_sid).toBe("AC1");
		expect(row().registration).toMatchObject({
			support_phone: "+15125550100",
		});

		const err = await submitRegistration(ORG, form()).catch((e) => e);
		expect(err).toBeInstanceOf(SmsAccountError);
		expect(err.status).toBe(409);
		expect(m.provider.startRegistration).toHaveBeenCalledTimes(1);
		expect(row().status).toBe("submitted");
	});

	it("the poller moves submitted → brand_pending → campaign_pending → active and buys exactly one number", async () => {
		await submitRegistration(ORG, form());
		m.provider.pollRegistration
			.mockResolvedValueOnce({ status: "brand_pending", patch: {} })
			.mockResolvedValueOnce({ status: "campaign_pending", patch: {} })
			.mockResolvedValueOnce({ status: "campaign_pending", patch: {} })
			.mockResolvedValueOnce({
				status: "campaign_pending",
				needsNumber: true,
				patch: {},
			});
		m.provider.createCampaign.mockResolvedValue({ campaign_sid: "QE1" });
		m.provider.provisionNumber.mockResolvedValue({
			phone_number: "+15125550199",
			phone_number_sid: "PN1",
		});

		await runRegistrationPoll(tick(1));
		expect(row().status).toBe("brand_pending");
		await runRegistrationPoll(tick(2));
		expect(row().status).toBe("campaign_pending");
		expect(row().campaign_sid).toBe("QE1");
		const content = m.provider.createCampaign.mock.calls[0][1];
		expect(content.soleProprietor).toBe(false);
		expect(content.messageFlow).toBe(SMS_OPT_IN_DESCRIPTION);
		expect(content.messageSamples).toHaveLength(3);
		expect(content.messageSamples[0]).toMatch(
			/^Cool Air: .*Reply STOP to opt out\.$/,
		);
		expect(content.messageSamples[1]).toContain("Alex is on the way");

		await runRegistrationPoll(tick(3));
		expect(row().status).toBe("campaign_pending");
		expect(m.provider.createCampaign).toHaveBeenCalledTimes(1);

		await runRegistrationPoll(tick(4));
		expect(row().status).toBe("active");
		expect(row().phone_number).toBe("+15125550199");
		expect(row().activated_at).toEqual(tick(4));
		expect(m.provider.provisionNumber).toHaveBeenCalledWith(
			expect.objectContaining({ campaign_sid: "QE1" }),
			{ areaCode: "512", region: "TX", isoCountry: "US" },
		);

		// An active account is not re-checked within a day, and a same-tick re-poll is skipped.
		await runRegistrationPoll(tick(5));
		expect(await pollSmsAccount(ORG, tick(5))).toBeNull();
		expect(m.provider.pollRegistration).toHaveBeenCalledTimes(4);
		expect(m.provider.provisionNumber).toHaveBeenCalledTimes(1);
		expect(m.notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(m.notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({ type: "sms_registration_update" }),
			ORG,
		);
	});

	it("a failed brand stores the provider's reason and allows edit-and-resubmit", async () => {
		await submitRegistration(ORG, form());
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "failed",
			failureReason: "Legal name does not match the EIN",
			patch: {},
		});
		await runRegistrationPoll(tick(1));
		const failed = await getSmsAccount(ORG);
		expect(failed.status).toBe("failed");
		expect(failed.failure_reason).toBe("Legal name does not match the EIN");
		expect(m.notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "sms_registration_update",
				body: expect.stringContaining("Legal name does not match"),
			}),
			ORG,
		);

		await saveRegistrationDraft(ORG, {
			legal_name: "Cool Air Holdings LLC",
		});
		expect(row().registration).toEqual({
			legal_name: "Cool Air Holdings LLC",
		});

		const view = await submitRegistration(
			ORG,
			form({ legal_name: "Cool Air Holdings LLC" }),
		);
		expect(view.status).toBe("submitted");
		expect(view.failure_reason).toBeNull();
		const [, sent, existing] = m.provider.startRegistration.mock.calls[1];
		expect(sent.legal_name).toBe("Cool Air Holdings LLC");
		// Same subaccount and messaging service; a new brand is filed.
		expect(existing).toMatchObject({
			subaccount_sid: "AC1",
			messaging_service_sid: "MG1",
		});
		expect(existing.brand_sid).toBeUndefined();
	});

	it("a provider failure part-way keeps the ids it created for the resubmit", async () => {
		m.provider.startRegistration.mockRejectedValueOnce(
			new SmsRegistrationError("Address could not be verified", {
				subaccount_sid: "AC1",
				auth_token_enc: "enc",
			}),
		);
		const view = await submitRegistration(ORG, form());
		expect(view.status).toBe("failed");
		expect(view.failure_reason).toBe("Address could not be verified");
		expect(row().subaccount_sid).toBe("AC1");

		await submitRegistration(ORG, form());
		expect(m.provider.startRegistration.mock.calls[1][2]).toMatchObject({
			subaccount_sid: "AC1",
			auth_token_enc: "enc",
		});
	});

	it("drafts can't be changed once submitted", async () => {
		await submitRegistration(ORG, form());
		const err = await saveRegistrationDraft(ORG, { dba: "x" }).catch(
			(e) => e,
		);
		expect(err.status).toBe(409);
	});

	// Takes an account through brand approval to a filed campaign.
	const toFiledCampaign = async () => {
		await submitRegistration(ORG, form());
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "campaign_pending",
			patch: {},
		});
		m.provider.createCampaign.mockResolvedValueOnce({
			campaign_sid: "QE1",
		});
		await runRegistrationPoll(tick(1));
		expect(row().campaign_sid).toBe("QE1");
	};
	const verified = {
		status: "campaign_pending",
		needsNumber: true,
		patch: {},
	};

	it("a number that can't be attached fails the registration, keeps the campaign and the bought number, and a resubmit goes straight to the number", async () => {
		await toFiledCampaign();
		m.provider.pollRegistration.mockResolvedValueOnce(verified);
		m.provider.provisionNumber.mockRejectedValueOnce(
			new SmsRegistrationError("The number could not be added", {
				phone_number: "+15125550199",
				phone_number_sid: "PN1",
			}),
		);
		await runRegistrationPoll(tick(2));
		expect(row()).toMatchObject({
			status: "failed",
			failed_step: "number",
			failure_reason: "The number could not be added",
			campaign_sid: "QE1",
			brand_sid: "BN1",
			phone_number_sid: "PN1",
		});

		await submitRegistration(ORG, form());
		m.provider.pollRegistration.mockResolvedValueOnce(verified);
		m.provider.provisionNumber.mockResolvedValueOnce({
			phone_number: "+15125550199",
			phone_number_sid: "PN1",
		});
		await runRegistrationPoll(tick(3));
		expect(row().status).toBe("active");
		expect(row().failed_step).toBeNull();
		expect(m.provider.provisionNumber.mock.calls[1][0]).toMatchObject({
			phone_number_sid: "PN1",
		});
		expect(m.provider.createCampaign).toHaveBeenCalledTimes(1);
		expect(m.provider.deleteCampaign).not.toHaveBeenCalled();
	});

	it("a failed campaign is removed before a new one is filed on resubmit", async () => {
		await toFiledCampaign();
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "failed",
			failedStep: "campaign",
			failureReason: "Samples do not match the use case",
			patch: {},
		});
		await runRegistrationPoll(tick(2));
		expect(row()).toMatchObject({
			status: "failed",
			failed_step: "campaign",
			campaign_sid: "QE1",
			brand_sid: "BN1",
		});

		await submitRegistration(ORG, form());
		m.provider.deleteCampaign.mockRejectedValueOnce(new Error("timeout"));
		await runRegistrationPoll(tick(3));
		// Not removed yet: the sid stays so the next tick retries.
		expect(row().campaign_sid).toBe("QE1");
		expect(m.provider.pollRegistration).toHaveBeenCalledTimes(2);

		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "campaign_pending",
			patch: {},
		});
		m.provider.createCampaign.mockResolvedValueOnce({
			campaign_sid: "QE2",
		});
		await runRegistrationPoll(tick(4));
		expect(m.provider.deleteCampaign).toHaveBeenLastCalledWith(
			expect.objectContaining({ campaign_sid: "QE1" }),
		);
		expect(
			m.provider.pollRegistration.mock.calls[2][0].campaign_sid,
		).toBeNull();
		expect(row()).toMatchObject({
			status: "campaign_pending",
			campaign_sid: "QE2",
			failed_step: null,
		});
	});

	it("a brand failure after the campaign was filed clears the brand and removes the campaign on resubmit", async () => {
		await toFiledCampaign();
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "failed",
			failedStep: "brand",
			failureReason: "Brand suspended by TCR",
			patch: {},
		});
		await runRegistrationPoll(tick(2));
		expect(row()).toMatchObject({
			status: "failed",
			failed_step: "brand",
			brand_sid: null,
			profile_sid: null,
			campaign_sid: "QE1",
		});

		await submitRegistration(ORG, form());
		expect(
			m.provider.startRegistration.mock.calls[1][2].brand_sid,
		).toBeUndefined();
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "brand_pending",
			patch: {},
		});
		await runRegistrationPoll(tick(3));
		expect(m.provider.deleteCampaign).toHaveBeenCalledTimes(1);
		expect(row()).toMatchObject({
			status: "brand_pending",
			campaign_sid: null,
			failed_step: null,
		});
	});

	it("a refusal from createCampaign fails the registration at the campaign step", async () => {
		await submitRegistration(ORG, form());
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "campaign_pending",
			patch: {},
		});
		m.provider.createCampaign.mockRejectedValueOnce(
			new SmsRegistrationError("Twilio 21701: Brand not approved"),
		);
		await runRegistrationPoll(tick(1));
		expect(row()).toMatchObject({
			status: "failed",
			failed_step: "campaign",
			failure_reason: "Twilio 21701: Brand not approved",
		});
		expect(m.notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "Twilio 21701: Brand not approved. Edit your details under Customer messages and submit again.",
			}),
			ORG,
		);
	});

	it("a transient provider error leaves the status for the next tick", async () => {
		await submitRegistration(ORG, form());
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "campaign_pending",
			patch: {},
		});
		m.provider.createCampaign.mockRejectedValueOnce(
			new Error("ECONNRESET"),
		);
		await runRegistrationPoll(tick(1));
		expect(row().status).toBe("submitted");
		expect(m.notifyDispatchers).not.toHaveBeenCalled();
	});

	it("a submit that never filed its brand is failed after 30 minutes", async () => {
		m.provider.startRegistration.mockResolvedValueOnce({
			subaccount_sid: "AC1",
			auth_token_enc: "enc",
		});
		await submitRegistration(ORG, form());
		row().submitted_at = tick(0);
		m.provider.pollRegistration.mockResolvedValue({
			status: "submitted",
			patch: {},
		});
		await runRegistrationPoll(tick(1));
		expect(row().status).toBe("submitted");
		expect(m.provider.pollRegistration).toHaveBeenCalledTimes(1);
		await runRegistrationPoll(tick(3));
		expect(row()).toMatchObject({
			status: "failed",
			failure_reason: "Registration didn't finish. Submit it again.",
		});
		expect(m.provider.pollRegistration).toHaveBeenCalledTimes(1);
	});

	it("ids from a successful filing survive a failed write afterwards", async () => {
		m.fakeDb.org_sms_account.update.mockRejectedValueOnce(
			new Error("db down"),
		);
		await expect(submitRegistration(ORG, form())).rejects.toThrow(
			"db down",
		);
		// Not rolled back to draft, so a retry can't file a second registration.
		expect(row().status).toBe("submitted");
	});

	it("an abandoned submit keeps the failed step so the resubmit resumes there", async () => {
		await toFiledCampaign();
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "failed",
			failedStep: "campaign",
			failureReason: "Samples do not match the use case",
			patch: {},
		});
		await runRegistrationPoll(tick(2));
		expect(row().failed_step).toBe("campaign");

		m.provider.startRegistration.mockResolvedValueOnce({});
		await submitRegistration(ORG, form());
		row().submitted_at = tick(0);
		row().brand_sid = null;
		await runRegistrationPoll(tick(4));
		expect(row()).toMatchObject({
			status: "failed",
			failure_reason: "Registration didn't finish. Submit it again.",
			failed_step: "campaign",
		});
	});

	it("logs the provider ids, never the auth token, when the poll's write fails after a purchase", async () => {
		await toFiledCampaign();
		m.provider.pollRegistration.mockResolvedValueOnce(verified);
		m.provider.provisionNumber.mockResolvedValueOnce({
			phone_number: "+15125550199",
			phone_number_sid: "PN1",
		});
		// The first updateMany is the poll's claim; fail the result write.
		const real =
			m.fakeDb.org_sms_account.updateMany.getMockImplementation()!;
		m.fakeDb.org_sms_account.updateMany
			.mockImplementationOnce(real)
			.mockImplementationOnce(async () => {
				throw new Error("db down");
			});
		vi.mocked(log.error).mockClear();
		await runRegistrationPoll(tick(2));
		const call = vi
			.mocked(log.error)
			.mock.calls.find((c) => JSON.stringify(c[0]).includes("PN1"));
		expect(call).toBeDefined();
		expect(JSON.stringify(call)).not.toMatch(/enc|auth_token/);
	});

	it("logs the provider ids when the write after the filing fails", async () => {
		m.provider.startRegistration.mockResolvedValueOnce({
			subaccount_sid: "AC9",
			auth_token_enc: "secret-enc",
			brand_sid: "BN9",
		});
		m.fakeDb.org_sms_account.update.mockRejectedValueOnce(
			new Error("db down"),
		);
		vi.mocked(log.error).mockClear();
		await expect(submitRegistration(ORG, form())).rejects.toThrow(
			"db down",
		);
		const logged = JSON.stringify(vi.mocked(log.error).mock.calls);
		expect(logged).toContain("AC9");
		expect(logged).toContain("BN9");
		expect(logged).not.toContain("secret-enc");
	});

	it("an active account is re-checked daily and a carrier suspension is stored and announced", async () => {
		await submitRegistration(ORG, form());
		const activatedAt = tick(0);
		Object.assign(row(), {
			status: "active",
			brand_sid: "BN1",
			campaign_sid: "QE1",
			phone_number: "+15125550199",
			activated_at: activatedAt,
			last_polled_at: activatedAt,
		});
		const later = (h: number) =>
			new Date(activatedAt.getTime() + h * 3_600_000);

		await runRegistrationPoll(later(23));
		expect(m.provider.pollRegistration).not.toHaveBeenCalled();

		// Still active: nothing is written beyond the poll stamp, and an
		// unattached number is never re-bought from here.
		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "campaign_pending",
			needsNumber: true,
			patch: {},
		});
		await runRegistrationPoll(later(25));
		expect(m.provider.pollRegistration).toHaveBeenCalledTimes(1);
		expect(row().status).toBe("active");
		expect(m.provider.provisionNumber).not.toHaveBeenCalled();
		expect(m.notifyDispatchers).not.toHaveBeenCalled();

		m.provider.pollRegistration.mockResolvedValueOnce({
			status: "suspended",
			patch: {},
		});
		await runRegistrationPoll(later(50));
		expect(row().status).toBe("suspended");
		expect(m.notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(m.notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "sms_registration_update",
				title: "Text messaging was suspended",
			}),
			ORG,
		);
	});

	it("the 409 says what state the account is in", async () => {
		await submitRegistration(ORG, form());
		const pending = await submitRegistration(ORG, form()).catch((e) => e);
		expect(pending.message).toMatch(/in review/);
		row().status = "active";
		const active = await saveRegistrationDraft(ORG, {}).catch((e) => e);
		expect(active.message).toBe("Text messaging is already set up.");
	});
});

describe("campaign content", () => {
	it("declares embedded links and shows a sample link that carries no real token", () => {
		const prev = process.env.FRONTEND_URL;
		process.env.FRONTEND_URL = "https://app.coolair.example";
		try {
			const c = buildCampaignContent(form() as never);
			expect(c.hasEmbeddedLinks).toBe(true);
			const withLink = c.messageSamples.filter((s) =>
				s.includes("https://app.coolair.example/app/c/"),
			);
			expect(withLink.length).toBeGreaterThan(0);
		} finally {
			if (prev === undefined) delete process.env.FRONTEND_URL;
			else process.env.FRONTEND_URL = prev;
		}
	});
});
