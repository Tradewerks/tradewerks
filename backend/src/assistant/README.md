# Assistant

The in-app chat panel. It owns the conversation and the model loop; it owns no
business logic — every action it can take is a tool from `src/agent/`, and every
security decision was made there.

## Layout

| File | Role |
| --- | --- |
| `config.ts` | Model, limits, and the on/off switch |
| `openaiClient.ts` | Lazily-built SDK client |
| `prompt.ts` | Static instructions and the per-turn context, including injection defence |
| `toolBridge.ts` | Agent registry → Responses function tools, and result summaries |
| `conversations.ts` | Persistence and transcript replay |
| `loop.ts` | The streaming model→tool→model loop |
| `events.ts` | The SSE protocol |

Routes live in `src/routes/assistant.ts`; the UI is `frontend/src/components/assistant/`.

## Configuration

Set `OPENAI_API_KEY` to switch the assistant on and `OPENAI_MODEL` to name the
model — there is no clever default-picking, because naming a model the account
cannot reach fails in front of a user mid-sentence rather than at boot. With no
key the backend boots normally, `/assistant/status` reports `enabled: false`, and
the UI renders nothing. Every other knob is in `config.ts` with a default.

`OPENAI_BASE_URL` points the client at Azure OpenAI or a compatible gateway.

The default model is `gpt-5.6-luna`, and `ASSISTANT_REASONING_EFFORT` defaults to
`low`. Luna is the cheap tier of the family — roughly a tenth of Terra's price
per token — and its one hard limitation, long-context recall falling apart past
about 256k tokens, is out of reach for this workload: the fixed prefix is ~6k
tokens, lists are capped, and a turn is at most `MAX_TOOL_ITERATIONS` round
trips. Escalate to `gpt-5.6-terra` if the numbers say the reasoning is not
enough. Two metrics already answer that, and both are exported:
`hvac_assistant_approvals_total{decision="rejected"}` rising means the model
proposes the wrong thing, and `hvac_assistant_turns_total{outcome="iteration_limit"}`
rising means it gets lost. Since the model is env-only, an A/B is a restart.

**This assumes a reasoning model.** `streamOnce` always sends `reasoning`, which
a non-reasoning model rejects.

## Why the Responses API, not Chat Completions

Chat Completions was the original choice, for portability. It is no longer
viable: the GPT-5.6 family rejects a request carrying function tools together
with any `reasoning_effort` above `none`, and it defaults to `medium`, so the
call fails even when the parameter is never sent. Newer models drop function
calling on that endpoint entirely.

The switch pays for itself anyway. Responses returns the model's reasoning as
items that get handed straight back on the next request, so a turn that searches,
reads and then answers thinks once instead of three times from scratch — and the
middle of that turn is exactly where this loop spends its tokens.

Four related choices:

- **`store` is false.** The API otherwise retains each response on OpenAI's side
  for 30 days. This is a multi-tenant product holding other companies' client
  records; that is a data-residency decision nobody here made deliberately, and
  the transcript already lives in our own database. Because nothing is stored,
  reasoning has to travel with the request, which is why `include` asks for
  `reasoning.encrypted_content`.
- **`reasoning.context` is `current_turn`.** The gpt-5.6 family defaults to
  `all_turns`, which expects reasoning items from earlier turns that this loop
  cannot supply — the transcript is rebuilt from the database, and nothing
  encrypted is persisted there. Ask for what can actually be provided.
- **`strict` mode is off.** It requires every property in `required` and
  `additionalProperties: false` throughout, which Zod-derived schemas do not
  satisfy — most tool parameters are genuinely optional. Loosening the schemas
  to satisfy it would advertise a contract the server does not enforce. The
  server re-validates every call with Zod regardless, so a malformed call
  returns a structured error the model can correct.
- **`temperature` is never sent.** Reasoning models reject it, and the default
  is right for this workload.

## The prompt is split in two, on purpose

`buildInstructions` is static — identical for every dispatcher on every day,
varying only with the policy — and goes in `instructions`. `buildTurnContext`
carries the person's name, the org timezone and today's date, and goes in the
input as a `developer` item.

That split is worth real money. Everything ahead of the first input item —
instructions plus the ~5.3k-token tool catalog — is the prefix OpenAI hashes for
prompt caching, and cached input bills at roughly a tenth of the rate. The first
version of this file opened the system prompt with the person's name and today's
date, which made that prefix unique per user per day: every request paid to write
a cache entry nothing else could ever read, and on the gpt-5.6 family a cache
write costs 1.25x an ordinary input token. Keep anything that varies out of
`buildInstructions`; `prompt.test.ts` asserts it.

## The loop

`runTurn` persists the user message, replays the transcript, then repeats:
stream a response → run any tool calls through `executeTool` → feed the
results back, along with the reasoning items that produced them. It stops when
the model stops asking for tools, or at `MAX_TOOL_ITERATIONS`, which reports the
limit rather than presenting a partial answer as a complete one.

It also stops on a truncated response. `MAX_OUTPUT_TOKENS` counts reasoning
tokens as well as visible ones, so a turn can spend its whole budget thinking and
return no text — which reached a dispatcher as a blank reply until the loop
started checking. A truncated turn now emits `OUTPUT_LIMIT` and runs none of the
tool calls it contained, because the last one's arguments may have been cut off
mid-string.

Each model turn is persisted as its own `assistant_message`. A turn that calls
tools, answers, then calls more tools has an order that matters —
`toTranscript` has to replay it exactly or the API rejects the request. That is
also why `provider_call_id` is stored rather than regenerated: it becomes the
`call_id`, and a `function_call_output` matching no preceding `function_call` is
a hard error.

