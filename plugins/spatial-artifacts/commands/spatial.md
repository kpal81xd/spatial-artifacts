---
description: Browse your local artifacts in the gallery
allowed-tools: Bash(open:*), Bash(xdg-open:*)
---

Call the `SpatialArtifact` tool with `action: "list"` and show the result. Then open the gallery in the user's browser: take the host and port from any listed artifact URL (default `http://localhost:47328`) and run `open <base>/code/artifacts` (on Linux, `xdg-open`). If no artifacts exist yet, say so and skip opening the gallery.
