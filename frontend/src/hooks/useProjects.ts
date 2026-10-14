import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import { getClientProjects } from "../api/clients";
import type { CreateProjectInput, UpdateProjectInput, ProjectNote, CreateProjectNoteInput, UpdateProjectNoteInput } from "../types/project";
import {
    getProjects,
    getProjectById,
    createProject,
    updateProject,
    attachJobToProject,
    detachJobFromProject,
    deleteProject,
    getProjectNotes,
    createProjectNote,
    updateProjectNote,
    deleteProjectNote,
    uploadProjectNotePhoto,
} from "../api/project";

const useQuery = moduleQuery("projects");

// Queries

export function useClientProjectsQuery(clientId: string) {
	return useQuery({
		queryKey: ["clientProjects", clientId],
		queryFn: () => getClientProjects(clientId)
	});
}

export function useProjectsQuery() {
    return useQuery({
        queryKey: ["projects"],
        queryFn: getProjects,
    });
}

export function useProjectByIdQuery(projectId: string) {
    return useQuery({
        queryKey: ["project", projectId],
        queryFn: () => getProjectById(projectId),
        enabled: !!projectId,
    });
}

// Mutations

export function useCreateProjectMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (data: CreateProjectInput) => createProject(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["projects"] });
        }
    });
}

export function useUpdateProjectMutation(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (data: UpdateProjectInput) => updateProject(projectId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["projects"] });
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        }
    });
}

export function useAttachJobToProjectMutation(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (jobId: string) => attachJobToProject(projectId, jobId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["projects"] });
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            queryClient.invalidateQueries({ queryKey: ["jobs"] });
        }
    });
}

export function useDetachJobFromProjectMutation(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (jobId: string) => detachJobFromProject(projectId, jobId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["projects"] });
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            queryClient.invalidateQueries({ queryKey: ["jobs"] });
        }
    });
}

export function useDeleteProjectMutation(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => deleteProject(projectId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["projects"] });
            queryClient.invalidateQueries({ queryKey: ["jobs"] });
        }
    });
}

// ============================================
// PROJECT NOTE QUERIES
// ============================================

export const useProjectNotesQuery = (projectId: string): UseQueryResult<ProjectNote[], Error> => {
    return useQuery({
        queryKey: ["project", projectId, "notes"],
        queryFn: () => getProjectNotes(projectId),
        enabled: !!projectId,
    });
};

// ============================================
// PROJECT NOTE MUTATIONS
// ============================================

export const useCreateProjectNoteMutation = (): UseMutationResult<
    ProjectNote, Error, { projectId: string; data: CreateProjectNoteInput }
> => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ projectId, data }) => createProjectNote(projectId, data),
        onSuccess: async (_, variables) => {
            await queryClient.invalidateQueries({ queryKey: ["project", variables.projectId] });
            await queryClient.invalidateQueries({ queryKey: ["project", variables.projectId, "notes"] });
            await queryClient.invalidateQueries({ queryKey: ["changes"] });
        },
    });
};

export const useUpdateProjectNoteMutation = (): UseMutationResult<
    ProjectNote, Error, { projectId: string; noteId: string; data: UpdateProjectNoteInput }
> => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ projectId, noteId, data }) => updateProjectNote(projectId, noteId, data),
        onSuccess: async (_, variables) => {
            await queryClient.invalidateQueries({ queryKey: ["project", variables.projectId] });
            await queryClient.invalidateQueries({ queryKey: ["project", variables.projectId, "notes"] });
            await queryClient.invalidateQueries({ queryKey: ["changes"] });
        },
    });
};

export const useDeleteProjectNoteMutation = (): UseMutationResult<
    { message: string }, Error, { projectId: string; noteId: string }
> => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ projectId, noteId }) => deleteProjectNote(projectId, noteId),
        onSuccess: async (_, variables) => {
            await queryClient.invalidateQueries({ queryKey: ["project", variables.projectId] });
            await queryClient.invalidateQueries({ queryKey: ["project", variables.projectId, "notes"] });
            await queryClient.invalidateQueries({ queryKey: ["changes"] });
        },
    });
};

export const useUploadProjectNotePhotoMutation = (): UseMutationResult<
    { url: string; raw_url: string }, Error, { projectId: string; file: File }
> =>
    useMutation({ mutationFn: ({ projectId, file }) => uploadProjectNotePhoto(projectId, file) });