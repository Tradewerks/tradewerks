import postmark, { TemplatedMessage } from "postmark";
import { db } from "../db.js";
import { create } from "node:domain";
import {
	createErrorResponse,
	createSuccessResponse,
	ErrorCodes,
} from "../types/responses.js";
import { log } from "../services/appLogger.js";
import { translateSendError } from "./emailErrors.js";
import { generateQuotePdf, generateInvoicePdf } from "../lib/pdf/pdfService.js";
import { getQuoteById } from "../controllers/quotesController.js";
import { getInvoiceById } from "../controllers/invoicesController.js";
import { SUBSCRIPTION_PATH } from "../lib/entitlements/registry.js";

// ============================================================================
// EMAIL TEMPORARILY DISABLED — pending Postmark sender approval.
// All exported send functions short-circuit below and log a notice instead of
// hitting Postmark. To re-enable, flip EMAIL_DISABLED to false (and ensure
// POSTMARK_API_KEY / POSTMARK_FROM_EMAIL are set).
// ============================================================================
const EMAIL_DISABLED = false;

const POSTMARK_FROM_EMAIL = (process.env.POSTMARK_FROM_EMAIL ?? "") as string;
if (!EMAIL_DISABLED && !POSTMARK_FROM_EMAIL)
	throw new Error("POSTMARK_FROM_EMAIL is not set");

const POSTMARK_API_KEY = (process.env.POSTMARK_API_KEY ?? "") as string;
if (!EMAIL_DISABLED && !POSTMARK_API_KEY)
	throw new Error("POSTMARK_API_KEY is not set");

const client = POSTMARK_API_KEY
	? new postmark.ServerClient(POSTMARK_API_KEY)
	: (null as unknown as postmark.ServerClient);

export const sendEmail = async (
	to: string,
	templateAlias: string,
	templateModel: Record<string, unknown>,
) => {
	if (EMAIL_DISABLED) {
		log.info(
			{ to, templateAlias },
			"[EMAIL DISABLED] Skipping templated email — pending Postmark approval",
		);
		return;
	}
	try {
		await client.sendEmailWithTemplate({
			From: POSTMARK_FROM_EMAIL,
			To: to,
			TemplateAlias: templateAlias,
			MessageStream: "outbound",
			TemplateModel: templateModel,
		} as TemplatedMessage);
	} catch (error) {
		log.error({ err: error }, "Failed to send templated email");
	}
};

/**
 * Send a Postmark templated email with open-tracking enabled, returning the Postmark
 * MessageID so callers can correlate later Open webhooks back to the send record.
 * Honors EMAIL_DISABLED (logs + returns a synthetic id so the pipeline still records/advances).
 * Throws on Postmark failure so the caller can record a failed send.
 */
export const sendTemplatedTracked = async (
	to: string,
	templateAlias: string,
	templateModel: Record<string, unknown>,
	options?: { metadata?: Record<string, string> },
): Promise<{ messageId: string | null }> => {
	if (EMAIL_DISABLED) {
		log.info(
			{ to, templateAlias },
			"[EMAIL DISABLED] Skipping tracked template email — pending Postmark approval",
		);
		return {
			messageId: `disabled-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
		};
	}
	const result = await client.sendEmailWithTemplate({
		From: POSTMARK_FROM_EMAIL,
		To: to,
		TemplateAlias: templateAlias,
		MessageStream: "outbound",
		TemplateModel: templateModel,
		TrackOpens: true,
		...(options?.metadata ? { Metadata: options.metadata } : {}),
	} as TemplatedMessage);
	return { messageId: result.MessageID ?? null };
};

// Naive HTML→text fallback for the multipart body: strip tags, collapse
// whitespace, and drop the invisible preheader. Good enough for the text/plain
// alternative Postmark includes for clients that don't render HTML.
const htmlToText = (html: string): string =>
	html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<head[\s\S]*?<\/head>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&middot;/g, "·")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

/**
 * Send a fully-rendered HTML email (subject + body already substituted) with
 * open-tracking, returning the Postmark MessageID for open correlation. This is
 * the followup send path: templates live in our DB and are rendered by us, so we
 * send the final HTML via HtmlBody rather than a Postmark-hosted template alias.
 * `text` is the plain-text alternative; when blank/omitted it is auto-generated
 * from the HTML. Honors EMAIL_DISABLED (returns a synthetic id so the pipeline
 * still records/advances). Throws on Postmark failure so the caller can record a failed send.
 */
export const sendRenderedTracked = async (
	to: string,
	subject: string,
	html: string,
	text?: string | null,
	options?: { metadata?: Record<string, string> },
): Promise<{ messageId: string | null }> => {
	if (EMAIL_DISABLED) {
		log.info(
			{ to, subject },
			"[EMAIL DISABLED] Skipping rendered tracked email — pending Postmark approval",
		);
		return {
			messageId: `disabled-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
		};
	}
	const result = await client.sendEmail({
		From: POSTMARK_FROM_EMAIL,
		To: to,
		Subject: subject,
		HtmlBody: html,
		TextBody: text && text.trim() ? text : htmlToText(html),
		MessageStream: "outbound",
		TrackOpens: true,
		...(options?.metadata ? { Metadata: options.metadata } : {}),
	});
	return { messageId: result.MessageID ?? null };
};

