import { vi } from "vitest";

/**
 * In-memory stand-in for the Prisma client, just enough for the inbound SMS
 * paths. Use with the real getScopedDb so the org filters it injects (AND
 * wrappers, relation filters, forced organization_id) are evaluated here.
 */
type Row = Record<string, any>;

export interface CommsStore {
	org_sms_account: Row[];
	client: Row[];
	contact: Row[];
	client_contact: Row[];
	contact_consent: Row[];
	customer_message: Row[];
}

function matches(row: Row | undefined, where: Row = {}): boolean {
	if (!row) return false;
	return Object.entries(where).every(([k, cond]) => {
		if (k === "AND") return (cond as Row[]).every((w) => matches(row, w));
		if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
		const v = row[k];
		if (cond === null) return v === null || v === undefined;
		if (cond && typeof cond === "object" && !(cond instanceof Date)) {
			if ("in" in cond) return (cond.in as unknown[]).includes(v);
			if ("not" in cond)
				return cond.not === null
					? v !== null && v !== undefined
					: v !== cond.not;
			if ("equals" in cond) return v === cond.equals;
			return matches(v, cond);
		}
		return v === cond;
	});
}

function pick(row: Row, select?: Row): Row {
	if (!select) return { ...row };
	const out: Row = {};
	for (const [k, s] of Object.entries(select)) {
		if (s === true) out[k] = row[k];
		else if (s && typeof s === "object" && "select" in s)
			out[k] = row[k] ? pick(row[k], s.select) : null;
	}
	return out;
}

const uniqueViolation = () =>
	Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

export function createCommsFakeDb() {
	const store: CommsStore = {
		org_sms_account: [],
		client: [],
		contact: [],
		client_contact: [],
		contact_consent: [],
		customer_message: [],
	};

	// client_contact filters reach through to the client relation.
	const view = (model: keyof CommsStore, r: Row): Row =>
		model === "client_contact"
			? { ...r, client: store.client.find((c) => c.id === r.client_id) }
			: r;
	const find = (model: keyof CommsStore, where?: Row) =>
		store[model].filter((r) => matches(view(model, r), where));

	const msgConflict = (d: Row) =>
		store.customer_message.some(
			(m) =>
				(d.provider_message_id &&
					m.provider_message_id === d.provider_message_id) ||
				(m.organization_id === d.organization_id &&
					m.dedupe_key === d.dedupe_key &&
					m.channel === d.channel &&
					m.recipient === d.recipient),
		);

	const delegate = (model: keyof CommsStore) => ({
		findMany: vi.fn(async (a: Row = {}) =>
			find(model, a.where).map((r) => pick(view(model, r), a.select)),
		),
		findFirst: vi.fn(async (a: Row = {}) => {
			const r = find(model, a.where)[0];
			return r ? pick(view(model, r), a.select) : null;
		}),
		findUnique: vi.fn(async (a: Row = {}) => {
			const r = find(model, a.where)[0];
			return r ? pick(view(model, r), a.select) : null;
		}),
		updateMany: vi.fn(async (a: Row) => {
			const hit = find(model, a.where);
			for (const r of hit) Object.assign(r, a.data);
			return { count: hit.length };
		}),
		createMany: vi.fn(async (a: Row) => {
			let count = 0;
			for (const d of a.data as Row[]) {
				if (model === "customer_message" && msgConflict(d)) {
					if (a.skipDuplicates) continue;
					throw uniqueViolation();
				}
				store[model].push({
					id: `${model}-${store[model].length + 1}`,
					...d,
				});
				count++;
			}
			return { count };
		}),
		create: vi.fn(async (a: Row) => {
			if (model === "customer_message" && msgConflict(a.data))
				throw uniqueViolation();
			const row = {
				id: `${model}-${store[model].length + 1}`,
				...a.data,
			};
			store[model].push(row);
			return row;
		}),
		upsert: vi.fn(async (a: Row) => {
			const key = a.where.contact_id_channel;
			const existing = store[model].find(
				(r) =>
					r.contact_id === key.contact_id &&
					r.channel === key.channel,
			);
			if (existing) Object.assign(existing, a.update);
			else store[model].push({ ...a.create });
			return existing ?? a.create;
		}),
	});

	const delegates = Object.fromEntries(
		(Object.keys(store) as (keyof CommsStore)[]).map((m) => [
			m,
			delegate(m),
		]),
	) as Record<keyof CommsStore, ReturnType<typeof delegate>>;

	const client: Row = { ...delegates };
	client.$transaction = vi.fn(async (fn: any) =>
		typeof fn === "function" ? fn(client) : Promise.all(fn),
	);
	// Same hook contract as Prisma's query extension; enough for getScopedDb.
	client.$extends = (cfg: any) => {
		const hooks = cfg?.query?.$allModels ?? {};
		const scoped: Row = new Proxy(
			{},
			{
				get(_t, model: string) {
					if (model === "$transaction")
						return async (fn: any) => fn(scoped);
					const d = (delegates as Row)[model];
					if (!d) return undefined;
					return new Proxy(
						{},
						{
							get(_x, op: string) {
								const run = (args: unknown) => d[op](args);
								const hook = hooks[op];
								if (!hook) return run;
								return (args: Row = {}) =>
									hook({
										model,
										operation: op,
										args,
										query: run,
									});
							},
						},
					);
				},
			},
		);
		return scoped;
	};

	return { db: client, store, delegates };
}
