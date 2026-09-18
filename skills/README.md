# Shape skills

Shape installs three coding-harness skills:

- **shape-serve** — connect to or start the server.
- **shape-map** — map a committed branch (`main` by default).
- **shape-live** — report the current session on an already-mapped branch.

## Install

From a stable Shape checkout:

```bash
pnpm shape install omp       # OMP
pnpm shape install claude    # Claude Code
pnpm shape install           # both
```

For another harness:

```bash
pnpm shape install --custom-dir /absolute/path/to/skills
```

Standard targets:

- OMP: `~/.omp/agent/skills`
- Claude Code: `~/.claude/skills`

The installer preserves unrelated files and refuses to overwrite an unowned same-name skill. Each
installed skill points to this checkout's absolute `scripts/shape.mjs` path, so keep the checkout in
place or reinstall after moving it.

Skills are normally loaded when a harness session starts. Installing them does not retrofit the
current process. During the installation session, read the checked-in `skills/<name>/SKILL.md`
directly; use the installed prompt in later sessions.

See [`docs/onboarding.md`](../docs/onboarding.md) for the short serve → map → live workflow.
