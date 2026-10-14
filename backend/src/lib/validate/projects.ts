import z from "zod";
import { isOwnBucketUrl } from "../../services/wasabiService.js";

// Note photos must live in our own storage bucket: the URL is signed blindly on
// read, so an arbitrary URL would let a caller mint signed links for any key.
const notePhotoUrl = z
    .string()
    .url()
    .refine(isOwnBucketUrl, { message: "photo_url must point to the configured storage bucket" });

export const projectStatusEnum = z.enum([
  "Planning", "Active", "OnHold", "Completed", "Cancelled",
]);

// Matches Decimal(12, 2) on project.budget
export const PROJECT_BUDGET_MAX = 9_999_999_999.99;

const endNotBeforeStart = (d: { starts_at?: string | null; target_end_at?: string | null }) =>
    !d.starts_at ||
    !d.target_end_at ||
    new Date(d.target_end_at).getTime() >= new Date(d.starts_at).getTime();

const END_BEFORE_START = {
    message: "Target end date cannot be before the start date",
    path: ["target_end_at"],
};

// "" on a nullable column clears it; undefined (key absent) leaves it untouched.
const emptyToNull = (v: string | null | undefined) => (v === "" ? null : v);

export const createProjectSchema = z.object({
        name:  z.string().min(1),
        description: z.string().default(""),
        client_id: z.string().uuid(),
        status: projectStatusEnum.optional(),      // defaults Planning in DB
        priority: z
            .enum(["Low", "Medium", "High", "Urgent", "Emergency"])
            .optional()
            .default("Medium"),
        address: z.string().optional(),
        coords: z.any().optional(),
        budget: z.number().nonnegative().max(PROJECT_BUDGET_MAX).optional(),
        starts_at: z.string().datetime().optional(),
        target_end_at: z.string().datetime().optional(),
        manager_dispatcher_id: z.string().uuid().optional().nullable(),
    })
    .refine(endNotBeforeStart, END_BEFORE_START)
    .transform((data)=>({
        ...data,
        name: data.name,
        description: data.description,
        client_id: data.client_id ?? undefined,
        status: data.status ?? undefined,
        priority: data.priority ?? undefined,
        address: data.address || undefined,
        coords: data.coords ?? undefined,
        budget: data.budget ?? undefined,
        starts_at: data.starts_at ?? undefined,
        target_end_at: data.target_end_at ?? undefined,
        manager_dispatcher_id: data.manager_dispatcher_id ?? undefined,
    }));


export const updateProjectSchema = z
    .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        client_id: z.string().uuid().optional(),
        status: projectStatusEnum.optional(),
        priority: z
            .enum(["Low", "Medium", "High", "Urgent", "Emergency"])
            .optional(),
        address: z.string().optional().nullable(),
        coords: z.any().optional(),
        budget: z.number().nonnegative().max(PROJECT_BUDGET_MAX).optional().nullable(),
        starts_at: z.string().datetime().optional().nullable(),
        target_end_at: z.string().datetime().optional().nullable(),
        cancellation_reason: z.string().optional().nullable(),
        manager_dispatcher_id: z.string().uuid().optional().nullable(),
    })
    .refine(endNotBeforeStart, END_BEFORE_START)
    .transform((data) => ({
        ...data,
        // description is NOT NULL in the schema, so "" is a legitimate cleared value
        address: emptyToNull(data.address),
        cancellation_reason: emptyToNull(data.cancellation_reason),
    }));

// jobId comes from the URL; a body jobId is tolerated only when it agrees with the URL.
export const attachJobSchema = z
    .object({
        jobId: z.string().uuid("Invalid job ID"),
        bodyJobId: z.unknown().optional(),
    })
    .refine((d) => d.bodyJobId === undefined || d.bodyJobId === d.jobId, {
        message: "jobId in the request body does not match the URL",
        path: ["jobId"],
    });

export const createProjectNoteSchema = z
    .object({
        content: z.string(),
        notify_technician: z.boolean().default(false),
        photos: z
            .array(
                z.object({
                    photo_url: notePhotoUrl,
                    photo_label: z.enum(["Before", "After", "Other"]),
                }),
            )
            .optional()
            .default([]),
    })
    .refine(
        (data) => data.content.trim().length > 0 || (data.photos ?? []).length > 0,
        { message: "Content or at least one photo is required", path: ["content"] },
    )
    .transform((data) => ({
        content: data.content,
        notify_technician: data.notify_technician ?? false,
        photos: data.photos ?? [],
    }));

export const updateProjectNoteSchema = z.object({
    content: z.string().min(1, "Content is required").optional(),
    photos: z
        .array(
            z.object({
                id: z.string().uuid().optional(),
                photo_url: notePhotoUrl,
                photo_label: z.enum(["Before", "After", "Other"]),
            }),
        )
        .optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type AttachJobInput = z.infer<typeof attachJobSchema>;
export type CreateProjectNoteInput = z.infer<typeof createProjectNoteSchema>;
export type UpdateProjectNoteInput = z.infer<typeof updateProjectNoteSchema>;
