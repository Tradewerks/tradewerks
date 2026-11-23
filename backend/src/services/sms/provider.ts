import { twilioProvider } from "./twilioProvider.js";

export { SmsRegistrationError } from "./errors.js";

export type SmsAccountStatus =
	| "draft"
	| "submitted"
	| "brand_pending"
	| "campaign_pending"
	| "active"
	| "failed"
	| "suspended";

/** What the adapter needs to send for one org; the token stays encrypted. */
export interface SmsCredentials {
	subaccount_sid: string;
	auth_token_enc: string;
	messaging_service_sid: string;
}

/** The provider-side ids stored on org_sms_account (same column names). */
export interface OrgSmsAccountIds {
	subaccount_sid: string | null;
	auth_token_enc: string | null;
	profile_sid: string | null;
	brand_sid: string | null;
	messaging_service_sid: string | null;
	campaign_sid: string | null;
	phone_number: string | null;
	phone_number_sid: string | null;
}

export interface SmsAddress {
	street: string;
	street_secondary?: string;
	city: string;
	region: string; // two-letter state or province
	postal_code: string;
	iso_country: "US" | "CA";
}

export interface SmsRegistrationForm {
	legal_name: string;
	dba?: string;
	ein?: string;
	entity_type: string;
	vertical: string;
	address: SmsAddress;
	website: string;
	support_email: string;
	support_phone: string;
	rep_name: string;
	rep_title: string;
	rep_email: string;
	rep_phone: string;
	sole_prop_mobile?: string;
	privacy_url: string;
	terms_url: string;
	area_code: string;
}

export interface SmsCampaignContent {
	soleProprietor: boolean;
	description: string;
	messageFlow: string;
	messageSamples: string[];
	hasEmbeddedLinks: boolean;
	hasEmbeddedPhone: boolean;
	privacyPolicyUrl?: string;
	termsAndConditionsUrl?: string;
}

export type SmsRegistrationStep = "brand" | "campaign" | "number";

export interface SmsProvider {
	send(
		acct: SmsCredentials,
		p: { to: string; body: string; statusCallbackUrl: string },
	): Promise<{ providerMessageId: string; segments: number }>;
	validateWebhook(
		acct: SmsCredentials,
		req: { url: string; params: Record<string, string>; signature: string },
	): boolean;
	/**
	 * Pass the ids from an earlier failed attempt (SmsRegistrationError.partial)
	 * to reuse its subaccount, brand and messaging service.
	 */
	startRegistration(
		orgId: string,
		form: SmsRegistrationForm,
		existing?: Partial<OrgSmsAccountIds>,
	): Promise<Partial<OrgSmsAccountIds>>;
	/**
	 * Stays `campaign_pending` with no campaign_sid once the brand is approved
	 * (the caller generates the content and calls createCampaign), and with
	 * `needsNumber` once the campaign is verified but no number is attached
	 * (the caller calls provisionNumber). `active` only with a number.
	 */
	pollRegistration(acct: OrgSmsAccountIds): Promise<{
		status: SmsAccountStatus;
		failureReason?: string;
		/** Which registration step `failed` refers to. */
		failedStep?: "brand" | "campaign";
		needsNumber?: boolean;
		patch: Partial<OrgSmsAccountIds>;
	}>;
	createCampaign(
		acct: OrgSmsAccountIds,
		content: SmsCampaignContent,
	): Promise<Pick<OrgSmsAccountIds, "campaign_sid">>;
	/** Removes a campaign that failed or belongs to a failed brand, so a new one can be filed. */
	deleteCampaign(acct: OrgSmsAccountIds): Promise<void>;
	/**
	 * Attaches a local number: the one already recorded or already in the
	 * subaccount if any, else buys one (area code first, then the region).
	 * An attach failure after a purchase throws SmsRegistrationError with the
	 * bought number in `partial`.
	 */
	provisionNumber(
		acct: OrgSmsAccountIds,
		p: { areaCode: string; region: string; isoCountry: "US" | "CA" },
	): Promise<Pick<OrgSmsAccountIds, "phone_number" | "phone_number_sid">>;
}

export const smsProvider: SmsProvider = twilioProvider;
