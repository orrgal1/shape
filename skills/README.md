# Skills

`visualize/` is the agent skill that onboards a repo onto the Shape canvas: it starts the bridge
and the web app, points the bridge at the repo, opens the canvas and triggers the onboarding
survey. Install it by symlink as described in
[`README.md#onboard-an-existing-repo`](../README.md#onboard-an-existing-repo).

It lives here rather than under `docs/` because it is shipped code an agent loads, not documentation.
