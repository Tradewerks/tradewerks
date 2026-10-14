import type { AxiosRequestConfig } from "axios";
import http from "./httpService.js";
import { config } from "../config.js";
import * as adminAuth from "../auth/adminAuth.js";
import type { Coordinates } from "../types/location.js";
import type { Technician } from "../types/technicians.js";
import type { Client } from "../types/clients.js";
import type { Job, JobVisit, VisitStatus } from "../types/jobs.js";

type Envelope<T> = {
	success: boolean;
	data: T | null;
	error: { code: string; message: string } | null;
};

async function call<T>(
	method: "get" | "post" | "put" | "patch" | "delete",
	path: string,
	body?: unknown,
	config2: AxiosRequestConfig = {},
): Promise<T> {
	const token = await adminAuth.getToken();
	const url = `${config.backendUrl}${path}`;
	const headers = {
		...(config2.headers ?? {}),
		Authorization: `Bearer ${token}`,
	};

	const send = (): Promise<{ status: number; data: Envelope<T> }> => {
		if (method === "get" || method === "delete") {
			return http.request<Envelope<T>>({
				url,
				method,
				headers,
				...config2,
				validateStatus: () => true,
			});
		}
		return http.request<Envelope<T>>({
			url,
			method,
			headers,
			data: body,
			...config2,
			validateStatus: () => true,
		});
	};

	let resp = await send();
	if (resp.status === 401) {
		console.warn(
			`[backendApi] ${method.toUpperCase()} ${path} got 401 — body:`,
			JSON.stringify(resp.data),
		);
		adminAuth.invalidate();
		const newToken = await adminAuth.getToken();
		headers.Authorization = `Bearer ${newToken}`;
		resp = await send();
	}

	const env = resp.data;
	if (!env || !env.success) {
		const code = env?.error?.code;
		const msg = env?.error?.message ?? `HTTP ${resp.status}`;
		throw new Error(
			`${method.toUpperCase()} ${path} failed: HTTP ${resp.status}${code ? ` ${code}` : ""} — ${msg}`,
		);
	}
	return env.data as T;
}

// ── Technicians ─────────────────────────────────────────────────────────────

export const listTechnicians = () => call<Technician[]>("get", "/technicians");

export const createTechnician = (body: {
	name: string;
	email: string;
	phone: string;
	password: string;
	title: string;
	coords: Coordinates;
	description?: string;
}) => call<Technician>("post", "/technicians", body);

export const pingTechnician = (id: string, coords: Coordinates) =>
	call<Technician>("post", `/technicians/${id}/ping`, { coords });

export const getTechnicianVisits = (techId: string) =>
	call<JobVisit[]>("get", `/technicians/${techId}/visits`);

// ── Clients ─────────────────────────────────────────────────────────────────

export const listClients = () => call<Client[]>("get", "/clients");

export const createClient = (body: {
	name: string;
	address: string;
	coords: Coordinates;
	is_active?: boolean;
}) => call<Client>("post", "/clients", body);

// ── Jobs ────────────────────────────────────────────────────────────────────

export const createJob = (body: {
	name: string;
	client_id: string;
	address: string;
	coords: Coordinates;
	description?: string;
}) => call<Job>("post", "/jobs", body);

// ── Job Visits ──────────────────────────────────────────────────────────────

export const createJobVisit = (body: {
	job_id: string;
	name: string;
	arrival_constraint: "anytime" | "at" | "between" | "by";
	finish_constraint: "when_done" | "at" | "by";
	scheduled_start_at: string;
	scheduled_end_at: string;
	tech_ids?: string[];
}) => call<JobVisit>("post", "/job-visits", body);

export const updateJobVisit = (
	id: string,
	body: {
		status?: VisitStatus;
		actual_start_at?: string | null;
		actual_end_at?: string | null;
	},
) => call<JobVisit>("put", `/job-visits/${id}`, body);

export const assignVisitTechs = (visitId: string, tech_ids: string[]) =>
	call<JobVisit>("put", `/job-visits/${visitId}/technicians`, { tech_ids });

export const listVisitsInRange = (startIso: string, endIso: string) =>
	call<JobVisit[]>(
		"get",
		`/job-visits/date-range/${encodeURIComponent(startIso)}/${encodeURIComponent(endIso)}`,
	);

// Lifecycle transitions go through the same path as the tech app, so tech_status,
// drive records and the arrival tracker all see a real drive.
export type VisitAction = "drive" | "arrive" | "start" | "complete";

export const transitionVisit = (id: string, action: VisitAction, tech_coords?: Coordinates) =>
	call<JobVisit>("post", `/job-visits/${id}/transition`, { action, tech_coords });

export const cancelVisit = (id: string, cancellation_reason: string) =>
	call<JobVisit>("post", `/job-visits/${id}/cancel`, { cancellation_reason });

export const createAtVisit = (body: {
	job_id: string;
	name: string;
	scheduled_start_at: string;
	scheduled_end_at: string;
	arrival_time: string;
	tech_ids: string[];
}) =>
	call<JobVisit>("post", "/job-visits", {
		...body,
		arrival_constraint: "at",
		finish_constraint: "when_done",
	});

/** The org timezone rides in the access token; no extra request needed. */
export async function getOrgTimezone(): Promise<string> {
	const token = await adminAuth.getToken();
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		return payload.organization_timezone || "America/Chicago";
	} catch {
		return "America/Chicago";
	}
}
