import { vi, type Mock } from "vitest";
import type { Request, Response, NextFunction, Router } from "express";

/**
 * Route-level test harness (generalised from org.test.ts).
 *
 * - `createFakeDb()` builds a minimal stand-in for the Prisma client: every
 *   `db.<model>.<op>` is a lazily created `vi.fn()`, `$transaction(fn)` runs the
 *   callback against the same client, and `$extends(cfg)` returns a scoped
 *   client that drives the real `getScopedDb` query hooks before landing on the
 *   base delegate — so assertions can inspect the final, org-scoped args.
 *   Test files register it with `vi.mock("../../db.js", async () => ({ db: (await import("./harness.js")).createFakeDb() }))`.
 * - `callRoute(router, method, path, opts)` runs a router's handler chain for a
 *   route the way Express would and returns the status/body that was sent.
 */

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

type Delegate = Record<string, Mock>;

export interface FakeDb {
	[model: string]: any;
	$transaction: Mock;
	$executeRaw: Mock;
	$executeRawUnsafe: Mock;
	$queryRaw: Mock;
	$extends: (cfg: any) => any;
}

export function createFakeDb(): FakeDb {
	const delegates: Record<string, Delegate> = {};
	const delegateFor = (model: string): Delegate =>
		(delegates[model] ??= new Proxy({} as Delegate, {
			get(target, op: string) {
				if (op === "then") return undefined;
				return (target[op] ??= vi.fn());
			},
		}));

	const base: Record<string, unknown> = {
		$executeRaw: vi.fn(),
		$executeRawUnsafe: vi.fn(),
		$queryRaw: vi.fn(),
	};

	const client: FakeDb = new Proxy(base as FakeDb, {
		get(target, prop: string) {
			if (prop in target) return (target as Record<string, unknown>)[prop];
			if (prop === "then") return undefined;
			return delegateFor(prop);
		},
	});

	base.$transaction = vi.fn(async (arg: unknown) =>
		typeof arg === "function" ? arg(client) : Promise.all(arg as Promise<unknown>[]),
	);

	base.$extends = (cfg: { query?: { $allModels?: Record<string, Handler | any> } }) => {
		const hooks = cfg?.query?.$allModels ?? {};
		const scopedBase: Record<string, unknown> = {
			$executeRaw: base.$executeRaw,
			$executeRawUnsafe: base.$executeRawUnsafe,
			$queryRaw: base.$queryRaw,
		};
		const scoped: any = new Proxy(scopedBase, {
			get(target, model: string) {
				if (model in target) return target[model];
				if (model === "then") return undefined;
				return new Proxy(
					{},
					{
						get(_t, op: string) {
							if (op === "then") return undefined;
							const run = (args: unknown) => delegateFor(model)[op](args);
							const hook = hooks[op];
							if (!hook) return run;
							return (args: unknown = {}) =>
								hook({ model, operation: op, args, query: run });
						},
					},
				);
			},
		});
		scopedBase.$transaction = vi.fn(async (arg: unknown) =>
			typeof arg === "function" ? arg(scoped) : Promise.all(arg as Promise<unknown>[]),
		);
		return scoped;
	};

	return client;
}

type RouterLayer = {
	route?: {
		path: string;
		methods: Record<string, boolean>;
		stack: Array<{ handle: Handler }>;
	};
	handle?: Handler;
	name?: string;
};

export function getHandlers(router: Router, method: string, path: string): Handler[] {
	const stack = (router as unknown as { stack: RouterLayer[] }).stack;
	const routeLayer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
	if (!routeLayer?.route) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
	// Router-level middleware registered via router.use() before the route
	// (e.g. denyTechnicians) runs ahead of the route's own handlers.
	const routeIndex = stack.indexOf(routeLayer);
	const routerUse = stack
		.slice(0, routeIndex)
		.filter((l) => !l.route && typeof l.handle === "function")
		.map((l) => l.handle as Handler);
	return [...routerUse, ...routeLayer.route.stack.map((s) => s.handle)];
}

export interface CallOptions {
	user?: Record<string, unknown> | null;
	params?: Record<string, string>;
	query?: Record<string, unknown>;
	body?: unknown;
	headers?: Record<string, string>;
	ip?: string;
}

export interface CallResult {
	status: number;
	body: any;
	res: Response & { status: Mock; json: Mock };
}

