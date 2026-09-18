---
name: shape-map
description: "Create or update a truthful semantic Shape canvas map when the user asks to map a repository, refresh its Shape diagram, visualize code architecture, or reconcile a branch with its existing canvas."
---

# Shape map

Map the user's original repository by preparing an immutable snapshot, inspecting real code and prior state, authoring semantic Canvas operations, and committing them atomically. The command prepares data; the model performs the semantic mapping. Never imply that `prepare` generated a map or that a checkpoint exists before `finish` succeeds.

## Invocation rule

Use a structured argv/process API. Every Shape invocation begins with these argv elements:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"map","<subcommand>"]}
```

`__SHAPE_DISPATCHER_JSON__` is installed as the JSON string for the absolute dispatcher. Keep it as one argv element, append every option/value separately, and never change the process working directory to the Shape checkout. This preserves the user's original repository location and works from any current directory.

## 1. Fix the repository and branch explicitly

Determine the canonical root of the repository the user meant without modifying its checkout, branch, index, or files. If the current location is not inside a repository, ask for the repository path; do not map the Shape checkout or an arbitrary parent as a fallback. Preserve that original path throughout the workflow.

Use branch `main` unless the user names another branch. A branch argument means the local `refs/heads/<branch>` tip, not whatever happens to be checked out. Do not switch branches or map detached/dirty working-tree contents implicitly.

## 2. Prepare an immutable mapping input

Invoke:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"map","prepare","main","--repo","<original-repo-root>"]}
```

Add `--server <origin>` and `--token <token>` as separate argv elements only when overriding the saved connection. Keep tokens private. Preparation resolves the selected branch to an exact commit, materializes an owned immutable snapshot under Shape's temporary mapping area, reads the committed mapping baseline, derives repository reality, and computes history/diff information. It does not alter the checkout and does not perform semantic mapping.

Require and retain the complete JSON result:

- `preparationId`, `snapshotPath`, `repository`, and `branch`;
- `fromCommit`, exact `toCommit`, `mode`, `revision`, and `mappedCommit`;
- existing committed `doc`, `changedPaths`, unified `diff`, and `reality`.

Treat `snapshotPath` as read-only. All later file/code inspection must read from that snapshot, not from a moving worktree. If prepare fails, no checkpoint was created; resolve its connection/ref/snapshot error and retry.

## 3. Inspect before designing operations

Inspect enough of all four evidence sources to explain the actual repository at `toCommit`:

1. files and top-level symbols in the immutable snapshot;
2. the unified `diff` and `changedPaths` when present;
3. the existing committed `doc`, including stable node and edge IDs;
4. `reality`, using its observed workspace/package/code relationships rather than invented components.

Read implementation entrypoints and boundaries, not just manifests or filenames. Every mapped node must have a specific, truthful responsibility and grounded code reference. Do not fabricate summaries, dependencies, tools, files, runtime behavior, or LLM output.

## 4. Author real CanvasOp JSON

Write a temporary JSON file containing a **top-level array** of supported operations:

- `{"op":"upsert_node","node":{...}}`
- `{"op":"remove_node","id":"..."}`
- `{"op":"upsert_edge","edge":{...}}`
- `{"op":"remove_edge","id":"..."}`
- `{"op":"set_phase","id":"...","phase":"..."}`

Node IDs must match `^[a-z0-9][a-z0-9-]*$`. A node requires `id`, `parentId` (string or `null`), `label` (at most 60 characters), `summary` (at most 200), and `phase` (`idea`, `concept`, `component`, `building`, `built`, or `failed`). Optional semantic fields are `status`, `modelRole`, `kind`, `codeRefs`, `layer`, `realizes`, `hosts`, and `verifies`. Use `layer` only as `product`, `build`, `infra`, or `correctness`; omission means `build`.

`codeRefs` must be workspace-relative path prefixes or precise `file#TopLevelSymbol` references verified in the snapshot/reality. Edges require slug ID, existing `source` and `target`, and `kind` `depends`, `dataflow`, or `relates`; optional labels are at most 60 characters. Prefer the stable `source--target` edge-ID convention.

Enforce the shared semantic-layer invariants before writing the batch:

- A nonempty document has exactly one top-level `product` root and 3–5 product capability children. Product nodes describe user-visible intent, have no `codeRefs`, and may `realizes` only existing `build` node IDs.
- `build` nodes own the grounded `codeRefs`. An `infra` node may `hosts` only existing build node IDs; a `correctness` node may `verifies` only existing build node IDs.
- A parent and child must have the same layer. Represent hierarchy only with `parentId`; never add an edge for containment.
- Edges represent non-hierarchical relationships only, and both endpoints must be on the same layer.
- Remove incident edges and descendant children before removing their referenced node.
- `kind` is optional and layer-specific. Omit it unless its exact schema-supported enum is known from the existing document/reality; never invent a plausible kind string.

