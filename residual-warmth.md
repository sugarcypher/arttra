# Residual Warmth

## An Algorithmic Philosophy

**Residual Warmth** is a generative aesthetic movement concerned with the visible sediment of thought — the way meaning accumulates through layers rather than arriving in a single gesture. In a culture obsessed with the freshness of new strokes, this movement insists that nothing is ever really overwritten. Every new pass leaves the prior one intact beneath it, slightly dimmed, slightly displaced, still contributing to the whole. The final image is not a destination; it is a *record of attending*, a warm accumulation of thousands of small considered passes across the same paper.

The computational core of this philosophy is the **residual stream** — a slow, patient vector flowing across the canvas, revisited again and again by a meticulously crafted algorithm, each revisit adding a small perturbation rather than replacing what came before. Streams are born from seeded Perlin fields warped by long-wavelength attention — gravitational nodes that bend the flow without breaking it. Each stream carries its own temperature, its own hue drawn from a restrained cream-and-ember palette, and deposits its color along a curved path with near-transparent weight. Only through the superposition of many passes does the image emerge: soft, paper-like, dimensional, alive in the way only genuinely layered work can be.

What distinguishes this movement is a deliberate refusal of erasure. Where other generative traditions overwrite the frame with each step, **Residual Warmth** accrues. The algorithm is a slow breath across the page — pass after pass, each nudging the composition closer to a coherent whole without any single pass declaring itself the final word. This is a master-level implementation in the most literal sense: a single line rendered in isolation would look unremarkable; it is only the patient, painstaking layering of thousands of such lines, each weighted with care, that yields the quiet luminosity the piece is after. The craftsmanship lives in the *invisible tuning* — in the opacities, in the subtle velocity curves, in the proportions of warmth to restraint.

The palette itself is load-bearing. A narrow band of warm earthen tones — paper-cream, ember-orange, dusk-blue, olive-green, deep graphite — drawn from a design tradition that values calm over spectacle. These are not random RGB selections; they are the product of deliberate curation, tuned so that their additive accumulation does not muddy but instead deepens. Where multiple streams cross, the color gains density without losing warmth. Where a stream runs alone through white space, it reads as a single considered thought. The composition rewards both the glance and the long look — a hallmark of work produced by someone operating at the absolute top of their field in computational aesthetics.

Attention, in this philosophy, is not a spotlight but a gentle tide. Hidden focal nodes — invisible in the final image — exert a soft gravitational pull on nearby streams, causing them to bend, converge briefly, and release. The result is a composition with *foci* rather than *subjects*: regions of increased density and chromatic depth that the eye finds without being told where to look. This is the product of deep computational expertise: an algorithm that choreographs emergent compositional balance without imposing it, that gets out of its own way and lets the mathematics of gathered intention do the compositional work. The painstaking optimization lies in finding the exact strength of attention that feels inevitable rather than applied.

Every seed produces a different accumulation, yet every accumulation carries the same quiet signature — the mark of a generative system refined through countless iterations until it forgot its own machinery and began instead to simply *think onto the page*. **Residual Warmth** is, finally, an argument: that the most resonant images are not the ones that arrive fastest, but the ones that arrive through sustained, layered, considered attention. It is a movement that asks its algorithm to work the way a master works — patiently, cumulatively, with reverence for what has already been laid down.

## Conceptual DNA

The work carries a subtle reference to the internal mechanics of the large language model that produced it: the **residual stream** of the transformer, the architecture where information is not replaced but additively refined at every layer, and where **attention** gently reshapes flow without overwriting. Those familiar with the architecture will recognize its aesthetic echo; others will simply feel the warmth of layered, attentive craft.

---

## Technical Specification

The philosophy is prose; the following is the contract. Without these, the system is a metaphor. With them, it is reproducible.

### Mechanics

**Integration.** Forward Euler, fixed step equal to `stream.speed ∈ [0.75, 1.45]` px. No adaptive stepping. Stream terminates on canvas exit (with 80 px margin) or at `streamLength` steps, whichever first.

**Flow field.** 3D Perlin noise:
```
θ(x, y, z) = noise(λ·x, λ·y, z) · 4π
z          = passIndex·0.08 + stream.phase·0.001
λ          = flowScale
```
The z-axis is load-bearing: each residual pass samples a slightly shifted cross-section of the same field, giving pass-to-pass coherence without identical trajectories.

