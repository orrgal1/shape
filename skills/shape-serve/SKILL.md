---
name: shape-serve
description: "Discover, connect to, or safely start a Shape canvas server when the user asks to serve Shape, open its canvas, connect to an existing Shape deployment, or set up a local or remote Shape server."
---

# Shape serve

Discover before changing anything, let the user choose, then prove both the HTTP health endpoint and authenticated control channel work. Never scan the network, guess a server, silently start one, or detach a daemon.

## Invocation rule

Run Shape through a structured argv/process API, not a shell-built command. In every Shape invocation below, use:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"serve","<subcommand>"]}
```

`__SHAPE_DISPATCHER_JSON__` is installed as the JSON string for the absolute `scripts/shape.mjs` entrypoint. Keep it as one argv element. Append each option and value as separate elements; never concatenate commands or expose a token in logs, a URL, or prose. The Shape checkout is the parent of the entrypoint's `scripts` directory, independent of the user's current working directory.

## 1. Discover first

Ask for any server origins the user already knows. Probe only those explicit origins plus Shape's saved, configured, and loopback defaults:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"serve","discover","--server","https://shape.example.test"]}
```

`--server <origin>` is repeatable. Do not use a port scanner, subnet scan, `nc`, or an unbounded address list. Discovery is read-only: it must not select, save, connect to, or start a server.

Parse the JSON object `{command,candidates}`. Each candidate has `server`, `sources`, and exactly one status:

- `reachable`: verified Shape health is available; it may be offered for connection.
- `auth-required`: it is Shape but needs a token; offer it and ask for the token privately.
- `wrong-service`: do not connect; explain that the origin is not a Shape service.
- `unreachable`: report it as unavailable and retain its `message` as diagnostic evidence.

Show the discovered choices before offering **connect to this server** versus **start a new server**. Never auto-connect to a merely open port or silently replace an unreachable server.

## 2. Collect the deployment choices

Before starting anything, ask and retain:

1. local machine or a named remote host;
2. host/bind policy and port;
3. persistent data directory;
4. authentication policy and token-file location;
5. web asset directory if it is not the checkout's `packages/web/dist`.

Defaults may be proposed, but do not invent remote credentials, storage paths, or public exposure. A non-loopback server requires authentication. Shape does not provide native TLS: a remote token may be sent only over HTTPS supplied by a reverse proxy, or over an SSH tunnel to a loopback-bound server. Plain remote HTTP with a token is invalid and must not be bypassed.

## 3A. Connect to an existing server

Invoke with separate argv elements:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"serve","connect","https://shape.example.test","--token","<private-token>"]}
```

Omit `--token` when not required. The command must verify both `GET/HEAD /api/health` as the Shape protocol and an authenticated `/control` WebSocket before saving the selection. Success is only a JSON receipt with `command`, normalized `server`, token-free `canvasUrl`, and `saved:true`. This saves CLI connection/auth state only; it does **not** provision a fresh browser with the token.

Recovery:

- `auth-required`: obtain a valid token privately and retry the CLI connection; never print it, put it in a URL, or expose it in chat/tool logs. Browser authentication is entered directly in the canvas form below.
- `unreachable`: check the exact URL, supervised process, reverse proxy, or SSH tunnel, then rediscover.
- `wrong-service`: choose the actual Shape origin; do not force-save it.
- TLS/tunnel rejection: use HTTPS or create a loopback SSH tunnel, then connect to its local endpoint.

## 3B. Start a local server

Derive the Shape checkout from the installed entrypoint. Before launch, verify Node is at least 26, pnpm is 11, runtime dependencies are installed, and the chosen web directory contains a current `index.html`. If dependencies or assets are missing or stale, run these from the Shape checkout with structured argv:

```text
corepack pnpm install
corepack pnpm --filter @shape/web build
```

Do not rebuild when the prerequisites and production assets are already current.

Start the server as a harness-supervised **foreground** process. For OMP, use its process supervisor with `application:"node"`, a stable descriptive process name, and argv shaped like:

```json
{"application":"node","args":[__SHAPE_DISPATCHER_JSON__,"serve","start","--host","127.0.0.1","--port","4400","--data-dir","<chosen-data-dir>","--token-file","<chosen-token-file>","--web-dir","<shape-checkout>/packages/web/dist"]}
```

Include only options the user selected. Do not append `&`, use `nohup`, request daemon mode, or treat process creation as readiness. Watch the supervised output for the startup JSON `{command,server,canvasUrl,dataDir,authenticated}`; the process then intentionally remains in the foreground. A start error is nonzero: inspect its sanitized error, correct prerequisites/options/port permissions, and restart through the supervisor rather than spawning a second copy.

After the startup receipt, run `serve connect <server>` with the chosen token when applicable. This independent check proves health and control authentication and saves the CLI connection; then complete the separate clean browser connection/form verification below.

## 3C. Start or connect on a remote host

Use the harness's SSH and remote process-supervision tools, never an interpolated local shell command. Confirm the remote absolute Shape checkout and entrypoint, Node >=26, pnpm 11, installed dependencies, and built `packages/web/dist/index.html`; install/build there with the same repo-grounded commands only when needed.

Choose one safe boundary:

- bind Shape to remote loopback, keep it foreground under remote supervision, and create a supervised SSH local-forward; then discover/connect to the local tunnel endpoint; or
- bind as explicitly requested behind an existing HTTPS reverse proxy, with authentication enabled, then discover/connect to the HTTPS origin.

Pass the remote entrypoint, options, paths, and token-file as separate SSH/process argv values. Do not assume the local checkout path exists remotely. Do not claim Shape terminates TLS. Do not launch a detached SSH daemon or leave an untracked tunnel.

## 4. Open and verify the browser

After any successful `serve connect`, always navigate the browser to the returned clean, token-free `canvasUrl`. The CLI's saved credentials are CLI-only and do not provision browser storage.

Observe the canvas connection state. If browser authentication is required or `/ws` cannot authenticate, the canvas displays its access-token form. Have the user enter the token directly and securely in that browser form; never ask them to paste it into chat, put it in a query/fragment, or pass it through command/tool output. Do not synthesize a credential-bearing URL or script token injection. The form stores the browser credential through Shape's origin-bound auth path.

Success requires the token form to clear and the browser's `/ws` connection to reach the connected state. A loaded HTML shell or successful CLI `/control` connection alone is insufficient. If the form remains or authentication fails, correct the token directly in the form. If WebSocket reachability still fails, check the same-origin proxy, HTTPS/WSS boundary, or active SSH tunnel without exposing credentials.

## Required success evidence

Do not report success until all are true:

1. discovery output was shown and the selected action came from the user's choice;
2. a started process is still supervised, or the selected existing service remains reachable;
3. `serve connect` returned `saved:true` after checking Shape health and authenticated control;
4. the browser opened the clean canvas URL; when auth was required, the user entered it directly in the browser form, the form cleared, and `/ws` connected;
5. the returned `server` is the intended origin and the reported `canvasUrl` contains no credential;
6. for remote use, HTTPS or an active supervised loopback SSH tunnel protects credentials.

Return only the exact clean token-free `canvasUrl`, whether the service is local or remote, the supervised process/tunnel names if created, and a short statement of verified HTTP health, control authentication, and browser WebSocket evidence. Never expose the token or construct a credential-bearing URL.