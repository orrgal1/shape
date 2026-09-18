# Shape

Shape turns a repository into an explorable map of the product and the code behind it. A model
describes what each part promises; Shape compares that intent with evidence from the repository and
shows current coding activity on the same canvas.

![Shape canvas](docs/shape-canvas.png)

## Try it

Start your coding harness in the repository you want to map and paste:

```text
Set up Shape for this repository. Clone https://github.com/orrgal1/shape.git to a separate stable directory; in that checkout run pnpm install --frozen-lockfile, pnpm --filter @shape/web build, and pnpm shape install for this harness. Installed skills load in future sessions, so for this session read and follow skills/shape-serve/SKILL.md and skills/shape-map/SKILL.md directly from the Shape checkout, using its scripts/shape.mjs entrypoint. Return here, start or connect to a local Shape server, map main without changing my working tree, and give me the verified canvas URL.
```

Requirements: [Node 26+](https://nodejs.org/en/download), [pnpm 11](https://pnpm.io/installation),
Git, and a coding harness that supports skills. Node 26 does not bundle Corepack; install pnpm
directly or install Corepack separately.

## Use it

After installation, start a new harness session in your repository. These are **harness prompts**,
not shell commands:

1. **`shape serve`** — find an existing Shape server or start one, then return its canvas URL.
2. **`shape map`** — map the committed `main` branch without switching your checkout.
   Use **`shape map feature/payments`** to map another local branch.
3. **`shape live`** — report the current session against its already-mapped branch.

That is the normal workflow. Run `shape map <branch>` again after committing meaningful code
changes.

## What the three steps mean

- **Serve** owns the shared canvas and its database. A local server defaults to
  `http://127.0.0.1:4400`.
- **Map** reads an immutable snapshot of a committed branch. Dirty, staged, and untracked files are
  left alone. The first map is complete; later maps use the Git delta when safe and remap fully
  after rebases or missing history.
- **Live** adds activity and optional semantic changes as an uncommitted overlay. It never advances
  the branch's committed map checkpoint.

The canvas is for reading the system, not directing agents. Projects can be marked inactive without
losing their maps or history, then restored through **Show inactive**.

## Manual installation

In a stable directory outside the repository you want to map:

```bash
git clone https://github.com/orrgal1/shape.git /absolute/path/to/shape
cd /absolute/path/to/shape
pnpm install --frozen-lockfile
pnpm --filter @shape/web build
pnpm shape install omp       # or: claude
```

`pnpm shape install` installs all three skills into both standard roots. Other harnesses can use:

```bash
pnpm shape install --custom-dir /absolute/path/to/skills
```

The installed skills point back to this checkout, so keep it in place. Shape does not install a
global `shape` command. See [skills/README.md](skills/README.md) for the install targets.

## State and remote servers

The selected server stores maps, revisions, live overlays, and the project registry. The default
local database is `~/.shape/server/shape.db`; client connections and temporary map/live state also
live under `~/.shape`.

For a remote server, use HTTPS/WSS behind a trusted TLS proxy or an SSH tunnel to a loopback-bound
server. Never put a token in a URL. Saved CLI credentials do not authenticate a fresh browser; enter
the token in the canvas prompt when asked.

See [docs/onboarding.md](docs/onboarding.md) for recovery and remote setup details.

## Development and reference

From the Shape checkout:

```bash
pnpm shape --help
```

- [docs/onboarding.md](docs/onboarding.md) — operation and recovery
- [skills/README.md](skills/README.md) — skill installation
- [packages/link/README.md](packages/link/README.md) — optional native adapters
- [CONTRACTS.md](CONTRACTS.md) — runtime and wire contracts
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and checks
- [SECURITY.md](SECURITY.md) — vulnerability reporting

## Third-party

Geometry helpers in
[`packages/web/src/canvas/vendor/archify-geometry.ts`](packages/web/src/canvas/vendor/archify-geometry.ts)
and glyph data in [`packages/web/src/canvas/kind.tsx`](packages/web/src/canvas/kind.tsx) are adapted
from [archify](https://github.com/tt-a1i/archify) at commit `5de7275`, under MIT.

## License

MIT — see [LICENSE](LICENSE).
