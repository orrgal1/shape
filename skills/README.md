# Skills

`visualize/` is the agent skill that puts a repo on the Shape canvas: it starts the bridge and
the web app, points the bridge at the repo and opens the canvas. The map seeds itself from
there — the bridge reads the checkout and draws the package skeleton on an empty canvas.
Install it by symlink as described in
[`README.md#map-an-existing-repo`](../README.md#map-an-existing-repo).

It lives here rather than under `docs/` because it is shipped code an agent loads, not documentation.