// if you'd like, feel free to add additional functions for common email templates

//temp function since I can't make a template rn
const generateOTPEmail = (otp: string): string => `
  <!DOCTYPE html>
  <html>
    <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px;">
      <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 8px; padding: 32px;">
        
        <h2 style="color: #1a1a1a; margin-bottom: 8px;">Verification Code</h2>
        <p style="color: #555; margin-bottom: 24px;">
          Use the code below to complete your sign in. It expires in 5 minutes.
        </p>

        <div style="
          font-size: 36px;
          font-weight: bold;
          letter-spacing: 12px;
          color: #2563eb;
          background: #eff6ff;
          border-radius: 8px;
          padding: 16px;
          text-align: center;
          margin-bottom: 24px;
        ">
          ${otp}
        </div>

        <p style="color: #999; font-size: 13px;">
          If you didn't request this code, you can safely ignore this email.
        </p>

      </div>
    </body>
  </html>
`;
export const sendOTPEmail = async (to: string, otp: string) => {
	if (EMAIL_DISABLED) {
		log.info(
			{ to, otp },
			"[EMAIL DISABLED] Skipping OTP email — pending Postmark approval. Use 000000 to verify.",
		);
		return createSuccessResponse(null);
	}
	if (process.env.NODE_ENV !== "production") {
		log.info(
			{ to, otp },
			"[DEV] Skipping OTP email — use 000000 to verify",
		);
		return createSuccessResponse(null);
	}
	try {
		// sendEmail(to, "otp-verification", { otp });
		await client.sendEmail({
			From: POSTMARK_FROM_EMAIL,
			To: to,
			Subject: "Your verification code",
			HtmlBody: generateOTPEmail(otp),
			TextBody: `Your verification code is: ${otp}. It expires in 5 minutes.`, // fallback for email clients that don't support HTML
			MessageStream: "outbound",
		});
		return createSuccessResponse(null);
	} catch (error) {
		log.error({ err: error }, "Failed to send OTP email");
		return createErrorResponse(
			ErrorCodes.SERVER_ERROR,
			"Error sending OTP email",
		);
	}
};

// ── Document emails ────────────────────────────────────────────────────────────

