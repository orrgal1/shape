# Mapping and live onboarding

Shape's onboarding surface is three installed harness skills:

- **shape serve** finds or starts the Shape service and returns its real canvas URL.
- **shape map** builds or updates the committed semantic map for one repository branch.
- **shape live** reports the current harness session and its uncommitted semantic edits over
  that committed map.

The browser is the resulting view, not an orchestration console. It does not prompt, launch,
type into, or otherwise steer a coding harness.

## End-to-end flow

Keep the repository being mapped as the **original repository** throughout setup. Shape itself
can be cloned to any stable, separate location; its dependencies, built web client, and skills
belong to that checkout. The installed skills retain the checkout's absolute entrypoint, so
they work when the harness is later running in the original repository or any other working
directory.

Run the skills in this order:

1. **shape serve** discovers existing configured and local Shape endpoints first. The user can
   connect to a verified existing service or start a new one. Starting is an explicit,
   foreground process supervised by the harness's process tool, not a detached daemon.
2. **shape map** targets the original repository and the requested branch (`main` by default).
   It prepares an immutable snapshot, performs the semantic mapping work, and finishes the
   transaction. Preparation alone is not a completed map.
3. Open the actual canvas URL returned by Shape. Use **shape live** in an already-running
   coding session to report work and temporary semantic changes as that session proceeds.

## Serving and connection trust

The serve wizard asks whether the service is local or remote, which port and storage location
to use, and whether authentication is required. It checks runtime and web-build prerequisites,
then verifies Shape health and an authenticated control connection before saving a selected
endpoint. Discovery is deliberately first: it uses known, configured endpoints and bounded
probes, never a blind network scan and never silently starts a second service.

`shape serve connect` saves credentials for CLI control clients; it does not authenticate a
fresh browser. Open the clean canvas URL. If authentication or connection fails, the canvas
presents its own token form; the user enters the token securely in the page, which binds it to
the selected server origin in local storage and retries `/ws`. The token never belongs in a
URL, chat, command output, or tool output. Verify the browser's WebSocket connection and
continue reporting only the clean canvas URL.

For remote setup, the harness may use its SSH and supervised-process tools to install and run
Shape on the chosen host. Credentials may cross a remote connection only over TLS, or through
an explicit SSH tunnel whose Shape endpoint is loopback. Shape does not claim native TLS
termination; use a trusted TLS reverse proxy or the loopback tunnel. Tokens are not placed in
logged commands or prose. Saved CLI credentials remain in `~/.shape/servers.json` with private
permissions; browser credentials remain bound to their selected server.

## Mapping is a transaction

`shape map prepare [branch] --repo <path>` resolves the named local branch to an exact commit;
it does not switch the checkout or implicitly substitute the current branch. It materializes
an immutable owned snapshot under Shape's home, derives the mechanical reality layer there,
and reads the current server state. The preparation records:

- a preparation ID and snapshot path;
- canonical repository identity and branch;
- the pinned destination commit and, when usable, the prior mapped commit;
- the current effective revision and committed map document;
- changed paths, a commit-to-commit diff, and extracted reality; and
- the selected `initial`, `incremental`, or `full` mode.

The model then reads that frozen snapshot and existing committed document and chooses honest,
code-reference-aware semantic operations. An initial or full mapping describes the repository
from the snapshot rather than manufacturing generic summaries. An incremental mapping updates
stable entities and removes entities made obsolete by the diff. A legitimate no-diff path
needs neither a fake operation nor a claim that Shape wrote a new checkpoint.

For an exact incremental no-diff, an empty operation batch is normal and returns
`committed: false`. An initial or full empty batch is valid only for a genuinely empty mapping
or an explicit, evidence-backed clear; it is never a shortcut for mapping a nonempty
repository.

`shape map finish <preparation-id> --ops <json-file>` is the commit point. Before sending, the
local map client revalidates the pinned local branch tip and snapshot. The remote server does
not interpret or validate a local repository path; it checks the expected effective revision,
prior checkpoint, and entire semantic operation batch. A stale revision/checkpoint or invalid
operation rejects the whole batch without advancing the checkpoint. An accepted batch
atomically stores the committed document, checkpoint, visible graph, reality, and revision.

