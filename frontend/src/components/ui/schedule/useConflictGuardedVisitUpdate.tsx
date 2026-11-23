import { useCallback, useMemo, useState } from "react";
import { useReloadConflictedVisit, useUpdateJobVisitMutation } from "../../../hooks/useJobs";
import { isConflict, visitVersion } from "../../../lib/apiErrors";
import VisitConflictDialog from "../../jobs/VisitConflictDialog";
import type { JobVisit, UpdateJobVisitInput } from "../../../types/jobs";

/**
 * The board's visit save: stamps the version token and raises the conflict
 * dialog on a 409. Callers that captured the visit when the drag started pass
 * its token themselves; the lookup is the fallback for immediate drops.
 * Rethrows so each caller's existing failure path still reverts the card.
 */
export function useConflictGuardedVisitUpdate(visits: readonly JobVisit[]) {
	const { mutateAsync } = useUpdateJobVisitMutation();
	const reload = useReloadConflictedVisit();
	const [conflictOpen, setConflictOpen] = useState(false);
	const byId = useMemo(() => new Map(visits.map((v) => [v.id, v])), [visits]);

	const updateVisit = useCallback(
		async ({ id, data }: { id: string; data: UpdateJobVisitInput }) => {
			const expected = data.expected_updated_at ?? visitVersion(byId.get(id));
			if (!expected && import.meta.env.DEV) {
				console.warn(`Visit ${id} saved without a version token; this save can overwrite a concurrent edit.`);
			}
			try {
				return await mutateAsync({
					id,
					data: { ...data, expected_updated_at: expected },
				});
			} catch (err) {
				if (isConflict(err)) setConflictOpen(true);
				throw err;
			}
		},
		[mutateAsync, byId],
	);

	const conflictDialog = (
		<VisitConflictDialog
			open={conflictOpen}
			onReload={async () => {
				await reload();
				setConflictOpen(false);
			}}
			onClose={() => setConflictOpen(false)}
		/>
	);

	return { updateVisit, conflictDialog };
}