const fmt = (v: unknown): string =>
	`$${Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const generateQuoteEmailHtml = (
	quoteNumber: string,
	clientName: string,
	total: string,
	validUntil: string | null,
): string => `
<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
    <div style="max-width: 560px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08);">
      <div style="background: #1e3a5f; padding: 28px 32px;">
        <p style="color: #93c5fd; font-size: 13px; margin: 0 0 4px;">Epic HVAC Services</p>
        <h1 style="color: white; font-size: 22px; margin: 0;">Quote ${quoteNumber}</h1>
      </div>
      <div style="padding: 32px;">
        <p style="color: #374151; font-size: 15px; margin: 0 0 20px;">
          Hi ${clientName},
        </p>
        <p style="color: #374151; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
          Thank you for the opportunity. Please find your quote attached to this email as a PDF.
        </p>
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px 20px; margin-bottom: 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Quote Number</td>
              <td style="color: #111827; font-size: 13px; font-weight: bold; text-align: right;">${quoteNumber}</td>
            </tr>
            <tr>
              <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Total</td>
              <td style="color: #111827; font-size: 13px; font-weight: bold; text-align: right;">${total}</td>
            </tr>
            ${
				validUntil
					? `<tr>
              <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Valid Until</td>
              <td style="color: #111827; font-size: 13px; font-weight: bold; text-align: right;">${validUntil}</td>
            </tr>`
					: ""
			}
          </table>
        </div>
        <p style="color: #6b7280; font-size: 13px; line-height: 1.6; margin: 0;">
          If you have any questions or would like to proceed, please reply to this email or call us directly.
        </p>
      </div>
      <div style="background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 16px 32px;">
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">Epic HVAC Services · La Crosse, WI</p>
      </div>
    </div>
  </body>
</html>
`;

const generateInvoiceEmailHtml = (
	invoiceNumber: string,
	clientName: string,
	total: string,
	balanceDue: string,
	dueDate: string | null,
): string => `
<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px; margin: 0;">
    <div style="max-width: 560px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08);">
      <div style="background: #1e3a5f; padding: 28px 32px;">
        <p style="color: #93c5fd; font-size: 13px; margin: 0 0 4px;">Epic HVAC Services</p>
        <h1 style="color: white; font-size: 22px; margin: 0;">Invoice ${invoiceNumber}</h1>
      </div>
      <div style="padding: 32px;">
        <p style="color: #374151; font-size: 15px; margin: 0 0 20px;">
          Hi ${clientName},
        </p>
        <p style="color: #374151; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
          Please find your invoice attached to this email as a PDF. A summary is included below.
        </p>
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px 20px; margin-bottom: 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Invoice Number</td>
              <td style="color: #111827; font-size: 13px; font-weight: bold; text-align: right;">${invoiceNumber}</td>
            </tr>
            <tr>
              <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Invoice Total</td>
              <td style="color: #111827; font-size: 13px; font-weight: bold; text-align: right;">${total}</td>
            </tr>
            <tr>
              <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Balance Due</td>
              <td style="color: #dc2626; font-size: 14px; font-weight: bold; text-align: right;">${balanceDue}</td>
            </tr>
            ${
				dueDate
					? `<tr>
              <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Due Date</td>
              <td style="color: #111827; font-size: 13px; font-weight: bold; text-align: right;">${dueDate}</td>
            </tr>`
					: ""
			}
          </table>
        </div>
        <p style="color: #6b7280; font-size: 13px; line-height: 1.6; margin: 0;">
          Please reply to this email if you have any questions regarding this invoice.
        </p>
      </div>
      <div style="background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 16px 32px;">
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">Epic HVAC Services · La Crosse, WI</p>
      </div>
    </div>
  </body>
