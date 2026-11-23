import twilio from "twilio";
import { log } from "../appLogger.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { SendRejected } from "../customerComms/channels/types.js";
import { SmsRegistrationError } from "./errors.js";
import { countSegments } from "./segments.js";
import type {
	OrgSmsAccountIds,
	SmsAccountStatus,
	SmsCredentials,
	SmsProvider,
	SmsRegistrationForm,
} from "./provider.js";

type Client = twilio.Twilio;
export type ClientFactory = (accountSid: string, authToken: string) => Client;

// Trust Hub policy SIDs from Twilio's ISV onboarding docs (verified 2026-11-16).
const POLICY = {
	secondaryProfile: "RNdfbf3fae0e1107f8aded0e7cead80bf5",
	a2pTrustProduct: "RNb0d4771c2c98518d916a3d4cd70a8f8b",
	starterProfile: "RN806dd6cd175f314e1f96a9727ee271f4",
	soleProprietorTrustProduct: "RN670d5d2e282a6130ae063b234b6019c8",
};
const JOB_POSITIONS = ["Director", "GM", "VP", "CEO", "CFO", "General Counsel"];
const OPTED_OUT = 21610;

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set`);
	return v;
}

// Read per call: SMS is optional, so a missing key must not stop the server booting.
function tokenKey(): Buffer {
	const key = Buffer.from(requireEnv("SMS_TOKEN_ENCRYPTION_KEY"), "hex");
	if (key.length !== 32)
		throw new Error("SMS_TOKEN_ENCRYPTION_KEY must be 64 hex characters");
	return key;
}

const httpStatus = (err: unknown): number | null => {
	const s = (err as { status?: unknown })?.status;
	return typeof s === "number" ? s : null;
};
const twilioCode = (err: unknown): number | null => {
	const c = (err as { code?: unknown })?.code;
	return typeof c === "number" ? c : null;
};
const messageOf = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/**
 * Transport errors can carry the request config, and with it the basic-auth
 * token, so only the message survives. A Twilio API error carries no secrets.
 */
function scrub(err: unknown): unknown {
	if (httpStatus(err) !== null || err instanceof SmsRegistrationError)
		return err;
	return new Error(`Twilio request failed: ${messageOf(err)}`);
}

async function scrubbed<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		throw scrub(err);
	}
}

/**
 * For registration steps: a 4xx other than a rate limit is Twilio refusing the
 * request for good, so it becomes an SmsRegistrationError the org can act on.
 */
function refusal(err: unknown): unknown {
	const s = httpStatus(err);
	if (
		s !== null &&
		s >= 400 &&
		s < 500 &&
		s !== 429 &&
		twilioCode(err) !== 20429
	)
		return new SmsRegistrationError(
			`Twilio ${twilioCode(err) ?? s}: ${messageOf(err)}`,
		);
	return scrub(err);
}

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		throw refusal(err);
	}
}

type ServiceContext = ReturnType<Client["messaging"]["v1"]["services"]>;

async function isAttached(svc: ServiceContext, phoneNumberSid: string) {
	try {
		await svc.phoneNumbers(phoneNumberSid).fetch();
		return true;
	} catch (err) {
		if (httpStatus(err) === 404) return false;
		throw err;
	}
}

// Socket errors raised before any byte reached Twilio.
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * SMS is at-most-once once the request may have reached Twilio, and Message
 * create has no idempotency key. So only proven non-acceptance is a
 * SendRejected: a 4xx (retryable only for a rate limit), or a connection that never
 * opened. A 5xx, timeout or reset may have created the message: rethrown as
 * outcome-unknown and never retried.
 */
function classifySendError(err: unknown): unknown {
	const status = httpStatus(err);
	const code = twilioCode(err);
	if (status === null) {
		const sys = (err as { code?: unknown })?.code;
		if (typeof sys === "string" && NEVER_SENT.has(sys))
			return new SendRejected(`twilio unreachable: ${sys}`, true);
		return scrub(err);
	}
	if (status >= 500)
		return new Error(`twilio ${code ?? status}: ${messageOf(err)}`);
	if (code === OPTED_OUT)
		return new SendRejected("recipient_opted_out", false);
	return new SendRejected(
		`twilio ${code ?? status}: ${messageOf(err)}`,
		status === 429 || code === 20429,
	);
}

function splitName(full: string): { first: string; last: string } {
	const [first, ...rest] = full.trim().split(/\s+/);
	return { first, last: rest.join(" ") || first };
}

type Evaluation = { status: string; results?: unknown[] };

function evaluationReasons(ev: Evaluation): string {
	const reasons = new Set<string>();
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const n = node as Record<string, unknown>;
		if (typeof n.failure_reason === "string" && n.failure_reason)
			reasons.add(n.failure_reason);
		for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(walk);
	};
	(ev.results ?? []).forEach(walk);
	return (
		[...reasons].join("; ") ||
		"Twilio could not verify the business details"
	);
}

function assertCompliant(ev: Evaluation) {
	if (ev.status !== "compliant")
		throw new SmsRegistrationError(evaluationReasons(ev));
}

function errorsReason(errors: unknown, fallback?: string | null): string {
	const list = Array.isArray(errors) ? errors : [];
	const texts = list
		.map((e) => {
			const o = (e ?? {}) as Record<string, unknown>;
			return [o.description, o.message, o.reason].find(
				(t): t is string => typeof t === "string" && t.length > 0,
			);
		})
		.filter((t): t is string => !!t);
	return texts.join("; ") || fallback || "Twilio declined the registration";
}

export function createTwilioProvider(
	deps: { clientFactory?: ClientFactory } = {},
): SmsProvider {
	const makeClient: ClientFactory =
		deps.clientFactory ?? ((sid, token) => twilio(sid, token));

	const parentClient = () =>
		makeClient(
			requireEnv("TWILIO_ACCOUNT_SID"),
			requireEnv("TWILIO_AUTH_TOKEN"),
		);
	const subClient = (a: {
		subaccount_sid: string | null;
		auth_token_enc: string | null;
	}) => {
		if (!a.subaccount_sid || !a.auth_token_enc)
			throw new Error("SMS account has no subaccount yet");
		return makeClient(
			a.subaccount_sid,
			decryptSecret(a.auth_token_enc, tokenKey()),
		);
	};

	async function fileStandard(
		c: Client,
		orgId: string,
		form: SmsRegistrationForm,
		addressDoc: string,
		ids: Partial<OrgSmsAccountIds>,
	) {
		const profile = await c.trusthub.v1.customerProfiles.create({
			friendlyName: `${form.legal_name} (${orgId})`.slice(0, 64),
			email: form.support_email,
			policySid: POLICY.secondaryProfile,
		});
		ids.profile_sid = profile.sid;
		const business = await c.trusthub.v1.endUsers.create({
			type: "customer_profile_business_information",
			friendlyName: "Business information",
			attributes: {
				business_name: form.legal_name,
				website_url: form.website,
				business_regions_of_operation: "USA_AND_CANADA",
				business_type: form.entity_type,
				business_registration_identifier: "EIN",
				business_identity: "direct_customer",
				business_industry: form.vertical,
				business_registration_number: form.ein,
			},
		});
		const { first, last } = splitName(form.rep_name);
		const title = JOB_POSITIONS.find(
			(p) => p.toLowerCase() === form.rep_title.trim().toLowerCase(),
		);
		const rep = await c.trusthub.v1.endUsers.create({
			type: "authorized_representative_1",
			friendlyName: "Authorized representative",
			attributes: {
				first_name: first,
				last_name: last,
				email: form.rep_email,
				phone_number: form.rep_phone,
				business_title: form.rep_title,
				job_position: title ?? "Other",
			},
		});
		const p = c.trusthub.v1.customerProfiles(profile.sid);
		for (const objectSid of [
			business.sid,
			rep.sid,
			addressDoc,
			requireEnv("TWILIO_PRIMARY_PROFILE_SID"),
		])
			await p.customerProfilesEntityAssignments.create({ objectSid });
		assertCompliant(
			await p.customerProfilesEvaluations.create({
				policySid: POLICY.secondaryProfile,
			}),
		);
		await p.update({ status: "pending-review" });

		const trust = await c.trusthub.v1.trustProducts.create({
			friendlyName: `${form.legal_name} A2P profile`.slice(0, 64),
			email: form.support_email,
			policySid: POLICY.a2pTrustProduct,
		});
		const a2p = await c.trusthub.v1.endUsers.create({
			type: "us_a2p_messaging_profile_information",
			friendlyName: "A2P messaging profile",
			attributes: {
				company_type:
					form.entity_type === "Non-profit Corporation"
						? "non-profit"
						: "private",
			},
		});
		const t = c.trusthub.v1.trustProducts(trust.sid);
		for (const objectSid of [a2p.sid, profile.sid])
			await t.trustProductsEntityAssignments.create({ objectSid });
		assertCompliant(
			await t.trustProductsEvaluations.create({
				policySid: POLICY.a2pTrustProduct,
			}),
		);
		await t.update({ status: "pending-review" });

		// Low-volume standard brand: secondary vetting is only needed above
		// ~6,000 segments a day, far beyond any plan's meter.
		const brand = await c.messaging.v1.brandRegistrations.create({
			customerProfileBundleSid: profile.sid,
			a2PProfileBundleSid: trust.sid,
			skipAutomaticSecVet: true,
		});
		return { profile_sid: profile.sid, brand_sid: brand.sid };
	}

	async function fileSoleProprietor(
		c: Client,
		orgId: string,
		form: SmsRegistrationForm,
		addressDoc: string,
		ids: Partial<OrgSmsAccountIds>,
	) {
		const { first, last } = splitName(form.rep_name);
		const profile = await c.trusthub.v1.customerProfiles.create({
			friendlyName: `${form.legal_name} (${orgId})`.slice(0, 64),
			email: form.rep_email,
			policySid: POLICY.starterProfile,
		});
		ids.profile_sid = profile.sid;
		const person = await c.trusthub.v1.endUsers.create({
			type: "starter_customer_profile_information",
			friendlyName: "Starter profile end user",
			attributes: {
				first_name: first,
				last_name: last,
				email: form.rep_email,
				phone_number: form.rep_phone,
			},
		});
		const p = c.trusthub.v1.customerProfiles(profile.sid);
		for (const objectSid of [
			person.sid,
			addressDoc,
			requireEnv("TWILIO_PRIMARY_PROFILE_SID"),
		])
			await p.customerProfilesEntityAssignments.create({ objectSid });
		assertCompliant(
			await p.customerProfilesEvaluations.create({
				policySid: POLICY.starterProfile,
			}),
		);
		await p.update({ status: "pending-review" });

		const trust = await c.trusthub.v1.trustProducts.create({
			friendlyName: `${form.legal_name} sole proprietor`.slice(0, 64),
			email: form.rep_email,
			policySid: POLICY.soleProprietorTrustProduct,
		});
		const sp = await c.trusthub.v1.endUsers.create({
			type: "sole_proprietor_information",
			friendlyName: "Sole proprietor",
			attributes: {
				brand_name: form.dba || form.legal_name,
				vertical: form.vertical,
				mobile_phone_number: form.sole_prop_mobile,
			},
		});
		const t = c.trusthub.v1.trustProducts(trust.sid);
		for (const objectSid of [sp.sid, profile.sid])
			await t.trustProductsEntityAssignments.create({ objectSid });
		assertCompliant(
			await t.trustProductsEvaluations.create({
				policySid: POLICY.soleProprietorTrustProduct,
			}),
		);
		await t.update({ status: "pending-review" });

		const brand = await c.messaging.v1.brandRegistrations.create({
			customerProfileBundleSid: profile.sid,
			a2PProfileBundleSid: trust.sid,
			brandType: "SOLE_PROPRIETOR",
		});
		return { profile_sid: profile.sid, brand_sid: brand.sid };
	}

	return {
		async send(acct, p) {
			let client: Client;
			try {
				client = subClient(acct);
			} catch (err) {
				log.warn(
					{ subaccount: acct.subaccount_sid, reason: messageOf(err) },
					"SMS credentials unavailable",
				);
				throw new SendRejected("sms_credentials_unavailable", false);
			}
			try {
				const msg = await client.messages.create({
					to: p.to,
					body: p.body,
					messagingServiceSid: acct.messaging_service_sid,
					statusCallback: p.statusCallbackUrl,
				});
				// num_segments is 0 at creation for Messaging Service sends.
				const reported = Number.parseInt(msg.numSegments, 10) || 0;
				return {
					providerMessageId: msg.sid,
					segments: Math.max(
						reported,
						countSegments(p.body).segments,
					),
				};
			} catch (err) {
				const out = classifySendError(err);
				log.warn(
					{
						subaccount: acct.subaccount_sid,
						status: httpStatus(err),
						code: twilioCode(err),
						rejected: out instanceof SendRejected,
					},
					"Twilio send failed",
				);
				throw out;
			}
		},

		validateWebhook(acct, req) {
			let token: string;
			try {
				token = decryptSecret(acct.auth_token_enc, tokenKey());
			} catch {
				log.warn(
					{ subaccount: acct.subaccount_sid },
					"Twilio webhook token unreadable",
				);
				return false;
			}
			return twilio.validateRequest(
				token,
				req.signature,
				req.url,
				req.params,
			);
		},

		async startRegistration(orgId, form, existing = {}) {
			// Every setting is checked before anything is created at Twilio.
			const key = tokenKey();
			const reuse = !!(
				existing.subaccount_sid && existing.auth_token_enc
			);
			if (!reuse) {
				requireEnv("TWILIO_ACCOUNT_SID");
				requireEnv("TWILIO_AUTH_TOKEN");
			}
			requireEnv("TWILIO_PRIMARY_PROFILE_SID");
			const base = requireEnv("BACKEND_PUBLIC_URL").replace(/\/+$/, "");

			const ids: Partial<OrgSmsAccountIds> = {};
			try {
				let c: Client;
				if (reuse) {
					ids.subaccount_sid = existing.subaccount_sid;
					ids.auth_token_enc = existing.auth_token_enc;
					c = subClient(ids as OrgSmsAccountIds);
				} else {
					const sub = await parentClient().api.v2010.accounts.create({
						friendlyName: `org ${orgId}`,
					});
					ids.subaccount_sid = sub.sid;
					ids.auth_token_enc = encryptSecret(sub.authToken, key);
					c = makeClient(sub.sid, sub.authToken);
				}

				if (existing.brand_sid) {
					ids.profile_sid = existing.profile_sid;
					ids.brand_sid = existing.brand_sid;
				} else {
					const address = await c.addresses.create({
						customerName: form.legal_name,
						street: form.address.street,
						streetSecondary: form.address.street_secondary,
						city: form.address.city,
						region: form.address.region,
						postalCode: form.address.postal_code,
						isoCountry: form.address.iso_country,
					});
					const doc = await c.trusthub.v1.supportingDocuments.create({
						type: "customer_profile_address",
						friendlyName: "Business address",
						attributes: { address_sids: address.sid },
					});
					const filed = form.ein
						? await fileStandard(c, orgId, form, doc.sid, ids)
						: await fileSoleProprietor(
								c,
								orgId,
								form,
								doc.sid,
								ids,
							);
					ids.brand_sid = filed.brand_sid;
				}

				if (existing.messaging_service_sid) {
					ids.messaging_service_sid = existing.messaging_service_sid;
				} else {
					const svc = await c.messaging.v1.services.create({
						friendlyName: `${form.legal_name}`.slice(0, 64),
						inboundRequestUrl: `${base}/integrations/twilio/sms`,
						statusCallback: `${base}/integrations/twilio/status`,
					});
					ids.messaging_service_sid = svc.sid;
				}
				log.info(
					{
						orgId,
						subaccount: ids.subaccount_sid,
						brand: ids.brand_sid,
					},
					"SMS registration filed with Twilio",
				);
				return ids;
			} catch (err) {
				const reason =
					err instanceof SmsRegistrationError
						? err.reason
						: messageOf(scrub(err));
				log.warn(
					{
						orgId,
						subaccount: ids.subaccount_sid,
						status: httpStatus(err),
						code: twilioCode(err),
					},
					"SMS registration step failed",
				);
				throw new SmsRegistrationError(reason, ids);
			}
		},

		pollRegistration: (acct) =>
			scrubbed(async () => {
				if (!acct.brand_sid) return { status: "submitted", patch: {} };
				const c = subClient(acct);
				const brand = await c.messaging.v1
					.brandRegistrations(acct.brand_sid)
					.fetch();
				const status = (s: SmsAccountStatus) => ({
					status: s,
					patch: {},
				});
				const failed = (
					failedStep: "brand" | "campaign",
					failureReason: string,
				) => ({
					status: "failed" as const,
					failedStep,
					failureReason,
					patch: {},
				});

				if (brand.status === "FAILED")
					return failed(
						"brand",
						errorsReason(brand.errors, brand.failureReason),
					);
				if (
					brand.status === "DELETION_PENDING" ||
					brand.status === "DELETION_FAILED"
				)
					return failed(
						"brand",
						"The brand registration is being deleted at Twilio",
					);
				if (brand.status === "SUSPENDED") return status("suspended");
				if (brand.status !== "APPROVED") return status("brand_pending");
				// A sole proprietor's brand waits on the owner answering the OTP text.
				if (
					brand.brandType === "SOLE_PROPRIETOR" &&
					brand.identityStatus !== "VERIFIED"
				)
					return status("brand_pending");
				if (!acct.campaign_sid || !acct.messaging_service_sid)
					return status("campaign_pending");

				const svc = c.messaging.v1.services(acct.messaging_service_sid);
				const campaign = await svc
					.usAppToPerson(acct.campaign_sid)
					.fetch();
				if (campaign.campaignStatus === "VERIFIED")
					// A recorded number may have been bought but never attached.
					return acct.phone_number_sid &&
						(await isAttached(svc, acct.phone_number_sid))
						? status("active")
						: { ...status("campaign_pending"), needsNumber: true };
				if (campaign.campaignStatus === "FAILED")
					return failed("campaign", errorsReason(campaign.errors));
				return status("campaign_pending");
			}),

		createCampaign: (acct, content) =>
			refusing(async () => {
				if (!acct.messaging_service_sid || !acct.brand_sid)
					throw new Error(
						"SMS account has no brand or messaging service",
					);
				const campaign = await subClient(acct)
					.messaging.v1.services(acct.messaging_service_sid)
					.usAppToPerson.create({
						brandRegistrationSid: acct.brand_sid,
						usAppToPersonUsecase: content.soleProprietor
							? "SOLE_PROPRIETOR"
							: "LOW_VOLUME",
						description: content.description,
						messageFlow: content.messageFlow,
						messageSamples: content.messageSamples,
						hasEmbeddedLinks: content.hasEmbeddedLinks,
						hasEmbeddedPhone: content.hasEmbeddedPhone,
						privacyPolicyUrl: content.privacyPolicyUrl,
						termsAndConditionsUrl: content.termsAndConditionsUrl,
					});
				return { campaign_sid: campaign.sid };
			}),

		deleteCampaign: (acct) =>
			scrubbed(async () => {
				if (!acct.campaign_sid || !acct.messaging_service_sid) return;
				try {
					await subClient(acct)
						.messaging.v1.services(acct.messaging_service_sid)
						.usAppToPerson(acct.campaign_sid)
						.remove();
				} catch (err) {
					// Already gone is the outcome we wanted.
					if (httpStatus(err) !== 404) throw err;
				}
			}),

		provisionNumber: (acct, p) =>
			refusing(async () => {
				if (!acct.messaging_service_sid)
					throw new Error("SMS account has no messaging service");
				const c = subClient(acct);
				const svc = c.messaging.v1.services(acct.messaging_service_sid);
				// The subaccount is this org's alone, so a number already in it
				// was bought by an earlier attempt: reuse it rather than buy again.
				let num: { sid: string; phoneNumber: string } | undefined =
					acct.phone_number_sid && acct.phone_number
						? {
								sid: acct.phone_number_sid,
								phoneNumber: acct.phone_number,
							}
						: (await c.incomingPhoneNumbers.list({ limit: 1 }))[0];
				if (!num) {
					const local = c.availablePhoneNumbers(p.isoCountry).local;
					const [found] = await local.list({
						areaCode: Number(p.areaCode),
						smsEnabled: true,
						limit: 1,
					});
					const pick =
						found ??
						(
							await local.list({
								inRegion: p.region,
								smsEnabled: true,
								limit: 1,
							})
						)[0];
					if (!pick)
						throw new SmsRegistrationError(
							`No text-capable local number is available in ${p.region}`,
						);
					num = await c.incomingPhoneNumbers.create({
						phoneNumber: pick.phoneNumber,
					});
				}
				const out = {
					phone_number: num.phoneNumber,
					phone_number_sid: num.sid,
				};
				try {
					if (!(await isAttached(svc, num.sid)))
						await svc.phoneNumbers.create({
							phoneNumberSid: num.sid,
						});
				} catch (err) {
					const refused = refusal(err);
					// Only a refusal fails the registration; anything else is
					// retried next poll, which finds this number in the subaccount.
					if (!(refused instanceof SmsRegistrationError)) {
						log.warn(
							{ ...out, err: refused },
							"SMS number attach failed, will retry",
						);
						throw refused;
					}
					throw new SmsRegistrationError(
						`The number ${num.phoneNumber} could not be added to your messaging service: ${refused.reason}`,
						out,
					);
				}
				return out;
			}),
	};
}

export const twilioProvider = createTwilioProvider();
