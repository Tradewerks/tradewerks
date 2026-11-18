import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import twilio from "twilio";

const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../appLogger.js", () => {
	const rec =
		(level: string) =>
		(...args: unknown[]) =>
			logged.push([level, ...args]);
	return {
		log: {
			info: rec("info"),
			warn: rec("warn"),
			error: rec("error"),
			debug: rec("debug"),
		},
	};
});

import { createTwilioProvider } from "../twilioProvider.js";
import { SendRejected } from "../../customerComms/channels/types.js";
import { SmsRegistrationError } from "../errors.js";
import { decryptSecret, encryptSecret } from "../../crypto.js";
import type { OrgSmsAccountIds, SmsRegistrationForm } from "../provider.js";

const KEY_HEX = "ab".repeat(32);
const KEY = Buffer.from(KEY_HEX, "hex");
const PARENT_TOKEN = "parent-token-SECRET-1111";
const SUB_TOKEN = "sub-token-SECRET-2222";

const acct = () => ({
	subaccount_sid: "ACsub",
	auth_token_enc: encryptSecret(SUB_TOKEN, KEY),
	messaging_service_sid: "MGsvc",
});

const ids = (over: Partial<OrgSmsAccountIds> = {}): OrgSmsAccountIds => ({
	subaccount_sid: "ACsub",
	auth_token_enc: encryptSecret(SUB_TOKEN, KEY),
	profile_sid: "BUprofile",
	brand_sid: "BNbrand",
	messaging_service_sid: "MGsvc",
	campaign_sid: null,
	phone_number: null,
	phone_number_sid: null,
	...over,
});

const form = (
	over: Partial<SmsRegistrationForm> = {},
): SmsRegistrationForm => ({
	legal_name: "Acme Heating LLC",
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
	website: "https://acme.example",
	support_email: "help@acme.example",
	support_phone: "+15125550100",
	rep_name: "Pat Lee Jones",
	rep_title: "Owner",
	rep_email: "pat@acme.example",
	rep_phone: "+15125550101",
	privacy_url: "https://acme.example/privacy",
	terms_url: "https://acme.example/terms",
	area_code: "512",
	...over,
});

function restError(status: number, code?: number, message = "nope") {
	return Object.assign(new Error(message), { status, code });
}

