# Automated Client Followups — Operator Guide

Automated, branded email sequences that chase clients until they engage (open) or the
goal is met (quote approved, invoice paid, visit done). Sequences can be triggered
automatically from lifecycle events or started manually, plus visit/date reminders.

## Concepts

- **Sequence** — an ordered list of **steps** with a `trigger_type` and a `stop_on_open` flag.
- **Step** — one email in a sequence: a **category**, a delay, and a condition. The step's
  **category selects the email template** rendered for it (`followup`, `reminder`, `quote_chase`,
  `invoice_chase`, `request_ack`, `custom`).
- **Template** — the HTML + subject sent for a category. Each org can **edit its own template
  per category** in-app (Followups → Templates), with a live preview; a category with no saved
  override falls back to a **built-in default** (`services/followupTemplateDefaults.ts`). Templates
  are **rendered by us** (Mustache-subset engine in `services/templateRenderer.ts`) and sent to
  Postmark as `HtmlBody` — there are **no Postmark-hosted templates**. Branding (logo, accent
  color, org name/address/phone/website) is injected as `{{brand.*}}` variables at render time,
  along with `{{client_name}}`. The org logo is signed with a 7-day TTL so it renders in emails
  opened well after send.
- **Enrollment** — a running instance of a sequence for one client, advanced by the
  scheduler. Stops when the recipient opens (if `stop_on_open`), the anchor entity
  resolves, or the last step sends.
- **Send** — one email attempt (records the alias sent + the Postmark MessageID for open correlation).

## Trigger types

| trigger_type      | Fires when…                        | Timing        | Anchor       |
|-------------------|------------------------------------|---------------|--------------|
| `manual`          | a dispatcher enrolls a client      | after enroll  | —            |
| `date_based`      | manual enroll with a target date   | after date    | scheduled_at |
| `quote_sent`      | a quote is emailed                 | after send    | quote        |
| `invoice_sent`    | an invoice is emailed              | after send    | invoice      |
| `request_created` | a request is created               | after create  | request      |
| `visit_scheduled` | a job visit is scheduled           | **before** the visit | job_visit |

`visit_scheduled` is a "reminder": steps send *before* the anchor (e.g. delay 1 day →
sent 1 day before the visit). Use `stop_on_open = false` + step condition `always` so a
later reminder still fires even if an earlier one was opened.

## Engagement (opens-only)

Emails send with Postmark open tracking. The `/integrations/postmark/webhook` endpoint
records opens (and bounces/spam-complaints). "No-open" chaining: a step with condition
`if_previous_not_opened` is skipped once the recipient opens; `stop_on_open` ends the
whole sequence on first open. There is no reply parsing — dispatchers can Stop manually.

## Templates (in-app)

Templates are edited in the app — **no out-of-band Postmark template setup**. Under
**Followups → Templates** each category shows an editable card. The editor is a split
pane: edit the **subject**, a **plain-text version**, and (under *Advanced*) the **HTML** on the
left, with a **live preview** on the right (toggle HTML / Text).
The **variables** form lists every `{{token}}` the template references and updates
the preview as you type — those are the same variables substituted when the email sends.
The org logo and brand color are prefilled automatically. The plain-text body is the
`text/plain` alternative — **leave it blank to auto-generate it from the HTML** at send time.
**Reset to default** discards the org's override. Available variables: `{{brand.name}}`, `{{brand.logo_url}}`, `{{brand.color}}`,
`{{brand.address}}`, `{{brand.phone}}`, `{{brand.website}}`, `{{client_name}}`. Sections like
`{{#brand.logo_url}}…{{/brand.logo_url}}` render a block only when the value is present.

Templates persist in the `email_template` table (`@@unique([organization_id, category])`);
CRUD lives at `/followups/templates*` (perms `view_followups` / `manage_followups`).

## Setup (out-of-band)

1. **Open tracking** — enable on the Postmark server (the code also sets `TrackOpens`).
2. **Webhook** — add a Postmark webhook for **Open, Bounce, SpamComplaint** pointing at
   `https://<api-host>/integrations/postmark/webhook`, authenticated with the shared secret
   (either `?secret=<value>` on the URL or HTTP Basic auth whose password is the secret).
3. **Env** — set in `backend/.env`:
   - `POSTMARK_WEBHOOK_SECRET` — shared secret for the webhook. **Required in production**:
     if unset, the webhook fails closed in production (accepts nothing) and open only in dev.
   - `POSTMARK_API_KEY`, `POSTMARK_FROM_EMAIL` — existing Postmark send config.
   - `WASABI_*` — used to sign the org logo URL embedded in emails (7-day TTL).
