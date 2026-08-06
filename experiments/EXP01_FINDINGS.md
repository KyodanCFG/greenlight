# Experiment 01 — Cross-Asset Style Consistency

**Run:** 2026-08-05 (script: `exp01-style-consistency.ps1`).
**Cost:** 102 credits (balance 8000 → 7898). All 13 tasks succeeded; zero failures.
**Question:** does the shared-2D-anchor funnel produce a visibly more cohesive set than
independent text-to-3D calls with identical style keywords?

**Evidence:** [exp01-results/exp01-contact-sheet.png](exp01-results/exp01-contact-sheet.png)
(control row vs funnel row), [exp01-results/funnel-anchor.png](exp01-results/funnel-anchor.png)
(the style anchor), per-asset concepts alongside. Full task JSON and GLBs in
`generated/exp01/` (local only, not committed).

## Design

Three assets (goblin scout, wooden watchtower, treasure chest), one theme ("swamp goblin
camp"), two arms:

- **Control:** three independent Text-to-3D preview+refine runs (`meshy-5`), identical
  style keywords appended to each prompt: "low-poly stylized game asset, flat shading,
  muted swamp palette of moss green and bog brown, hand-painted texture look."
- **Funnel:** one Text-to-Image style anchor (`nano-banana`, 3 credits) → three
  Image-to-Image tasks, each given the anchor as `reference_image_urls` → three
  Image-to-3D tasks via `input_task_id` (`meshy-5`, textured).

## Results

**Control: individually good, collectively mismatched.** The goblin came back painterly
and semi-realistic, the tower hand-painted and muted, the chest a bright saturated
cartoon with chunky proportions. The "flat shading" instruction was effectively ignored
on two of three. Anyone would read the chest as belonging to a different game.

**Funnel: visibly one set.** Shared muted palette, shared painterly-cartoon register,
shared prop language. Not pixel-identical in style — the 3D chest's iron came out
lighter than its concept and the goblin reads slightly clay-like — but the set reads as
one game.

**Where fidelity is lost, stage by stage.** This is the finding with product value:

1. **Text-to-Image anchor: exceeded the brief.** Asked for a "concept art style sheet,"
   nano-banana produced a six-panel sheet (hut, watchtower, campfire, traps, resource
   pile, totem) in one rigorously coherent style, for 3 credits.
2. **Image-to-Image stage: near-perfect style hold.** All three concepts match the
   anchor's palette, rendering style, and ground-base convention almost exactly.
3. **Image-to-3D stage: design holds, texture drifts.** Composition and geometry survive
   the lift remarkably well — the 3D tower preserved the canopy's goblin-face emblem and
   the hanging bucket from the sheet. The drift is texture-side: values lighten, darks
   wash out, saturation shifts.

## Conclusions

1. **Style keywords alone do not hold a set together.** Documented with images; the
   control row is the proof. This is the honest baseline for any claim we make.
2. **The funnel works and is the correct pipeline shape.** Cohesion comes from anchoring
   in 2D, where consistency is achievable, and lifting to 3D, which preserves design.
3. **Residual drift is texture-side, i.e. exactly where deterministic post-processing
   operates.** Palette and tone correction toward the anchor is a tractable, provable
   fix — unlike generation-side determinism, which the API does not offer.
4. **The style sheet itself is a product primitive.** One cheap 2D generation gives the
   user a reviewable, approvable definition of the entire set's art direction before any
   3D credits are spent. "Approve one image, get a matching set" is a demonstrable
   workflow the web app does not offer as a one-click path.
5. **Operationally:** 13/13 tasks succeeded; text-to-image ~20s, image-to-image ~25s,
   image-to-3D 80–150s, text-to-3D preview ~60s + refine ~90s. A full 3-asset funnel
   completes in under 4 minutes wall-clock with parallel submission. (Single run, one
   evening, n=3 — indicative, not statistics.)

## Caveats

- n=3, one theme, one style, one run. The funnel's hold on *very* different aesthetics
  (pixel, realistic, sci-fi) is untested.
- Cohesion judged by eye, not measured. Fine for a product decision; not a benchmark —
  and publishing benchmarks would sit badly with ToS §2.6(iv) anyway.
- The 2D concepts include ground bases and props the 3D stage partly incorporated
  (chest base survived into the model). Whether that is desirable is a product question
  — a `remove background/base` instruction in the i2i prompt may be needed.
