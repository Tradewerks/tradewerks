// In-memory stand-in for the parts of Prisma the outbox touches, so the tests
// exercise the real status transitions (claim, finish guards, dedupe) instead of
// asserting on mock call shapes.

export interface FakeRow {
	id: string;
	organization_id: string;
	event: string;
	channel: string;
	client_id: string | null;
	contact_id: string | null;
	recipient: string;
	entity_type: string;
	entity_id: string;
	dedupe_key: string;
	status: string;
	skip_reason: string | null;
	send_after: Date;
	claimed_at: Date | null;
	attempts: number;
	provider_message_id: string | null;
	error: string | null;
	[k: string]: unknown;
}

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
	return Object.entries(where).every(([k, v]) => {
		if (k === "OR") return (v as Where[]).some((w) => matches(row, w));
		if (v && typeof v === "object" && "not" in v)
			return row[k] !== (v as { not: unknown }).not;
		if (v && typeof v === "object" && "lt" in v)
			return (row[k] as Date) < (v as { lt: Date }).lt;
		if (v && typeof v === "object" && "in" in v)
			return (v as { in: unknown[] }).in.includes(row[k]);
		if (v && typeof v === "object" && "gte" in v)
			return (row[k] as Date) >= (v as { gte: Date }).gte;
		return row[k] === v;
	});
}

export function makeFakeDb() {
	const rows: FakeRow[] = [];
	let seq = 0;
	const state = {
		rows,
		settings: new Map<
			string,
			{ email_enabled: boolean; sms_enabled: boolean }
		>(),
		visits: new Map<string, { status: string; job_id: string }>(),
		jobs: new Map<
			string,
			{ id: string; status: string; client_id: string }
		>(),
		arrivals: [] as Record<string, unknown>[],
		reviewUrl: null as string | null,
		openDisputes: 0,
		disputedInvoices: 0,
		disputeWheres: [] as unknown[],
		contacts: new Map<
			string,
			{
				id: string;
				email: string | null;
				phone: string | null;
				is_active: boolean;
				type: string | null;
			}
		>(),
		clientContacts: [] as {
			client_id: string;
			contact_id: string;
			is_primary: boolean;
			notify_visits: boolean;
		}[],
		timezone: "America/Chicago",
		smsAccount: {
			status: "active",
			subaccount_sid: "AC1",
			auth_token_enc: "enc",
			messaging_service_sid: "MG1",
		} as Record<string, unknown> | null,
	};

	const customer_message = {
		createMany: async ({
			data,
		}: {
			data: Record<string, unknown>[];
			skipDuplicates?: boolean;
		}) => {
			let count = 0;
			for (const d of data) {
				const dup = rows.some(
					(r) =>
						r.organization_id === d.organization_id &&
						r.dedupe_key === d.dedupe_key &&
						r.channel === d.channel &&
						r.recipient === d.recipient,
				);
				if (dup) continue;
				rows.push({
					id: `m${++seq}`,
					direction: "out",
					client_id: null,
					contact_id: null,
					status: "queued",
					skip_reason: null,
					send_after: new Date(),
					claimed_at: null,
					attempts: 0,
					provider_message_id: null,
					error: null,
					created_at: new Date(),
					...(d as object),
				} as FakeRow);
				count++;
			}
			return { count };
		},
		updateMany: async ({ where, data }: { where: Where; data: Where }) => {
			const hit = rows.filter((r) => matches(r, where));
			for (const r of hit) Object.assign(r, data);
			return { count: hit.length };
		},
		deleteMany: async ({ where }: { where: Where }) => {
			const keep = rows.filter((r) => !matches(r, where));
			const count = rows.length - keep.length;
			rows.splice(0, rows.length, ...keep);
			return { count };
		},
		findFirst: async ({ where }: { where: Where }) =>
			rows.find((r) => matches(r, where)) ?? null,
		count: async ({ where }: { where: Where }) =>
			rows.filter((r) => matches(r, where)).length,
	};

	const db = {
		customer_message,
		customer_notification_setting: {
			findFirst: async ({ where }: { where: { event: string } }) =>
				state.settings.get(where.event) ?? null,
		},
		visit_tech_arrival: {
			findMany: async ({ where }: { where: Where }) =>
				state.arrivals.filter((r) => matches(r, where)),
		},
		job_visit: {
			findFirst: async ({ where }: { where: { id: string } }) =>
				state.visits.get(where.id) ?? null,
			findMany: async ({
				where,
			}: {
				where: { job_id: string; status?: { notIn: string[] } };
			}) =>
				[...state.visits.entries()]
					.filter(
						([, v]) =>
							v.job_id === where.job_id &&
							!where.status?.notIn.includes(v.status),
					)
					.map(([id, v]) => ({ id, ...v })),
		},
		job: {
			findFirst: async ({ where }: { where: { id: string } }) =>
				state.jobs.get(where.id) ?? null,
		},
		document_dispute: {
			count: async (args: { where: unknown }) => {
				state.disputeWheres.push(args.where);
				return state.openDisputes;
			},
		},
		invoice: {
			count: async (args: { where: unknown }) => {
				state.disputeWheres.push(args.where);
				return state.disputedInvoices;
			},
		},
		contact: {
			findFirst: async ({ where }: { where: { id: string } }) =>
				state.contacts.get(where.id) ?? null,
		},
		client: { findFirst: async () => ({ name: "Acme Homes" }) },
		client_contact: {
			findMany: async ({ where }: { where: { client_id: string } }) =>
				state.clientContacts
					.filter((l) => l.client_id === where.client_id)
					.map((l) => ({
						is_primary: l.is_primary,
						notify_visits: l.notify_visits,
						contact: state.contacts.get(l.contact_id)!,
					})),
		},
		email_template: { findFirst: async () => null },
		org_sms_account: { findFirst: async () => state.smsAccount },
		organization: {
			findUnique: async () => ({
				timezone: state.timezone,
				review_url: state.reviewUrl,
			}),
		},
		$queryRaw: async (
			strings: TemplateStringsArray,
			...values: unknown[]
		) => {
			const sql = strings.join("?");
			if (sql.includes("SKIP LOCKED")) {
				const now = values[0] as Date;
				const due = rows
					.filter((r) => r.status === "queued" && r.send_after <= now)
					.sort((a, b) => +a.send_after - +b.send_after)
					.slice(0, values[2] as number);
				for (const r of due) {
					r.status = "sending";
					r.claimed_at = now;
					r.send_started_at = null;
					r.attempts += 1;
				}
				return due.map((r) => ({ ...r }));
			}
			if (sql.includes("'unknown'")) {
				const cutoff = values[0] as Date;
				const stale = rows.filter(
					(r) =>
						r.status === "sending" &&
						r.send_started_at instanceof Date &&
						r.send_started_at < cutoff,
				);
				for (const r of stale) {
					r.status = "unknown";
					r.error = "send outcome unknown";
				}
				return stale.map((r) => ({ ...r }));
			}
			if (sql.includes("SET \"status\" = 'queued'")) {
				const cutoff = values[0] as Date;
				const orphaned = rows.filter(
					(r) =>
						r.status === "sending" &&
						!r.send_started_at &&
						r.claimed_at &&
						r.claimed_at < cutoff,
				);
				for (const r of orphaned) {
					r.status = "queued";
					r.attempts -= 1;
				}
				return orphaned.map((r) => ({ ...r }));
			}
			throw new Error(`unexpected raw SQL: ${sql}`);
		},
	};

	return { db, state };
}
