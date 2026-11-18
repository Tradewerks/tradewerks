import z from "zod";
import {
	createProjectSchema,
	updateProjectSchema,
	createProjectNoteSchema,
	updateProjectNoteSchema,
} from "../lib/validate/projects.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	json,
	moduleOff,
} from "./shared.js";
import { clientParams, noteAuthor } from "./clients.js";
import { coords, deletedId, priority } from "./requestsQuotes.js";

// ===============================================================================================================================
// Projects
// ===============================================================================================================================

const noProjectsForTechs = `${moduleOff("projects")}; technicians can't use projects`;

const projectFields = {
	id: z.uuid(),
	project_number: z.string(),
	name: z.string(),
	description: z.string(),
	status: z.enum(["Planning", "Active", "OnHold", "Completed", "Cancelled"]),
	priority,
	address: z.string().nullable(),
	coords: coords.nullable(),
	client_id: z.uuid(),
	manager_dispatcher_id: z.uuid().nullable(),
	budget: decimal.nullable(),
	starts_at: z.iso.datetime().nullable(),
	target_end_at: z.iso.datetime().nullable(),
	completed_at: z.iso.datetime().nullable(),
	cancelled_at: z.iso.datetime().nullable(),
	cancellation_reason: z.string().nullable(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
};

const project = z.object(projectFields).meta({ id: "Project" });

const projectListItem = z
	.object({
		...projectFields,
		client: z.object({ id: z.uuid(), name: z.string() }),
		manager_dispatcher: z
			.object({ id: z.uuid(), name: z.string() })
			.nullable(),
		jobs: z.array(
			z.object({
				id: z.uuid(),
				job_number: z.string(),
				name: z.string(),
				status: z.string(),
			}),
		),
	})
	.meta({ id: "ProjectListItem" });

const projectNote = z
	.object({
		id: z.uuid(),
		project_id: z.uuid(),
		content: z.string(),
		notify_technician: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		creator_tech: noteAuthor,
		creator_dispatcher: noteAuthor,
		photos: z.array(
			z.object({
				id: z.uuid(),
				photo_url: z.string().describe("Signed, short-lived image URL"),
				photo_label: z.enum(["Before", "After", "Other"]),
				photo_name: z.string().nullable(),
				created_at: z.iso.datetime(),
			}),
		),
	})
	.meta({ id: "ProjectNote" });

authed(
	"get",
	"/projects",
	"Projects",
	"view_projects",
	{
		summary: "List projects",
		description:
			"Requires the `view_projects` permission. Returns every project in the caller's organization, newest first, with its client, manager and jobs.",
		responses: {
			200: json(
				envelope(z.array(projectListItem)),
				"Projects (empty array if none)",
			),
		},
	},
	noProjectsForTechs,
);

authed(
	"post",
	"/projects",
	"Projects",
	"create_projects",
	{
		summary: "Create a project",
		description:
			"Requires the `create_projects` permission. `project_number` is assigned by the server; `coords` is looked up from `address` when omitted.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createProjectSchema.meta({
							id: "CreateProject",
						}),
						example: {
							name: "Office HVAC retrofit",
							client_id: "3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(project), "Project created"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Client or manager dispatcher not found (`NOT_FOUND`)",
			),
			500: json(
				errorEnvelope,
				"Project couldn't be created (`SERVER_ERROR`)",
			),
		},
	},
	noProjectsForTechs,
);

authed(
	"put",
	"/projects/{id}",
	"Projects",
	"edit_projects",
	{
		summary: "Update a project",
		description:
			'Requires the `edit_projects` permission. Send only the fields to change; `""` clears `address` and `cancellation_reason`. Moving to `Completed` or `Cancelled` stamps `completed_at` / `cancelled_at`.',
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateProjectSchema.meta({
							id: "UpdateProject",
						}),
						example: { status: "Active" },
					},
				},
			},
		},
		responses: {
			200: json(envelope(project), "Project updated"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Project, client or manager dispatcher not found (`NOT_FOUND`)",
			),
			500: json(
				errorEnvelope,
				"Project couldn't be updated (`SERVER_ERROR`)",
			),
		},
	},
	noProjectsForTechs,
);

authed(
	"post",
	"/projects/{id}/jobs/{jobId}",
	"Projects",
	"edit_projects",
	{
		summary: "Attach a job to a project",
		description:
			"Requires the `edit_projects` permission. No body needed. Attaching a job already on this project succeeds without changes. Returns the project.",
		request: { params: z.object({ id: z.uuid(), jobId: z.uuid() }) },
		responses: {
			200: json(envelope(project), "Job attached"),
			400: json(
				errorEnvelope,
				"`jobId` is not a UUID (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Project or job not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"Job is already on another project (`CONFLICT`)",
			),
			500: json(
				errorEnvelope,
				"Job couldn't be attached (`SERVER_ERROR`)",
			),
		},
	},
	noProjectsForTechs,
);

