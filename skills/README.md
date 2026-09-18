# Skills

Shape ships three coding-harness skills. They are operational instructions loaded by a harness,
not general documentation:

- **shape-serve** discovers known Shape services first, then connects to a verified service or
  starts one in the foreground under harness process supervision. Its wizard covers local or
  remote placement, port, storage, authentication, and the TLS-or-loopback-SSH trust boundary.
- **shape-map** prepares an immutable snapshot of the original repository's requested branch
  (`main` by default), has the model author honest semantic canvas operations from the
  snapshot, diff, reality, and prior document, and then atomically finishes or explicitly
  aborts. Prepare alone is not a completed map.
- **shape-live** explicitly starts reporting for the current session, emits meaningful activity
  and optional uncommitted semantic operations, and stops with the returned session handle. It
  does not claim to retrofit native hooks into an already-running harness.

## Installation

Run Shape's installer from its stable checkout:

```bash
pnpm shape install
```

The default (equivalently, `pnpm shape install all`) installs all three skills into both actual
standard skill roots:

- OMP: `~/.omp/agent/skills`
- Claude Code: `~/.claude/skills`

Use `pnpm shape install omp` or `pnpm shape install claude` to target one standard root. For a
harness with another skill root, use `pnpm shape install --custom-dir <directory>`; add `all`
before that option to install the standard roots as well. Installation is idempotent, preserves
unrelated files, and refuses to overwrite an unowned same-name skill directory.

The installer writes a safely JSON-encoded, structured-argv **absolute** path to this checkout's
`scripts/shape.mjs` into every installed skill. Consequently the skills work from the target
repository—or any other current working directory—without a hardcoded user path in the source
skill documents. Move the Shape checkout only by reinstalling the skills from its new stable
location.

See [`docs/onboarding.md`](../docs/onboarding.md) for the complete serve → map → live workflow,
transaction boundaries, branch baseline/live overlay model, and remote trust requirements.
