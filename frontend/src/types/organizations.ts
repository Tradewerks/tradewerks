

// ========================================================
// Interfaces
// ========================================================
export interface Organization {
    id: string;
    name: string;
    timezone: string | null;
    created_at: string;
    updated_at: string;
}
export interface RegisterOrganizationInput {
    org_name: string;
    admin_name: string;
    admin_email: string;
    admin_password: string;
    business_type: string;
    admin_phone?: string;
    org_phone?: string;
    org_address?: string;
    org_website?: string;
    org_timezone?: string;
    org_tax_rate?: number;
}

export interface RegisterOrganizationResponse {
    org: { id: string; name: string };
    admin: { id: string; name: string; email: string };
}

export interface OrganizationRole {
    id: string;
    name: string;
    base_tier: "dispatcher" | "technician";
    permissions: string[];
    is_default: boolean;
    _count?: { dispatchers: number; technicians: number };
}