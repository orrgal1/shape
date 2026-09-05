#!/usr/bin/env node
/**
 * Protocol stub standing in for the herdr server in bridge smoke tests: a unix
 * socket speaking newline-delimited JSON, the subset of the herdr API the Shape
 * launcher uses. Plain Node, no deps.
 *
 * Requests are `{ id, method, params }`, answers are `{ id, result }` or
 * `{ id, error: { code, message } }`. Connection lifetimes are the real
 * server's, which is the point of this stub: a plain request is answered with
 * ONE line and then the connection is CLOSED, while an `events.subscribe`
 * connection is answered `{ type: "subscription_started" }` and then stays
 * open, carrying unsolicited `{ event, data }` envelopes.
 *
 * What it really does, and does not:
 *   `workspace.list`    every workspace it holds, each with `worktree: null`:
 *                  a plain workspace, which is what the user's really are.
 *   `workspace.create`  a workspace that is already usable — the answer
 *                  carries its first `tab` and `root_pane`, as the real one's
 *                  `workspace_created` does.
 *   `tab.create`   invents a tab and a root pane in the named `workspace_id`
 *                  (an unknown one is refused `workspace_not_found`, the way
 *                  a workspace the user just closed would be; naming none
 *                  means the focused workspace) and REMEMBERS the
 *                  cwd/label/env. It spawns no terminal: nothing to render.
 *   `tab.rename`   relabels a tab: how a project's first session claims the
 *                  root tab that came with its brand-new workspace.
 *   `workspace.close`   throws a workspace away with every tab and harness in
 *                  it, the way a user closing one does: what a launcher
 *                  holding that workspace's id has to survive.
 *   `agent.start`  spawns `node scripts/fake-omp-tui.mjs` in the tab's cwd with
 *                  the tab's env plus the call's `args`, and waits for the fake
 *                  to say it is ready — so the agent under test sees a real
 *                  session appear on its loopback link. A tab with NO
 *                  `SHAPE_LINK` in its env instead gets a process that only
 *                  occupies the pane: a live agent herdr can see and Shape's
 *                  link never hears from, which is what the user's own
 *                  sessions (their manager tab above all) look like.
 *   `agent.prompt` types the text into that child (`{"type":"typed",…}` on its
 *                  stdin), the way herdr submits into a pane.
 *   `agent.list`   every pane with a live harness in it, with the cwd it runs
 *                  in: the whole of what Shape's discovery scan can see of
 *                  this machine, and how it finds a session it did not start —
 *                  to name the repo as a project, to focus its terminal, and
 *                  to recognize the manager's tab.
 *   `tab.list`     one workspace's tabs by the label a human reads.
 *   `agent.focus`, `tab.focus`  recorded, nothing to focus.
 *   `tab.close`    terminates the child (which says `bye` on its way out).
 *   `events.subscribe`  streams `pane.exited` globally and
 *                  `pane.agent_status_changed` (from the child's own status
 *                  lines) to whoever subscribed THAT pane — subscribing it
 *                  without a `pane_id` is refused `invalid_request`, the way
 *                  herdr's own subscription schema refuses it.
 *   `session.snapshot`  protocol 19 and whatever workspaces exist. The fake
 *                  starts with ONE that belongs to no project ("scratch", in
 *                  tmpdir), so a test can tell reuse from creation.
 *
 * Environment:
 *   HERDR_SOCKET_PATH  socket to listen on; default <tmpdir>/fake-herdr.sock
 *   FAKE_HERDR_LOG     JSONL log of every call and its answer, every event
 *                      and the lifecycle markers;
 *                      default <cwd>/fake-herdr.log
 * stdout: one line `{ "type": "ready", "pid", "socket" }` once listening.
 */

import { spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_OMP_TUI = join(HERE, "fake-omp-tui.mjs");
const SOCKET = process.env.HERDR_SOCKET_PATH ?? join(tmpdir(), "fake-herdr.sock");
const LOG = process.env.FAKE_HERDR_LOG ?? join(process.cwd(), "fake-herdr.log");
const PROTOCOL = 19;
const VERSION = "0.8.0-fake";
/** herdr's own default readiness wait for `agent.start` */
const START_TIMEOUT_MS = 30_000;

function record(entry) {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

let seq = 0;
let stateChangeSeq = 0;
/** every connection ever accepted, so a log line says which one a call came on */
let connections = 0;
/** tab id -> the pane, cwd, env and child that tab is standing for */
const tabs = new Map();
/** every connection that asked for events, with the subscriptions it asked for */
const subscribers = new Set();

/** workspace id -> its label, cwd, number and the tabs it has handed out */
const workspaces = new Map();
let workspaceSeq = 0;

/**
 * A workspace, the way `workspace.create` makes one. Every workspace here is
 * a PLAIN one (`worktree: null`) because the user's real ones are: a launcher
 * has to find a project's workspace by the id it kept or by the label it
 * gave, not by hoping herdr recognized a checkout.
 */
function addWorkspace(label, cwd, focused) {
  const id = `w${String(++workspaceSeq)}`;
  const workspace = { id, label, cwd, number: workspaceSeq, focused, tabSeq: 0 };
  workspaces.set(id, workspace);
  return workspace;
}

/** A tab and its root pane inside a workspace: `<ws>:t<n>` / `<ws>:p<n>`. */
function addTab(workspace, params) {
  const n = String(++workspace.tabSeq);
  const tab = {
    tabId: `${workspace.id}:t${n}`,
    paneId: `${workspace.id}:p${n}`,
    workspaceId: workspace.id,
    cwd: String(params.cwd ?? workspace.cwd),
    label: String(params.label ?? `${workspace.id}:t${n}`),
    env: params.env ?? {},
    focused: params.focus === true,
    agent: null,
    child: null,
  };
  tabs.set(tab.tabId, tab);
  return tab;
}

/** herdr's `WorkspaceInfo`, as `workspace.list` and the snapshot return it */
function workspaceInfo(workspace) {
  const own = [...tabs.values()].filter((tab) => tab.workspaceId === workspace.id);
  return {
    workspace_id: workspace.id,
    label: workspace.label,
    number: workspace.number,
    focused: workspace.focused,
    tab_count: own.length,
    pane_count: own.length,
    agent_status: own.find((tab) => tab.agent !== null)?.agent.status ?? "unknown",
    active_tab_id: own.find((tab) => tab.focused)?.tabId ?? own[0]?.tabId ?? null,
    tokens: 0,
    worktree: null,
  };
}

/** herdr's `TabInfo`: what a tab looks like in an answer or the snapshot */
const tabInfo = (tab) => ({
  tab_id: tab.tabId,
  workspace_id: tab.workspaceId,
  label: tab.label,
  agent_status: tab.agent?.status ?? "unknown",
  focused: tab.focused,
  pane_count: 1,
});

/** Focusing a tab focuses the workspace holding it, as the real server does. */
function focusTab(tab) {
  for (const other of tabs.values()) other.focused = other === tab;
  for (const workspace of workspaces.values()) workspace.focused = workspace.id === tab.workspaceId;
}

// The workspace the fake starts with, belonging to no project: whatever the
// user happened to have open. A launcher that drops its tabs into the focused
// workspace instead of making the project one of its own lands them in HERE,
// and the smoke test can say so.
addWorkspace("scratch", tmpdir(), true);

function tabOfPane(paneId) {
  for (const tab of tabs.values()) {
    if (tab.paneId === paneId) return tab;
  }
  return null;
}

/** herdr targets an agent by its (live, unique) name or by the pane hosting it */
function agentTarget(target) {
  for (const tab of tabs.values()) {
    if (tab.agent !== null && (tab.agent.name === target || tab.paneId === target)) return tab;
  }
  return null;
}

/** the agent record shape `agent.get`/`agent.list`/the snapshot all return */
function agentRecord(tab) {
  const agent = tab.agent;
  return {
    agent: agent === null ? null : agent.kind,
    agent_session:
      agent === null || agent.sessionFile === null
        ? null
        : { agent: agent.kind, kind: "path", source: `herdr:${agent.kind}`, value: agent.sessionFile },
    agent_status: agent === null ? "unknown" : agent.status,
    cwd: tab.cwd,
    focused: tab.focused,
    foreground_cwd: tab.cwd,
    pane_id: tab.paneId,
    revision: ++seq,
    screen_detection_skipped: true,
    state_change_seq: stateChangeSeq,
    tab_id: tab.tabId,
    terminal_id: `term_fake_${tab.tabId.replace(":", "_")}`,
    terminal_title: agent === null ? tab.label : `${agent.kind} > ${tab.label}`,
    terminal_title_stripped: agent === null ? tab.label : `${agent.kind} > ${tab.label}`,
    workspace_id: tab.workspaceId,
  };
}

/**
 * Push an event to every connection that subscribed it, and log WHICH
 * connections it went to: an event with nobody listening for it is exactly
 * the bug a per-pane subscription can have.
 */
function emit(name, data) {
  const line = `${JSON.stringify({ event: name, data })}\n`;
  const to = [];
  for (const sub of subscribers) {
    if (sub.socket.destroyed) continue;
    // a subscription is a type plus, for the per-pane events, the pane it is
    // about: `pane.agent_status_changed` is subscribed one pane at a time
    const wanted = sub.wants.some(
      (want) => want.type === name && (want.pane_id === undefined || want.pane_id === data.pane_id),
    );
    if (!wanted) continue;
    sub.socket.write(line);
    to.push(sub.conn);
  }
  record({ type: "__event", event: name, data, to });
}

function statusChanged(tab, status) {
  const agent = tab.agent;
  if (agent === null) return;
  agent.status = status;
  stateChangeSeq += 1;
  emit("pane.agent_status_changed", {
    agent: agent.name,
    agent_status: status,
    display_agent: agent.kind,
    pane_id: tab.paneId,
    state_labels: {},
    title: `${agent.kind} > ${tab.label}`,
    workspace_id: tab.workspaceId,
  });
}

/**
 * Start whatever stands in for a harness in this tab's pane, and wait for it
 * to be up.
 *
 * A tab carrying `SHAPE_LINK` gets the omp stub: a session that reports in on
 * Shape's loopback link, which is what a builder launched into a tab is. The
 * real server waits for its detector to recognize the agent; here the child
 * says so itself on stdout, which is also where its session file comes from.
 *
 * A tab WITHOUT a link gets a process that only occupies the pane. herdr
 * lists it as a live agent all the same, and Shape's link never hears a word
 * from it — which is what the user's own sessions look like, the manager tab
 * they opened by hand above all. Shape has to find those in herdr or not at
 * all, so there is nothing to wait for: the pane is taken the moment the
 * child is spawned.
 */
function startAgent(tab, name, kind, args, timeoutMs) {
  const linked = typeof tab.env.SHAPE_LINK === "string" && tab.env.SHAPE_LINK.length > 0;
  const child = spawn(process.execPath, linked ? [FAKE_OMP_TUI, ...args] : ["-e", "process.stdin.resume()"], {
    cwd: tab.cwd,
    env: { ...process.env, ...tab.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  tab.child = child;
  tab.agent = { name, kind, status: "working", sessionFile: null, pid: child.pid };

  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error("agent_start_timeout")), timeoutMs);
  // nothing to wait for: an unlinked pane is taken as soon as it has a child
  if (!linked) {
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
  }
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.length === 0) continue;
      let said;
      try {
        said = JSON.parse(line);
      } catch {
        continue;
      }
      record({ type: "__child", pane: tab.paneId, said });
      if (said.type === "ready" && tab.agent !== null) {
        tab.agent.sessionFile = said.sessionFile ?? null;
        clearTimeout(timer);
        resolve();
      }
      if (said.type === "status") statusChanged(tab, said.status === "working" ? "working" : "idle");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => record({ type: "__child_stderr", pane: tab.paneId, text: String(chunk) }));
  child.on("exit", (code) => {
    clearTimeout(timer);
    tab.child = null;
    tab.agent = null;
    emit("pane.exited", { pane_id: tab.paneId, workspace_id: tab.workspaceId, tab_id: tab.tabId, exit_code: code });
    reject(new Error("agent_exited"));
  });
  return promise;
}

async function dispatch(method, params) {
  switch (method) {
    case "session.snapshot":
      return {
        // the real server tags its results; the launcher reads the snapshot
        type: "session_snapshot",
        snapshot: {
          version: VERSION,
          protocol: PROTOCOL,
          focused_workspace_id: [...workspaces.values()].find((workspace) => workspace.focused)?.id ?? null,
          focused_tab_id: [...tabs.values()].find((tab) => tab.focused)?.tabId ?? null,
          focused_pane_id: [...tabs.values()].find((tab) => tab.focused)?.paneId ?? null,
          workspaces: [...workspaces.values()].map(workspaceInfo),
          tabs: [...tabs.values()].map(tabInfo),
          panes: [...tabs.values()].map(agentRecord),
          agents: [...tabs.values()].filter((tab) => tab.agent !== null).map(agentRecord),
          layouts: [],
        },
      };
    case "workspace.list":
      return { type: "workspace_list", workspaces: [...workspaces.values()].map(workspaceInfo) };
    case "workspace.create": {
      const workspace = addWorkspace(
        String(params.label ?? `workspace ${String(workspaceSeq + 1)}`),
        String(params.cwd ?? process.cwd()),
        params.focus === true,
      );
      // the real server answers with a workspace that is already usable: its
      // first tab and that tab's root pane come with it, so a caller can
      // `agent.start` in the pane without creating anything more
      const tab = addTab(workspace, { cwd: workspace.cwd, label: workspace.label, env: params.env, focus: params.focus });
      return {
        type: "workspace_created",
        workspace: workspaceInfo(workspace),
        tab: tabInfo(tab),
        root_pane: { pane_id: tab.paneId, workspace_id: workspace.id, tab_id: tab.tabId, cwd: tab.cwd, focused: tab.focused },
      };
    }
    case "tab.create": {
      const asked = params.workspace_id;
      // a named workspace that is gone is the case a launcher has to survive:
      // the user closed it between listing the workspaces and this call
      const workspace =
        typeof asked === "string" && asked.length > 0
          ? workspaces.get(asked)
          : ([...workspaces.values()].find((candidate) => candidate.focused) ?? [...workspaces.values()][0]);
      if (workspace === undefined) {
        throw Object.assign(new Error(`no such workspace: ${String(asked)}`), { code: "workspace_not_found" });
      }
      const tab = addTab(workspace, params);
      return {
        tab: tabInfo(tab),
        root_pane: { pane_id: tab.paneId, workspace_id: workspace.id, tab_id: tab.tabId, cwd: tab.cwd, focused: tab.focused },
      };
    }
    case "tab.rename": {
      const tab = tabs.get(String(params.tab_id ?? ""));
      if (tab === undefined) throw Object.assign(new Error(`no such tab: ${String(params.tab_id)}`), { code: "tab_not_found" });
      tab.label = String(params.label ?? tab.label);
      return { renamed: true, tab: tabInfo(tab) };
    }
    case "agent.start": {
      // herdr's `AgentStartParams`: `pane_id` is required, `timeout_ms` optional —
      // refused exactly the way herdr's schema refuses a request without it
      if (typeof params.pane_id !== "string") {
        throw Object.assign(new Error("invalid request: missing field `pane_id`"), { code: "invalid_request" });
      }
      const tab = tabOfPane(params.pane_id);
      if (tab === null) throw Object.assign(new Error(`no such pane: ${params.pane_id}`), { code: "pane_not_found" });
      if (tab.agent !== null) throw Object.assign(new Error("pane already hosts an agent"), { code: "pane_busy" });
      const name = String(params.name ?? "agent");
      if (agentTarget(name) !== null) throw Object.assign(new Error(`agent name in use: ${name}`), { code: "agent_name_in_use" });
      const args = Array.isArray(params.args) ? params.args.map(String) : [];
      const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : START_TIMEOUT_MS;
      try {
        await startAgent(tab, name, String(params.kind ?? "omp"), args, timeoutMs);
      } catch (err) {
        tab.child?.kill("SIGKILL");
        tab.child = null;
        tab.agent = null;
        throw Object.assign(new Error(err.message), { code: err.message });
      }
      statusChanged(tab, "idle");
      return { agent: agentRecord(tab) };
    }
    case "agent.get": {
      // what the launcher reads before its first utterance: this fake's agents
      // are ready the moment `agent.start` answers, so it never says pending
      const tab = agentTarget(String(params.target ?? ""));
      if (tab === null || tab.child === null) {
        throw Object.assign(new Error(`no such agent: ${String(params.target)}`), { code: "agent_not_found" });
      }
      return { agent: agentRecord(tab) };
    }
    case "agent.prompt": {
      const tab = agentTarget(String(params.target ?? ""));
      if (tab === null || tab.child === null) {
        throw Object.assign(new Error(`no such agent: ${String(params.target)}`), { code: "agent_not_found" });
      }
      // atomically submitted with its enter, the way herdr writes into a pane
      tab.child.stdin.write(`${JSON.stringify({ type: "typed", text: String(params.text ?? "") })}\n`);
      statusChanged(tab, "working");
      return { submitted: true, agent: agentRecord(tab) };
    }
    case "agent.list": {
      // global by protocol: every pane with a live harness in it, whoever
      // started it. The cwd is what Shape matches a session on, so it is the
      // tab's, spelled the way the tab was created.
      const live = [...tabs.values()].filter((tab) => tab.agent !== null && tab.child !== null);
      return {
        type: "agent_list",
        agents: live.map((tab) => ({
          pane_id: tab.paneId,
          tab_id: tab.tabId,
          workspace_id: tab.workspaceId,
          name: tab.agent.name,
          cwd: tab.cwd,
          status: tab.agent.status,
        })),
      };
    }
    case "tab.list": {
      // one workspace's tabs, or all of them when no workspace is named
      const asked = params.workspace_id;
      const wanted =
        typeof asked === "string" && asked.length > 0 ? [...tabs.values()].filter((tab) => tab.workspaceId === asked) : [...tabs.values()];
      return { type: "tab_list", tabs: wanted.map((tab) => ({ tab_id: tab.tabId, label: tab.label, workspace_id: tab.workspaceId })) };
    }
    case "agent.focus": {
      const tab = agentTarget(String(params.target ?? ""));
      if (tab === null) throw Object.assign(new Error(`no such agent: ${String(params.target)}`), { code: "agent_not_found" });
      focusTab(tab);
      return { focused: true, agent: agentRecord(tab) };
    }
    case "tab.focus": {
      const tab = tabs.get(String(params.tab_id ?? ""));
      if (tab === undefined) throw Object.assign(new Error(`no such tab: ${String(params.tab_id)}`), { code: "tab_not_found" });
      focusTab(tab);
      return { focused: true, tab_id: tab.tabId };
    }
    case "tab.close": {
      const tab = tabs.get(String(params.tab_id ?? ""));
      if (tab === undefined) throw Object.assign(new Error(`no such tab: ${String(params.tab_id)}`), { code: "tab_not_found" });
      tab.child?.kill("SIGTERM");
      tabs.delete(tab.tabId);
      return { closed: true, tab_id: tab.tabId };
    }
    case "workspace.close": {
      // the user throwing away a whole workspace, tabs and harnesses with it:
      // the case a launcher holding that workspace's id has to survive
      const workspace = workspaces.get(String(params.workspace_id ?? ""));
      if (workspace === undefined) {
        throw Object.assign(new Error(`no such workspace: ${String(params.workspace_id)}`), { code: "workspace_not_found" });
      }
      for (const tab of [...tabs.values()]) {
        if (tab.workspaceId !== workspace.id) continue;
        tab.child?.kill("SIGTERM");
        tabs.delete(tab.tabId);
      }
      workspaces.delete(workspace.id);
      return { closed: true, workspace_id: workspace.id };
    }
    default:
      throw Object.assign(new Error(`unknown method: ${method}`), { code: "unknown_method" });
  }
}

/**
 * The accept loop, and the two connection lifetimes the real server has: a
 * plain request is answered with ONE line and then the connection is CLOSED
 * (herdr 0.8.0 hangs up per request), while an `events.subscribe` connection
 * is answered `{type:"subscription_started"}` and then stays open, streaming
 * everything it asked for.
 */
const server = createServer((socket) => {
  const conn = ++connections;
  const sub = { socket, conn, wants: [] };
  let buf = "";
  let answered = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.length === 0) continue;
      // one exchange per connection: anything after the answer is not ours
      if (answered) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        answered = true;
        socket.end(`${JSON.stringify({ id: "", error: { code: "invalid_json", message: "not JSON" } })}\n`);
        continue;
      }
      const { id = null, method = "", params = {} } = request;
      record({ type: "__call", conn, id, method, params });
      // subscribing is what turns a connection into a stream: it is answered
      // once, and then everything it asked for arrives unsolicited
      if (method === "events.subscribe") {
        const asked = Array.isArray(params.subscriptions) ? params.subscriptions : [];
        const wants = asked.map((item) => (typeof item === "string" ? { type: item } : { ...item, type: String(item.type) }));
        // the schema's own rule: per-pane events are not subscribable globally
        const unscoped = wants.find((want) => want.type === "pane.agent_status_changed" && typeof want.pane_id !== "string");
        if (unscoped !== undefined) {
          answered = true;
          const error = { code: "invalid_request", message: "invalid request: missing field `pane_id`" };
          record({ type: "__error", id, method, error });
          socket.end(`${JSON.stringify({ id: "", error })}\n`);
          continue;
        }
        sub.wants = wants;
        subscribers.add(sub);
        socket.write(`${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`);
        continue;
      }
      answered = true;
      dispatch(method, params ?? {}).then(
        (result) => {
          // the answer, not only the question: a test that has to know WHICH
          // workspace or tab herdr handed out reads it here rather than
          // guessing at the id scheme
          record({ type: "__answer", id, method, result });
          if (!socket.destroyed) socket.end(`${JSON.stringify({ id, result })}\n`);
        },
        (err) => {
          const error = { code: err.code ?? "internal_error", message: err.message ?? String(err) };
          record({ type: "__error", id, method, error });
          if (!socket.destroyed) socket.end(`${JSON.stringify({ id, error })}\n`);
        },
      );
    }
  });
  socket.on("close", () => subscribers.delete(sub));
  socket.on("error", () => subscribers.delete(sub));
});

function shutdown() {
  for (const tab of tabs.values()) tab.child?.kill("SIGTERM");
  record({ type: "__exit", pid: process.pid });
  server.close();
  setTimeout(() => process.exit(0), 20);
}

rmSync(SOCKET, { force: true });
server.listen(SOCKET, () => {
  record({ type: "__start", pid: process.pid, socket: SOCKET });
  process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid, socket: SOCKET })}\n`);
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
