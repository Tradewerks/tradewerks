import {
    setupMfa,
    disableMfa,
    enableMfa,
    getMfaStatus,
    resetMfa
} from "../api/mfa"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// ============================================================================
// Queries
// ============================================================================

export const useMfaStatusQuery = () =>{
    return useQuery({
        queryKey: ["mfaStatus"],
        queryFn: getMfaStatus
    })
}

// ============================================================================
// Mutations
// ============================================================================

export const useEnableMfaMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
        meta: { silentError: true },
        mutationFn: enableMfa,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["mfaStatus"]})
        }
    })
};

export const useDisableMfaMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
        meta: { silentError: true },
        mutationFn: disableMfa,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["mfaStatus"]})
        }
    })
};

export const useResetMfaMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ userId, role }: { userId: string; role: string }) => resetMfa(userId, role),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["mfaStatus"] });
            queryClient.invalidateQueries({ queryKey: ["dispatchers"] });
            queryClient.invalidateQueries({ queryKey: ["technicians"] });
        }
    })
};

export const useSetupMfaMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: setupMfa,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["mfaStatus"]})
        }
    })
}