authed(
	"post",
	"/projects/{id}/notes",
	"Projects",
	"edit_projects",
	{
		summary: "Add a note to a project",
		description:
			"Requires the `edit_projects` permission. Needs `content` or at least one photo. Photo URLs must point to the app's own storage bucket. The author is the caller, taken from the token.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: createProjectNoteSchema.meta({
							id: "CreateProjectNote",
						}),
						example: { content: "Ductwork delivered to site." },
					},
				},
			},
		},
		responses: {
			201: json(envelope(projectNote), "Note created"),
			400: json(
				errorEnvelope,
				"Validation failed, or the note couldn't be created (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Project not found (`NOT_FOUND`)"),
		},
	},
	noProjectsForTechs,
);

authed(
	"get",
	"/projects/{id}",
	"Projects",
	"view_projects",
	{
		summary: "Get a project",
		description:
			"Requires the `view_projects` permission. Also includes `client` and `manager_dispatcher` (`id`, `name`) and `jobs` (number, name, status, priority, totals and client).",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(project), "Project"),
			404: json(
				errorEnvelope,
				'Project not in the caller\'s organization (`NOT_FOUND`, message "No projects found")',
			),
		},
	},
	noProjectsForTechs,
);

authed(
	"delete",
	"/projects/{id}",
	"Projects",
	"delete_projects",
	{
		summary: "Delete a project",
		description:
			"Requires the `delete_projects` permission. Its notes and their photos are deleted with it; its jobs stay and are detached from it.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: deletedId,
			404: json(errorEnvelope, "Project not found (`NOT_FOUND`)"),
		},
	},
	noProjectsForTechs,
);

authed(
	"get",
	"/clients/{clientId}/projects",
	"Clients",
	"view_projects",
	{
		summary: "List a client's projects",
		description:
			"Requires the `view_projects` permission. Newest first. An unknown client returns an empty array.",
		request: { params: clientParams },
		responses: {
			200: json(
				envelope(z.array(projectListItem)),
				"Projects (empty array if none)",
			),
		},
	},
	noProjectsForTechs,
);

const projectNoteParams = z.object({ projectId: z.uuid(), noteId: z.uuid() });

authed(
	"delete",
	"/projects/{id}/jobs/{jobId}",
	"Projects",
	"edit_projects",
	{
		summary: "Detach a job from a project",
		description:
			"Requires the `edit_projects` permission. Returns the job.",
		request: { params: z.object({ id: z.uuid(), jobId: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.record(z.string(), z.unknown()).describe("The job")),
				"Detached",
			),
			404: json(errorEnvelope, "Project or job not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"The job isn't on this project (`CONFLICT`)",
			),
		},
	},
	noProjectsForTechs,
);

authed(
	"get",
	"/projects/{id}/changes",
	"Projects",
	"view_projects",
	{
		summary: "Get a project's history",
		description: "Requires the `view_projects` permission.",
		request: { params: z.object({ id: z.uuid() }), query: historyQuery },
		responses: historyResponses,
	},
	noProjectsForTechs,
);

authed(
	"get",
	"/projects/{projectId}/notes",
	"Projects",
	"view_projects",
	{
		summary: "List a project's notes",
		description:
			"Requires the `view_projects` permission. Newest first. An unknown project returns an empty array.",
		request: { params: z.object({ projectId: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.array(projectNote)),
				"Notes (empty array if none)",
			),
		},
	},
	noProjectsForTechs,
);

authed(
	"put",
	"/projects/{projectId}/notes/{noteId}",
	"Projects",
	"edit_projects",
	{
		summary: "Update a project note",
		description:
			"Requires the `edit_projects` permission. Any user with the permission can edit any note; the caller is recorded as the last editor. When `photos` is sent it replaces the list.",
		request: {
			params: projectNoteParams,
			body: {
				content: {
					"application/json": {
						schema: updateProjectNoteSchema.meta({
							id: "UpdateProjectNote",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(projectNote), "Updated"),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Note not found (`NOT_FOUND`)"),
		},
	},
	noProjectsForTechs,
);

authed(
	"delete",
	"/projects/{projectId}/notes/{noteId}",
	"Projects",
	"edit_projects",
	{
		summary: "Delete a project note",
		description:
			"Requires the `edit_projects` permission. Any user with the permission can delete any note. Its photos are deleted from storage too.",
		request: { params: projectNoteParams },
		responses: {
			200: json(envelope(z.object({ message: z.string() })), "Deleted"),
			404: json(errorEnvelope, "Note not found (`NOT_FOUND`)"),
		},
	},
	noProjectsForTechs,
);

authed(
	"post",
	"/projects/{projectId}/notes/upload-photo",
	"Projects",
	"edit_projects",
	{
		summary: "Upload a project note photo",
		description:
			"Requires the `edit_projects` permission. Stores one image and returns its URLs; attach it by creating or updating a note with `raw_url` as a `photo_url`. JPEG, PNG or WebP, up to 5 MB. The project isn't checked.",
		request: {
			params: z.object({ projectId: z.uuid() }),
			body: {
				content: {
					"multipart/form-data": {
						schema: z.object({
							photo: z.string().meta({ format: "binary" }),
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(z.object({ url: z.string(), raw_url: z.string() })),
				"Uploaded",
			),
			400: json(
				errorEnvelope,
				"No `photo`, or the file is over 5 MB (the message says 15MB) (`VALIDATION_ERROR`)",
			),
			500: json(
				errorEnvelope,
				"The file isn't JPEG, PNG or WebP, or the upload failed (`SERVER_ERROR`)",
			),
		},
	},
	noProjectsForTechs,
);
