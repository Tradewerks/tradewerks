import { useCallback, useEffect, useState } from "react";
import { api, type ClientLite, type DemoScenario, type DemoTech, type TechSnapshot } from "../api";

type Props = {
	techs: TechSnapshot[];
	notify: (kind: "success" | "error", text: string) => void;
};

const SCENARIOS: { value: DemoScenario; label: string; hint: string }[] = [
	{ value: "late", label: "Late", hint: "Due well before the live-traffic ETA. Dispatch gets a running-late alert." },
	{ value: "at_risk", label: "At risk", hint: "Only ~3 min to spare. Hit traffic to tip it into late." },
	{ value: "on_time", label: "On time", hint: "~25 min to spare. Stays green unless you add traffic." },
];

const fmtTime = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function fmtDuration(sec: number) {
	const s = Math.max(0, Math.round(sec));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ArrivalDemoPanel({ techs, notify }: Props) {
	const [allTechs, setAllTechs] = useState<DemoTech[]>([]);
	const [clients, setClients] = useState<ClientLite[]>([]);
	const [techId, setTechId] = useState("");
	const [clientId, setClientId] = useState("");
	const [scenario, setScenario] = useState<DemoScenario>("late");
	const [busy, setBusy] = useState(false);
	const [, setTick] = useState(0);

	const load = useCallback(async () => {
		try {
			const [t, c] = await Promise.all([api.listDemoTechs(), api.listClients()]);
			setAllTechs(t);
			setClients(c.filter((x) => x.coords));
		} catch (err) {
			notify("error", (err as Error).message);
		}
	}, [notify]);

	useEffect(() => {
		load();
	}, [load]);

	// Re-render every second so the arrival countdown runs smoothly
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, []);

	const demos = techs.filter((t) => t.demo);

	async function start(e: React.FormEvent) {
		e.preventDefault();
		if (!techId) return;
		setBusy(true);
		try {
			const { warning } = await api.startArrivalDemo({ techId, scenario, clientId: clientId || undefined });
			notify(warning ? "error" : "success", warning ?? "Demo started — watch the dispatch dashboard");
		} catch (err) {
			notify("error", (err as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function act(fn: () => Promise<unknown>, ok: string) {
		try {
			await fn();
			notify("success", ok);
		} catch (err) {
			notify("error", (err as Error).message);
		}
	}

	return (
		<div className="demo">
			<p className="demo-intro">
				Drives a tech to a client in real time with a promised arrival set from Mapbox live traffic. The
				dispatch app picks it up within a minute: <strong>Dashboard → Arrivals</strong>, the visit page and
				the map.
			</p>

			<form className="sim-form" onSubmit={start}>
				<label>
					Technician
					<select value={techId} onChange={(e) => setTechId(e.target.value)}>
						<option value="">-- select --</option>
						{allTechs.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
								{t.coords ? "" : " (no location — starts from sim home)"}
							</option>
						))}
					</select>
				</label>

				<fieldset className="scenario-group">
					<legend>Outcome</legend>
					{SCENARIOS.map((s) => (
						<label key={s.value} className={`scenario ${scenario === s.value ? "selected" : ""}`}>
							<input
								type="radio"
								name="scenario"
								value={s.value}
								checked={scenario === s.value}
								onChange={() => setScenario(s.value)}
							/>
							<span>
								<strong>{s.label}</strong>
								<small>{s.hint}</small>
							</span>
						</label>
					))}
				</fieldset>

				<label>
					Drive to
					<select value={clientId} onChange={(e) => setClientId(e.target.value)}>
						<option value="">Auto — a client about 10–15 min away</option>
						{clients.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</label>

				<button className="primary" type="submit" disabled={busy || !techId}>
					{busy ? "Starting…" : "Start arrival demo"}
				</button>
			</form>

			{demos.length > 0 && (
				<div className="demo-list">
					<h3>Running demos</h3>
					{demos.map((t) => {
						const d = t.demo!;
						const remaining = d.arrivedAt ? 0 : d.driveSec * (1 - d.progress);
						const stalled = !!d.stalledUntil;
						return (
							<div key={t.techId} className="demo-row">
								<div className="demo-head">
									<span className="name">{t.name}</span>
									<span className={`badge scenario-${d.scenario}`}>{d.scenario.replace("_", " ")}</span>
								</div>
								<div className="meta">
									<span>→ {d.clientName}</span>
									<span>Due {fmtTime(d.dueAt)}</span>
									<span>Drive {Math.round(d.driveSec / 60)} min</span>
									{d.stalledSec > 0 && <span>+{Math.round(d.stalledSec / 60)} min traffic</span>}
								</div>
								<div className="progress" aria-label="Drive progress">
									<div style={{ width: `${Math.round(d.progress * 100)}%` }} />
								</div>
								<div className="meta">
									{d.arrivedAt ? (
										<span>Arrived {fmtTime(d.arrivedAt)} — visit left On Site</span>
									) : stalled ? (
										<span className="stalled">Stuck in traffic until {fmtTime(d.stalledUntil!)}</span>
									) : (
										<span>Arrives in {fmtDuration(remaining)}</span>
									)}
								</div>
								<div className="buttons">
									{!d.arrivedAt && (
										<>
											<button
												className="secondary"
												onClick={() => act(() => api.stallDemo(t.techId, 5), "Added 5 min of traffic")}
											>
												Hit traffic +5 min
											</button>
											<button
												className="secondary"
												onClick={() => act(() => api.stallDemo(t.techId, 15), "Added 15 min of traffic")}
											>
												+15 min
											</button>
										</>
									)}
									<button
										className="secondary"
										onClick={() =>
											act(
												() => api.endDemo(t.techId),
												d.arrivedAt ? "Demo cleared" : "Demo ended — visit cancelled",
											)
										}
									>
										{d.arrivedAt ? "Clear" : "End demo"}
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