// A Twilio client double: every create() returns a sid and records its args.
function fakeClient() {
	let n = 0;
	const sid = (p: string) => `${p}${++n}`;
	const calls: { path: string; args: unknown }[] = [];
	const rec = <T>(path: string, result: (args: any) => T) =>
		vi.fn(async (args?: any) => {
			calls.push({ path, args });
			return result(args);
		});

	const profileAssign = rec("customerProfiles.assign", () => ({
		sid: sid("BV"),
	}));
	const profileEval = rec("customerProfiles.evaluate", () => ({
		status: "compliant",
		results: [],
	}));
	const profileUpdate = rec("customerProfiles.update", (a) => ({
		status: a.status,
	}));
	const tpAssign = rec("trustProducts.assign", () => ({ sid: sid("BV") }));
	const tpEval = rec("trustProducts.evaluate", () => ({
		status: "compliant",
		results: [],
	}));
	const tpUpdate = rec("trustProducts.update", (a) => ({ status: a.status }));
	const brandFetch = vi.fn();
	const campaignFetch = vi.fn();
	const campaignCreate = rec("usAppToPerson.create", () => ({
		sid: "QEcamp",
	}));
	const svcPhoneCreate = rec("services.phoneNumbers.create", () => ({
		sid: "PNx",
	}));
	const svcPhoneFetch = vi.fn(async () => ({ sid: "PNx" }));
	const campaignRemove = rec("usAppToPerson.remove", () => true);
	const incomingList = vi.fn(async () => [] as unknown[]);
	const localList = vi.fn();
	const incomingCreate = rec("incomingPhoneNumbers.create", (a) => ({
		sid: "PNbought",
		phoneNumber: a.phoneNumber,
	}));
	const messagesCreate = vi.fn();

	const client = {
		api: {
			v2010: {
				accounts: {
					create: rec("accounts.create", () => ({
						sid: "ACsub",
						authToken: SUB_TOKEN,
					})),
				},
			},
		},
		addresses: {
			create: rec("addresses.create", () => ({ sid: "ADaddr" })),
		},
		messages: { create: messagesCreate },
		availablePhoneNumbers: vi.fn(() => ({ local: { list: localList } })),
		incomingPhoneNumbers: { create: incomingCreate, list: incomingList },
		trusthub: {
			v1: {
				customerProfiles: Object.assign(
					vi.fn(() => ({
						customerProfilesEntityAssignments: {
							create: profileAssign,
						},
						customerProfilesEvaluations: { create: profileEval },
						update: profileUpdate,
					})),
					{
						create: rec("customerProfiles.create", () => ({
							sid: "BUprofile",
						})),
					},
				),
				trustProducts: Object.assign(
					vi.fn(() => ({
						trustProductsEntityAssignments: { create: tpAssign },
						trustProductsEvaluations: { create: tpEval },
						update: tpUpdate,
					})),
					{
						create: rec("trustProducts.create", () => ({
							sid: "BUtrust",
						})),
					},
				),
				endUsers: {
					create: rec("endUsers.create", () => ({ sid: sid("IT") })),
				},
				supportingDocuments: {
					create: rec("supportingDocuments.create", () => ({
						sid: "RDdoc",
					})),
				},
			},
		},
		messaging: {
			v1: {
				brandRegistrations: Object.assign(
					vi.fn(() => ({ fetch: brandFetch })),
					{
						create: rec("brandRegistrations.create", () => ({
							sid: "BNbrand",
						})),
					},
				),
				services: Object.assign(
					vi.fn(() => ({
						usAppToPerson: Object.assign(
							vi.fn(() => ({
								fetch: campaignFetch,
								remove: campaignRemove,
							})),
							{ create: campaignCreate },
						),
						phoneNumbers: Object.assign(
							vi.fn(() => ({ fetch: svcPhoneFetch })),
							{ create: svcPhoneCreate },
						),
					})),
					{
						create: rec("services.create", () => ({
							sid: "MGsvc",
						})),
					},
				),
			},
		},
	};
	return {
		client,
		calls,
		messagesCreate,
		brandFetch,
		campaignFetch,
		profileEval,
		localList,
		svcPhoneCreate,
		svcPhoneFetch,
		campaignRemove,
		campaignCreate,
		incomingList,
		incomingCreate,
	};
}

let fake: ReturnType<typeof fakeClient>;
let factory: ReturnType<typeof vi.fn>;
const provider = () => createTwilioProvider({ clientFactory: factory as any });

beforeEach(() => {
	logged.length = 0;
	fake = fakeClient();
	factory = vi.fn(() => fake.client);
	vi.stubEnv("SMS_TOKEN_ENCRYPTION_KEY", KEY_HEX);
	vi.stubEnv("TWILIO_ACCOUNT_SID", "ACparent");
	vi.stubEnv("TWILIO_AUTH_TOKEN", PARENT_TOKEN);
	vi.stubEnv("TWILIO_PRIMARY_PROFILE_SID", "BUprimary");
	vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.example");
});
afterEach(() => vi.unstubAllEnvs());

