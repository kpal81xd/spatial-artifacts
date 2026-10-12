---
name: spatial-3d-design
description: Design guidance and the scene template for 3D Artifacts on the PlayCanvas engine - lit, framed scenes that viewers select, move, rotate and scale with gizmos, with their edits kept. Load before writing any 3D scene, model viewer or spatial layout artifact; spatial-design still governs the page around the canvas.
---

Work the way a lighting and layout lead at a small visualisation studio would: every scene gets a deliberate camera, a real light and materials that belong to its subject. A scene is a page too, so `spatial-design` still governs the title, the overlay text, the themes and the copy; this skill governs what happens inside the canvas, and never overrides the user's own words or the project's existing assets.

## Read the request first

Decide the treatment the same way as for a page. A model viewer, a layout study or a spatial explainer is utilitarian: honest scale, clear light, no flourish. A showcase scene is editorial: one strong light direction, a composed camera, one bold material. A well-lit, well-framed plain scene is always acceptable; a busy one sometimes isn't.

## Fundamentals for every scene

**Respect what exists.** Use the repo's GLBs, material libraries, units and PlayCanvas conventions when they exist. When this session offers them, load `inspect-glb` and `calibrate-model` before placing any model, `light-scene` for lighting, and `apply-conventions` or `assemble-scene` for engine patterns; this skill fills the gaps they leave.

**Ground it in the subject, at real scale.** Units are metres. A desk is 0.72 m high; a mug is 0.1 m across. Build from the subject's own objects and materials, and include one detail only this subject would have (the brand of lamp head, the joint on the shelf) as geometry, not decoration. Never leave placeholder names like "Cube" or "Object 1": the names appear in the toolbar, in comments and in Claude's edit list.

**Plan before building.** Write a short scene plan:
- **Materials:** 4-6 named PBR swatches (diffuse RGB, gloss, metalness), taken from the subject's world. Keep `metalness` at 0: the template has no environment lighting, so a metal has nothing to reflect and renders black. Suggest metal with a warm diffuse and high gloss instead.
- **Light:** one key light with a clear direction and shadows; ambient low enough that shadows read; no more lights than the image needs.
- **Camera:** a fov (35-50 for objects, wider only for rooms), a position and a target that frame the subject with room to breathe, slightly above eye level unless the subject says otherwise.
- **Composition:** one sentence on what the eye lands on first.

**Ground everything.** Objects sit on a surface: a floor, a plinth, a desk. Nothing floats and nothing sinks through the ground; calibrate each model's scale, grounding offset and yaw once. Everything is selectable, floors and backdrops included, as in an editor.

**Make it complete at rest.** The first frame is the picture: framed, lit, grounded, with shadows. No auto-spin, no ambient motion, no fly-in. The camera opens on the pose you chose; the viewer orbits from there.

**Design both themes.** The template's `--scene-bg` token is the clear colour, via `"clear": "token:--scene-bg"` (selection outlines are always white; comment outlines and the editing toolbar take the viewer's orange, `--tool`, which stays as is); retune the tokens for the subject in both theme blocks, as `spatial-design` describes; any CSS colour works, and a token used by a material or light follows the theme like the clear colour does. A token set on one `.scene` section retunes only that scene. A scene that deliberately commits to one visual world may use literal colours instead.

**Avoid AI-generated 3D.** It clusters around a spinning cube, the default blue-grey clear colour, a grey grid floor, flat unshadowed light, a tiny object centred in a void, heavy bloom and rainbow primitives. When the user asks for one of these, follow them; otherwise don't spend the freedom there.

**Build cleanly.** Keep ids short, stable and meaningful (`lamp`, `desk-left`); ids never change once published, because viewer edits are keyed by them. Keep scenes to what the image needs; every entity is a draw call on someone's laptop.

## Process

1. Write the scene plan above.
2. Scaffold the page into the working directory or the scratchpad (publish sources must live under one of them):

   ```bash
   node <this skill's base directory>/scripts/new-scene.mjs <dir>/<name>.html --title "<Page Name>" [--scenes "Option A,Option B,Option C"]
   ```

   It writes one page: tokens and toolbar, a sample scene, the pinned PlayCanvas 2.22.5 engine from jsdelivr under integrity hashes, and a `<script type="module" src="/_frame/scene/scene-runtime.mjs">` that loads the scene runtime the artifact server serves to every 3D page (so there is no runtime to read or republish). Never edit that script tag or the import map; edit the `<title>` and `<h1>`, the tokens in `<style>`, each section's `<h2>` label (shown above its viewport; a page with one scene has none, since the `<h1>` names it, and its scene takes the title's name), and each `.scene-data`. `--scenes` lays out one section per name in a responsive grid, each an independent scene with its own camera, toolbar, selection and undo; use it to compare design options side by side in one artifact, the way a 2D page shows several mockups. Keys go to the scene the pointer was last on.
