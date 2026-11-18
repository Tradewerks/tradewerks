import { Router, type Request } from "express";
import { z } from "zod";
import { respondToQuote } from "../controllers/quotesController.js";
import { getScopedDb } from "../lib/context.js";
import { resolveLink, type ResolvedLink } from "../lib/publicLink.js";
import {
	documentPdfTokenLimiter,
	oneClickIpLimiter,
	oneClickTokenLimiter,
	publicLinkLimiter,
} from "../platform/rateLimit.js";
import { canSend, setConsent } from "../services/consentService.js";
import { getOrgBrand } from "../services/emailBranding.js";
import { isModuleOn } from "../services/entitlementService.js";
import {
	buildPublicView,
	documentPdf,
	type Requester,
} from "../services/publicViews.js";
import {
	createErrorResponse,
	createSuccessResponse,
	ErrorCodes,
} from "../types/responses.js";

const router = Router();

const tokenSchema = z.object({ token: z.string().min(1).max(200) });
const linkSchema = tokenSchema.extend({
	mark_viewed: z.boolean().optional(),
});
const unsubscribeSchema = tokenSchema.extend({
	channel: z.enum(["email", "sms"]),
	status: z.enum(["subscribed", "unsubscribed"]),
});

const respondSchema = tokenSchema.extend({
	action: z.enum(["approve", "decline"]),
	name: z
		.string()
		.trim()
		.min(2)
		.max(100)
		.refine((n) => !/\p{C}/u.test(n) && /\p{L}/u.test(n)),
	reason: z.string().trim().max(1000).optional(),
});

const requester = (req: Request): Requester => ({
	ip: req.ip,
	userAgent:
		typeof req.headers["user-agent"] === "string"
			? req.headers["user-agent"].slice(0, 500)
			: undefined,
});

const invalid = () =>
	createErrorResponse(ErrorCodes.NOT_FOUND, "This link is no longer valid.");

function maskEmail(email: string | null): string | null {
	if (!email) return null;
	const at = email.indexOf("@");
	if (at < 0) return `${email.slice(0, 1)}***`;
	return `${email.slice(0, 1)}***${email.slice(at)}`;
}

async function unsubscribeState(link: ResolvedLink) {
	const sdb = getScopedDb(link.organization_id);
	const contactId = link.contact_id ?? link.entity_id;
	const contact = await sdb.contact.findFirst({
		where: { id: contactId },
		select: { email: true },
	});
	if (!contact) return null;
	const [email, sms] = await Promise.all([
		canSend(sdb, contactId, "email"),
		canSend(sdb, contactId, "sms"),
	]);
	return {
		contactId,
		contact_email_masked: maskEmail(contact.email),
		email: email ? ("subscribed" as const) : ("unsubscribed" as const),
		sms: sms ? ("subscribed" as const) : ("unsubscribed" as const),
	};
}

router.post("/link", publicLinkLimiter, async (req, res, next) => {
	try {
		const body = linkSchema.safeParse(req.body);
		const link = body.success ? await resolveLink(body.data.token) : null;
		if (!link) return res.status(404).json(invalid());

		const brand = await getOrgBrand(link.organization_id);
		const org = {
			name: brand.name,
			logo_url: brand.logo_url,
			color: brand.color,
			phone: brand.phone,
			email: brand.reply_to,
		};
		if (link.purpose !== "unsubscribe") {
			const view = await buildPublicView(link, {
				...requester(req),
				markViewed: body.data?.mark_viewed === true,
			});
			if (!view) return res.status(404).json(invalid());
			if (
				link.purpose === "quote" &&
				"can_respond" in view &&
				view.can_respond &&
				!(await isModuleOn(link.organization_id, "customer_comms"))
			)
				view.can_respond = false;
			return res.json(
				createSuccessResponse({ purpose: link.purpose, org, ...view }),
			);
		}
		const state = await unsubscribeState(link);
		if (!state) return res.status(404).json(invalid());
		const { contactId: _contactId, ...rest } = state;
		return res.json(
			createSuccessResponse({ purpose: link.purpose, org, ...rest }),
		);
	} catch (err) {
		next(err);
	}
});

