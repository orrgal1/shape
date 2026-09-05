---
name: visualize
description: Put any existing repo on the Shape canvas — bridge + web started (or reused), bridge targeted at the repo, canvas open and mapping itself. Use when the user says "onboard this repo to Shape", "open the Shape canvas for this project", "map this project visually", or otherwise wants this project shown on the Shape bubble canvas.
---

# Shape — put this repo on the canvas

Gets the current repo onto the Shape canvas: ensure the bridge and web dev server are running,
point the bridge at this repo, and hand the user the canvas URL. The map then seeds itself —
Shape reads the checkout and, on a canvas with no bubbles, draws one bubble per workspace
package with the imports between them. There is nothing to trigger and nothing to type at:
Shape shows the project, and agents are directed in the terminal.

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

4. **Tell the user** the canvas is live at **http://localhost:5173**, and what they will see:
   the mechanical package skeleton appears by itself within a second or two of the retarget,
   and the bubbles gain their promises as an agent works in the repo and keeps the picture
   current through the `canvas` tool. To check what the bridge thinks is on the canvas:
   `node "$HARNESS/packages/bridge/scripts/ctl.mjs" status` (its `nodes` count is 0 on a canvas
   nothing has drawn yet).

## Notes

- **Nothing on the canvas reaches an agent.** Shape is a picture: it starts no session, and the
  browser can neither instruct nor interrupt one. If the user wants work done on this repo,
  that happens in their terminal — or through the manager skill, whose builders report in to
  Shape on their own.
- **Non-TS / non-pnpm repos:** the mechanical skeleton is empty, so the canvas starts blank and
  stays blank until an agent working in the repo draws it. Expected behavior, not a failure.
- Bridge and web are shared singletons — one bridge serves one target at a
  time; switching projects for repo B moves the canvas off repo A.
- Do not run the bridge or web in the foreground with bash; they are
  long-running services and MUST be hub-managed (`shape-bridge`, `shape-web`).
