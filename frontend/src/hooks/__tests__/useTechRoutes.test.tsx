import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Technician } from "../../types/technicians";

const fetchDrivingRoute = vi.hoisted(() => vi.fn());
vi.mock("../../api/directions", () => ({ fetchDrivingRoute }));

import { useTechRoutes } from "../useTechRoutes";
import { getTechColor } from "../../lib/techColors";

function drivingTech(id: string, visitId: string, jobId: string): Technician {
	return {
		id,
		name: `Tech ${id}`,
		coords: { lat: 43.8, lon: -91.2 },
		status: "EnRoute",
		visit_techs: [
			{
				visit_id: visitId,
				tech_id: id,
				tech_status: "EnRoute",
				visit: {
					id: visitId,
					job_id: jobId,
					status: "Driving",
					scheduled_start_at: "2026-10-01T15:00:00Z",
					job: { id: jobId, name: "Job", coords: { lat: 43.9, lon: -91.3 } },
				},
			},
		],
	} as unknown as Technician;
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("useTechRoutes", () => {
	test("routes carry the visit and job they lead to", async () => {
		fetchDrivingRoute.mockResolvedValue(null);
		const techs = [drivingTech("t1", "v1", "j1")];
		const { result } = renderHook(() => useTechRoutes(techs), { wrapper });
		expect(result.current[0]).toMatchObject({ techId: "t1", visitId: "v1", jobId: "j1" });
	});

	test("a scope fetches only scoped techs but keeps the org-wide color", async () => {
		fetchDrivingRoute.mockReset().mockResolvedValue(null);
		const techs = [drivingTech("t1", "v1", "j1"), drivingTech("t2", "v2", "j2")];
		const scope = new Set(["t2"]);
		const { result } = renderHook(() => useTechRoutes(techs, scope), { wrapper });
		expect(result.current.map((r) => r.techId)).toEqual(["t2"]);
		expect(result.current[0].color).toBe(getTechColor("t2", ["t1", "t2"]));
		await waitFor(() => expect(fetchDrivingRoute).toHaveBeenCalledTimes(1));
	});

	test("re-rendering with the same inputs returns the same reference", () => {
		fetchDrivingRoute.mockReset().mockResolvedValue(null);
		const client = new QueryClient();
		const stableWrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const techs = [drivingTech("t1", "v1", "j1")];
		const { result, rerender } = renderHook(() => useTechRoutes(techs), {
			wrapper: stableWrapper,
		});
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
		expect(result.current[0]).toBe(first[0]);
	});
});