Honor `mode`:

- `initial`: build a coherent semantic map of the actual repository from an empty baseline. A top-level `[]` is truthful only when inspection proves the repository/map is genuinely empty. A nonempty repository requires genuine snapshot-grounded semantic operations; empty ops are never a shortcut.
- `full`: rebuild the semantic map from actual snapshot/reality because the prior checkpoint is missing, unavailable, or divergent. A top-level `[]` is truthful only for a genuinely empty repository/map or an explicit evidence-backed clear of the existing map. Otherwise produce the real full semantic batch; do not blindly reuse stale content or erase it for convenience.
- `incremental`: preserve IDs for unchanged concepts; upsert only genuinely new/changed nodes and edges, update affected code refs/summaries, and explicitly remove obsolete edges before obsolete nodes. An empty array is valid when the inspected change has no semantic canvas effect; never invent an operation merely to make the list nonempty.

Operations are applied atomically, so order references safely and ensure the complete batch is internally consistent. Do not encode mechanical file lists as fake architecture.

## 5. Finish atomically

Invoke with the exact preparation handle and ops file:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"map","finish","<preparationId>","--ops","<absolute-ops-json-file>"]}
```

Success is a JSON receipt containing `projectId`, `branch`, `revision`, `mappedCommit`, `canvasUrl`, and `committed`. Verify `mappedCommit === toCommit`, the intended branch/repository are represented, and the revision is the returned server revision. Incremental exact no-diff `[]` at an already-checkpointed tip normally returns `committed:false`. An intentional, evidence-backed initial/full `[]` is still submitted as an atomic mapping result and normally returns `committed:true`; report the receipt's actual value rather than inferring it from the empty batch.

Only this normal receipt confirms the map/checkpoint result. When it also contains `cleanupPending:true`, `preparationId`, and `cleanupError`, the server commit/no-diff result is still confirmed, but the local owned preparation/snapshot remains. Run `shape map abort <preparationId>` strictly to clean those owned resources and require `{preparationId,aborted:true}`. This cleanup abort does not roll back the confirmed checkpoint. If abort fails, report the confirmed map result **and** the unresolved cleanup/preparation ID; never hide the residue or call the commit ambiguous.

Without `cleanupPending:true`, finish cleaned its owned snapshot/preparation normally. Delete the temporary ops file after consuming any confirmed receipt.

## Failure and abort discipline

Deterministic rejections comprise local preparation checks (JSON parsing, missing/invalid pinned snapshot, or changed local branch tip) and server `control_error` responses (invalid CanvasOps or stale revision/checkpoint). Neither path atomically accepts the map commit, and both retain the preparation/snapshot. Correct JSON/operations against the same pinned snapshot, or abort a changed-tip/stale preparation and prepare the current branch again; do not force an old batch.

A transport timeout/disconnect or missing/malformed acknowledgement is **ambiguous**: the server may already have atomically accepted `map_commit`. Do not retry the old finish and do not claim either committed or uncommitted. Reconcile first:

1. reconnect, then run a fresh `map prepare` for the same original repository and branch so its `map_read` observes the server's committed `mappedCommit` and `doc`;
2. compare that fresh baseline with the old `toCommit` **and** the intended semantic result, not merely the commit SHA;
3. if it is an exact no-diff, already-checkpointed match, finish the fresh incremental preparation with a top-level `[]`, require its `committed:false` receipt and canvas URL, then abort the old retained preparation;
4. otherwise abort the old preparation and remap from the fresh baseline (or abort/re-prepare again if that fresh preparation became stale).

Only after reconciliation yields a valid finish receipt may you describe the checkpoint state. If abandoning any retained preparation, clean only Shape-owned resources with:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"map","abort","<preparationId>"]}
```

Require `{preparationId,aborted:true}`. Abort cleans only owned preparation resources; it never rolls back an already accepted commit. Never manually delete an unknown snapshot path or report an aborted/failed preparation as mapped.

## Required success evidence

Return:

- original repository identity/path and selected branch;
- preparation mode, `fromCommit`, and exact `toCommit`;
- a concise account of snapshot, diff, existing-doc, and reality evidence inspected;
- operation counts by discriminant and examples of the code references that ground the semantic map;
- finish receipt values `projectId`, `revision`, `mappedCommit`, `committed`, token-free `canvasUrl`, and whether `cleanupPending` was present; when it was, include either the successful cleanup abort receipt or the unresolved `preparationId`/cleanup error.

The visible canvas URL plus a successful matching finish receipt are mandatory. A prepared snapshot, a written ops file, or a plausible-looking document alone is not success.