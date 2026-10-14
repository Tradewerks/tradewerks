import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import {
    useQBMappedEmployeesQuery,
    useQBEmployeesQuery,
    usePushQBEmployeeMutation,
    useLinkQBEmployeeMutation,
    useUnlinkQBEmployeeMutation,
} from "../../hooks/useQuickbooks";
import { usePermission } from "../../hooks/usePermission";
import { useToast } from "../ui/useToast";
import type { QBEmployeeLite } from "../../types/quickbooks";
import LinkQBEmployeeModal from "./LinkQBEmployeeModal";
import type { Technician } from "../../types/technicians";
import { useAllTechniciansQuery } from "../../hooks/useTechnicians";

const NO_PERMISSION_TITLE = "You don't have permission to perform this action";

export default function QBEmployeeMappingCard() {
    const { data: mappedEmployees } = useQBMappedEmployeesQuery();
    const { data: qbEmployees } = useQBEmployeesQuery();
    const { data: technicians } = useAllTechniciansQuery();
    const push = usePushQBEmployeeMutation();
    const link = useLinkQBEmployeeMutation();
    const unlink = useUnlinkQBEmployeeMutation();
    const toast = useToast();
    const onError = (e: Error) => toast.error(e.message);

    // permissions
    const MANAGE_TECHNICIANS = usePermission("manage_technicians");
    const [linkTechnician, setLinkTechnician] = useState<Technician | null>(null);

    // technician_id -> linked QB external_id
    const mappedByEmployeeId = useMemo(
        () => new Map((mappedEmployees ?? []).map((m) => [m.technician_id, m.external_id])),
        [mappedEmployees],
    );
    // QB Id -> QB employee name (to show what an employee is linked to)
    const qbNameById = useMemo(
        () => new Map((qbEmployees ?? []).map((q) => [q.Id, q.DisplayName])),
        [qbEmployees],
    );
    // technician_id -> unlinked QB employee the backend matched by email or name
    const suggestionByTechId = useMemo(
        () =>
            new Map(
                (qbEmployees ?? [])
                    .filter((q) => q.suggestedTechnicianId && !q.linkedTechnicianId)
                    .map((q): [string, QBEmployeeLite] => [q.suggestedTechnicianId!, q]),
            ),
        [qbEmployees],
    );

    return (
        <div>
            <p className="mb-4 text-xs text-text-muted leading-relaxed w-fit">
                Link technicians to QuickBooks employees so their hours sync to the right person.
            </p>

            {technicians?.length ? (
                <div className="grid gap-3 [grid-template-columns:repeat(2,minmax(0,1fr))]">
                    {technicians.map((tech) => {
                        const externalId = mappedByEmployeeId.get(tech.id);
                        const linked = externalId != null;
                        const suggestion = suggestionByTechId.get(tech.id);
                        return (
                            <div key={tech.id} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3.5">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-text-primary" title={tech.name}>
                                        {tech.name}
                                    </div>
                                    <div className="truncate text-xs text-text-muted" title={tech.email}>{tech.email}</div>
                                </div>
                                {linked ? (
                                    <div className="flex items-center justify-between gap-2 border-t border-surface-raised pt-2">
                                        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-success-text">
                                            <CheckCircle2 size={11} className="flex-shrink-0" />
                                            <span className="truncate">{qbNameById.get(externalId!) ?? `#${externalId}`}</span>
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => unlink.mutate(tech.id, { onError })}
                                            disabled={!MANAGE_TECHNICIANS || unlink.isPending}
                                            title={!MANAGE_TECHNICIANS ? NO_PERMISSION_TITLE : undefined}
                                            className="flex-shrink-0 rounded-md border border-border bg-surface-raised px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Unlink
                                        </button>
                                    </div>
                                ) : suggestion ? (
                                    <div className="flex items-center justify-between gap-2 border-t border-surface-raised pt-2">
                                        <span className="min-w-0 truncate text-xs text-text-tertiary">
                                            Suggested:{" "}
                                            <span className="font-medium text-text-primary" title={suggestion.DisplayName}>
                                                {suggestion.DisplayName}
                                            </span>
                                        </span>
                                        <div className="flex flex-shrink-0 items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    link.mutate(
                                                        { technician_id: tech.id, qb_employee_id: suggestion.Id },
                                                        { onError },
                                                    )
                                                }
                                                disabled={!MANAGE_TECHNICIANS || link.isPending}
                                                title={!MANAGE_TECHNICIANS ? NO_PERMISSION_TITLE : undefined}
                                                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                Link
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setLinkTechnician(tech)}
                                                disabled={!MANAGE_TECHNICIANS}
                                                title={!MANAGE_TECHNICIANS ? NO_PERMISSION_TITLE : undefined}
                                                className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                Choose…
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 border-t border-surface-raised pt-2">
                                        <button
                                            type="button"
                                            onClick={() => setLinkTechnician(tech)}
                                            disabled={!MANAGE_TECHNICIANS}
                                            title={!MANAGE_TECHNICIANS ? NO_PERMISSION_TITLE : undefined}
                                            className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Link
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => push.mutate(tech.id, { onError })}
                                            disabled={!MANAGE_TECHNICIANS || push.isPending}
                                            title={!MANAGE_TECHNICIANS ? NO_PERMISSION_TITLE : undefined}
                                            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Push to QB
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="rounded-lg border border-border-subtle px-5 py-8 text-center text-sm text-text-muted">
                    No technicians yet.
                </div>
            )}

            {linkTechnician && (
                <LinkQBEmployeeModal technician={linkTechnician} isOpen={!!linkTechnician} onClose={() => setLinkTechnician(null)} />
            )}
        </div>
    );
}
