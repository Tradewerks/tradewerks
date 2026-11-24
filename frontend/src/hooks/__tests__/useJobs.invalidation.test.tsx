import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCreateJobMutation } from "../useJobs";
import * as jobApi from "../../api/jobs";

const wrapper =
	(qc: QueryClient) =>
	({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);

describe("useCreateJobMutation", () => {
	it("useCreateJobMutation resolves before its invalidations settle", async () => {
		const job = { id: "j1", client_id: "c1", request_id: "r1", quote_id: "q1" };
		vi.spyOn(jobApi, "createJob").mockResolvedValue(job as never);
		const qc = new QueryClient();
		const invalidate = vi
			.spyOn(qc, "invalidateQueries")
			.mockImplementation(() => new Promise<void>(() => undefined));
		const { result } = renderHook(() => useCreateJobMutation(), { wrapper: wrapper(qc) });
		await expect(result.current.mutateAsync({} as never)).resolves.toMatchObject({ id: "j1" });
		expect(invalidate).toHaveBeenCalled();
		expect(qc.getQueryData(["jobs", "j1"])).toMatchObject({ id: "j1" });
	});
});
