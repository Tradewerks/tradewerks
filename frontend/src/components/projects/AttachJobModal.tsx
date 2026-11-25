import { useJobSearchQuery } from "../../hooks/useJobs";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { JobStatusColors, JobStatusLabels, type JobStatus } from "../../types/jobs";
import type { Project } from "../../types/project";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import {
	TemplateSearch,
	type TemplateSearchClient,
	type TemplateSearchResult,
} from "../ui/forms/TemplateSearch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface attachJobProps {
    isModalOpen: boolean;
    setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    project: Project;
    attachJob: (jobIds: string[]) => Promise<{ id: string; message: string}[]>;
}

export default function AttachJobModal({isModalOpen, setIsModalOpen, project, attachJob}: attachJobProps) {
    const [selectedJobs, setSelectedJobs] = useState<string[]>([]); // holds only the job ids
    const [clientOnly, setClientOnly] = useState(true); // if the user wants to attach a job with a different client
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");

    const [search, setSearch] = useState("");
    const debouncedSearch = useDebouncedValue(search);
    // Server search (first 20): the unattached filter and client scope are applied there.
    const {data: jobs, isLoading: jobsLoading} = useJobSearchQuery(debouncedSearch, {
        enabled: isModalOpen,
        unattached: true,
        clientId: clientOnly ? project.client_id : undefined,
    });

    const eligible = useMemo(() => {
        const attached = new Set(project.jobs.map((j) => j.id));
        return (jobs?.rows ?? []).filter((job) => !attached.has(job.id));
    }, [jobs, project]);

    // Every job id seen in results to its client, so the scope toggle can prune picks the
    // current results no longer show.
    const selectedClientRef = useRef(new Map<string, string>());
    useEffect(() => {
        for (const j of eligible) selectedClientRef.current.set(j.id, j.client_id);
    }, [eligible]);

    const templateResults = useMemo((): TemplateSearchResult[] => {
        return eligible.map((j) => ({
            id: j.id,
            title: j.name,
            subtitle: j.job_number,
            detail: j.address || undefined,
            badge: JobStatusLabels[j.status as JobStatus] ?? j.status,
            badgeColor: JobStatusColors[j.status as JobStatus],
            value:
                j.estimated_total != null
                    ? `$${Number(j.estimated_total).toFixed(2)}`
                    : undefined,
            createdAt: new Date(j.created_at).toISOString(),
            clientId: j.client_id,
            clientName: j.client?.name,
        }));
    }, [eligible]);

    const templateClients = useMemo((): TemplateSearchClient[] => {
        const seen = new Map<string, string>();
        for (const j of eligible) {
            if (j.client_id && !seen.has(j.client_id)) {
                seen.set(j.client_id, j.client?.name ?? "Unknown client");
            }
        }
        return Array.from(seen, ([id, name]) => ({ id, name }));
    }, [eligible]);

    useEffect(() => {
        if (!isModalOpen) {
            setSelectedJobs([]);
            setClientOnly(true);
            setSearch("");
            setSubmitError("");
            setIsSubmitting(false);
        }
    }, [isModalOpen]);

    const handleToggleSelect = useCallback((id: string) => {
        setSelectedJobs((prev) =>
            prev.includes(id) ? prev.filter((j) => j !== id) : [...prev, id]
        );
    }, []);

    const clientLabel = project.client?.name ?? "this client";

    const invokeAttach = async () => {
        if (isSubmitting || selectedJobs.length === 0) return;
        setSubmitError("");
        setIsSubmitting(true);
        try {
            const failures = await attachJob(selectedJobs);
            if (failures.length === 0) {
                setIsModalOpen(false);
                return;
            }
            const attachedCount = selectedJobs.length - failures.length;
            setSelectedJobs(failures.map((f) => f.id));
            setSubmitError(
                `Attached ${attachedCount} of ${selectedJobs.length}. ` +
                    failures.map((f) => f.message).join(" · ")
            );
        } catch (error) {
            setSubmitError(
                error instanceof Error
                    ? error.message
                    : "Failed to attach jobs. Please try again."
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    const content = useMemo(() =>{
        return(
            <div className="space-y-2 lg:space-y-3 min-w-0">
                {submitError && (
                    <div className="rounded border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                        {submitError}
                    </div>
                )}

                <div className={isSubmitting ? "pointer-events-none opacity-60" : undefined}>
                    <TemplateSearch
                        heading="Unattached jobs"
                        headingHint={
                            selectedJobs.length > 0
                                ? `— ${selectedJobs.length} selected`
                                : "— click a job to select it"
                        }
                        placeholder="Search for jobs by number, name, or client..."
                        results={templateResults}
                        clients={templateClients}
                        isLoading={jobsLoading}
                        selectedIds={selectedJobs}
                        onToggleSelect={handleToggleSelect}
                        onQueryChange={setSearch}
                        onSelect={() => {}}
                        onClose={() => setIsModalOpen(false)}
                        scopeToggle={{
                            thisLabel: "This client",
                            anyLabel: "All clients",
                            isThisScope: clientOnly,
                            onToggle: () => {
                                // Narrowing to this client drops picks that belong to others.
                                if (!clientOnly) {
                                    setSelectedJobs((prev) =>
                                        prev.filter((id) => selectedClientRef.current.get(id) === project.client_id)
                                    );
                                }
                                setClientOnly((v) => !v);
                            },
                        }}
                        emptyHint={
                            clientOnly
                                ? `No unattached jobs for ${clientLabel}. Switch to "All clients" to see every client.`
                                : "No unattached jobs — every job already belongs to a project."
                        }
                    />
                </div>
            </div>
        )
    }, [
        jobsLoading,
        submitError,
        clientOnly,
        clientLabel,
        isSubmitting,
        templateResults,
        templateClients,
        selectedJobs,
        handleToggleSelect,
        setIsModalOpen,
    ])

    return (

        <FormWizardContainer
            title={`Attach Jobs to ${project.project_number}`}
			steps={[]}
            currentStep={1}
            visitedSteps={new Set([1])}
            isLoading={isSubmitting}
            isOpen={isModalOpen}
            onClose={() => !isSubmitting && setIsModalOpen(false)}
            onSubmit={invokeAttach}
            canGoNext={selectedJobs.length > 0}
            submitLabel={
                selectedJobs.length > 0
                    ? `Attach ${selectedJobs.length} job${selectedJobs.length === 1 ? "" : "s"}`
                    : "Attach"
            }
        >
            {content}
        </FormWizardContainer>
    );
}
