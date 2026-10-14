import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";

// ============================================================================
// AUTHENTICATE API
// ============================================================================

interface User{
    email: string,
    password: string,
    // removed role
}

interface AuthResponse {
    pendingToken: string;
    token: string,
    expiresIn: number,
    refreshToken?: string,
    user?: {
        email: string,
        role: string
    },
    forcePasswordReset?: boolean,
    resetToken?: string,
    challenge?: "otp" | "totp" | "enroll"
}

export const loginCall = async (input: User): Promise<AuthResponse> => {
    // Ensure coords is always provided (backend requirement)
    const userData = { 
        ...input,
    }
    
    const response = await api.post<ApiResponse<AuthResponse>>('/login', userData);

    if (response.data.error) {
        throw new Error(response.data.error?.message || "Login failed");
    }
    const data = response.data.data!;

    // First login skips OTP and returns a full token directly
    // Normal login returns a pendingToken for the OTP step
    const tokenToStore = data.token ?? data.pendingToken;
    localStorage.setItem("accessToken", tokenToStore);
    api.defaults.headers.common["Authorization"] = `Bearer ${tokenToStore}`;
    return response.data.data!;
};

export const verifyOTPCall = async (otp: string): Promise<AuthResponse> => {
    const response = await api.post<ApiResponse<AuthResponse>>('/otp-verify', { otp });

    if (response.data.error) {
        throw new Error(response.data.error?.message || "OTP verification failed");
    }
    localStorage.setItem("accessToken", response.data.data!.token);
    api.defaults.headers.common["Authorization"] = `Bearer ${response.data.data!.token}`;

    return response.data.data!;
}

export const verifyMfaCall = async (args: { code?: string; backupCode?: string }): Promise<AuthResponse> => {
    const response = await api.post<ApiResponse<AuthResponse>>('/mfa/verify', args);

    if (response.data.error) {
        throw new Error(response.data.error?.message || "MFA verification failed");
    }
    localStorage.setItem("accessToken", response.data.data!.token);
    api.defaults.headers.common["Authorization"] = `Bearer ${response.data.data!.token}`;

    return response.data.data!;
}

export const logoutCall = async (): Promise<AuthResponse> => {
    const response = await api.post<ApiResponse<AuthResponse>>('/logout');

    if (response.data.error) {
        throw new Error(response.data.error?.message || "Logout Failed");
    }
    localStorage.removeItem("accessToken");
    delete api.defaults.headers.common.Authorization;
    return response.data.data!;
}

export const logoutBeacon = () => {
    const token = localStorage.getItem("accessToken");
    try {
        fetch(`${import.meta.env.VITE_BACKEND_URL}/logout`, {
            method: "POST",
            headers: token ? { "Authorization": `Bearer ${token}` } : {},
            credentials: "include",
            keepalive: true,
        });
    } catch (error) {
        console.error("Logout beacon failed:", error);
    }
}

export const requestPasswordResetCall = async (id: string, role: string): Promise<{ message: string }> => {
    const endpoint = role === "technician" ? `/technicians/${id}/reset-password` : `/dispatchers/${id}/reset-password`;
    const response = await api.post<ApiResponse<{ message: string }>>(endpoint);

    if (response.data.error) {
        throw new Error(response.data.error?.message || "Password reset request failed");
    }
    return response.data.data!;
}

export type ResetTokenStatus = "valid" | "expired" | "invalid";

export const checkResetTokenCall = async (token: string, role: string | null): Promise<ResetTokenStatus> => {
    const response = await api.post<ApiResponse<{ status: ResetTokenStatus }>>('/reset-password/check', { token, role });
    return response.data.data?.status ?? "invalid";
}

export const resetPasswordCall = async (token: string, newPassword: string, role: string): Promise<AuthResponse> => {
    const response = await api.post<ApiResponse<AuthResponse>>('/reset-password', { token, newPassword, role });

    if (response.data.error) {
        throw new Error(response.data.error?.message || "Password reset failed");
    }
    const tokenToStore = response.data.data!.token;
    localStorage.setItem("accessToken", tokenToStore);
    api.defaults.headers.common["Authorization"] = `Bearer ${tokenToStore}`;
    return response.data.data!;
}

export const refreshTokenCall = async (): Promise<string> => {
    const response = await api.post<ApiResponse<{ token: string; expiresIn: number }>>('/refresh', {}, { withCredentials: true });

    if (response.data.error) {
        throw new Error(response.data.error?.message || "Token refresh failed");
    }
    return response.data.data!.token;
}