</html>
`;

const fmtDate = (d: Date | string | null | undefined): string | null => {
	if (!d) return null;
	return new Date(d).toLocaleDateString("en-US", {
		timeZone: "UTC",
		month: "long",
		day: "numeric",
		year: "numeric",
	});
};

/**
 * Generate the quote PDF and send it to the recipient via Postmark.
 * Throws on failure so the caller can surface a meaningful HTTP error.
 */
export const sendQuoteEmail = async (
	quoteId: string,
	recipientEmail: string,
	organizationId: string,
): Promise<void> => {
	if (EMAIL_DISABLED) {
		log.info(
			{ quoteId, recipientEmail },
			"[EMAIL DISABLED] Skipping quote email — pending Postmark approval",
		);
		return;
	}
	const [quote, pdfBuffer] = await Promise.all([
		getQuoteById(quoteId, organizationId),
		generateQuotePdf(quoteId, organizationId),
	]);

	if (!quote)
		throw Object.assign(new Error("Quote not found"), { status: 404 });

	const clientName =
		(quote as typeof quote & { client: { name: string } | null }).client
			?.name ?? "Valued Customer";
	const total = fmt(quote.total);
	const validUntil = fmtDate(quote.valid_until);

	try {
		await client.sendEmail({
			From: POSTMARK_FROM_EMAIL,
			To: recipientEmail,
			Subject: `Quote ${quote.quote_number} from Epic HVAC Services`,
			HtmlBody: generateQuoteEmailHtml(
				quote.quote_number,
				clientName,
				total,
				validUntil,
			),
			TextBody: `Hi ${clientName},\n\nPlease find your quote ${quote.quote_number} attached. Total: ${total}${validUntil ? `. Valid until: ${validUntil}` : ""}.\n\nEpic HVAC Services`,
			MessageStream: "outbound",
			Attachments: [
				{
					Name: `${quote.quote_number}.pdf`,
					Content: pdfBuffer.toString("base64"),
					ContentType: "application/pdf",
					ContentID: "",
				},
			],
		});
	} catch (err: any) {
		log.error(
			{
				quoteId,
				recipientEmail,
				postmarkCode: err.code,
				postmarkStatus: err.statusCode,
				message: err.message,
			},
			"Postmark failed to send quote email",
		);
		throw translateSendError(err);
	}

	log.info({ quoteId, recipientEmail }, "Quote email sent");
};

/**
 * Generate the invoice PDF and send it to the recipient via Postmark.
 * Throws on failure so the caller can surface a meaningful HTTP error.
 */
export const sendInvoiceEmail = async (
	invoiceId: string,
	recipientEmail: string,
	organizationId: string,
): Promise<void> => {
	if (EMAIL_DISABLED) {
		log.info(
			{ invoiceId, recipientEmail },
			"[EMAIL DISABLED] Skipping invoice email — pending Postmark approval",
		);
		return;
	}
	const [invoice, pdfBuffer] = await Promise.all([
		getInvoiceById(invoiceId, organizationId),
		generateInvoicePdf(invoiceId, organizationId),
	]);

	if (!invoice)
		throw Object.assign(new Error("Invoice not found"), { status: 404 });

	const clientName = invoice.client?.name ?? "Valued Customer";
	const total = fmt(invoice.total);
	const balanceDue = fmt(invoice.balance_due);
	const dueDate = fmtDate(invoice.due_date);

	try {
		await client.sendEmail({
			From: POSTMARK_FROM_EMAIL,
			To: recipientEmail,
			Subject: `Invoice ${invoice.invoice_number} from Epic HVAC Services`,
			HtmlBody: generateInvoiceEmailHtml(
				invoice.invoice_number,
				clientName,
				total,
				balanceDue,
				dueDate,
			),
			TextBody: `Hi ${clientName},\n\nPlease find invoice ${invoice.invoice_number} attached. Total: ${total}. Balance due: ${balanceDue}${dueDate ? `. Due: ${dueDate}` : ""}.\n\nEpic HVAC Services`,
			MessageStream: "outbound",
			Attachments: [
				{
					Name: `${invoice.invoice_number}.pdf`,
					Content: pdfBuffer.toString("base64"),
					ContentType: "application/pdf",
					ContentID: "",
				},
			],
		});
	} catch (err: any) {
		log.error(
			{
				invoiceId,
				recipientEmail,
				postmarkCode: err.code,
				postmarkStatus: err.statusCode,
				message: err.message,
			},
			"Postmark failed to send invoice email",
		);
		throw translateSendError(err);
	}

	log.info({ invoiceId, recipientEmail }, "Invoice email sent");
};

export const sendEmailVerificationEmail = async (
	to: string,
	token: string,
	tempPassword?: string,
) => {
	if (EMAIL_DISABLED) {
		const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
		log.info(
			{ to, verificationLink, tempPassword },
			"[EMAIL DISABLED] Skipping verification email — pending Postmark approval. Use the logged link to verify.",
		);
		return;
	}
	try {
		const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
		const tempPasswordSection = tempPassword
			? `
						<div style="margin: 20px 0; padding: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
							<p style="color: #555; font-size: 13px; margin: 0 0 8px;">Your temporary password:</p>
							<p style="font-size: 18px; font-weight: bold; color: #1a1a1a; letter-spacing: 2px; margin: 0;">${tempPassword}</p>
							<p style="color: #999; font-size: 12px; margin: 8px 0 0;">You will be prompted to change this after logging in.</p>
						</div>`
			: "";

		const htmlContent = `
			<!DOCTYPE html>
			<html>
				<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px;">
					<div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 8px; padding: 32px;">
						<h2 style="color: #1a1a1a; margin-bottom: 8px;">Welcome to EpicIT Dispatch</h2>
						<p style="color: #555; margin-bottom: 24px;">
							Your account has been created. Please verify your email and use the temporary password below to log in.
						</p>
						${tempPasswordSection}
						<a href="${verificationLink}" style="
							display: inline-block;
							padding: 12px 24px;
							font-size: 16px;
							color: white;
							background-color: #2563eb;
							border-radius: 8px;
							text-decoration: none;
						">
							Verify Email
						</a>
						<p style="color: #999; font-size: 13px; margin-top: 24px;">
							If you didn't create an account, you can safely ignore this email.
						</p>
					</div>
				</body>
			</html>
		`;

		await client.sendEmail({
			From: POSTMARK_FROM_EMAIL,
			To: to,
			Subject: "Welcome — verify your email address",
			HtmlBody: htmlContent,
			TextBody: `Please verify your email by clicking the following link: ${verificationLink}${tempPassword ? `\n\nYour temporary password is: ${tempPassword}` : ""}`,
			MessageStream: "outbound",
		});
	} catch (error) {
		log.error({ err: error }, "Failed to send email verification email");
		return createErrorResponse(
			ErrorCodes.SERVER_ERROR,
			"Error sending email verification email",
		);
	}
};

export const sendPasswordResetEmail = async (
	to: string,
	token: string,
	role: string,
) => {
	if (EMAIL_DISABLED) {
		// Never log the reset token: logs are broadly readable and the token is a credential.
		log.info(
			{ to, role },
			"[EMAIL DISABLED] Skipping password reset email — pending Postmark approval.",
		);
		return createSuccessResponse(null);
	}
	try {
		const passwordResetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}&role=${role}`;
		const htmlContent = `
			<!DOCTYPE html>
			<html>
				<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px;">
					<div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 8px; padding: 32px;">
						<h2 style="color: #1a1a1a; margin-bottom: 8px;">Reset Your Password</h2>
						<p style="color: #555; margin-bottom: 24px;">
							Please click the button below to reset your password.
						</p>
						<a href="${passwordResetLink}" style="
							display: inline-block;
							padding: 12px 24px;
							font-size: 16px;
							color: white;
							background-color: #2563eb;
							border-radius: 8px;
							text-decoration: none;
						">
							Reset Password
						</a>
						<p style="color: #999; font-size: 13px; margin-top: 24px;">
							If you know your password, you can safely ignore this email.
						</p>
					</div>
				</body>
			</html>
		`;

		const result = await client.sendEmail({
			From: POSTMARK_FROM_EMAIL,
			To: to,
			Subject: "Reset Password",
			HtmlBody: htmlContent,
			TextBody: `Reset your password by visiting the following link: ${passwordResetLink}`,
			MessageStream: "outbound",
		});
		if (result.ErrorCode) {
			log.error(
				{
					to,
					postmarkCode: result.ErrorCode,
					postmarkMessage: result.Message,
				},
				"Failed to send password reset email",
			);
			return createErrorResponse(
				ErrorCodes.SERVER_ERROR,
				"Error sending password reset email",
			);
		}
		return createSuccessResponse(null);
	} catch (error) {
		log.error({ err: error }, "Failed to send password reset email");
		return createErrorResponse(
			ErrorCodes.SERVER_ERROR,
			"Error sending password reset email",
		);
	}
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const sendStaffInviteEmail = async (
	to: string,
	name: string,
	inviteUrl: string,
	inviterName: string,
) => {
	if (EMAIL_DISABLED) {
		// The invite URL is a credential: never log it. Staff copy it from the back office.
		log.info({ to }, "[EMAIL DISABLED] Skipping staff invite email.");
		return;
	}
	try {
		const htmlContent = `
			<!DOCTYPE html>
			<html>
				<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px;">
					<div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 8px; padding: 32px;">
						<h2 style="color: #1a1a1a; margin-bottom: 8px;">TradeWerks back office</h2>
						<p style="color: #555; margin-bottom: 24px;">
							Hi ${escapeHtml(name)}, ${escapeHtml(inviterName)} invited you to the TradeWerks back office.
							The link below works once and expires in 48 hours.
						</p>
						<a href="${inviteUrl}" style="display: inline-block; padding: 12px 24px; font-size: 16px; color: white; background-color: #2563eb; border-radius: 8px; text-decoration: none;">
							Accept invite
						</a>
					</div>
				</body>
			</html>
		`;
		await client.sendEmail({
			From: POSTMARK_FROM_EMAIL,
			To: to,
			Subject: "Your TradeWerks back office invite",
			HtmlBody: htmlContent,
			TextBody: `${inviterName} invited you to the TradeWerks back office. Accept within 48 hours: ${inviteUrl}`,
			MessageStream: "outbound",
		});
	} catch (error) {
		log.error({ err: error }, "Failed to send staff invite email");
	}
};

