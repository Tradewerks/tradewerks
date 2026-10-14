export type TechSnapshot = {
	techId: string;
	name: string;
	state: "Idle" | "Driving" | "OnSite" | "Working";
	currentVisitId: string | null;
	coords: { lat: number; lon: number };
	isActive: boolean;
	demo: ArrivalDemo | null;
};

export type DemoScenario = "late" | "at_risk" | "on_time";

export type ArrivalDemo = {
	scenario: DemoScenario;
	visitId: string;
	jobId: string;
	clientName: string;
	dueAt: string;
	driveSec: number;
	startedAt: string;
	stalledSec: number;
	stalledUntil: string | null;
	arrivedAt: string | null;
	progress: number;
};

export type DemoTech = {
	id: string;
	name: string;
	status: string;
	coords: { lat: number; lon: number } | null;
};

export type ClientLite = {
	id: string;
	name: string;
	address: string;
	coords?: { lat: number; lon: number };
};

export type VisitLite = {
	id: string;
	name?: string;
	status: string;
	scheduled_start_at: string;
	scheduled_end_at: string;
	job?: { id: string; name: string; address: string };
};

async function request<T>(
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`/api${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = `${res.status} ${res.statusText}`;
		try {
			const j = await res.json();
			if (j?.error) msg = j.error;
		} catch {
			// no json body
		}
		throw new Error(msg);
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

export const api = {
	getState: () => request<TechSnapshot[]>("GET", "/state"),
	createTech: (name: string, coords?: { lat: number; lon: number }) =>
		request<TechSnapshot>("POST", "/techs", { name, coords }),
	startTech: (id: string) => request<TechSnapshot>("POST", `/techs/${id}/start`),
	pauseTech: (id: string) => request<TechSnapshot>("POST", `/techs/${id}/pause`),
	replayTech: (id: string) => request<TechSnapshot>("POST", `/techs/${id}/replay`),

	listClients: () => request<ClientLite[]>("GET", "/clients"),
	createClient: (body: {
		name: string;
		address: string;
		coords: { lat: number; lon: number };
	}) => request<ClientLite>("POST", "/clients", body),

	createJobWithVisit: (body: {
		client_id: string;
		address: string;
		coords: { lat: number; lon: number };
		visit_name: string;
		description?: string;
		scheduled_start_at: string;
		scheduled_end_at: string;
		tech_ids: string[];
	}) => request<unknown>("POST", "/job-with-visit", body),

	listDemoTechs: () => request<DemoTech[]>("GET", "/demo/techs"),
	startArrivalDemo: (body: { techId: string; scenario: DemoScenario; clientId?: string }) =>
		request<{ snapshot: TechSnapshot; warning?: string }>("POST", "/demo/arrival", body),
	stallDemo: (techId: string, minutes: number) =>
		request<TechSnapshot>("POST", `/demo/arrival/${techId}/stall`, { minutes }),
	endDemo: (techId: string) => request<TechSnapshot>("POST", `/demo/arrival/${techId}/end`),

	listScheduledVisits: () =>
		request<VisitLite[]>("GET", "/visits?status=Scheduled"),
	assignVisit: (visitId: string, tech_ids: string[]) =>
		request<unknown>("POST", `/visits/${visitId}/assign`, { tech_ids }),
};
