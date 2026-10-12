# Garden Bedroom

The scene in the main README's demo. Claude built it with this plugin in one Claude Code session. There are no asset
libraries or downloaded models: every piece is a GLB that `build-models.mjs`, a dependency-free Node script Claude
wrote during the session, generates with baked textures.

## How it was made

1. The opening prompt: _"Generate me a realistic mock-up of a bedroom: a bed with pillows and a duvet, a desk with a
   chair, a window looking out onto a garden, a rug and a bedside lamp. All assets are to be generated from scratch."_
   The first pass was built from primitives.
2. A second-pass brief asked for real geometry and baked textures instead: bevelled furniture, a soft duvet, wood
   grain, linen, a wool rug, late-afternoon sun and ACES tone mapping. Claude wrote the generator for that.
3. Comments in the viewer did the rest: one on the window ("make it a bright, sunlit garden with real depth") and one
   on the chair ("swap this for a mid-century lounge chair"). A couple of chat follow-ups made the sky more golden and
   kept the camera inside the room when you orbit.

## Open it yourself

```bash
node examples/bedroom/build-models.mjs   # writes the 17 GLBs (about 25 MB) to examples/bedroom/models/
```

Then ask Claude: _"Publish examples/bedroom/index.html with SpatialArtifact, with the GLBs in examples/bedroom/models
as its models/ files."_ The script is deterministic, so it rebuilds the same models every time.