4. **Enable** — turn on **Settings → Followups enabled** per organization, set a brand
   color + logo, then customize templates / build sequences under **Followups**.

## EMAIL_DISABLED

`backend/src/services/emailService.ts` has `EMAIL_DISABLED = true` while the Postmark sender
signature is pending approval — this gates ALL app email (quotes, invoices, OTP, followups).
While disabled, the scheduler still runs: it logs each send, records a `followup_send` with a
synthetic `disabled-…` MessageID, and advances/completes enrollments (so flows are testable in
dev). **Do not enable followups in production until `EMAIL_DISABLED` is false**, or clients
will silently receive nothing while enrollments complete.

## Operations

- The scheduler sweeps every 5 minutes (`startFollowupSchedulerInterval` in `index.ts`), with a
  startup catch-up run. Delivery is **at-least-once**: a hard crash between a successful send and
  the DB advance can, rarely, re-send a step after the 15-min lease lapses.
- Bounces/spam-complaints stop the enrollment and suppress re-enrollment of that address for the
  same sequence+anchor.
- Permissions: `view_followups` (read) and `manage_followups` (write), under the Followups role
  category.

## Verify

Unit suites: `npx vitest run src/services/__tests__/followup*.test.ts src/services/__tests__/templateRenderer.test.ts src/controllers/__tests__/followupsController.test.ts`.
Runtime integration smoke (needs a live DB):
`DATABASE_URL=postgresql://hvac_user:hvac_pass@localhost:5433/hvac_db npx tsx scripts/followupsSmoke.ts`.

## Customer messages

Transactional notices to a visit's customer, separate from the followup sequences above.
Module `customer_comms` (Admin → Customer messages tab). Permissions: `view_customer_comms`
(read) and `manage_customer_comms` (write).

**Events** (`services/customerComms/events.ts`): `visit_confirmed`, `visit_reminder`,
`visit_rescheduled`, `visit_cancelled`, `tech_on_the_way`, `tech_running_late`,
`visit_completed`, `review_request`. A setting row per org and event holds `email_enabled`,
`sms_enabled` and `config`. **No row means off.**

**Defaults.** An org provisioned with `customer_comms` on (in its plan and its business-type
defaults) gets email on for `visit_confirmed`, `visit_reminder` (`lead_hours: [24]`),
`visit_rescheduled` and `visit_cancelled`; nothing else, and SMS is never defaulted. Existing
orgs got no rows. An org that turns the module on later starts all-off: the Admin tab is where
it switches events on.

**Dedupe keys** (`customer_message.dedupe_key`; a repeat call with the same key queues nothing):

| Event | Key |
|---|---|
| `visit_confirmed` | `visit_confirmed:<visitId>` |
| `visit_reminder` | `visit_reminder:<visitId>:<leadHours>:<startISO>` (a new start time is a new reminder) |
| `visit_rescheduled` | `visit_rescheduled:<visitId>:<editEpochMs>` (one per edit) |
| `visit_cancelled` | `visit_cancelled:<visitId>:<cancelEpochMs>` (one per cancellation) |
| `tech_on_the_way` | `tech_on_the_way:<visitId>:<orgLocalDate>` (one per visit per local day) |
| `review_request` | `review_request:<jobId>` (one per job, ever) |

**Quiet hours.** SMS only, 08:00–20:00 in the org's timezone. A text due outside the window is
held to the next 08:00 (reminders are moved back to the previous 20:00 instead, so they
never arrive after the visit starts). Exempt: `visit_rescheduled`, `visit_cancelled`,
`tech_on_the_way`, `tech_running_late`. Email is never held.

**How it differs from followup sequences.** A followup enrollment is a multi-step chase that
stops when the client opens, pays or approves; the scheduler advances it every 5 minutes.
A customer message is a single outbox row per channel and recipient, written when the
event happens and sent by the outbox sweeper, with a per-event dedupe key instead of
enrollment state. Followups also have a visit reminder trigger, so an org running both can send
two reminders. The Customer messages tab shows a banner when the `visit_reminder` email is on
and a Followups sequence is active; turn one of them off.

**Review requests.** Queued when a job moves into Completed (visit transition, a dispatcher
editing a visit's status, cancelling the last open visit, or setting the job's status), sent
`delay_hours` later (1–72, default 2). Needs the org's review link (Admin → Customer messages →
Review request → paste the link, then switch on). Not queued while the job's quote or invoice
has an Open dispute or an invoice billing it is Disputed, or when the client already got one in
the last 180 days (checked again at send time). The key is per job, so a job that is reopened
and completed again never gets a second request.
