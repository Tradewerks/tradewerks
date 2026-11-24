import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
    sendResultErr,
} from "../types/responses.js";
import { getUserContext } from '../lib/context.js';
import { REFUSAL_STATUS } from '../lib/refusalStatus.js';
import { requirePermission, requireAnyPermission } from '../lib/requirePermissions.js';
import { requireAssigned } from '../lib/requireAssigned.js';
import { assignedTechId, SEES_EVERY_JOB } from '../lib/assignedScope.js';
import { acknowledgeTaxReviewRoute } from './tax.js';
import { isAddressTaxChoiceRefusal } from '../lib/addressTaxChoice.js';
import { getEntityHistory, parseHistoryLimit, INVALID_HISTORY_LIMIT } from '../controllers/logsController.js';
import {
    getAllJobs,
    getJobById,
    insertJob,
    updateJob,
    deleteJob,
    cancelJob,
} from "../controllers/jobsController.js";
import { cancelJobSchema } from "../lib/validate/jobs.js";
import {
    getJobNotes,
    getJobNotesByVisitId,
    insertJobNote,
    updateJobNote,
    deleteJobNote,
} from "../controllers/jobNotesController.js";
import {
    getJobVisitsByJobId,
} from "../controllers/jobVisitsController.js";
import * as invoicesController from '../controllers/invoicesController.js';
import * as recurringPlansController from "../controllers/recurringPlansController.js";
import * as recurringPlanNotesController from "../controllers/recurringPlanNotesController.js";
import { imageUpload } from "../lib/upload.js";
import { uploadFile, signImageUrl } from "../services/wasabiService.js";

const router = Router();

