# Agent tool layer

One catalog of callable actions, shared by every AI surface: the in-app
assistant (`src/assistant/`) and the MCP server (`src/mcp/`). Neither transport
gets its own idea of what a tool is or who may call it — both are adapters over
this registry, and adding a tool here reaches both for free.

Nothing here talks to a model. The whole layer is typed and unit-testable
without an API key — `npx vitest run src/agent`.

## Layout

| File | Role |
| --- | --- |
| `types.ts` | `AgentContext`, `ToolDefinition`, `ToolResult`, `AgentToolError` |
| `policy.ts` | The permission ceiling, and why an admin's agent is not an admin |
| `context.ts` | Build an `AgentContext` from verified JWT claims |
| `registry.ts` | `defineTool` / `describeTools`. Validates at registration |
| `schema.ts` | Zod → JSON Schema for tool input |
| `execute.ts` | The gate every call passes through |
| `audit.ts` | Where agent activity is recorded, and where it deliberately is not |
| `records.ts` | Agent-sized projections behind `get_record` / `list_records` |
| `controllerBridge.ts` | Calling the domain controllers from a tool |
| `tools/` | The tools themselves |

## The gate

`executeTool` runs these in order — cheapest and most decisive first, so a
caller who may not run a tool learns that without their input being parsed or
the database being touched:

1. Does the tool exist?
2. Does policy permit this risk class?
3. Does the caller hold one of the tool's permissions?
4. If the tool needs approval, is this call carrying one?
5. Does the input validate?
6. Run it, against `getScopedDb(ctx.organizationId)` and nothing else.
7. Audit.

Permission is checked *before* approval on purpose: asking a person to approve
an action that will then be refused wastes their attention and teaches them the
prompts are noise.

It never throws. A model that gets `{ ok: false, error }` can correct itself;
an exception just ends the turn.

## Adding a tool

```ts
export const doTheThing = defineTool({
	name: "do_the_thing",          // snake_case; this is what the model sees
	title: "Do the thing",
	description: "...",            // written for the model — see below
	risk: "read",                  // read | write | destructive
	requiresApproval: true,        // defaults to risk === "destructive"
	permissions: ["view_jobs"],    // ANY-OF, must be non-empty
	input: z.object({ ... }),      // reuse lib/validate/* for writes
	async handler({ input, ctx, db }) { ... },
});
```

Then export it from `tools/index.ts`, and add its name to the expected list in
`__tests__/catalog.test.ts`. A tool that is not exported silently does not
exist, which is what that test is for.

Registration fails at boot — not at call time — if the tool declares no
permissions, collides with an existing name, is a write with no audit
descriptor, is destructive while opting out of approval, or has a schema Zod
cannot represent.

### Approval

`requiresApproval` defaults to `risk === "destructive"`. Two deliberate
exceptions:

- **Scheduling writes set it to `true`.** They are not destructive, but they
  change live dispatch state, so they stop for a person.
- **`propose_draft` sets it to `false`.** What it writes is a draft somebody
  then reviews in the Create panel — gating it would ask for the same approval
  twice.

A destructive tool may never set it to `false`; the registry refuses.

### Rules that are not optional

- **Every tool declares permissions.** The registry refuses one that does not.
  If a tool's permission is not in `AGENT_PERMISSION_CEILING`, no caller can
  ever reach it — `catalog.test.ts` fails on that.
- **Writes call the controllers.** That is where status guards, total
  recomputation, tax rules, and activity logging live. Reads use the explicit
  projections in `records.ts` instead, because the controllers' UI-shaped
  payloads are far too large for a context window. Several write controllers
  take an Express `Request`; `controllerBridge.ts` hands them the shape they
  read, and confines that compromise to one file.
- **Handlers get `db`, never the raw client.** It is already org-scoped.
- **Cap everything.** Every list takes a limit and reports `total` so the model
  can tell when it is seeing a subset.
- **Descriptions are for the model.** Say what it returns and when to prefer it
  over a neighbouring tool. Most tool-selection mistakes are description
  problems, not model problems.

## What is deliberately excluded

`policy.ts` documents the permissions the ceiling withholds and why — deletes,
role and org management, and anything that asserts a human was physically
somewhere (`check_in`, vehicle stock adjustments). Read that block before
widening the ceiling.

## Auditing

Mutations go to the `log` table via `logActivity` with `actor_type: "agent"` and
`actor_id` set to the **human** the agent acted for — so `getActorHistory`
surfaces agent activity under the person responsible for it. Reads go only to
the pino stream: an audit row per lookup would bury real events and make the
activity feed useless.