describe("twilioProvider.send", () => {
	it("sends through the org's messaging service with the subaccount's own token", async () => {
		fake.messagesCreate.mockResolvedValue({ sid: "SM1", numSegments: "0" });
		const out = await provider().send(acct(), {
			to: "+15125550100",
			body: "a".repeat(161),
			statusCallbackUrl: "https://api.example/integrations/twilio/status",
		});
		expect(factory).toHaveBeenCalledWith("ACsub", SUB_TOKEN);
		expect(fake.messagesCreate).toHaveBeenCalledWith({
			to: "+15125550100",
			body: "a".repeat(161),
			messagingServiceSid: "MGsvc",
			statusCallback: "https://api.example/integrations/twilio/status",
		});
		expect(out).toEqual({ providerMessageId: "SM1", segments: 2 });
	});

	it('twilioProvider.send maps Twilio error 21610 to SendRejected(retryable false) with message "recipient_opted_out"; 5xx is treated as outcome unknown (not SendRejected)', async () => {
		const p = { to: "+15125550100", body: "hi", statusCallbackUrl: "u" };

		fake.messagesCreate.mockRejectedValueOnce(restError(400, 21610));
		const optedOut = await provider()
			.send(acct(), p)
			.catch((e) => e);
		expect(optedOut).toBeInstanceOf(SendRejected);
		expect(optedOut.message).toBe("recipient_opted_out");
		expect(optedOut.retryable).toBe(false);

		fake.messagesCreate.mockRejectedValueOnce(restError(503, 20503));
		const down = await provider()
			.send(acct(), p)
			.catch((e) => e);
		expect(down).toBeInstanceOf(Error);
		expect(down).not.toBeInstanceOf(SendRejected);

		fake.messagesCreate.mockRejectedValueOnce(restError(500));
		const err500 = await provider()
			.send(acct(), p)
			.catch((e) => e);
		expect(err500).not.toBeInstanceOf(SendRejected);
	});

	it("a connection that never opened is a retryable rejection", async () => {
		const p = { to: "+15125550100", body: "hi", statusCallbackUrl: "u" };
		for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
			fake.messagesCreate.mockRejectedValueOnce(
				Object.assign(new Error(`connect ${code}`), { code }),
			);
			const err = await provider()
				.send(acct(), p)
				.catch((e) => e);
			expect(err).toBeInstanceOf(SendRejected);
			expect(err.retryable).toBe(true);
		}
		fake.messagesCreate.mockRejectedValueOnce(
			Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
		);
		const reset = await provider()
			.send(acct(), p)
			.catch((e) => e);
		expect(reset).not.toBeInstanceOf(SendRejected);
	});

	it("4xx validation codes are rejected for good", async () => {
		const p = { to: "+15125550100", body: "hi", statusCallbackUrl: "u" };
		for (const code of [21211, 21408, 21614]) {
			fake.messagesCreate.mockRejectedValueOnce(restError(400, code));
			const err = await provider()
				.send(acct(), p)
				.catch((e) => e);
			expect(err).toBeInstanceOf(SendRejected);
			expect(err.retryable).toBe(false);
		}
	});

	it("rate limits retry; other 4xx are rejected for good", async () => {
		const p = { to: "+15125550100", body: "hi", statusCallbackUrl: "u" };
		fake.messagesCreate.mockRejectedValueOnce(restError(429, 20429));
		const limited = await provider()
			.send(acct(), p)
			.catch((e) => e);
		expect(limited).toBeInstanceOf(SendRejected);
		expect(limited.retryable).toBe(true);

		fake.messagesCreate.mockRejectedValueOnce(
			restError(400, 21211, "Invalid 'To'"),
		);
		const bad = await provider()
			.send(acct(), p)
			.catch((e) => e);
		expect(bad).toBeInstanceOf(SendRejected);
		expect(bad.retryable).toBe(false);
		expect(bad.message).toContain("21211");
	});

	it("a failure with no HTTP status is outcome-unknown (not SendRejected) and carries no request config", async () => {
		const net = Object.assign(new Error("socket hang up"), {
			config: { auth: { username: "ACsub", password: SUB_TOKEN } },
		});
		fake.messagesCreate.mockRejectedValueOnce(net);
		const err = await provider()
			.send(acct(), {
				to: "+15125550100",
				body: "hi",
				statusCallbackUrl: "u",
			})
			.catch((e) => e);
		expect(err).not.toBeInstanceOf(SendRejected);
		expect(err.message).toContain("socket hang up");
		expect(
			JSON.stringify(err, Object.getOwnPropertyNames(err)),
		).not.toContain(SUB_TOKEN);
	});

	it("an undecryptable token or missing key is sms_credentials_unavailable (not retried, nothing reached Twilio)", async () => {
		const msg = { to: "+15125550100", body: "hi", statusCallbackUrl: "u" };
		const err = await provider()
			.send({ ...acct(), auth_token_enc: "garbage" }, msg)
			.catch((e) => e);
		expect(err).toBeInstanceOf(SendRejected);
		expect(err.message).toBe("sms_credentials_unavailable");
		expect(err.retryable).toBe(false);

		const good = acct();
		vi.stubEnv("SMS_TOKEN_ENCRYPTION_KEY", "");
		const noKey = await provider()
			.send(good, msg)
			.catch((e) => e);
		expect(noKey).toBeInstanceOf(SendRejected);
		expect(noKey.message).toBe("sms_credentials_unavailable");
		expect(noKey.retryable).toBe(false);
		expect(fake.messagesCreate).not.toHaveBeenCalled();
	});

	it("Twilio code 20429 is a retryable rate limit whatever the HTTP status", async () => {
		fake.messagesCreate.mockRejectedValueOnce(restError(400, 20429));
		const err = await provider()
			.send(acct(), {
				to: "+15125550100",
				body: "hi",
				statusCallbackUrl: "u",
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(SendRejected);
		expect(err.retryable).toBe(true);
	});
});

describe("twilioProvider.validateWebhook", () => {
	const url = "https://api.example/integrations/twilio/sms";
	const params = { AccountSid: "ACsub", Body: "STOP", From: "+15125550100" };

	it("accepts a signature made with the subaccount token and rejects any other", () => {
		const good = twilio.getExpectedTwilioSignature(SUB_TOKEN, url, params);
		const other = twilio.getExpectedTwilioSignature(
			"someone-else",
			url,
			params,
		);
		expect(
			provider().validateWebhook(acct(), {
				url,
				params,
				signature: good,
			}),
		).toBe(true);
		expect(
			provider().validateWebhook(acct(), {
				url,
				params,
				signature: other,
			}),
		).toBe(false);
		expect(
			provider().validateWebhook(acct(), {
				url,
				params: { ...params, Body: "START" },
				signature: good,
			}),
		).toBe(false);
	});

	it("an undecryptable token validates nothing", () => {
		const good = twilio.getExpectedTwilioSignature(SUB_TOKEN, url, params);
		expect(
			provider().validateWebhook(
				{ ...acct(), auth_token_enc: "garbage" },
				{ url, params, signature: good },
			),
		).toBe(false);
	});
});

describe("twilioProvider.startRegistration", () => {
	it("creates a subaccount, a secondary profile, an A2P trust product, a brand and a messaging service", async () => {
		const out = await provider().startRegistration("org-1", form());

		expect(factory).toHaveBeenNthCalledWith(1, "ACparent", PARENT_TOKEN);
		expect(factory).toHaveBeenNthCalledWith(2, "ACsub", SUB_TOKEN);
		const paths = fake.calls.map((c) => c.path);
		expect(paths[0]).toBe("accounts.create");

		const profile = fake.calls.find(
			(c) => c.path === "customerProfiles.create",
		)!;
		expect(profile.args).toMatchObject({
			policySid: "RNdfbf3fae0e1107f8aded0e7cead80bf5",
			email: "help@acme.example",
		});
		const endUserTypes = fake.calls
			.filter((c) => c.path === "endUsers.create")
			.map((c) => (c.args as any).type);
		expect(endUserTypes).toEqual([
			"customer_profile_business_information",
			"authorized_representative_1",
			"us_a2p_messaging_profile_information",
		]);
		const business = fake.calls.find(
			(c) =>
				(c.args as any)?.type ===
				"customer_profile_business_information",
		)!.args as any;
		expect(business.attributes).toMatchObject({
			business_name: "Acme Heating LLC",
			business_registration_identifier: "EIN",
			business_registration_number: "12-3456789",
			business_identity: "direct_customer",
		});
		const rep = fake.calls.find(
			(c) => (c.args as any)?.type === "authorized_representative_1",
		)!.args as any;
		expect(rep.attributes).toMatchObject({
			first_name: "Pat",
			last_name: "Lee Jones",
		});

		const assigned = fake.calls
			.filter((c) => c.path === "customerProfiles.assign")
			.map((c) => (c.args as any).objectSid);
		expect(assigned).toContain("BUprimary");
		expect(assigned).toContain("RDdoc");

		expect(
			fake.calls.find((c) => c.path === "customerProfiles.update")!.args,
		).toEqual({
			status: "pending-review",
		});
		expect(
			fake.calls.find((c) => c.path === "trustProducts.create")!.args,
		).toMatchObject({
			policySid: "RNb0d4771c2c98518d916a3d4cd70a8f8b",
		});
		expect(
			fake.calls.find((c) => c.path === "brandRegistrations.create")!
				.args,
		).toEqual({
			customerProfileBundleSid: "BUprofile",
			a2PProfileBundleSid: "BUtrust",
			skipAutomaticSecVet: true,
		});
		expect(
			fake.calls.find((c) => c.path === "services.create")!.args,
		).toMatchObject({
			inboundRequestUrl: "https://api.example/integrations/twilio/sms",
			statusCallback: "https://api.example/integrations/twilio/status",
		});

		expect(out).toMatchObject({
			subaccount_sid: "ACsub",
			profile_sid: "BUprofile",
			brand_sid: "BNbrand",
			messaging_service_sid: "MGsvc",
		});
		expect(decryptSecret(out.auth_token_enc!, KEY)).toBe(SUB_TOKEN);
	});

	it("with no EIN it files a sole-proprietor starter profile and brand", async () => {
		await provider().startRegistration(
			"org-1",
			form({ ein: undefined, sole_prop_mobile: "+15125550199" }),
		);
		expect(
			fake.calls.find((c) => c.path === "customerProfiles.create")!.args,
		).toMatchObject({
			policySid: "RN806dd6cd175f314e1f96a9727ee271f4",
		});
		expect(
			fake.calls.find((c) => c.path === "trustProducts.create")!.args,
		).toMatchObject({
			policySid: "RN670d5d2e282a6130ae063b234b6019c8",
		});
		const sp = fake.calls.find(
			(c) => (c.args as any)?.type === "sole_proprietor_information",
		)!.args as any;
		expect(sp.attributes).toMatchObject({
			mobile_phone_number: "+15125550199",
		});
		expect(
			fake.calls.find((c) => c.path === "brandRegistrations.create")!
				.args,
		).toEqual({
			customerProfileBundleSid: "BUprofile",
			a2PProfileBundleSid: "BUtrust",
			brandType: "SOLE_PROPRIETOR",
		});
	});

	it("a noncompliant evaluation stops with the provider's reasons", async () => {
		fake.profileEval.mockResolvedValueOnce({
			status: "noncompliant",
			results: [
				{
					friendly_name: "Business Information",
					failure_reason: "Website is invalid",
				},
			],
		});
		const err = await provider()
			.startRegistration("org-1", form())
			.catch((e) => e);
		expect(err).toBeInstanceOf(SmsRegistrationError);
		expect(err.reason).toContain("Website is invalid");
		expect(err.partial).toMatchObject({
			subaccount_sid: "ACsub",
			profile_sid: "BUprofile",
		});
		expect(
			fake.calls.some((c) => c.path === "brandRegistrations.create"),
		).toBe(false);
	});

	it("checks every setting before creating anything at Twilio", async () => {
		for (const name of [
			"SMS_TOKEN_ENCRYPTION_KEY",
			"TWILIO_PRIMARY_PROFILE_SID",
			"BACKEND_PUBLIC_URL",
			"TWILIO_ACCOUNT_SID",
			"TWILIO_AUTH_TOKEN",
		]) {
			const saved = process.env[name];
			vi.stubEnv(name, "");
			const err = await provider()
				.startRegistration("org-1", form())
				.catch((e) => e);
			expect(err.message, name).toContain(name);
			vi.stubEnv(name, saved as string);
		}
		expect(fake.calls).toEqual([]);
	});

	it("a failure part-way carries the ids created so far, and a retry with them reuses the subaccount", async () => {
		const brandCreate = fake.client.messaging.v1.brandRegistrations
			.create as unknown as ReturnType<typeof vi.fn>;
		brandCreate.mockRejectedValueOnce(
			restError(400, 70002, "brand refused"),
		);
		const err = await provider()
			.startRegistration("org-1", form())
			.catch((e) => e);
		expect(err).toBeInstanceOf(SmsRegistrationError);
		expect(err.reason).toContain("brand refused");
		expect(err.partial).toMatchObject({
			subaccount_sid: "ACsub",
			profile_sid: "BUprofile",
		});
		expect(decryptSecret(err.partial.auth_token_enc, KEY)).toBe(SUB_TOKEN);
		expect(err.partial.brand_sid).toBeUndefined();

		fake.calls.length = 0;
		factory.mockClear();
		const out = await provider().startRegistration(
			"org-1",
			form(),
			err.partial,
		);
		expect(fake.calls.some((c) => c.path === "accounts.create")).toBe(
			false,
		);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(factory).toHaveBeenCalledWith("ACsub", SUB_TOKEN);
		expect(out).toMatchObject({
			subaccount_sid: "ACsub",
			brand_sid: "BNbrand",
			messaging_service_sid: "MGsvc",
		});

		// With a brand and service already filed, nothing is created again.
		fake.calls.length = 0;
		await provider().startRegistration("org-1", form(), out);
		expect(fake.calls).toEqual([]);
	});
});

describe("twilioProvider.pollRegistration", () => {
	it("maps brand and campaign states onto the account status", async () => {
		const p = provider();
		fake.brandFetch.mockResolvedValueOnce({ status: "IN_REVIEW" });
		expect((await p.pollRegistration(ids())).status).toBe("brand_pending");

		fake.brandFetch.mockResolvedValueOnce({
			status: "FAILED",
			errors: [
				{ code: 30794, description: "EIN does not match legal name" },
			],
			failureReason: "",
		});
		expect(await p.pollRegistration(ids())).toEqual({
			status: "failed",
			failedStep: "brand",
			failureReason: "EIN does not match legal name",
			patch: {},
		});

		fake.brandFetch.mockResolvedValueOnce({
			status: "APPROVED",
			brandType: "SOLE_PROPRIETOR",
			identityStatus: "UNVERIFIED",
		});
		expect((await p.pollRegistration(ids())).status).toBe("brand_pending");

		fake.brandFetch.mockResolvedValueOnce({
			status: "APPROVED",
			brandType: "STANDARD",
		});
		expect(await p.pollRegistration(ids())).toEqual({
			status: "campaign_pending",
			patch: {},
		});

		fake.brandFetch.mockResolvedValue({
			status: "APPROVED",
			brandType: "STANDARD",
		});
		fake.campaignFetch.mockResolvedValueOnce({
			campaignStatus: "IN_PROGRESS",
		});
		expect(
			(await p.pollRegistration(ids({ campaign_sid: "QEcamp" }))).status,
		).toBe("campaign_pending");
		fake.campaignFetch.mockResolvedValueOnce({
			campaignStatus: "VERIFIED",
		});
		expect(
			await p.pollRegistration(ids({ campaign_sid: "QEcamp" })),
		).toEqual({ status: "campaign_pending", needsNumber: true, patch: {} });
		fake.campaignFetch.mockResolvedValueOnce({
			campaignStatus: "VERIFIED",
		});
		expect(
			(
				await p.pollRegistration(
					ids({ campaign_sid: "QEcamp", phone_number_sid: "PNx" }),
				)
			).status,
		).toBe("active");
		// Recorded but never attached: provision again.
		fake.campaignFetch.mockResolvedValueOnce({
			campaignStatus: "VERIFIED",
		});
		fake.svcPhoneFetch.mockRejectedValueOnce(restError(404, 20404));
		expect(
			await p.pollRegistration(
				ids({ campaign_sid: "QEcamp", phone_number_sid: "PNx" }),
			),
		).toEqual({ status: "campaign_pending", needsNumber: true, patch: {} });
		fake.campaignFetch.mockResolvedValueOnce({
			campaignStatus: "FAILED",
			errors: [{ description: "Message samples do not match use case" }],
		});
		expect(
			await p.pollRegistration(ids({ campaign_sid: "QEcamp" })),
		).toEqual({
			status: "failed",
			failedStep: "campaign",
			failureReason: "Message samples do not match use case",
			patch: {},
		});

		fake.brandFetch.mockResolvedValueOnce({ status: "SUSPENDED" });
		expect((await p.pollRegistration(ids())).status).toBe("suspended");

		for (const deleting of ["DELETION_PENDING", "DELETION_FAILED"]) {
			fake.brandFetch.mockResolvedValueOnce({ status: deleting });
			const r = await p.pollRegistration(ids());
			expect(r.status).toBe("failed");
			expect(r.failureReason).toMatch(/deleted/);
		}
	});

	it("with no brand yet the account stays submitted", async () => {
		expect(
			(await provider().pollRegistration(ids({ brand_sid: null })))
				.status,
		).toBe("submitted");
		expect(fake.brandFetch).not.toHaveBeenCalled();
	});
});

describe("twilioProvider.createCampaign / provisionNumber", () => {
	it("creates a Low Volume Mixed campaign, or SOLE_PROPRIETOR for a sole prop", async () => {
		const content = {
			soleProprietor: false,
			description: "Appointment notices",
			messageFlow: "Customers give their mobile number when booking.",
			messageSamples: ["a", "b"],
			hasEmbeddedLinks: true,
			hasEmbeddedPhone: false,
		};
		expect(await provider().createCampaign(ids(), content)).toEqual({
			campaign_sid: "QEcamp",
		});
		expect(
			fake.calls.find((c) => c.path === "usAppToPerson.create")!.args,
		).toMatchObject({
			brandRegistrationSid: "BNbrand",
			usAppToPersonUsecase: "LOW_VOLUME",
		});

		await provider().createCampaign(ids(), {
			...content,
			soleProprietor: true,
		});
		expect(
			fake.calls.filter((c) => c.path === "usAppToPerson.create")[1].args,
		).toMatchObject({ usAppToPersonUsecase: "SOLE_PROPRIETOR" });
	});

	it("buys in the area code first, falls back to the region, and attaches the number", async () => {
		fake.localList
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ phoneNumber: "+17375550100" }]);
		fake.svcPhoneFetch.mockRejectedValueOnce(restError(404, 20404));
		const out = await provider().provisionNumber(ids(), {
			areaCode: "512",
			region: "TX",
			isoCountry: "US",
		});
		expect(fake.localList).toHaveBeenNthCalledWith(1, {
			areaCode: 512,
			smsEnabled: true,
			limit: 1,
		});
		expect(fake.localList).toHaveBeenNthCalledWith(2, {
			inRegion: "TX",
			smsEnabled: true,
			limit: 1,
		});
		expect(fake.svcPhoneCreate).toHaveBeenCalledWith({
			phoneNumberSid: "PNbought",
		});
		expect(out).toEqual({
			phone_number: "+17375550100",
			phone_number_sid: "PNbought",
		});
	});
});

