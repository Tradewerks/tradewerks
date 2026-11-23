import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
	process.env.PUBLIC_LINK_SECRET = "s".repeat(40);
	process.env.FRONTEND_URL = "https://app.test";
	type LinkRow = {
		id: string;
		token_hash: string;
		expires_at: Date | null;
		revoked_at: Date | null;
		[k: string]: unknown;
	};
	const links: LinkRow[] = [];
	const public_link = {
		findFirst: async ({ where }: { where: { token_hash: string } }) =>
			links.find((l) => l.token_hash === where.token_hash) ?? null,
		create: async ({ data }: { data: Omit<LinkRow, "id"> }) => {
			const row = {
				id: `l${links.length + 1}`,
				revoked_at: null,
				...data,
			};
			links.push(row);
			return row;
		},
		update: async ({
			where,
			data,
		}: {
			where: { id: string };
			data: Partial<LinkRow>;
		}) => {
			const row = links.find((l) => l.id === where.id)!;
			Object.assign(row, data);
			return row;
		},
	};
	const visit: {
		scheduled_end_at: Date;
		status?: string;
		actual_end_at?: Date | null;
	} = { scheduled_end_at: new Date("2026-06-11T17:00:00Z") };
	const techPhoto = { raw: null as string | null };
	const quoteDates = { valid_until: null as Date | null, tz: "UTC" };
	const sdb = {
		public_link,
		contact: { findFirst: vi.fn(async () => ({ id: "k1" })) },
		client: { findFirst: async () => ({ name: "Acme Homes" }) },
		job_visit: { findFirst: async () => visit },
		email_template: { findFirst: async () => null },
	};
	return {
		links,
		sdb,
		visit,
		techPhoto,
		quoteDates,
		sendEmail: vi.fn(async () => ({ MessageID: "pm-1" })),
		isModuleOn: vi.fn(async () => true),
	};
});

vi.mock("postmark", () => ({
	default: {
		ServerClient: class {
			sendEmail = h.sendEmail;
		},
	},
}));
vi.mock("../../db.js", () => ({
	db: {
		organization: {
			findUniqueOrThrow: async () => ({ timezone: h.quoteDates.tz }),
		},
	},
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => h.sdb }));
vi.mock("../wasabiService.js", () => ({
	signImageUrl: vi.fn(async (u: string | null | undefined, ttl?: number) =>
		u ? `${u}?X-Amz-Expires=${ttl}&X-Amz-Signature=sig` : null,
	),
}));
vi.mock("../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../entitlementService.js", () => ({ isModuleOn: h.isModuleOn }));
vi.mock("../../lib/pdf/pdfService.js", () => ({
	generateQuotePdf: async () => Buffer.from("pdf"),
	generateInvoicePdf: async () => Buffer.from("pdf"),
}));
vi.mock("../../controllers/quotesController.js", () => ({
	getQuoteById: async () => ({
		id: "q1",
		quote_number: "Q-1",
		total: 100,
		client_id: "c1",
		client: { name: "Acme Homes" },
		valid_until: h.quoteDates.valid_until,
		expires_at: null,
		created_at: new Date(),
	}),
}));
vi.mock("../../controllers/invoicesController.js", () => ({
	getInvoiceById: async () => ({
		id: "i1",
		invoice_number: "INV-1",
		total: 100,
		balance_due: 100,
		due_date: null,
		client_id: "c1",
		client: { name: "Acme Homes" },
	}),
}));
vi.mock("../emailBranding.js", () => ({
	getOrgBrand: async () => ({
		name: "Cool Air Co",
		logo_url: null,
		color: "#111111",
		address: null,
		phone: null,
		website: null,
		reply_to: null,
	}),
	getOrgBrandModel: async () => ({ brand: { name: "Cool Air Co" } }),
}));
vi.mock("../visitMessageModel.js", () => ({
	buildVisitModel: async () => ({
		visit: {
			date: "Thursday, June 11",
			window: "8-10",
			name: "Furnace tune-up",
			description: "Replaced the filter",
			tech_first_name: "Ann",
		},
		tech: { name: "Ann Lee", title: "" },
		tech_photo_raw_url: h.techPhoto.raw,
	}),
}));

import { sendInvoiceEmail, sendQuoteEmail } from "../emailService.js";
import { renderCustomerMessage } from "../customerComms/render.js";
import { hashInviteToken } from "../../lib/inviteToken.js";
import { log } from "../appLogger.js";

const sent = () =>
	(
		h.sendEmail.mock.calls.at(-1) as unknown as [
			{ HtmlBody: string; TextBody: string },
		]
	)[0];
