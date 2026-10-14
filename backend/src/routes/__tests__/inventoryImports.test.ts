import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response, Router } from "express";

vi.mock("../../controllers/inventoryImportsController.js", () => ({
	createImport: vi.fn(),
	listImports: vi.fn(),
	getImport: vi.fn(),
	listCandidates: vi.fn(),
	patchCandidate: vi.fn(),
	approveFinancial: vi.fn(),
	retryImport: vi.fn(),
	commitImport: vi.fn(),
	undoImport: vi.fn(),
	cancelImport: vi.fn(),
}));

import inventoryImportsRouter from "../inventoryImports.js";
import {
	approveFinancial,
	cancelImport,
	commitImport,
	createImport,
	getImport,
	listCandidates,
	listImports,
	patchCandidate,
	retryImport,
	undoImport,
} from "../../controllers/inventoryImportsController.js";

type Method = "get" | "post" | "patch";

function handlers(method: Method, path: string) {
	const stack = (inventoryImportsRouter as unknown as Router & {
		stack: Array<{
			route?: {
				path: string;
				methods: Record<string, boolean>;
				stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => unknown }>;
			};
		}>;
	}).stack;
	const layer = stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
	if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
	return layer.route.stack.map((entry) => entry.handle);
}

function request(permissions: string[]): Request {
	return {
		user: { uid: "dispatcher-1", role: "dispatcher", organization_id: "org-1", permissions },
		params: { id: "import-1", candidateId: "candidate-1" },
		body: {},
		query: {},
		headers: {},
	} as unknown as Request;
}

function response() {
	const res = { status: vi.fn(), json: vi.fn() } as unknown as Response & {
		status: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
	};
	res.status.mockReturnValue(res);
	res.json.mockReturnValue(res);
	return res;
}

async function dispatch(routeHandlers: ReturnType<typeof handlers>, req: Request, res: Response, index = 0): Promise<void> {
	if (index >= routeHandlers.length) return;
	await new Promise<void>((resolve, reject) => {
		let continued = false;
		const next = ((error?: unknown) => {
			continued = true;
			if (error) reject(error);
			else dispatch(routeHandlers, req, res, index + 1).then(resolve, reject);
		}) as NextFunction;
		Promise.resolve(routeHandlers[index](req, res, next)).then(() => {
			if (!continued) resolve();
		}, reject);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("inventory import route permissions", () => {
	it.each([
		["get", "/", listImports],
		["get", "/:id", getImport],
		["get", "/:id/candidates", listCandidates],
	] as const)("allows view_inventory to %s %s", async (method, path, controller) => {
		const res = response();
		await dispatch(handlers(method, path), request(["view_inventory"]), res);
		expect(controller).toHaveBeenCalledOnce();
		expect(res.status).not.toHaveBeenCalledWith(403);
	});

	it.each([
		["post", "/", createImport],
		["patch", "/:id/candidates/:candidateId", patchCandidate],
		["post", "/:id/financial-approval", approveFinancial],
		["post", "/:id/retry", retryImport],
		["post", "/:id/commit", commitImport],
		["post", "/:id/undo", undoImport],
		["post", "/:id/cancel", cancelImport],
	] as const)("denies view-only users attempting to %s %s", async (method, path, controller) => {
		const res = response();
		await dispatch(handlers(method, path), request(["view_inventory"]), res);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(controller).not.toHaveBeenCalled();
	});

	it("allows manage_inventory to commit", async () => {
		const res = response();
		await dispatch(handlers("post", "/:id/commit"), request(["manage_inventory"]), res);
		expect(commitImport).toHaveBeenCalledOnce();
	});
});
