import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { config } from "./config.js";
import { techsRouter } from "./controlApi/techs.js";
import { clientsRouter } from "./controlApi/clients.js";
import { jobsRouter } from "./controlApi/jobs.js";
import { visitsRouter } from "./controlApi/visits.js";
import { arrivalDemoRouter } from "./controlApi/arrivalDemo.js";

export function buildApp() {
	const app = express();
	app.use(express.json());

	// Permissive CORS so the Vite dev server on another port can call /api/*.
	app.use((_req, res, next) => {
		res.header("Access-Control-Allow-Origin", "*");
		res.header("Access-Control-Allow-Headers", "Content-Type");
		res.header(
			"Access-Control-Allow-Methods",
			"GET,POST,PUT,PATCH,DELETE,OPTIONS",
		);
		if (_req.method === "OPTIONS") return res.sendStatus(204);
		next();
	});

	app.use("/api", techsRouter);
	app.use("/api", clientsRouter);
	app.use("/api", jobsRouter);
	app.use("/api", visitsRouter);
	app.use("/api", arrivalDemoRouter);

	// Serve the built UI when present (dist after `npm run build` in ui/).
	// In dev, users hit the Vite server directly.
	const uiDist = path.resolve(process.cwd(), "ui/dist");
	app.use(express.static(uiDist));
	app.get(/^(?!\/api).*/, (_req, res) => {
		res.sendFile(path.join(uiDist, "index.html"), (err) => {
			if (err) res.status(404).end();
		});
	});

	app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
		console.error("[controlApi]", err.message);
		res.status(500).json({ error: err.message });
	});

	return app;
}

export function startServer() {
	const app = buildApp();
	return app.listen(config.simServerPort, () => {
		console.log(
			`[simulator] control panel listening on http://localhost:${config.simServerPort}`,
		);
	});
}