3. Replace the sample in each section's `<script type="application/json" class="scene-data">` with that scene; each section's `data-scene` key (on its canvas) and its ids must stay as generated. The schema:
   - `camera`: `pos`, `target` (metres), `fov` (5-120).
   - `environment`: `clear` and `ambient` (RGB 0-1 arrays or `"token:--name"`), `exposure`, `toneMapping` (`linear`, `aces`, `neutral`).
   - `materials`: name → `{ diffuse, gloss, metalness, emissive? }`.
   - `models`: name → a path beside the page, e.g. `"models/lamp.glb"`.
   - `entities`, in order, parents before children: `{ id, name, parent?, primitive? | model? | light?, material?, pos?, rot? (degrees), scale?, shadows?, locked? }`. Primitives: `box`, `sphere`, `cylinder`, `cone`, `capsule`, `plane` (1 m, centred; a plane faces up). Lights: `{ type: directional | omni | spot, color?, intensity?, shadows?, range?, inner?, outer? }`; a directional light's shadows reach as far as the scene's shadow casters, however large the scene. Names may not contain `/`.
   - A compound object (a quarter pipe with its deck and coping) is one parent with its parts as children; lock the parts (`"locked": true`, which only means "part of its parent"), and a click on any part selects and moves the whole; a double-click drills into the part itself. Keep the parent's `scale` uniform (or leave it at 1) and size each part with its own `scale`: under a parent scaled unevenly, a rotated child shears, so the runtime offers only Move for such parts.
4. Look once with `SpatialArtifactCheck` `preview` on the file. Primitives render; models don't load in preview, because it serves only the page, so the report lists them as files beside the page, which is expected. A problem in that scene's `.scene-data` shows as a `scene-data: …` console error naming the entity, and a scene that never draws its first frame shows as a `scene` issue; fix it. The `db` note is expected too. Then make one pass of edits and publish.
5. Load the `spatial-capabilities` skill, then publish with `SpatialArtifact`: `file_path` = the page, `capabilities: { "db": {} }` (the edit tools need it), and any models in `files`, e.g. `{ "models/lamp.glb": { "from": "<path>", "contentType": "model/gltf-binary" } }` (`.gltf` is `model/gltf+json`). On a republish, leave models you did not change out of `files`: they carry forward. To replace a published model, list the artifact's files first (`action: "list"`, `scope: "files"`) so the publish may overwrite it; a model another artifact already publishes is reused with `{ "models/lamp.glb": { "artifact": "<its url>", "path": "models/lamp.glb" } }` instead of a local copy.

## Viewer edits

The camera orbits with a left-drag, pans with a middle-drag or Shift+drag, zooms with the wheel, flies with W/A/S/D (Q/E down and up, Shift faster, Ctrl slower), and looks around while the right button is held; keys reach the scene last pointed at. Viewers select objects (click, Shift+click; double-click to drill into a part of a compound object and centre the view on that point, Esc to step back out), which shows the active gizmo at once; switch between move, rotate and scale with 1/2/3 or the toolbar, drag gizmo handles, toggle local/world with X, snap with Shift or the Snap button, frame the selection with F, and undo with Ctrl/⌘+Z. Each scene's corner button takes it full screen, with commenting still available there (C, then click); Esc exits. Every edit is saved at once to the artifact's database, in the `edits` collection, one document per entity, with id `<scene>:<entity id>`: `{ pos, rot, scale, path, scene }`. They show in every open view and survive reloads and republishes, applied on top of each scene's `.scene-data`.

**Before you change a published 3D artifact's source, fold its edits in:**
1. `SpatialArtifactData` `list` with `collection: "edits"` and the artifact's `url`. Keep each document's `version`.
2. For each document, copy `pos`, `rot` and `scale` into the entity whose id follows the `:` in the doc id, inside the scene named before it (its `scene` field) in that scene's `.scene-data`. A document whose id no longer exists in the scene is an orphan: note it.
3. Make the change you were asked for, then publish.
4. Only after the publish succeeds, `SpatialArtifactData` `batch` with a `delete` write for each folded or orphaned document, pinned to the version you listed (`{ "op": "delete", "collection": "edits", "doc_id": "<id>", "if_version": <version> }`); a delete without `if_version` is refused, since the document exists. If the batch fails with a version mismatch, a viewer moved that object again after you listed it: list again, fold the newer transform, republish, and retry. Tell the user which edits you folded and which orphans you removed.

Deleting before publishing would snap the scene back to its old transforms in every open view. A republish reaches open views when the viewer pauses (never mid-drag), and each scene keeps its selection, gizmo tool and camera across it.

## Comments on a scene

In comment mode the scene hides the selection and its gizmo until comment mode ends, outlines what a click would comment on itself (the object, or its part after a double-click drills in; floors included), not a box around the canvas, keeps what a comment is on outlined while it is written or its thread is open, pins each comment on the 3D point it was placed at (following the camera), and a comment placed there arrives labelled `<Scene> › /Desk/Lamp` with `[anchored element] <canvas data-scene="grid" data-entity="/Desk/Lamp" data-point="0.91,0.02,1.2">`: `data-scene` names the scene, `data-entity` the entity path (names from the root; locked floors and walls included), and `data-point` the world point, in metres, that was clicked; it arrives with a `[view image]`, a capture of that object and some of what surrounds it as the viewer saw it. Shift+click adds more objects to the open comment and Shift+drag adds what an area covers; each arrives as an `[also on]` line after the first, and "these" means all of them. Empty space takes no click comment. A viewer can also drag across an area, empty space included: that comment arrives as `[region of]` the canvas, with one `[inside region] <canvas data-scene="grid" data-entity="/Desk">` per object at least half inside it that shows there (outermost objects only, up to 16; past that, those covering most of the area); "these" in its text means them. The canvas snippet carries `data-camera="x,y,z,tx,ty,tz,fov"` (the camera position, the point it looked at, and its fov when the area was drawn), and the comment arrives with a `[region image]`: a capture of the area as the viewer saw it, for things only visible on screen (a shadow, a seam, a z-fighting flicker). A comment can also carry `[attached image]`s: reference images the viewer attached (the chair they want, a material, a mood), which set the direction for the change. Look at these images before changing the scene. Find the entity by its path in that scene's `.scene-data`, act on the request, fold any edits first, and publish.