export function makeReq(opts: CallOptions = {}): Request {
	const user =
		opts.user === null
			? undefined
			: { uid: "user-1", organization_id: "org-1", role: "admin", permissions: [], ...(opts.user ?? {}) };
	return {
		user,
		params: opts.params ?? {},
		query: opts.query ?? {},
		body: opts.body ?? {},
		headers: opts.headers ?? {},
		ip: opts.ip,
		method: "GET",
		path: "/",
	} as unknown as Request;
}

export function makeRes() {
	const res: Partial<Response> & { status: Mock; json: Mock; statusCode: number } = {
		statusCode: 200,
		status: vi.fn(),
		json: vi.fn(),
	};
	res.status = vi.fn((code: number) => {
		res.statusCode = code;
		return res as Response;
	});
	res.json = vi.fn().mockReturnValue(res as Response);
	return res as Response & { status: Mock; json: Mock; statusCode: number };
}

// Dispatches handlers[i..] like Express would, resolving once a handler ends
// the response without calling next(), or next() runs past the last handler.
function dispatch(handlers: Handler[], req: Request, res: Response, i: number): Promise<void> {
	if (i >= handlers.length) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		let nextCalled = false;
		const next: NextFunction = ((err?: unknown) => {
			nextCalled = true;
			if (err) return reject(err);
			dispatch(handlers, req, res, i + 1).then(resolve, reject);
		}) as NextFunction;
		Promise.resolve(handlers[i](req, res, next))
			.then(() => {
				if (!nextCalled) resolve();
			})
			.catch(reject);
	});
}

export async function runChain(handlers: Handler[], req: Request, res: Response) {
	await dispatch(handlers, req, res, 0);
}

export async function callRoute(
	router: Router,
	method: string,
	path: string,
	opts: CallOptions = {},
): Promise<CallResult> {
	const handlers = getHandlers(router, method, path);
	const req = makeReq(opts);
	const res = makeRes();
	await runChain(handlers, req, res);
	const lastJson = res.json.mock.calls[res.json.mock.calls.length - 1];
	return { status: res.statusCode, body: lastJson ? lastJson[0] : undefined, res };
}

export async function callHandlers(handlers: Handler[], opts: CallOptions = {}): Promise<CallResult> {
	const req = makeReq(opts);
	const res = makeRes();
	await runChain(handlers, req, res);
	const lastJson = res.json.mock.calls[res.json.mock.calls.length - 1];
	return { status: res.statusCode, body: lastJson ? lastJson[0] : undefined, res };
}

// ── Where-tree helpers for asserting on Prisma filters ───────────────────────

// Flattens nested AND/OR/NOT where-clauses into a list of leaf conditions so
// tests can assert "a condition like X is present somewhere in the filter".
export function leaves(where: unknown): Record<string, unknown>[] {
	if (!where || typeof where !== "object") return [];
	if (Array.isArray(where)) return where.flatMap(leaves);
	const obj = where as Record<string, unknown>;
	const out: Record<string, unknown>[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (k === "AND" || k === "OR" || k === "NOT") out.push(...leaves(v));
		else out.push({ [k]: v });
	}
	return out;
}

// Recursively collects every object in the filter tree that carries all `keys`.
export function clausesWith(where: unknown, keys: string[]): Record<string, unknown>[] {
	if (!where || typeof where !== "object") return [];
	if (Array.isArray(where)) return where.flatMap((w) => clausesWith(w, keys));
	const obj = where as Record<string, unknown>;
	const here = keys.every((k) => k in obj) ? [obj] : [];
	return [...here, ...Object.values(obj).flatMap((v) => clausesWith(v, keys))];
}

// Every condition that appears under a NOT, anywhere in the tree.
export function notClauses(where: unknown): unknown[] {
	if (!where || typeof where !== "object") return [];
	if (Array.isArray(where)) return where.flatMap(notClauses);
	const obj = where as Record<string, unknown>;
	const out: unknown[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (k === "NOT") out.push(...(Array.isArray(v) ? v : [v]));
		else if (k === "AND" || k === "OR") out.push(...notClauses(v));
	}
	return out;
}

// A plausible `log` row for history/feed tests.
export const makeLogRow = (over: Record<string, unknown> = {}) => ({
	id: "log-1",
	organization_id: "org-1",
	event_type: "job.updated",
	action: "updated",
	entity_type: "job",
	entity_id: "job-1",
	actor_type: "dispatcher",
	actor_id: "disp-1",
	actor_name: "D",
	changes: { name: { old: "a", new: "b" } },
	timestamp: new Date("2026-08-01T00:00:00Z"),
	ip_address: null,
	user_agent: null,
	reason: null,
	...over,
});
