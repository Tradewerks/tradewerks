# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Build & Run Commands

### Frontend (`/frontend`)
```bash
npm install
npm run dev          # Dev server on :5173 with HMR, proxies API to backend
npm run build        # Production build (vite build)
npm run lint         # ESLint
npm run test:e2e     # Playwright E2E tests (requires frontend + backend running)
npm run test:e2e:ui  # Playwright interactive UI mode
```

### Backend (`/backend`)
```bash
npm install
npm run build        # TypeScript compile (tsc)
npm run start        # Run compiled output (node dist/index.js)
npx prisma migrate dev    # Apply database migrations
npx prisma generate       # Regenerate Prisma client after schema changes
```

### Docker (all services)
```bash
docker-compose up    # Backend :3000, Frontend :5173, PostgreSQL :5433
```

## Architecture

Full-stack HVAC/service dispatch system with three packages at the repo root:

- **`frontend/`** — React 19 + TypeScript + Vite 7. Uses React Router v7, TanStack Query for server state, Zustand for auth state, Tailwind CSS 4, Mapbox GL for maps, FullCalendar for scheduling, Recharts for reporting, Socket.io-client for real-time updates.
- **`backend/`** — Express 5 + TypeScript. Prisma 7 ORM with PostgreSQL. JWT auth (60min access tokens). Socket.io for real-time. Postmark for email. Zod for request validation.
- **`user-simulator/`** — Standalone utility for simulating user activity.

### Database (Prisma)

Schema at `backend/prisma/schema.prisma`. Multi-tenant via `Organization`. Core service flow:

**request → quote → job → job_visit**

Key models: Organization, User (dispatcher/technician roles), Client, Contact, Request, Quote, Job, JobVisit, RecurringPlan, InventoryItem, LineItem, Note, Log, FormDraft.

### Frontend Structure (`frontend/src/`)

- `api/` — API client functions (one file per domain: clients, jobs, quotes, etc.)
- `auth/` — Login page + Zustand auth store (localStorage token persistence)
- `components/` — UI components organized by domain
- `hooks/` — TanStack Query hooks wrapping API calls (useClients, useJobs, etc.)
- `layouts/` — DispatchLayout (main app shell)
- `pages/` — Route pages (dispatch role pages)
- `types/` — TypeScript interfaces matching API responses
- `AppRoutes.tsx` — All route definitions; dispatch pages under `/dispatch/*`

### Backend Structure (`backend/src/`)

- `controllers/` — Express route handlers (CRUD per domain)
- `services/` — jwtService, emailService, logger, draftLabel
- `lib/validate/` — Zod schemas for request validation
- `types/` — Response types, Express type extensions
- `index.ts` — Server setup, all route definitions, middleware
- `db.ts` — Prisma client singleton

### API Response Format

All endpoints return:
```typescript
{ success: boolean, data: T | null, error: { code: string, message: string } | null, meta?: { timestamp, count? } }
```

### Authentication

JWT Bearer tokens via `Authorization` header. Two roles: `dispatcher` (admin UI) and `technician` (field). Protected routes use `RequireAuth` HOC on the frontend and JWT middleware on the backend.

## Code Style

- **Prettier**: double quotes, tabs (width 8), 100 char print width
- **ESLint**: TypeScript + React Hooks rules
- **TypeScript**: strict mode, ES2020 target
- Zod for validation on both frontend and backend
