import { useCallback, useEffect, useState } from "react";
import { api, type TechSnapshot } from "./api";
import { TechList } from "./components/TechList";
import { CreateTechForm } from "./components/CreateTechForm";
import { CreateClientForm } from "./components/CreateClientForm";
import { CreateJobVisitForm } from "./components/CreateJobVisitForm";
import { AssignVisitForm } from "./components/AssignVisitForm";
import { ArrivalDemoPanel } from "./components/ArrivalDemoPanel";

type TabKey = "tech" | "client" | "job" | "assign" | "demo";
type Toast = { kind: "success" | "error"; text: string } | null;

export default function App() {
	const [tab, setTab] = useState<TabKey>("tech");
	const [techs, setTechs] = useState<TechSnapshot[]>([]);
	const [toast, setToast] = useState<Toast>(null);

	const refresh = useCallback(async () => {
		try {
			const next = await api.getState();
			setTechs(next);
		} catch (err) {
			console.error(err);
		}
	}, []);

	useEffect(() => {
		refresh();
		const t = setInterval(refresh, 1000);
		return () => clearInterval(t);
	}, [refresh]);

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(null), 3500);
		return () => clearTimeout(t);
	}, [toast]);

	const notify = useCallback((kind: "success" | "error", text: string) => {
		setToast({ kind, text });
	}, []);

	return (
		<div className="app">
			<section className="panel">
				<h2>Controls</h2>
				<div className="tabs">
					<button
						className={`tab ${tab === "tech" ? "active" : ""}`}
						onClick={() => setTab("tech")}
					>
						New Tech
					</button>
					<button
						className={`tab ${tab === "client" ? "active" : ""}`}
						onClick={() => setTab("client")}
					>
						New Client
					</button>
					<button
						className={`tab ${tab === "job" ? "active" : ""}`}
						onClick={() => setTab("job")}
					>
						New Job + Visit
					</button>
					<button
						className={`tab ${tab === "assign" ? "active" : ""}`}
						onClick={() => setTab("assign")}
					>
						Assign Visit
					</button>
					<button
						className={`tab ${tab === "demo" ? "active" : ""}`}
						onClick={() => setTab("demo")}
					>
						Arrival Demo
					</button>
				</div>

				{tab === "tech" && (
					<CreateTechForm onDone={refresh} notify={notify} />
				)}
				{tab === "client" && <CreateClientForm notify={notify} />}
				{tab === "job" && <CreateJobVisitForm techs={techs} notify={notify} />}
				{tab === "assign" && (
					<AssignVisitForm techs={techs} notify={notify} />
				)}
				{tab === "demo" && <ArrivalDemoPanel techs={techs} notify={notify} />}
			</section>

			<section className="panel">
				<h2>Technicians</h2>
				<TechList techs={techs} onDone={refresh} notify={notify} />
			</section>

			{toast && (
				<div className={`toast ${toast.kind}`}>{toast.text}</div>
			)}
		</div>
	);
}
