import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import {
	handleInboundSms,
	handleStatusCallback,
	twilioWebhookUrl,
	type TwilioParams,
} from "../services/sms/inbound.js";
import { smsProvider } from "../services/sms/provider.js";

// Public: Twilio is the caller. Each request is authenticated by its
// X-Twilio-Signature, checked with the auth token of the subaccount named in
// AccountSid, so one org's token can never write into another org.
const router = Router();

const EMPTY_TWIML =
	'<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

// Once at boot, not per request: without the base no signature can verify.
if (!process.env.BACKEND_PUBLIC_URL)
	log.warn("BACKEND_PUBLIC_URL is not set; Twilio webhooks will answer 403");

const paramsOf = (req: Request): TwilioParams =>
	req.body && typeof req.body === "object" ? (req.body as TwilioParams) : {};

async function verifyTwilio(req: Request, res: Response, next: NextFunction) {
	const params = paramsOf(req);
	const accountSid =
		typeof params.AccountSid === "string" ? params.AccountSid : "";
	const signature = req.get("x-twilio-signature") ?? "";
	const url = twilioWebhookUrl(req.originalUrl);
	// Malformed or unconfigured: refused before any lookup or log line.
	if (!url || !signature || !ACCOUNT_SID.test(accountSid)) {
		res.sendStatus(403);
		return;
	}
	const reject = (reason: string) => {
		log.warn(
			{ accountSid, path: req.path, reason },
			"Twilio webhook rejected",
		);
		res.sendStatus(403);
	};

	// Root db on purpose: the org is not known until the account is found.
	const acct = await db.org_sms_account.findUnique({
		where: { subaccount_sid: accountSid },
		select: {
			organization_id: true,
			subaccount_sid: true,
			auth_token_enc: true,
			messaging_service_sid: true,
		},
	});
	if (!acct?.subaccount_sid || !acct.auth_token_enc)
		return reject("unknown account");

	const valid = smsProvider.validateWebhook(
		{
			subaccount_sid: acct.subaccount_sid,
			auth_token_enc: acct.auth_token_enc,
			messaging_service_sid: acct.messaging_service_sid ?? "",
		},
		{ url, params: params as Record<string, string>, signature },
	);
	if (!valid) return reject("bad signature");
	res.locals.orgId = acct.organization_id;
	next();
}

router.post("/sms", verifyTwilio, async (req, res) => {
	try {
		await handleInboundSms(res.locals.orgId as string, paramsOf(req));
	} catch (err) {
		log.error(
			{ err, orgId: res.locals.orgId, sid: paramsOf(req).MessageSid },
			"Inbound SMS processing failed",
		);
		res.sendStatus(500);
		return;
	}
	// Empty TwiML: no reply. Twilio answers STOP/START/HELP itself.
	res.type("text/xml").send(EMPTY_TWIML);
});

router.post("/status", verifyTwilio, async (req, res) => {
	try {
		const m = req.query.m;
		await handleStatusCallback(
			res.locals.orgId as string,
			paramsOf(req),
			typeof m === "string" ? m : undefined,
		);
	} catch (err) {
		log.error(
			{ err, orgId: res.locals.orgId, sid: paramsOf(req).MessageSid },
			"SMS status callback failed",
		);
		res.sendStatus(500);
		return;
	}
	res.sendStatus(200);
});

export default router;