router.post("/quote/respond", publicLinkLimiter, async (req, res, next) => {
	try {
		const body = respondSchema.safeParse(req.body);
		if (!body.success) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						"Invalid request.",
					),
				);
		}
		const link = await resolveLink(body.data.token);
		if (!link || link.purpose !== "quote")
			return res.status(404).json(invalid());
		// Turning the module off stops new answers; the page and PDF stay readable
		// until the link expires.
		if (!(await isModuleOn(link.organization_id, "customer_comms"))) {
			const view = await buildPublicView(link);
			if (!view) return res.status(404).json(invalid());
			return res.json(
				createSuccessResponse({ ...view, can_respond: false }),
			);
		}
		const who = requester(req);
		// The quote and org come from the link, never from the request body.
		const result = await respondToQuote(
			link.organization_id,
			link.entity_id,
			{
				action: body.data.action,
				name: body.data.name,
				reason: body.data.reason,
				...who,
				linkId: link.id,
				contactId: link.contact_id,
			},
		);
		if (!result) return res.status(404).json(invalid());
		const view = await buildPublicView(link, who);
		if (!view) return res.status(404).json(invalid());
		return res.json(createSuccessResponse(view));
	} catch (err) {
		next(err);
	}
});

router.post(
	"/document/pdf",
	publicLinkLimiter,
	documentPdfTokenLimiter,
	async (req, res, next) => {
		try {
			const body = tokenSchema.safeParse(req.body);
			const link = body.success
				? await resolveLink(body.data.token)
				: null;
			if (!link) return res.status(404).json(invalid());
			const doc = await documentPdf(link);
			if (!doc) return res.status(404).json(invalid());
			res.setHeader("Content-Type", "application/pdf");
			res.setHeader(
				"Content-Disposition",
				`inline; filename="${doc.filename}"`,
			);
			res.setHeader("Cache-Control", "no-store");
			return res.send(doc.buffer);
		} catch (err) {
			next(err);
		}
	},
);

router.post("/unsubscribe", publicLinkLimiter, async (req, res, next) => {
	try {
		const body = unsubscribeSchema.safeParse(req.body);
		if (!body.success) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						"Invalid request.",
					),
				);
		}
		const link = await resolveLink(body.data.token);
		if (!link || link.purpose !== "unsubscribe")
			return res.status(404).json(invalid());
		// An unsubscribe link may stop texts but never opt a phone in: SMS consent is
		// only given through the dispatcher or a keyword reply.
		if (body.data.channel === "sms" && body.data.status === "subscribed") {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						"Invalid request.",
					),
				);
		}
		// The contact comes from the link, never from the request body.
		const contactId = link.contact_id ?? link.entity_id;
		await setConsent(link.organization_id, {
			contactId,
			channel: body.data.channel,
			status: body.data.status,
			source: "unsubscribe_link",
		});
		const state = await unsubscribeState(link);
		if (!state) return res.status(404).json(invalid());
		return res.json(
			createSuccessResponse({ email: state.email, sms: state.sms }),
		);
	} catch (err) {
		next(err);
	}
});

// RFC 8058 target: mail clients POST `List-Unsubscribe=One-Click` here with no
// session, so the token rides in the query string and the body is ignored.
router.post(
	"/unsubscribe/one-click",
	oneClickIpLimiter,
	oneClickTokenLimiter,
	async (req, res, next) => {
		try {
			const t =
				typeof req.query.t === "string"
					? req.query.t.slice(0, 200)
					: "";
			const link = await resolveLink(t);
			if (!link || link.purpose !== "unsubscribe")
				return res.status(404).json(invalid());
			await setConsent(link.organization_id, {
				contactId: link.contact_id ?? link.entity_id,
				channel: "email",
				status: "unsubscribed",
				source: "unsubscribe_link",
				detail: "one_click",
			});
			return res.json(createSuccessResponse({ email: "unsubscribed" }));
		} catch (err) {
			next(err);
		}
	},
);

export default router;
