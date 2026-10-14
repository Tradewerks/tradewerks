import { useAllClientsQuery } from "../../hooks/useClients";
import { useActiveDispatchersQuery } from "../../hooks/useDispatchers";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";
import {
    type Project,
    type UpdateProjectInput,
    type ProjectStatus,
    ProjectStatusValues,
    ProjectStatusLabels,
    UpdateProjectSchema,
} from "../../types/project";
import { useState, useMemo, useEffect } from "react";
import { type Priority, PriorityValues, PriorityLabels } from "../../types/common";
import type { ZodError } from "zod";


interface projectProps {
    isModalOpen: boolean;
    setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    project: Project;
    updateProject: (input: UpdateProjectInput) => Promise<string>;
}

const INPUT =
    "border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL =
    "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const toDateInput = (d: Date | string | null | undefined) =>
    d ? new Date(d).toISOString().split("T")[0] : "";

const toNumberInput = (n: number | null | undefined) =>
    n === null || n === undefined ? "" : String(Number(n));

export default function EditProjectModal ({isModalOpen, setIsModalOpen, project, updateProject}: projectProps){
    const [projectName, setProjectName] = useState(project.name ?? "");
    const [client, setClient] = useState(project.client_id ?? "");
    const [projectManager, setProjectManager] = useState(project.manager_dispatcher_id ?? "");
    const [status, setStatus] = useState<ProjectStatus>(project.status ?? "Planning");
    const [priority, setPriority] = useState<Priority>(project.priority ?? "Medium");
    const [budget, setBudget] = useState(toNumberInput(project.budget));
    const [startDate, setStartDate] = useState(toDateInput(project.starts_at));
    const [targetEndDate, setTargetEndDate] = useState(toDateInput(project.target_end_at));
    const [address, setAddress] = useState(project.address ?? "");
    const [description, setDescription] = useState(project.description ?? "");
    const [isLoading, setIsLoading] = useState(false);
    const [errors, setErrors] = useState<ZodError | null>(null);
    const [submitError, setSubmitError] = useState("");


    const { data: clients } = useAllClientsQuery();
    const clientList = useMemo(() => (clients ?? []), [clients]);

    const { data: dispatchers } = useActiveDispatchersQuery();
    const dispatcherList = useMemo(() => (dispatchers ?? []), [dispatchers]);

    const isFormValid = useMemo(
        () =>
            !!(
                projectName.trim() &&
                client.trim()
            ),
        [projectName, client]
    );

    useEffect(() => {
        if (!isModalOpen) return;
        setProjectName(project.name ?? "");
        setClient(project.client_id ?? "");
        setProjectManager(project.manager_dispatcher_id ?? "");
        setStatus(project.status ?? "Planning");
        setPriority(project.priority ?? "Medium");
        setBudget(toNumberInput(project.budget));
        setStartDate(toDateInput(project.starts_at));
        setTargetEndDate(toDateInput(project.target_end_at));
        setAddress(project.address ?? "");
        setDescription(project.description ?? "");
        setErrors(null);
        setSubmitError("");
    }, [isModalOpen, project]);

    const invokeUpdate = async () => {
        if (isLoading || !isFormValid) return;
        setSubmitError("");
        setErrors(null);

        const input: UpdateProjectInput = {
            name: projectName.trim(),
            client_id: client,
            description: description.trim(),
            status,
            priority,
            address: address.trim(),
            budget: budget.trim() ? Number(budget) : null,
            starts_at: startDate ? new Date(startDate).toISOString() : null,
            target_end_at: targetEndDate ? new Date(targetEndDate).toISOString() : null,
            manager_dispatcher_id: projectManager || null,
        };

        const parseResult = UpdateProjectSchema.safeParse(input);
        if (!parseResult.success) {
            setErrors(parseResult.error);
            return;
        }

        setIsLoading(true);
        try {
            const err = await updateProject(input);
            if (err) {
                setSubmitError(err);
                return;
            }
            setIsModalOpen(false); // reopening re-seeds from the refreshed project
        } catch (e) {
            setSubmitError(errorMessage(e, "Failed to update project"));
        } finally {
            setIsLoading(false);
        }
    };

    const ErrorDisplay = ({ path }: { path: string }) => {
        if (!errors) return null;
        const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
        if (fieldErrors.length === 0) return null;
        return (
            <div className="mt-0.5">
                {fieldErrors.map((err, idx) => (
                    <p
                        key={idx}
                        className="text-error-text text-xs leading-tight"
                    >
                        {err.message}
                    </p>
                ))}
            </div>
        );
    };

    const formContent = useMemo(
            () => (
                <div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
                    <FormErrorBanner message={submitError} />
                    {/* Name */}
                    <div className="min-w-0">
                        <label className={LABEL}>Project Name</label>
                        <input
                            type="text"
                            placeholder="e.g. Riverside Plaza — Rooftop HVAC Replacement"
                            value={projectName}
                            onChange={(e) => setProjectName(e.target.value)}
                            className={INPUT}
                            disabled={isLoading}
                        />
                        <ErrorDisplay path="name" />
                    </div>

                    {/* Client + Manager */}
                    <div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
                        <div className="min-w-0">
                            <label className={LABEL}>Client</label>
                            <select
                                value={client}
                                onChange={(e) => setClient(e.target.value)}
                                className={INPUT}
                                disabled={isLoading}
                            >
                                <option value="" disabled>Select a client…</option>
                                {clientList.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                            <ErrorDisplay path="client_id" />
                        </div>
                        <div className="min-w-0">
                            <label className={LABEL}>Project Manager</label>
                            <select
                                value={projectManager}
                                onChange={(e) => setProjectManager(e.target.value)}
                                className={INPUT}
                                disabled={isLoading}
                            >
                                <option value="">Unassigned</option>
                                {dispatcherList.map((d) => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Status + Priority */}
                    <div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
                        <div className="min-w-0">
                            <label className={LABEL}>Status</label>
                            <select
                                value={status}
                                onChange={(e) => setStatus(e.target.value as ProjectStatus)}
                                className={INPUT}
                                disabled={isLoading}
                            >
                                {ProjectStatusValues.map((s) => (
                                    <option key={s} value={s}>{ProjectStatusLabels[s]}</option>
                                ))}
                            </select>
                        </div>
                        <div className="min-w-0">
                            <label className={LABEL}>Priority</label>
                            <select
                                value={priority}
                                onChange={(e) => setPriority(e.target.value as Priority)}
                                className={INPUT}
                                disabled={isLoading}
                            >
                                {PriorityValues.map((p) => (
                                    <option key={p} value={p}>{PriorityLabels[p]}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Budget + Start date */}
                    <div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
                        <div className="min-w-0">
                            <label className={LABEL}>Budget</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="0.00"
                                value={budget}
                                onChange={(e) => setBudget(e.target.value)}
                                className={INPUT}
                                disabled={isLoading}
                            />
                            <ErrorDisplay path="budget" />
                        </div>
                        <div className="min-w-0">
                            <label className={LABEL}>Start Date</label>
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                className={INPUT}
                                disabled={isLoading}
                            />
                            <ErrorDisplay path="starts_at" />
                        </div>
                    </div>

                    {/* Target end date */}
                    <div className="min-w-0">
                        <label className={LABEL}>Target End Date</label>
                        <input
                            type="date"
                            value={targetEndDate}
                            onChange={(e) => setTargetEndDate(e.target.value)}
                            className={INPUT}
                            disabled={isLoading}
                        />
                        <ErrorDisplay path="target_end_at" />
                    </div>

                    {/* Address */}
                    <div className="min-w-0">
                        <label className={LABEL}>Address</label>
                        <input
                            type="text"
                            placeholder="Site address"
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                            className={INPUT}
                            disabled={isLoading}
                        />
                        <ErrorDisplay path="address" />
                    </div>

                    {/* Description */}
                    <div className="min-w-0">
                        <label className={LABEL}>Description</label>
                        <textarea
                            placeholder="Scope, phasing, notes..."
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
                            disabled={isLoading}
                        />
                    </div>
                </div>
            ),
            [
                projectName,
                client,
                projectManager,
                status,
                priority,
                budget,
                startDate,
                targetEndDate,
                address,
                description,
                isLoading,
                errors,
                submitError,
                clientList,
                dispatcherList,
            ]
        );

    return (
        <FormWizardContainer
            title={`Edit ${project.project_number}`}
            steps={[]}
            currentStep={1}
            visitedSteps={new Set([1])}
            isLoading={isLoading}
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            onSubmit={invokeUpdate}
            canGoNext={isFormValid}
            submitLabel="Save Changes"
        >
            {formContent}
        </FormWizardContainer>
    )
}