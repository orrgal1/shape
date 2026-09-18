---
name: shape-live
description: "Report an active coding session to an existing Shape canvas when the user asks to show live work, stream meaningful progress, update the uncommitted canvas overlay, or stop live Shape reporting."
---

# Shape live

Represent the current, real work session with an explicit start, meaningful updates, and a guaranteed stop. Live session/activity state is transient and clears on stop. Semantic live ops update the effective graph as an uncommitted overlay and remain after stop until a successful map commit replaces or reconciles them; they never advance the committed mapping baseline or checkpoint. Do not claim this skill can retrofit native hooks into an already running harness, and never manufacture events, tools, files, semantic changes, or model output.

## Invocation rule

Use a structured argv/process API. Every Shape invocation begins with:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"live","<subcommand>"]}
```

`__SHAPE_DISPATCHER_JSON__` is installed as the JSON string for the absolute dispatcher. Keep it as one argv element and append each option/value separately. Run against the user's current/original repository, not the Shape checkout; the absolute dispatcher makes this safe from any working directory. Never expose a token in output or compose a shell command string.

## Preconditions

Resolve the current repository and named local branch. If outside a repository, ask for the intended path and pass `--repo`; retain that exact original path and repeat `--repo` on every emit and stop because those commands re-resolve the checkout. If HEAD is detached, ask which named branch to use rather than guessing. The branch must already have a committed Shape map. If the server reports that it is unmapped, stop and run the `shape-map` skill first; do not synthesize a baseline with live operations.

Use the saved Shape connection unless the user explicitly supplies `--server <origin>` and optional `--token <token>`. The session handle stores the normalized server origin/identity but never the token. If start uses an explicit unsaved server/token, retain both privately and append the same `--server` and unsaved `--token` argv elements to **every** emit and stop; never persist or print the token.

## 1. Start this session

At the beginning of the actual work session, invoke:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"live","start","--repo","<original-repo-root>","--note","Starting <truthful task>","--tool","<actual-harness>","--files","<file-already-in-scope>"]}
```

`--repo`, `--server`, `--token`, `--note`, and `--tool` each take one value. `--files <path>` is repeatable; include only files genuinely in scope and omit it when none are known yet.

Before sending the start request, the CLI writes a credential-free pending handle. Normal success is a JSON acknowledgement with `ok:true`, a UUID `session`, repository descriptor, `projectId`, named `branch`, `state:"start"`, nonnegative `revision`, `mappedCommit`, and token-free `canvasUrl`; retain that exact session. If an ambiguous start failure (transport loss or missing acknowledgement) names a recovery session, retain it and issue an explicit `live stop` with the same repo/server/token options before retrying start—do not assume the server never started it. If no recovery session is named, handle deterministic unmapped-branch errors by mapping first and deterministic connection/auth errors by repairing the connection, then retry; never pretend live reporting started without the success acknowledgement.

## 2. Emit meaningful work

Emit after observable transitions such as finishing an investigation, beginning or completing a real implementation slice, changing the set of touched files, applying a supported semantic canvas change, or becoming intentionally idle. Do not emit timer ticks, inferred editor activity, fake tool calls, retrospective pseudo-events, or one event per trivial command.

Without semantic canvas operations:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"live","emit","--session","<retained-session>","--repo","<same-original-repo-root>","--state","working","--note","Implemented the actual parser boundary","--tool","edit","--files","src/parser.ts","--files","src/types.ts"]}
```

When start needed an explicit `--repo`, keep the same original path in every emit as shown; omit it only when the harness remains inside that repository. When the session was started with explicit connection overrides, also append `"--server","<same-origin>","--token","<same-private-token>"`; omit only the token option when start omitted it.

`--state` is `working` or `idle` and defaults to `working`. Notes, tool names, and repeatable files must describe what truly happened in this session. Emit `idle` only when the session is actually paused, and emit `working` when meaningful work resumes.

When the work genuinely supports a semantic canvas overlay, write an ops file and add `--ops <absolute-json-file>`. The file may be a top-level CanvasOp array or `{"ops":[...]}`. Supported operations are `upsert_node`, `remove_node`, `upsert_edge`, `remove_edge`, and `set_phase`, with the same schema and ID/code-reference rules as `shape-map`. Ground every node and code reference in files/symbols actually inspected or changed, preserve existing semantic IDs, and never use live ops to masquerade as a committed remap. If the evidence supports only activity/files, omit `--ops` entirely.

For every emit, require `ok:true`, exact equality with the retained `session`, and the requested `state`. Also verify its `projectId`, named `branch`, nonnegative `revision`, `mappedCommit`, and token-free `canvasUrl`. An acknowledgement proves only the current overlay/activity update; `mappedCommit` remains the committed baseline.

On a rejected atomic ops batch, correct or remove the unsupported semantic ops and retry with honest data. Do not claim a partial overlay update. An unknown or missing session is an error, not an idempotent stop signal: do not invent a replacement handle or claim it stopped. Recheck the exact retained session/tombstone and repository context; start a new session only after the old lifecycle is explicitly reconciled and real work continues.

## 3. Stop reliably

Stop in a finally/cleanup step when the work completes, is cancelled, or cannot continue:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"live","stop","--session","<retained-session>","--repo","<same-original-repo-root>"]}
```

When start needed an explicit `--repo`, keep the same original path here; omit it only when the harness remains inside that repository. When start used explicit connection overrides, append the same private `--server`/`--token` argv elements as well. Losing the repo or connection values is not a successful cleanup: recover them privately and retry rather than abandoning the live handle.

The first stop must acknowledge `ok:true`, the exact session, `state:"stop"`, and the associated project/branch/revision/mappedCommit; the CLI then records a stopped tombstone rather than deleting the handle. A repeated stop returns `{ok:true,session:<same>,state:"stop",alreadyStopped:true}` only for that known, previously confirmed stop. An unknown or missing session errors and must never be treated as `alreadyStopped`. Stopping clears only the live session/activity state. It does not roll back semantic live ops: they remain in the effective graph as an uncommitted overlay until a successful map commit replaces or reconciles them, and stop never advances the baseline/checkpoint. To make a durable baseline change, run `shape-map` prepare/inspect/finish separately.

If stop initially fails because the control connection or acknowledgement is unavailable, preserve the handle, restore the connection, and retry the exact same stop. Do not discard the handle or report the session stopped without a normal stop acknowledgement or a tombstone-backed `alreadyStopped:true` acknowledgement.

## Required success evidence

Report:

1. the start receipt's repository, named branch, session, mapped commit, and canvas URL;
2. a concise list of acknowledged meaningful states, actual tools/files, and any evidence-grounded CanvasOps emitted;
3. an explicit reminder that session/activity state was transient, while any semantic live ops remain as an uncommitted effective-graph overlay after stop until a successful map commit replaces/reconciles them; the committed baseline remained `mappedCommit`;
4. the final exact-session `state:"stop"` acknowledgement, or its `alreadyStopped:true` form only when backed by a known confirmed-stop tombstone.

A session that was started but not stopped is incomplete. A native-hook integration not already present is outside this workflow; describe only the explicit events this skill actually sent.