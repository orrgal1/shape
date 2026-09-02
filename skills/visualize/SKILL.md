---
name: visualize
description: Onboard any existing repo onto the Shape canvas — bridge + web started (or reused), bridge targeted at the repo, canvas open, onboarding survey triggered. Use when the user says "onboard this repo to Shape", "open the Shape canvas for this project", "map this project visually", or otherwise wants this project shown on the Shape bubble canvas.
---

# Shape — onboard this repo

Gets the current repo onto the Shape canvas: ensure the bridge and web
dev server are running, point the bridge at this repo, trigger the onboarding
survey, and hand the user the canvas URL.

```bash
# This skill ships inside the Shape repo (at skills/visualize/), so the
# checkout is this skill directory's own repo root. Works through the installed
# symlink too — chdir resolves it to the real directory:
HARNESS=$(git -C "$(dirname "<absolute path of this SKILL.md>")" rev-parse --show-toplevel)
```

## Install (once per machine)

From the Shape checkout:

```bash
ln -s "$PWD/skills/visualize" ~/.claude/skills/
```

## Steps

1. **Resolve the target repo:**
   ```bash
   target=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
   ```

2. **Bridge (WebSocket, port 4400).** Check: `nc -z 127.0.0.1 4400`.
   - **Not running** → start it as a managed background process with the hub tool:
     ```
     hub op:"start" name:"shape-bridge" application:"pnpm"
         args:["bridge", "--", "--cwd", "<target>"]
         cwd:"$HARNESS" ready:{port: 4400}
     ```
   - **Already running** → retarget it at this repo:
     ```bash
     node "$HARNESS/packages/bridge/scripts/ctl.mjs" switch-project "$target"
     ```
     Prints one JSON line `{"ok":true,"cwd":...}` on success. Exit code 2 means
     the bridge died since the port check — start it as above instead.

3. **Web (Vite, port 5173, strict).** Check:
   `curl -s -o /dev/null http://localhost:5173/` (NOT `nc -z 127.0.0.1` — vite
   may bind `::1` only, so IPv4 probes false-negative).
   Not running → hub-start it with log-based readiness (a `ready:{port: 5173}`
   probe would time out for the same reason):
   ```
   hub op:"start" name:"shape-web" application:"pnpm" args:["web"]
       cwd:"$HARNESS" ready:{log: "Local:.*5173"}
   ```

4. **Onboarding survey.** Skip this step if the repo is already mapped —
   `.shape/graph.json` exists in the target with a non-empty `nodes`
   array (`jq -e '.nodes | length > 0' "$target/.shape/graph.json"`);
   then retargeting (step 2) is enough. Otherwise trigger the survey:
   ```bash
   node "$HARNESS/packages/bridge/scripts/ctl.mjs" onboard
   ```
   If the user named what they care about ("map the auth flow"), pass it along:
   `... onboard --focus "the auth flow"`.

5. **Tell the user** the canvas is live at **http://localhost:5173** and that
   the survey will stream in — the canvas fills with a mechanical package
   skeleton first, then the agent survey enriches the bubbles.

## Notes

- **Non-TS / non-pnpm repos:** the mechanical skeleton is empty, so onboarding
  degrades to a pure agent survey (still anchored by codeRefs validation).
  Expected behavior, not a failure.
- Bridge and web are shared singletons — one bridge serves one target at a
  time; switching projects for repo B moves the canvas off repo A.
- Do not run the bridge or web in the foreground with bash; they are
  long-running services and MUST be hub-managed (`shape-bridge`, `shape-web`).
