---
name: spatial-diagramming
description: Diagram guidance for Artifacts - deciding whether a drawing is worth including, depicting the actual mechanism instead of a label for it, and hand-built inline SVG that stays readable in light and dark themes.
---

Approach a diagram as the engineer who must live with whatever gets decided, not as someone decorating a page. Include one only when it shows a reader arriving cold a mechanism they would otherwise piece together from paragraphs: how data moves, which components communicate, what differs between two options, which states a request passes through. When one sentence gets the point across quicker, write that sentence instead.

## What to draw

**Draw how it works, not what it is called.** A rectangle reading "cache" tells the reader less than the prose does. What words cannot carry is the route a request follows through it, the pair of stores on either side, and the arrow that vanishes once the cache is gone. Include the pieces the argument depends on - the boundary that gets crossed, the extra hop, the data in motion - and drop the rest.

**Comparing options? Show what differs.** Put the two architectures next to each other, draw a before and an after, or isolate the single edge each option adds or takes away, so the reader can point to the exact thing being decided. Don't give each option its own labeled box with nothing linking it to the system: that compares nothing and merely repeats the option list as shapes.

**Scale the drawing to what is at stake.** A single-hop question needs about three boxes; a migration that moves writes onto a queue needs the writer, the reader, the queue between them, and the arrow that fixes their order. Include exactly what the decision depends on - neither minimalism for its own sake nor a catalogue of the entire system.

**Put labels on the arrows.** A bare arrow only says the two ends are connected in some way; `writes`, `invalidates`, `polls every 30s` actually inform. Add a legend only if one encoding (dashed, colored, doubled) shows up more than once; otherwise write the meaning straight onto the mark.

## Building it in inline SVG

These notes are for pages that render inline SVG natively, meaning HTML pages; a page rendered from Markdown draws diagrams in whichever fenced block that lane's renderer understands, and the skill responsible for that lane names it. Write the inline `<svg>` by hand from `<text>` plus built-in shapes (`rect`, `circle`, `line`, `polyline`, `path`), and don't pull in a library, a runtime or any external image.

- **Size it with `viewBox`.** Set the SVG's `viewBox="0 0 W H"` so CSS can scale the figure (`max-width: 100%; height: auto`); derive W and H from the content, not a preset. Lay wide flows out left to right and layered stacks top to bottom.
- **Theme through `currentColor`.** Use `currentColor` for strokes, text and arrowheads so they pick up the page's foreground under light and dark themes. Save a literal hue for the single meaningful element (the favored option, the hop in question), and check that it stays readable against both backgrounds.
- **Arrowheads: marker or polygon.** Either define a `<defs><marker>` and point to it with `marker-end="url(#arrow)"` (an id within the same fragment), or place a small `<polygon>` where the line ends; never use an image.
- **Make labels readable.** About 11-13px at the scale the figure is drawn, `text-anchor` for alignment, and labels of one to three words; an explanatory sentence goes in the caption beneath the figure, not inside the drawing.
- **Snap to a grid.** Common baselines and equal spacing do most of the work of making a hand-drawn diagram look intentional; positions nudged by eye look like noise.
- **One claim per figure.** Put the `<svg>` inside a `<figure>` whose `<figcaption>` says what it depicts, and mark the `<svg>` with `role="img"` and an `aria-label` repeating that claim for anyone unable to see the image.
- **Keep it self-contained.** The SVG holds no `<script>`, `<style>` or `<foreignObject>`; gradients, patterns and `<use>` point at ids inside the same fragment (`href="#id"`). If the drawing needs long decorative path data, it is asking for a proper graphics tool - simplify it instead.