const tokenIn = (s: string) => /\/app\/c\/([\w-]+)/.exec(s)?.[1];

beforeEach(() => {
	vi.clearAllMocks();
	h.links.length = 0;
	h.isModuleOn.mockResolvedValue(true);
	h.visit.scheduled_end_at = new Date("2026-06-11T17:00:00Z");
	h.visit.status = "Scheduled";
	h.visit.actual_end_at = null;
	h.techPhoto.raw = null;
	h.quoteDates.valid_until = null;
	h.quoteDates.tz = "UTC";
	process.env.FRONTEND_URL = "https://app.test";
});

describe("document email links", () => {
	it('the quote email contains a "View and approve online" button pointing at /app/c/<token> when customer_comms is on, and no button when it is off', async () => {
		await sendQuoteEmail("q1", "k1@x.test", "org1");
		const on = sent();
		expect(on.HtmlBody).toContain("View and approve online");
		const token = tokenIn(on.HtmlBody);
		expect(token).toBeTruthy();
		expect(on.HtmlBody).toContain(`href="https://app.test/app/c/${token}"`);
		expect(on.TextBody).toContain(`https://app.test/app/c/${token}`);
		expect(h.links).toHaveLength(1);
		expect(h.links[0]).toMatchObject({
			purpose: "quote",
			entity_id: "q1",
			contact_id: "k1",
			token_hash: hashInviteToken(token!),
		});

		h.isModuleOn.mockResolvedValue(false);
		await sendQuoteEmail("q1", "k1@x.test", "org1");
		const off = sent();
		expect(off.HtmlBody).not.toContain("View and approve online");
		expect(off.HtmlBody).not.toContain("/app/c/");
		expect(off.TextBody).not.toContain("/app/c/");
	});

	it("a quote sent on its valid-until day still carries a link that lives to the end of that org-local day", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			// 4pm Chicago on Nov 20; valid until Nov 20 (stored as Chicago midnight).
			vi.setSystemTime(new Date("2026-11-20T22:00:00Z"));
			h.quoteDates.tz = "America/Chicago";
			h.quoteDates.valid_until = new Date("2026-11-20T06:00:00Z");
			await sendQuoteEmail("q1", "k1@x.test", "org1");
			expect(tokenIn(sent().HtmlBody)).toBeTruthy();
			expect(h.links[0].expires_at).toEqual(
				new Date("2026-11-21T06:00:00Z"),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('the invoice email contains "View invoice online"', async () => {
		await sendInvoiceEmail("i1", "k1@x.test", "org1");
		const msg = sent();
		expect(msg.HtmlBody).toContain("View invoice online");
		const token = tokenIn(msg.HtmlBody);
		expect(msg.HtmlBody).toContain(
			`href="https://app.test/app/c/${token}"`,
		);
		expect(h.links[0]).toMatchObject({
			purpose: "invoice",
			entity_id: "i1",
		});
	});

	it("leaves the link out rather than emit a localhost link when FRONTEND_URL is unset", async () => {
		delete process.env.FRONTEND_URL;
		await sendQuoteEmail("q1", "k1@x.test", "org1");
		expect(sent().HtmlBody).not.toContain("/app/c/");
		expect(h.links).toHaveLength(0);
	});
});

const visitMsg = (
	event: "visit_reminder" | "tech_on_the_way" | "visit_completed",
	channel = "email",
) =>
	renderCustomerMessage(
		"org1",
		{
			event,
			channel,
			entity_type: "job_visit",
			entity_id: "v1",
			client_id: "c1",
			contact_id: "k1",
		},
		"UTC",
	);

describe("document email link fallbacks", () => {
	it("a link that cannot be issued still sends the email, without the button, and logs no token", async () => {
		const secret = process.env.PUBLIC_LINK_SECRET;
		delete process.env.PUBLIC_LINK_SECRET;
		try {
			await sendQuoteEmail("q1", "k1@x.test", "org1");
		} finally {
			process.env.PUBLIC_LINK_SECRET = secret;
		}
		expect(h.sendEmail).toHaveBeenCalledTimes(1);
		expect(sent().HtmlBody).not.toContain("View and approve online");
		expect(sent().HtmlBody).not.toContain("/app/c/");
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org1", entityId: "q1" }),
			expect.any(String),
		);
		expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(
			"/app/c/",
		);
	});

	it("matches the recipient only to an active, non-vendor contact of the client", async () => {
		await sendQuoteEmail("q1", "k1@x.test", "org1");
		expect(h.sdb.contact.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					is_active: true,
					OR: [{ type: null }, { type: { not: "vendor" } }],
				}),
			}),
		);
	});
});