router.get("/", requireAnyPermission("view_jobs", "view_assigned_jobs", "view_all_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const jobs = await getAllJobs(orgId, assignedTechId(req));
        res.json(createSuccessResponse(jobs, { count: jobs.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/:id", requireAnyPermission("view_jobs", "view_assigned_jobs", "view_all_jobs"), requireAssigned("job", SEES_EVERY_JOB, "id", "hide"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const job = await getJobById(id, orgId, assignedTechId(req));

        if (!job) {
            return res
                .status(404)
                .json(
                    createErrorResponse(ErrorCodes.NOT_FOUND, "Job not found"),
                );
        }

        res.json(createSuccessResponse(job));
    } catch (err) {
        next(err);
    }
});

router.post("/", requirePermission("create_jobs"), async (req, res, next) => {
    try {
        const context = getUserContext(req);
        const result = await insertJob(req, context);

        if (result.err && result.code) {
            return res
                .status(REFUSAL_STATUS[result.code])
                .json(createErrorResponse(result.code, result.err));
        }
        if (result.err) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.patch("/:id", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateJob(req, orgId, context);

        if (isAddressTaxChoiceRefusal(result)) {
            return res
                .status(409)
                .json(createErrorResponse(result.code, result.err, result.details));
        }
        if (result.err) {
            return sendResultErr(res, result.err);
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/cancel", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const parsed = cancelJobSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return res.status(400).json(
                createErrorResponse(
                    ErrorCodes.VALIDATION_ERROR,
                    parsed.error.issues.map((i) => i.message).join(", "),
                ),
            );
        }
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await cancelJob(id, parsed.data.reason, orgId, getUserContext(req));
        if (result.err) {
            const status = result.code ? REFUSAL_STATUS[result.code] : 500;
            const code = result.code ?? ErrorCodes.SERVER_ERROR;
            return res.status(status).json(createErrorResponse(code, result.err));
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post(
	"/:id/tax-review/acknowledge",
	requirePermission("edit_jobs"),
	acknowledgeTaxReviewRoute("job"),
);

router.delete("/:id", requirePermission("delete_jobs"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteJob(id, orgId, context);

        if (result.err) {
            return sendResultErr(res, result.err, 400, ErrorCodes.DELETE_ERROR);
        }

        res.status(200).json(
            createSuccessResponse({ message: "Job deleted successfully", id }),
        );
    } catch (err) {
        next(err);
    }
});

router.get("/:jobId/visits", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), requireAssigned("job", SEES_EVERY_JOB, "jobId", "hide"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const visits = await getJobVisitsByJobId(jobId, orgId, assignedTechId(req));
        res.json(createSuccessResponse(visits, { count: visits.length }));
    } catch (err) {
        next(err);
    }
});




// ─────────────────────────────────────────────────────────────────────────────

// ============================================
// JOB NOTES
// ============================================

router.get("/:jobId/notes", requireAnyPermission("view_jobs", "view_assigned_jobs", "view_all_jobs"), requireAssigned("job", SEES_EVERY_JOB, "jobId", "hide"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const notes = await getJobNotes(jobId, orgId, assignedTechId(req));
        res.json(createSuccessResponse(notes, { count: notes.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/:jobId/visits/:visitId/invoices", requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const invoices = await invoicesController.getInvoicesByVisitId(
            req.params.visitId as string,
            orgId,
        );
        res.json(createSuccessResponse(invoices, { count: invoices.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/:jobId/visits/:visitId/notes", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), requireAssigned("visit", SEES_EVERY_JOB, "visitId", "hide"), async (req, res, next) => {
    try {
        const { jobId, visitId } = req.params as { jobId: string; visitId: string };
        const orgId = req.user!.organization_id as string;
        const notes = await getJobNotesByVisitId(jobId, visitId, orgId);
        res.json(createSuccessResponse(notes, { count: notes.length }));
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/notes", requireAnyPermission("edit_jobs", "add_job_notes"), requireAssigned("job", ["edit_jobs"], "jobId"), requireAssigned("visit", ["edit_jobs"], "visit_id"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertJobNote(jobId, req.body, orgId, context);

        if (result.err) {
            return sendResultErr(res, result.err);
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:jobId/notes/:noteId", requireAnyPermission("edit_jobs", "add_job_notes"), requireAssigned("note", ["edit_jobs"], "noteId"), async (req, res, next) => {
    try {
        const { jobId, noteId } = req.params as { jobId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateJobNote(jobId, noteId, req.body, orgId, context);

        if (result.err) {
            return sendResultErr(res, result.err);
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/:jobId/notes/:noteId", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const { jobId, noteId } = req.params as { jobId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteJobNote(jobId, noteId, orgId, context);

        if (result.err) {
            return sendResultErr(res, result.err, 400, ErrorCodes.DELETE_ERROR);
        }

        res.status(200).json(
            createSuccessResponse({
                message: result.message || "Note deleted successfully",
            }),
        );
    } catch (err) {
        next(err);
    }
});

router.post(
    "/:jobId/notes/upload-photo",
    requireAnyPermission("edit_jobs", "add_job_notes"),
    imageUpload.single("photo"),
    async (req, res, next) => {
        try {
            if (!req.file) {
                return res
                    .status(400)
                    .json(
                        createErrorResponse(
                            ErrorCodes.VALIDATION_ERROR,
                            "No image file provided",
                        ),
                    );
            }

            const rawUrl = await uploadFile(
                req.file.buffer,
                req.file.mimetype,
                req.file.originalname,
                "job-notes-photos"
            );
            const signedUrl = await signImageUrl(rawUrl);
            res.json(createSuccessResponse({ url: signedUrl, raw_url: rawUrl }));
        } catch (err) {
            next(err);
        }
    },
);

// invoices
router.get("/:jobId/invoices", requirePermission("view_invoices"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const invoices = await invoicesController.getInvoicesByJobId(
			req.params.jobId as string,
			orgId,
		);
		res.json(createSuccessResponse(invoices, { count: invoices.length }));
	} catch (err) {
		next(err);
	}
});

// occurrences
router.get("/:jobId/occurrences", requireModule("recurring_plans"), requireAnyPermission("view_recurring_plans", "view_jobs"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const occurrences =
            await recurringPlansController.getOccurrencesByJobId(jobId, req.user!.organization_id as string,);
        res.json(
            createSuccessResponse(occurrences, { count: occurrences.length }),
        );
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/occurrences/generate", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const context = getUserContext(req);
        const result = await recurringPlansController.generateOccurrences(
            jobId,
            req.body,
            req.user!.organization_id as string,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// ============================================
// RECURRING PLAN NOTES ROUTES
// ============================================

router.get("/:jobId/recurring-plan/notes", requireModule("recurring_plans"), requirePermission("view_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;

        const plan =
            await recurringPlansController.getRecurringPlanByJobId(jobId, orgId);

        if (!plan) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Recurring plan not found",
                    ),
                );
        }

        const notes = await recurringPlanNotesController.getRecurringPlanNotes(
            plan.id,
            orgId,
        );
        res.json(createSuccessResponse(notes, { count: notes.length }));
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/recurring-plan/notes", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result =
            await recurringPlanNotesController.insertRecurringPlanNote(
                req,
                orgId,
                context,
            );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:jobId/recurring-plan/notes/:noteId", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result =
            await recurringPlanNotesController.updateRecurringPlanNote(
                req,
                orgId,
                context,
            );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete(
    "/:jobId/recurring-plan/notes/:noteId",
    requireModule("recurring_plans"),
    requirePermission("manage_recurring_plans"),
    async (req, res, next) => {
        try {
            const { jobId, noteId } = req.params as { jobId: string; noteId: string };
            const orgId = req.user!.organization_id as string;
            const context = getUserContext(req);
            const result =
                await recurringPlanNotesController.deleteRecurringPlanNote(
                    jobId,
                    noteId,
                    orgId,
                    context,
                );

            if (result.err) {
                const statusCode = result.err.includes("not found") ? 404 : 400;
                return res
                    .status(statusCode)
                    .json(
                        createErrorResponse(
                            ErrorCodes.VALIDATION_ERROR,
                            result.err,
                        ),
                    );
            }

            res.json(createSuccessResponse({ message: result.message }));
        } catch (err) {
            next(err);
        }
    },
);

// recurring plans
router.get(
	"/:jobId/recurring-plan/skipped-dates",
	requireModule("recurring_plans"),
	requirePermission("view_recurring_plans"),
	async (req, res, next) => {
		try {
			const dates = await recurringPlansController.getSkippedDatesForJob(
				req.params.jobId as string,
				req.user!.organization_id as string,
			);
			res.json(createSuccessResponse({ dates: dates.map((d) => d.toISOString()) }));
		} catch (err) {
			next(err);
		}
	},
);

router.get("/:jobId/recurring-plan", requireModule("recurring_plans"), requirePermission("view_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const plan =
            await recurringPlansController.getRecurringPlanByJobId(jobId, orgId);

        if (!plan) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Recurring plan not found",
                    ),
                );
        }

        res.json(createSuccessResponse(plan));
    } catch (err) {
        next(err);
    }
});

router.put("/:jobId/recurring-plan", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await recurringPlansController.updateRecurringPlan(
            jobId,
            req.body,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:jobId/recurring-plan/template", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result =
            await recurringPlansController.updateRecurringPlanLineItems(
                jobId,
                req.body,
                orgId,
                context,
            );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/recurring-plan/pause", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await recurringPlansController.pauseRecurringPlan(
            jobId,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/recurring-plan/resume", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await recurringPlansController.resumeRecurringPlan(
            jobId,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/recurring-plan/renew", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await recurringPlansController.renewRecurringPlan(
            jobId,
            req.body,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/recurring-plan/cancel", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await recurringPlansController.cancelRecurringPlan(
            jobId,
            orgId,
            context,
            req.body,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:jobId/recurring-plan/complete", requireModule("recurring_plans"), requirePermission("manage_recurring_plans"), async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await recurringPlansController.completeRecurringPlan(
            jobId,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// ============================================
// RECURRING PLAN INVOICE SCHEDULE ROUTES
// ============================================

router.put(
    "/:jobId/recurring-plan/invoice-schedule",
    requireModule("recurring_plans"),
    requirePermission("manage_recurring_plans"),
    async (req, res, next) => {
        try {
            const jobId = req.params.jobId as string;
            const orgId = req.user!.organization_id as string;
            const result = await recurringPlansController.upsertInvoiceSchedule(
                jobId,
                req.body,
                orgId,
                getUserContext(req),
            );
            if (result.err) {
                res.status(400).json(
                    createErrorResponse("VALIDATION_ERROR", result.err),
                );
                return;
            }
            res.json(createSuccessResponse(result.item));
        } catch (err) {
            next(err);
        }
    },
);

router.delete(
    "/:jobId/recurring-plan/invoice-schedule",
    requireModule("recurring_plans"),
    requirePermission("manage_recurring_plans"),
    async (req, res, next) => {
        try {
            const jobId = req.params.jobId as string;
            const orgId = req.user!.organization_id as string;
            const result =
                await recurringPlansController.deleteInvoiceSchedule(jobId, orgId);
            if (result.err) {
                res.status(404).json(
                    createErrorResponse("NOT_FOUND", result.err),
                );
                return;
            }
            res.json(
                createSuccessResponse({ message: "Invoice schedule removed" }),
            );
        } catch (err) {
            next(err);
        }
    },
);

router.get("/:jobId/changes", requirePermission("view_jobs"),  async (req, res, next) => {
    try {
        const jobId = req.params.jobId as string;
        const orgId = req.user!.organization_id as string;
        let limit: number;
        try {
            limit = parseHistoryLimit(req.query.limit);
        } catch {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
        }

        const results = await getEntityHistory(orgId, "job", jobId, limit);

        if (results.err) {
            return res
                .status(500)
                .json(createErrorResponse(ErrorCodes.SERVER_ERROR, results.err));
        }

        res.json(createSuccessResponse(results.rows, {
            count: results.rows.length,
            hasMore: results.hasMore,
            total: results.total,
        }));
    } catch (err) {
        next(err);
    }
});

export default router;