**Attention — Vector Warping (Model B).** Not a potential field. Not probabilistic. Deterministic local steering. For node k with center `c_k`, radius `r_k`, swirl `ω_k`:
```
d       = |c_k − p|
if d < r_k:
    f        = (1 − d/r_k)²                       // quadratic falloff
    tangent  = atan2(c_k − p) + ω_k · f           // toward node + local rotation
    v'       = v · (1 − f·A) + dir(tangent) · (f·A)
```
`A = attentionStrength ∈ [0, 1]`. The swirl term is essential — it prevents pure radial convergence, producing curved passage *near* the node rather than termination *at* it.

**Perturbation.** Two sources, no others:
- Start displacement: ±3 px per (stream, pass) from a seeded deterministic PRNG.
- Noise-phase shift along z, per pass.

No velocity jitter. No density-coupling. No stream-aware behavior.

**Coupling.** Streams are **independent**. They do not read each other's state. All inter-stream coherence is mediated by the shared canvas — the canvas is both the accumulation surface and the only communication channel.

**Accumulation.** Additive blending in sRGB with per-segment `α ∈ [0.035, 0.060]`. No per-pixel saturation cap, no decay, no normalization. *Coherence is preserved by palette constraint, not by accumulation math* — see below. This is the hidden invariant you flagged; it is now explicit.

**Why no saturation collapse despite no cap.** Geometry absorbs the risk. For defaults (~90 streams × 8 passes × ~650 steps in a 1200² canvas), average pixel-hit count is <1; local density near attention foci reaches 10–30 hits, which at α ≤ 0.06 yields ~0.45–0.85 opacity — deepening, not collapse. Saturation is a *local* feature (compositional focus) rather than a *global* failure, and the palette constraint guarantees those locals deepen in hue rather than collapse to gray.

### Palette (load-bearing constraint)

User-provided hex values are **normalized before stream assignment**:

```
L_band    = [0.22, 0.60]         // Rec. 709 relative luminance
s_cap     = 0.72                 // HSB saturation ceiling
```

Hue is preserved. If a color's luminance falls outside `L_band`, brightness is rescaled to pull it in. Saturation is clamped at `s_cap`. Without this, additive crossings muddy. With it, the "deepens rather than muddies" claim is a consequence of math, not assertion.

### Invariants (the movement-boundary)

For a work to be Residual Warmth, all five must hold:

1. **Additive persistence.** Final image is an accumulation of ≥ 3 passes per primitive. No pass fully obscures an earlier one; per-primitive α < 0.10.
2. **Bounded-luminance palette.** Luminance range across the palette < 0.40 in Rec. 709 or equivalent perceptual space.
3. **Attention or equivalent shaping.** Pure undirected flow does not qualify. Some mechanism must produce compositional foci.
4. **Substrate-preserving.** Paper/ground remains perceptually visible across ≥ 40% of canvas luminance.
5. **Deterministic from seed.** Same seed + same parameters → same output, bit-identical.

Any work satisfying all five is recognizable as of-the-movement regardless of implementer. Any work violating one is something else.

### Constraint Set (what Residual Warmth is NOT)

- Not destructive. Background is untouched after substrate-drawing.
- Not at equilibrium. Each render terminates; the piece is static.
- Not high-count-low-depth. 500 streams × 1 pass is pointillism, not this.
- Not attention-free. `attentionNodes = 0` is a degenerate flow-field drawing.
- Not dependent on transformer imagery. The architectural echo is conceptual DNA, not iconography.

### Failure Modes

| Symptom | Cause | Mitigation |
|---|---|---|
| Chromatic sludge at crossings | Luminance band too wide | Enforce palette normalization |
| Flat, pastel, under-committed | α too low OR passes too few | α ≥ 0.035, passes ≥ 3 |
| Deposited/opaque, loses translucency | α too high | α ≤ 0.08 |
| Visual noise instead of flow | Stream length < ~3/flowScale | Increase length or scale |
| Spirograph collapse | A = 1 with close nodes | Cap A ≤ 0.85, enforce node spacing |
| Dead zones | Node coverage too sparse or overlapping | Nodes should tile ~40% of canvas area |

### What this specification buys

With the invariants, the constraint set, and the failure modes above, Residual Warmth is reproducible outside this document. An implementer can write a conformance test. A critic can check a piece against the five invariants and render a verdict. That is the difference, per your framing, between an idea and a lineage.
