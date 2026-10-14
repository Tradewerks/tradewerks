import PageHeader from "../../components/ui/PageHeader";
import { useParams, useNavigate } from "react-router-dom";
import { useProjectByIdQuery, useDetachJobFromProjectMutation, useUpdateProjectMutation, useAttachJobToProjectMutation, useDeleteProjectMutation } from "../../hooks/useProjects";
import { usePermission } from "../../hooks/usePermission";
import { useState, useRef, useEffect } from "react";
import { Edit2, MoreVertical, Trash2 } from "lucide-react";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { ProjectStatusColors, ProjectStatusLabels } from "../../types/project";
import { PriorityLabels, PriorityColors } from "../../types/common";
import { formatDate, formatDateOnly } from "../../util/util";
import AttachedJobsCard from "../../components/projects/AttachedJobsCard";
import BudgetCard from "../../components/projects/BudgetCard";
import Card from "../../components/ui/Card"
import EditProjectModal from "../../components/projects/EditProjectModal"
import AttachJobModal from "../../components/projects/AttachJobModal";
import ChangeHistory from "../../components/activity/ChangeHistory";
import ProjectNoteManager from "../../components/projects/ProjectNoteManager";
import { useToast } from "../../components/ui/useToast";

export default function ProjectDetailPage() {
    const { projectId } = useParams<{ projectId: string }>();
    const navigate = useNavigate();
    const { data: project, isLoading, error } = useProjectByIdQuery(projectId!);
    const detachJobMutation = useDetachJobFromProjectMutation(projectId!);
    const editProjectMutation = useUpdateProjectMutation(projectId!);
    const attachJobMutation = useAttachJobToProjectMutation(projectId!);
    const deleteProjectMutation = useDeleteProjectMutation(projectId!);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [isAttachJobModalOpen, setIsAttachJobModalOpen] = useState(false);
    const [pendingDetachJobId, setPendingDetachJobId] = useState<string | null>(null);
    const [detachError, setDetachError] = useState<string | null>(null);
    const optionsMenuRef = useRef<HTMLDivElement>(null);
    const toast = useToast();

    // permissions
    const EDIT_PROJECTS = usePermission("edit_projects");
    const DELETE_PROJECTS = usePermission("delete_projects");

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                optionsMenuRef.current &&
                !optionsMenuRef.current.contains(event.target as Node)
            ) {
                setIsOptionsMenuOpen(false);
                setDeleteConfirm(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    if (isLoading) {
        return <div>Loading...</div>;
    }
    if (error || !project) {
        return <div className="p-6 text-error-text">Project not found.</div>;
    }

    const pendingDetachJob = project.jobs?.find((j) => j.id === pendingDetachJobId) ?? null;

    const requestDetachJob = (id: string) => {
        setDetachError(null);
        setPendingDetachJobId(id);
    };

    const confirmDetachJob = async () => {
        if (!pendingDetachJobId) return;
        try {
            await detachJobMutation.mutateAsync(pendingDetachJobId);
            setPendingDetachJobId(null);
        } catch (err) {
            setDetachError(err instanceof Error ? err.message : "Failed to detach job.");
        }
    };

    const handleDeleteProject = async () => {
        if (!deleteConfirm) {
            setDeleteConfirm(true);
            return;
        }
        try {
            await deleteProjectMutation.mutateAsync();
            setIsOptionsMenuOpen(false);
            navigate("/dispatch/projects");
        } catch (error) {
            setDeleteConfirm(false);
            toast.error(error instanceof Error ? error.message : "Failed to delete project");
        }
    };

    return (
        <div>
            <PageHeader 
                title={project?.name ?? "Project Details"}
                subtitle={
                    <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-sm text-text-tertiary">
                    <span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${PriorityColors[project?.priority]}`}>
                        {PriorityLabels[project?.priority]}
                    </span>
                    <span className="font-mono text-xs bg-surface-inset border border-border-subtle rounded px-1.5 py-0.5">
                        {project?.project_number}
                    </span>
                    <span className="w-1 h-1 rounded-full bg-border-strong" />
                    <span>{project?.client?.name ?? "—"}</span>
                    <span className="w-1 h-1 rounded-full bg-border-strong" />
                    <span>
                        {project?.starts_at ? formatDateOnly(project.starts_at) : "—"} →{" "}
                        {project?.target_end_at ? formatDateOnly(project.target_end_at) : "—"}
                    </span>
                    <span className="w-1 h-1 rounded-full bg-border-strong" />
                    <span>{project?.jobs?.length ?? 0} jobs</span>
                </div>
                }
            > 
            <div className="justify-self-end flex items-center gap-3">
                <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border ${ProjectStatusColors[project?.status]}`}>
                    {ProjectStatusLabels[project?.status]}
                </span>
                <div className="relative" ref={optionsMenuRef}>
                    
                    <button
                        onClick={() => {
                            setIsOptionsMenuOpen((v) => !v);
                            setDeleteConfirm(false);
                        }}
                        className="p-2 hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong"
                    >
                        <MoreVertical size={20} />
                    </button>
                    {isOptionsMenuOpen && (
                        <div className="absolute right-0 mt-2 w-56 bg-base border border-border-subtle rounded-lg shadow-xl z-50">
                            <div className="py-1">
                                {EDIT_PROJECTS && (
                                    <button
                                        title={!EDIT_PROJECTS ? "You don't have permission to perform this action" : ""}
                                    onClick={() => {
                                        if (!EDIT_PROJECTS) return;
                                        setIsEditModalOpen(true);
                                        setIsOptionsMenuOpen(false);
                                        setDeleteConfirm(false);
                                    }}
                                    disabled={!EDIT_PROJECTS}
                                    className="w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    <Edit2 size={16} />
                                    Edit Project
                                </button>
                            )}
                            {DELETE_PROJECTS && EDIT_PROJECTS && (
                                <div className="my-1 border-t border-border-subtle" />
                            )}
                            {DELETE_PROJECTS && (
                                <button
                                    onClick={handleDeleteProject}
                                    onMouseLeave={() => setDeleteConfirm(false)}
                                    disabled={deleteProjectMutation.isPending}
                                    className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
                                        deleteConfirm
                                            ? "bg-error hover:bg-error-strong text-on-primary"
                                            : "text-error-text hover:bg-surface hover:text-error-text"
                                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                                >
                                    <Trash2 size={16} />
                                    {deleteProjectMutation.isPending
                                        ? "Deleting..."
                                        : deleteConfirm
                                            ? "Click Again to Confirm"
                                            : "Delete Project"}
                                </button>
                            )}
                            </div>
                        </div>
                    )} 
                </div>
            </div>
            </PageHeader>
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4 mt-6 items-start">
                <div className="flex flex-col gap-4 min-w-0">
            
                    <AttachedJobsCard
                        jobs={project.jobs}
                        className="mt-6"
                        onAttach={() => setIsAttachJobModalOpen(true)}
                        onDetach={requestDetachJob}
                    />

                    <Card title="Description">
                        <p>{project.description || "No description given"}</p>
                    </Card>
                    <ProjectNoteManager projectId={projectId ?? ""} />
                    <ChangeHistory scope={{kind: "entity", type: "project", id: projectId ?? ""}} />
                </div>
                <div className="flex flex-col gap-4 min-w-0">
                    <BudgetCard
                        budget={project.budget === null || project.budget === undefined ? null : Number(project.budget)}
                        estimated={project.jobs.reduce((a, j) => a + Number(j.estimated_total ?? 0), 0)}
                        actual={project.jobs.reduce((a, j) => a + Number(j.actual_total ?? 0), 0)}
                        className="mt-6"
                    />
                    <Card title="Project Details">
                         <dl className="flex flex-col divide-y divide-border-subtle text-sm">
                            {[
                                ["Project #", project.project_number],
                                ["Client", project.client?.name ?? "—"],
                                ["Project Manager", project.manager_dispatcher?.name ?? "—"],
                                ["Address", project.address || "—"],
                                ["Start date", project.starts_at ? formatDateOnly(project.starts_at) : "—"],
                                ["Target end", project.target_end_at ? formatDateOnly(project.target_end_at) : "—"],
                                ["Created", project.created_at ? formatDate(project.created_at) : "—"],
                            ].map(([k, v]) => (
                                <div key={k} className="flex justify-between gap-3 py-2.5">
                                    <dt className="text-text-muted">{k}</dt>
                                    <dd className="text-text-primary font-medium text-right">{v}</dd>
                                </div>
                            ))}
                        </dl>
                    </Card>
                </div>
            </div>

            <EditProjectModal
                isModalOpen={isEditModalOpen}
                setIsModalOpen={setIsEditModalOpen}
                project={project}
                updateProject={async (input) => {
                    try {
                        await editProjectMutation.mutateAsync(input);
                        return "";
                    }catch (error) {
                        return error instanceof Error ? error.message : "Failed to update project";
                    }
                }}
            />
            <AttachJobModal
                isModalOpen={isAttachJobModalOpen}
                setIsModalOpen={setIsAttachJobModalOpen}
                project={project}
                attachJob={async (jobIds) => {
                    const settled = await Promise.allSettled(
                        jobIds.map((jobId) => attachJobMutation.mutateAsync(jobId))
                    );
                    return settled.flatMap((result, i) =>
                        result.status === "rejected"
                            ? [{
                                    id: jobIds[i],
                                    message:
                                        result.reason instanceof Error
                                            ? result.reason.message
                                            : "Failed to attach job",
                                }]
                            : []
                    );
                }}
            />
            <ConfirmDialog
                open={pendingDetachJobId !== null}
                title="Detach job"
                body={
                    pendingDetachJob
                        ? `Remove '${pendingDetachJob.job_number} — ${pendingDetachJob.name}' from ${project.project_number}? The job itself is not deleted and can be attached again later.`
                        : "Remove this job from the project?"
                }
                confirmLabel="Detach"
                tone="destructive"
                pending={detachJobMutation.isPending}
                error={detachError}
                onConfirm={confirmDetachJob}
                onCancel={() => {
                    setPendingDetachJobId(null);
                    setDetachError(null);
                }}
            />
        </div>
    );
}