export const sendOrgAdminInviteEmail = async (
	to: string,
	company: string,
	inviteUrl: string,
	expires: Date,
	timeZone: string,
) => {
	if (EMAIL_DISABLED) {
		// The URL is a credential: never log it. Staff can copy it from the back office.
		log.info({ to }, "[EMAIL DISABLED] Skipping org admin invite email.");
		return;
	}
	const until = expires.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
	try {
		await client.sendEmail({
			From: POSTMARK_FROM_EMAIL,
			To: to,
			Subject: `TradeWerks set up ${company} for you`,
			HtmlBody: `
			<!DOCTYPE html>
			<html>
				<body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 40px;">
					<div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 8px; padding: 32px;">
						<h2 style="color: #1a1a1a; margin-bottom: 8px;">${escapeHtml(company)} is ready</h2>
						<p style="color: #555; margin-bottom: 24px;">
							TradeWerks set up your account. Set a password to sign in.
							The link works once and expires on ${until}.
						</p>
						<a href="${inviteUrl}" style="display: inline-block; padding: 12px 24px; font-size: 16px; color: white; background-color: #2563eb; border-radius: 8px; text-decoration: none;">
							Set your password
						</a>
					</div>
				</body>
			</html>`,
			TextBody: `TradeWerks set up ${company} for you. Set your password (link expires ${until}): ${inviteUrl}`,
			MessageStream: "outbound",
		});
	} catch (error) {
		log.error({ err: error }, "Failed to send org admin invite email");
	}
};