describe("twilioProvider registration retries", () => {
	it("a failed attach after a purchase carries the bought number, and the next try reuses it without buying", async () => {
		const p = provider();
		fake.localList.mockResolvedValueOnce([{ phoneNumber: "+15125550199" }]);
		fake.svcPhoneFetch.mockRejectedValue(restError(404, 20404));
		fake.svcPhoneCreate.mockRejectedValueOnce(restError(400, 21712, "bad"));
		const err = await p
			.provisionNumber(ids({ campaign_sid: "QEcamp" }), {
				areaCode: "512",
				region: "TX",
				isoCountry: "US",
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(SmsRegistrationError);
		expect(err.partial).toEqual({
			phone_number: "+15125550199",
			phone_number_sid: "PNbought",
		});
		expect(fake.incomingCreate).toHaveBeenCalledTimes(1);

		// Not recorded (say our write failed): the subaccount still has it.
		fake.incomingList.mockResolvedValueOnce([
			{ sid: "PNbought", phoneNumber: "+15125550199" },
		]);
		expect(
			await p.provisionNumber(ids({ campaign_sid: "QEcamp" }), {
				areaCode: "512",
				region: "TX",
				isoCountry: "US",
			}),
		).toEqual({
			phone_number: "+15125550199",
			phone_number_sid: "PNbought",
		});
		expect(fake.incomingCreate).toHaveBeenCalledTimes(1);
		expect(fake.localList).toHaveBeenCalledTimes(1);
		expect(fake.svcPhoneCreate).toHaveBeenCalledTimes(2);
	});

	it("a transient attach error is retried, not refused, and the next try does not buy again", async () => {
		const p = provider();
		fake.localList.mockResolvedValueOnce([{ phoneNumber: "+15125550199" }]);
		fake.svcPhoneFetch.mockRejectedValue(restError(404, 20404));
		fake.svcPhoneCreate.mockRejectedValueOnce(restError(503, 20503));
		const err = await p
			.provisionNumber(ids({ campaign_sid: "QEcamp" }), {
				areaCode: "512",
				region: "TX",
				isoCountry: "US",
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(SmsRegistrationError);

		fake.incomingList.mockResolvedValueOnce([
			{ sid: "PNbought", phoneNumber: "+15125550199" },
		]);
		await p.provisionNumber(ids({ campaign_sid: "QEcamp" }), {
			areaCode: "512",
			region: "TX",
			isoCountry: "US",
		});
		expect(fake.incomingCreate).toHaveBeenCalledTimes(1);
	});

	it("an already attached number is not attached twice", async () => {
		const out = await provider().provisionNumber(
			ids({ phone_number: "+15125550199", phone_number_sid: "PNx" }),
			{ areaCode: "512", region: "TX", isoCountry: "US" },
		);
		expect(out.phone_number_sid).toBe("PNx");
		expect(fake.svcPhoneCreate).not.toHaveBeenCalled();
		expect(fake.incomingList).not.toHaveBeenCalled();
	});

	it("deleteCampaign removes the campaign and treats 404 as done; a 4xx from createCampaign is a registration error", async () => {
		const p = provider();
		await p.deleteCampaign(ids({ campaign_sid: "QEold" }));
		expect(fake.campaignRemove).toHaveBeenCalledTimes(1);
		fake.campaignRemove.mockRejectedValueOnce(restError(404, 20404));
		await expect(
			p.deleteCampaign(ids({ campaign_sid: "QEold" })),
		).resolves.toBeUndefined();
		await p.deleteCampaign(ids());
		expect(fake.campaignRemove).toHaveBeenCalledTimes(2);

		const content = {
			soleProprietor: false,
			description: "d",
			messageFlow: "f",
			messageSamples: ["a", "b"],
			hasEmbeddedLinks: false,
			hasEmbeddedPhone: false,
		};
		fake.campaignCreate.mockRejectedValueOnce(
			restError(400, 21701, "Brand not approved"),
		);
		const err = await p.createCampaign(ids(), content).catch((e) => e);
		expect(err).toBeInstanceOf(SmsRegistrationError);
		expect(err.reason).toBe("Twilio 21701: Brand not approved");
	});
});

describe("logging", () => {
	it("the adapter never logs the auth token", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(m) => vi.spyOn(console, m).mockImplementation(() => {}),
		);
		const p = provider();
		const msg = { to: "+15125550100", body: "hi", statusCallbackUrl: "u" };
		fake.messagesCreate.mockResolvedValueOnce({
			sid: "SM1",
			numSegments: "1",
		});
		await p.send(acct(), msg);
		for (const e of [
			restError(400, 21610),
			restError(503, 20503),
			restError(400, 21211),
			Object.assign(new Error("socket hang up"), {
				config: { auth: { username: "ACsub", password: SUB_TOKEN } },
			}),
		]) {
			fake.messagesCreate.mockRejectedValueOnce(e);
			await p.send(acct(), msg).catch(() => {});
		}
		await p.startRegistration("org-1", form());
		fake.brandFetch.mockRejectedValueOnce(restError(500));
		await p.pollRegistration(ids()).catch(() => {});

		await p
			.send({ ...acct(), auth_token_enc: "garbage" }, msg)
			.catch(() => {});
		expect(logged.some((l) => l[2] === "SMS credentials unavailable")).toBe(
			true,
		);

		const brandCreate = fake.client.messaging.v1.brandRegistrations
			.create as unknown as ReturnType<typeof vi.fn>;
		brandCreate.mockRejectedValueOnce(
			Object.assign(new Error("socket hang up"), {
				config: { auth: { username: "ACsub", password: SUB_TOKEN } },
			}),
		);
		const regErr = await p
			.startRegistration("org-1", form())
			.catch((e) => e);
		expect(regErr).toBeInstanceOf(SmsRegistrationError);
		expect(regErr.partial.subaccount_sid).toBe("ACsub");
		expect(
			logged.some((l) => l[2] === "SMS registration step failed"),
		).toBe(true);
		const partial = JSON.stringify(regErr.partial);
		expect(partial).not.toContain(SUB_TOKEN);
		expect(partial).not.toContain(PARENT_TOKEN);
		expect(
			JSON.stringify(regErr, Object.getOwnPropertyNames(regErr)),
		).not.toContain(SUB_TOKEN);

		const seen = JSON.stringify([
			logged,
			...spies.map((s) => s.mock.calls),
		]);
		expect(logged.length).toBeGreaterThan(0);
		expect(seen).not.toContain(SUB_TOKEN);
		expect(seen).not.toContain(PARENT_TOKEN);
		for (const s of spies) s.mockRestore();
	});
});