Reasoning items are the exception to "persist everything". They are carried in
memory for the length of one turn and dropped — `store` is false, the encrypted
blobs are large, and their value does not outlive the turn that produced them. A
turn resumed after an approval therefore starts its reasoning fresh, which is
the right trade for an action a human has just spent minutes deciding on.

## Approvals

A gated call pauses the turn rather than blocking the stream:

1. The loop records the call as `pending_approval`, emits `approval_required`,
   and ends the turn.
2. The panel renders Approve / Decline with the exact arguments.
3. `POST /assistant/approvals/:id` records the decision, runs the tool if
   approved, and — once nothing else in the conversation is waiting — resumes
   the model on the same response.

The transcript is rebuilt from the database on resume, never carried in memory,
so a decision made after a page refresh or from a second tab works. Blocking the
open SSE connection instead would tie a pending action to a socket that a reload
destroys.

Two consequences worth knowing:

- **`toTranscript` renders undecided calls explicitly.** Every `function_call`
  needs a matching `function_call_output` or the API rejects the request, so a
  pending call gets one saying it has not run, and telling the model not to
  report it as done. Rejected and expired calls get their own wording.
- **Asking something new lapses anything undecided.** `runTurn` expires pending
  approvals for the conversation before it starts. Agreeing to a reschedule ten
  minutes and three questions later would fire an action nobody is thinking
  about.

## Finding out what the agent did, and why it failed

Three places, in the order you should reach for them.

**1. The tool card in the panel.** A failed call states its reason inline;
expanding it shows the exact arguments the model sent. That "Sent" block is
usually the answer — a validation failure means the model sent something the
schema did not allow, and seeing what it sent tells you whether the model
guessed badly or the schema advertised the wrong thing.

**2. The database.** Every call is stored, including failures:

```sql
select tool_name, status, error_code, duration_ms, input, result
from assistant_tool_call
order by created_at desc
limit 20;
```

`input` is what the model sent; `result` carries the structured error with its
Zod issues. Join through `assistant_message` → `assistant_conversation` to scope
to one person or organization.

**3. Logs.** Every call — read or write, success or failure — emits a pino line
with `evt: "agent.tool_call"`, carrying tool, surface, org, user, ok, code, ms,
and on failure the input and message. In Loki:

```logql
{app="hvac-backend"} | json | evt = "agent.tool_call" and ok = "false"
```

Writes additionally land in the `log` table with `actor_type: "agent"` and
`actor_id` set to the human, so they show up in that person's change history.

## Metrics

Exported through the existing Prometheus endpoint (`/metrics`) and the Grafana
Cloud OTLP exporter, alongside the HTTP metrics:

| Metric | Labels | Answers |
| --- | --- | --- |
| `hvac_agent_tool_calls_total` | tool, risk, surface, outcome, code | Which tools are used, which fail, and why |
| `hvac_agent_tool_duration` | tool, surface | Which tools are slow |
| `hvac_assistant_turns_total` | surface, outcome | How turns end: answered, awaiting_approval, iteration_limit, output_limit |
| `hvac_assistant_tokens_total` | direction, model | What the model is costing |
| `hvac_assistant_approvals_total` | tool, decision | How often people decline — the clearest signal on whether the assistant proposes the right things |

`direction` takes four values, not two: `input` counts only uncached input,
`cached_input` the rest, `output` everything generated, and `reasoning` the slice
of that output the model spent thinking. Splitting them is not bookkeeping —
cached input bills at roughly a tenth of uncached, so the two cannot be added
together and costed, and the ratio between them is the health check on prompt
caching. If `cached_input` is not most of your input on a busy day, something
has broken the static prefix; start at `prompt.ts`.

Organization is deliberately **not** a metric label: it is unbounded and would
blow up series cardinality. Per-org cost comes from `assistant_message`, which
stores the same breakdown per turn:

```sql
select c.organization_id, m.model,
       sum(m.input_tokens - coalesce(m.cached_input_tokens, 0)) as uncached_input,
       sum(coalesce(m.cached_input_tokens, 0))                  as cached_input,
       sum(m.output_tokens)                                     as output,
       sum(coalesce(m.reasoning_tokens, 0))                      as reasoning
from assistant_message m
join assistant_conversation c on c.id = m.conversation_id
where m.created_at >= now() - interval '30 days'
group by 1, 2;
```

`cached_input_tokens` and `reasoning_tokens` are null on rows written before the
Responses migration; the `coalesce` is what stops those turns from silently
reading as "nothing cached".

## Rules

- **The loop never widens what Phase 1 decided.** It passes `AgentContext` and
  `AgentPolicy` straight through to `executeTool`. If the assistant needs a
  capability, it gets it by changing the policy it is constructed with, never by
  adding an exception here.
- **Writes stop for a person.** Routes construct `WRITE_POLICY` unless
  `ASSISTANT_WRITES_ENABLED=false`. That flag governs whether write tools are
  *advertised*, never whether the agent can act unattended — every scheduling
  tool sets `requiresApproval`, and the executor refuses an unapproved call
  regardless of policy.
- **Failures go into the thread.** A tool error is fed back to the model, which
  usually corrects itself. A turn error becomes an `error` event the panel
  renders inline — not a toast, and not a thrown exception.
- **Record text is data.** The system prompt says so explicitly, because notes,
  descriptions and email bodies are attacker-influenced text that arrives inside
  tool results. Keep that section when editing the prompt.

## Auditing and cost

Tool calls are audited by the agent layer (see `src/agent/README.md`). On top of
that, every assistant message stores its own token breakdown — total input, the
cached share, total output, the reasoning share — and the model that produced
them, so the per-org cost question is answerable from the database rather than
from a provider dashboard.

`MAX_CONCURRENT_STREAMS_PER_USER` caps in-flight turns per user. That is a
runaway-client guard, not a rate limiter — real limits and per-org budgets are
Phase 5.
