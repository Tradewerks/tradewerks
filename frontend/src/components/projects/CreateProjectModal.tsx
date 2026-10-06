import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZodError } from "zod";
import {
    CreateProjectSchema,
    type CreateProjectInput,
    type ProjectStatus,
    ProjectStatusValues,
    ProjectStatusLabels,
} from "../../types/project";
import { type Priority, PriorityValues, PriorityLabels } from "../../types/common";
import type { GeocodeResult } from "../../types/location";
import { useAllClientsQuery } from "../../hooks/useClients";
import { useActiveDispatchersQuery } from "../../hooks/useDispatchers";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
import DatePicker from "../ui/DatePicker";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import { createStepRouter } from "../../hooks/forms/useZodStepRouting";

type Step = 1 | 2;

interface CreateProjectModalProps {
    isModalOpen: boolean;
    setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    createProject: (input: CreateProjectInput) => Promise<string>;
}

const STEPS = [
    { id: 1 as Step, label: "Basics" },
    { id: 2 as Step, label: "Schedule & Budget" },
];

const routeErrorToStep = createStepRouter<Step>({
    1: ["name", "client_id", "manager_dispatcher_id", "status", "priority", "description"],
    2: ["budget", "starts_at", "target_end_at", "address", "coords"],
});

const PRIORITY_ENTRIES = (
    <>
        {PriorityValues.map((v) => (
            <option key={v} value={v}>
                {PriorityLabels[v]}
            </option>
        ))}
    </>
);

const STATUS_ENTRIES = (
    <>
        {ProjectStatusValues.map((s) => (
            <option key={s} value={s}>
                {ProjectStatusLabels[s]}
            </option>
        ))}
    </>
);

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL =
	"block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";
const TEXTAREA =
	"border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0";

const toUtcMidnightISO = (d: Date | null): string | undefined =>
    d ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString() : undefined;