describe("visit message links", () => {
	it("one visit link is reused across that visit's messages to the same contact", async () => {
		const a = await visitMsg("visit_reminder");
		const b = await visitMsg("tech_on_the_way");
		const visitLinks = h.links.filter((l) => l.purpose === "visit");
		expect(visitLinks).toHaveLength(1);
		const ta = tokenIn("html" in a ? a.html! : "");
		expect(ta).toBeTruthy();
		expect(tokenIn("html" in b ? b.html! : "")).toBe(ta);
	});

	it("a rescheduled visit's reused link expires a day after the new end", async () => {
		await visitMsg("visit_reminder");
		const later = new Date("2026-06-14T17:00:00Z");
		h.visit.scheduled_end_at = later;
		await visitMsg("tech_on_the_way");
		const visitLinks = h.links.filter((l) => l.purpose === "visit");
		expect(visitLinks).toHaveLength(1);
		expect(visitLinks[0].expires_at?.getTime()).toBe(
			later.getTime() + 24 * 60 * 60 * 1000,
		);
	});

	it("a visit moved earlier pulls its reused link's expiry in to a day after the new end", async () => {
		await visitMsg("visit_reminder");
		const earlier = new Date("2026-06-10T17:00:00Z");
		h.visit.scheduled_end_at = earlier;
		await visitMsg("tech_on_the_way");
		const visitLinks = h.links.filter((l) => l.purpose === "visit");
		expect(visitLinks).toHaveLength(1);
		expect(visitLinks[0].expires_at?.getTime()).toBe(
			earlier.getTime() + 24 * 60 * 60 * 1000,
		);
	});

	it("an SMS carries the visit link unescaped", async () => {
		const r = await visitMsg("visit_reminder", "sms");
		const text = "text" in r ? r.text : "";
		expect(text).toMatch(/https:\/\/app\.test\/app\/c\/[\w-]+/);
		expect(text).not.toContain("&");
	});

	it("does not issue a visit link the template doesn't use", async () => {
		await renderCustomerMessage(
			"org1",
			{
				event: "visit_cancelled",
				channel: "email",
				entity_type: "job_visit",
				entity_id: "v1",
				client_id: "c1",
				contact_id: "k1",
			},
			"UTC",
		);
		expect(h.links.filter((l) => l.purpose === "visit")).toHaveLength(0);
	});
});

describe("completion summary and tech photo", () => {
	const RAW = "https://s3.us-east-1.wasabisys.com/bucket/technicians/ann.jpg";

	it("the completion summary says what was done, who did it, links the visit page and keeps the link 30 days", async () => {
		const done = new Date("2026-06-11T16:40:00Z");
		h.visit.status = "Completed";
		h.visit.actual_end_at = done;
		const r = await visitMsg("visit_completed");
		const html = "html" in r ? r.html! : "";
		expect(html).toContain("Furnace tune-up");
		expect(html).toContain("Replaced the filter");
		expect(html).toContain("Ann");
		expect(tokenIn(html)).toBeTruthy();
		const sms = await visitMsg("visit_completed", "sms");
		const text = "text" in sms ? sms.text : "";
		expect(text).toContain("Furnace tune-up");
		expect(text).not.toContain("Replaced the filter");
		expect(text).toMatch(/https:\/\/app\.test\/app\/c\//);
		const visitLinks = h.links.filter((l) => l.purpose === "visit");
		expect(visitLinks).toHaveLength(1);
		expect(visitLinks[0].expires_at?.getTime()).toBe(
			done.getTime() + 30 * 24 * 60 * 60 * 1000,
		);
	});

	it("the on-my-way email shows the tech photo as a signed URL; the text and SMS never carry it", async () => {
		h.techPhoto.raw = RAW;
		const r = await visitMsg("tech_on_the_way");
		const html = "html" in r ? r.html! : "";
		expect(html).toMatch(/<img [^>]*alt="Ann Lee"/);
		expect(html).toContain(
			`${RAW}?X-Amz-Expires=604800&amp;X-Amz-Signature=sig`,
		);
		expect(html.split(RAW).length - 1).toBe(1);
		expect("text" in r ? r.text : "").not.toContain(RAW);
		const sms = await visitMsg("tech_on_the_way", "sms");
		expect("text" in sms ? sms.text : "").not.toContain(RAW);

		h.techPhoto.raw = null;
		const none = await visitMsg("tech_on_the_way");
		expect("html" in none ? none.html : "").not.toContain("<img");
	});
});