// Every active staff member hears about invites, disables and MFA resets, so a hijacked account cannot entrench quietly.
export const sendStaffSecurityNotice = async (to: string[], subject: string, text: string) => {
	if (EMAIL_DISABLED) {
		log.info({ count: to.length, subject }, "[EMAIL DISABLED] Skipping staff security notice.");
		return;
	}
	for (const addr of to) {
		try {
			await client.sendEmail({
				From: POSTMARK_FROM_EMAIL,
				To: addr,
				Subject: subject,
				HtmlBody: `<p style="font-family: Arial, sans-serif;">${escapeHtml(text)}</p>`,
				TextBody: text,
				MessageStream: "outbound",
			});
		} catch (error) {
			log.error({ err: error }, "Failed to send staff security notice");
		}
	}
};

export const sendTrialEndingEmail = async (to: string[], subject: string, text: string) => {
	if (EMAIL_DISABLED) {
		log.info({ count: to.length, subject }, "[EMAIL DISABLED] Skipping trial ending email.");
		return;
	}
	const base = process.env.FRONTEND_URL ?? "http://localhost:5173";
	const link = `${base}${SUBSCRIPTION_PATH}`;
	for (const addr of to) {
		try {
			await client.sendEmail({
				From: POSTMARK_FROM_EMAIL,
				To: addr,
				Subject: subject,
				HtmlBody: `<p style="font-family: Arial, sans-serif;">${escapeHtml(text)}</p><p style="font-family: Arial, sans-serif;"><a href="${link}">Review your subscription</a></p>`,
				TextBody: `${text}\n\nReview your subscription: ${link}`,
				MessageStream: "outbound",
			});
		} catch (error) {
			log.error({ err: error }, "Failed to send trial ending email");
		}
	}
};