export default function CreateProjectModal({
    isModalOpen,
    setIsModalOpen,
    createProject,
}: CreateProjectModalProps) {
    const [projectName, setProjectName] = useState("");
    const [clientId, setClientId] = useState("");
    const [projectManager, setProjectManager] = useState("");
    const [status, setStatus] = useState<ProjectStatus>("Planning");
    const [priority, setPriority] = useState<Priority>("Medium");
    const [description, setDescription] = useState("");
    const [budget, setBudget] = useState("");
    const [startDate, setStartDate] = useState<Date | null>(null);
    const [targetEndDate, setTargetEndDate] = useState<Date | null>(null);
    const [geoData, setGeoData] = useState<GeocodeResult>();
    const [isLoading, setIsLoading] = useState(false);
    const [errors, setErrors] = useState<ZodError | null>(null);
    const [submitError, setSubmitError] = useState("");

    const { data: clients } = useAllClientsQuery();
    const { data: dispatchers } = useActiveDispatchersQuery();

    const {
        currentStep,
        visitedSteps,
        goNext,
        goBack,
        goToStep,
        reset: resetWizard,
    } = useStepWizard<Step>({ totalSteps: 2 as Step, initialStep: 1 as Step });

    const clientDropdownEntries = useMemo(() => {
        if (clients?.length) {
            return clients.map((c) => (
                <option value={c.id} key={c.id}>
                    {c.name}
                </option>
            ));
        }
        return (
            <option disabled value="">
                No clients found
            </option>
        );
    }, [clients]);

    const managerDropdownEntries = useMemo(() => {
        const entries = [
            <option value="" key="__unassigned">
                Unassigned
            </option>,
        ];
        if (dispatchers?.length) {
            entries.push(
                ...dispatchers.map((d) => (
                    <option value={d.id} key={d.id}>
                        {d.name}
                    </option>
                )),
            );
        }
        return entries;
    }, [dispatchers]);

    const validateStep1 = useCallback(
        (): boolean => !!(projectName.trim() && clientId.trim() && status && priority),
        [projectName, clientId, status, priority],
    );

    const validateStep = useCallback(
        (step: Step): boolean => (step === 1 ? validateStep1() : true),
        [validateStep1],
    );

    const canGoNext = validateStep(currentStep);

    const canGoToStep = useCallback(
        (targetStep: Step): boolean => {
            if (targetStep === currentStep) return true;
            if (visitedSteps.has(targetStep)) return true;
            if (targetStep === currentStep + 1 && validateStep(currentStep)) return true;
            return false;
        },
        [currentStep, visitedSteps, validateStep],
    );

    const resetForm = useCallback(() => {
        resetWizard();
        setProjectName("");
        setClientId("");
        setProjectManager("");
        setStatus("Planning");
        setPriority("Medium");
        setDescription("");
        setBudget("");
        setStartDate(null);
        setTargetEndDate(null);
        setGeoData(undefined);
        setErrors(null);
        setSubmitError("");
    }, [resetWizard]);

    useEffect(() => {
        if (!isModalOpen) {
            resetForm();
            setIsLoading(false);
        }
    }, [isModalOpen, resetForm]);

    const handleChangeAddress = useCallback(
        (result: GeocodeResult) => setGeoData({ address: result.address, coords: result.coords }),
        [],
    );
    const handleClearAddress = useCallback(() => setGeoData(undefined), []);

    const handleClientChange = useCallback(
        (v: string) => {
            setClientId(v);
            const client = clients?.find((c) => c.id === v);
            if (
                client?.address &&
                Number.isFinite(client.coords?.lat) &&
                Number.isFinite(client.coords?.lon) &&
                (client.coords.lat !== 0 || client.coords.lon !== 0)
            ) {
                setGeoData({
                    address: client.address,
                    coords: { lat: client.coords.lat, lon: client.coords.lon },
                });
            }
        },
        [clients],
    );

    const invokeCreate = async () => {
        if (isLoading) return;
        setSubmitError("");

        const budgetRaw = budget.trim();
        const newProject: CreateProjectInput = {
            name: projectName.trim(),
            client_id: clientId.trim(),
            description: description.trim(), 
            status,
            priority,
            address: geoData?.address || undefined,
            coords: geoData?.coords,
            budget: budgetRaw === "" ? undefined : Number(budgetRaw),
            starts_at: toUtcMidnightISO(startDate),
            target_end_at: toUtcMidnightISO(targetEndDate),
            manager_dispatcher_id: projectManager || null,
        };

        const parseResult = CreateProjectSchema.safeParse(newProject);
        if (!parseResult.success) {
            setErrors(parseResult.error);
            const errorStep = routeErrorToStep(parseResult.error);
            if (errorStep) goToStep(errorStep);
            return; 
        }

        setErrors(null);
        setIsLoading(true);
        try {
            await createProject(newProject); 
            setIsModalOpen(false);
            resetForm();
        } catch (error) {
            console.error("Failed to create project:", error);
            setSubmitError(
                error instanceof Error
                    ? error.message
                    : "Failed to create project. Please try again.",
            );
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

    const stepContent = useMemo(() => {
        switch (currentStep) {
            case 1:
                return (
                    <div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
                        {/* Name */}
                        <div className="min-w-0">
                            <label className={LABEL}>Project Name *</label>
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
                                <label className={LABEL}>Client *</label>
                                <Dropdown
                                    entries={clientDropdownEntries}
                                    value={clientId}
                                    onChange={handleClientChange}
                                    placeholder="Select client"
                                    disabled={isLoading}
                                    error={errors?.issues.some((e) => e.path[0] === "client_id")}
                                />
                                <ErrorDisplay path="client_id" />
                            </div>
                            <div className="min-w-0">
                                <label className={LABEL}>Project Manager</label>
                                <Dropdown
                                    entries={managerDropdownEntries}
                                    value={projectManager}
                                    onChange={setProjectManager}
                                    disabled={isLoading}
                                    error={errors?.issues.some(
                                        (e) => e.path[0] === "manager_dispatcher_id",
                                    )}
                                />
                                <ErrorDisplay path="manager_dispatcher_id" />
                            </div>
                        </div>

                        {/* Status + Priority */}
                        <div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
                            <div className="min-w-0">
                                <label className={LABEL}>Status *</label>
                                <Dropdown
                                    entries={STATUS_ENTRIES}
                                    value={status}
                                    onChange={(v) => setStatus(v as ProjectStatus)}
                                    disabled={isLoading}
                                />
                                <ErrorDisplay path="status" />
                            </div>
                            <div className="min-w-0">
                                <label className={LABEL}>Priority *</label>
                                <Dropdown
                                    entries={PRIORITY_ENTRIES}
                                    value={priority}
                                    onChange={(v) => setPriority(v as Priority)}
                                    disabled={isLoading}
                                />
                                <ErrorDisplay path="priority" />
                            </div>
                        </div>

                        {/* Description */}
                        <div className="min-w-0">
                            <label className={LABEL}>Description</label>
                            <textarea
                                placeholder="Scope, phasing, notes..."
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                className={TEXTAREA}
                                disabled={isLoading}
                            />
                            <ErrorDisplay path="description" />
                        </div>
                    </div>
                );
            case 2:
                return (
                    <div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
                        {/* Address */}
                        <div className="relative min-w-0" style={{ zIndex: 60 }}>
                            <label className={LABEL}>Address</label>
                            <AddressForm
                                mode={geoData ? "edit" : "create"}
                                originalValue={geoData?.address || ""}
                                originalCoords={geoData?.coords}
                                dropdownPosition="below"
                                handleChange={handleChangeAddress}
                                handleClear={handleClearAddress}
                            />
                            <ErrorDisplay path="address" />
                            <ErrorDisplay path="coords" />
                        </div>

                        {/* Budget + Start date */}
                        <div
                            className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0 relative"
                            style={{ zIndex: 50 }}
                        >
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
                                <DatePicker
                                    mode="create"
                                    value={startDate}
                                    onChange={setStartDate}
                                    align="left"
                                    position="below"
                                    portal
                                    disabled={isLoading}
                                />
                                <ErrorDisplay path="starts_at" />
                            </div>
                        </div>

                        {/* Target end date */}
                        <div
                            className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0 relative"
                            style={{ zIndex: 40 }}
                        >
                            <div className="min-w-0">
                                <label className={LABEL}>Target End Date</label>
                                <DatePicker
                                    mode="create"
                                    value={targetEndDate}
                                    onChange={setTargetEndDate}
                                    align="left"
                                    position="below"
                                    portal
                                    disabled={isLoading}
                                />
                                <ErrorDisplay path="target_end_at" />
                            </div>
                        </div>
                    </div>
                );
            default:
                return null;
        }
    }, [
        currentStep,
        projectName,
        clientId,
        projectManager,
        status,
        priority,
        description,
        budget,
        startDate,
        targetEndDate,
        geoData,
        isLoading,
        errors,
        clientDropdownEntries,
        managerDropdownEntries,
        handleClientChange,
        handleChangeAddress,
        handleClearAddress,
    ]);

    return (
        <FormWizardContainer<Step>
            title="Create Project"
			steps={STEPS}
			currentStep={currentStep}
			visitedSteps={visitedSteps}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			canGoToStep={canGoToStep}
			onStepClick={goToStep}
			onNext={goNext}
			onBack={goBack}
			onSubmit={invokeCreate}
			canGoNext={canGoNext}
			submitLabel="Create Project"
		>
			<>
				{submitError && (
					<div className="mb-2 rounded border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
						{submitError}
					</div>
				)}
				{stepContent}
			</>
        </FormWizardContainer>
    );
}