A transport error or missing acknowledgement after the request was sent is ambiguous: the
server may already have accepted and committed it. Do not blindly retry or report the
repository as mapped or unmapped. Run a fresh prepare, which reads current map state, and
reconcile the returned mapped commit and effective revision before retrying or reporting
success. Preparation and an unconfirmed client outcome are never proof of a new map.

A cleanup failure after the client has confirmed a commit or legitimate no-diff result is not
ambiguous. Finish returns the confirmed receipt with `cleanupPending: true`, `preparationId`,
and `cleanupError`; the reported checkpoint is confirmed. Run `shape map abort
<preparation-id>` to retry cleanup only. Abort discards Shape's owned preparation resources
and never rolls back a server commit. It is also appropriate for an unsent or abandoned
preparation; ordinary successful finish cleans the resources itself.

## Incremental versus full

The first map for a repository branch is `initial`. A later map is `incremental` only when the
stored mapped commit exists locally and is an ancestor of the requested branch tip, allowing
Shape to pin an exact commit delta. Missing commits or checkpoints, divergent/rebased history,
or otherwise unverifiable ancestry selects `full`. Full mapping starts the semantic document
from empty while still preserving the repository/branch history in Shape's store; it does not
pretend an unsafe delta is incremental.

Reality extraction is mechanical evidence. The model-owned semantic operations express what
the product and its components mean. Drift compares those claims to reality. These layers are
related but not interchangeable: installing the skill, extracting reality, or preparing a
snapshot does not itself create a semantic map.

## Committed baseline and live overlay

Persistent canvas identity is **repository plus branch**, not a checkout or worktree path. Each
branch has a committed mapped document and exact mapped-commit checkpoint. That pair is the
trusted baseline produced only by a successful map finish.

Live events produce the effective graph shown on the canvas. Their semantic operations and
activity form an uncommitted overlay over the branch's mapped baseline and advance the
effective revision, but they never rewrite the committed document or mapped checkpoint. Map
prepare reads the committed baseline while also pinning the current effective revision; if a
live update lands before finish, optimistic concurrency makes the prepared map stale instead
of silently overwriting the new work.

The browser's branch selector is backed by these durable repository/branch records, even when
no agent is connected. It identifies the default branch, mapped commit, current head when
known, and whether live uncommitted state is present. A physical worktree remains useful for
agent routing, but it is not the map's storage identity.

## Explicit live reporting

The live skill joins an already-running harness session:

1. `shape live start` resolves the current repository and attached branch, persists a pending
   session handle under Shape's home, and sends an explicit start event. Success returns that
   handle plus the canvas URL. If acknowledgement is ambiguous, the handle and session are
   retained so the caller can recover with a matching stop instead of inventing a new session.
2. `shape live emit --session <handle>` sends meaningful work/idle state, notes, tools, files,
   and optional atomic canvas operations as the work happens.
3. `shape live stop --session <handle>` sends the matching stop event. A confirmed stop records
   a stopped tombstone under Shape's home rather than deleting the handle. A repeat stop is
   reported as already stopped only for a known, confirmed tombstone; an unknown handle is an
   error.

Handles and tombstones live under Shape's home, never in the target repository. Detached
`HEAD` is rejected with guidance to select a branch, and live reporting requires that branch
to have a committed map. Live operations are honest source-origin events; the skill does not
fabricate model output or synthetic native harness events.

An installed skill cannot retrofit hooks or an extension into a harness process that is
already running. Native OMP or Claude activity integration may be reused when that integration
was already loaded, but the portable workflow is the explicit start/emit/stop protocol above.

## Browser boundary

The canvas reads the committed baseline, the live effective overlay, reality, drift, revisions,
and session activity. It can select branches and retain the project registry's active/inactive
state. Mapping and live writes arrive through authenticated control clients and harness
skills—not browser graph editing. The browser never receives credentials for a repository
host, never treats a displayed repository path as server filesystem authority, and never
launches, prompts, types into, or sends work to a coding session.
