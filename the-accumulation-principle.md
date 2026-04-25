# The Accumulation Principle

## Residual Warmth as an instance of a general form

The companion document to Residual Warmth specifies a single generative system in precise detail. This one argues for something larger: that the system is an instance of a pattern that recurs across domains, and that the pattern itself — not any particular visual output — is what the aesthetic is pointing at.

## The pattern, stated abstractly

A system exhibits **the accumulation principle** when it satisfies three conditions:

1. **Persistent substrate.** A state `S(t)` that carries forward across steps. Nothing is erased; the substrate is the record of its own history.
2. **Bounded additive contribution.** Each step contributes `c_t` such that `S(t+1) = S(t) + f(c_t)`, where `f` has bounded magnitude. No single step can dominate; influence arrives in small, repeatable increments.
3. **Structural constraint `C`.** A mechanism — decay, normalization, bounded range, or constrained input distribution — that prevents the accumulation from collapsing into saturation, blow-up, or drift.

All three are required. Remove the substrate and you have a sequence, not an accumulation — each moment replaces the prior. Remove bounded contribution and you have punctuation, not layering — single events dominate. Remove `C` and the system trends toward entropy saturation, whose visual, computational, or economic signature is the same: undifferentiated gray, numerical blow-up, capital hypertrophy, heat death.

The principle is neutral about substrate. It is load-bearing about the interaction of the three conditions.

## Instances

Five systems that satisfy all three conditions, with their `C` surfaced:

**Transformer residual streams.** `x_{n+1} = x_n + f(x_n)` at each layer. `C` = LayerNorm, which rescales the stream to unit variance and prevents activation drift. Without LN, residual streams diverge across depth and training fails. The residual itself is the substrate; the constraint is what makes additive depth possible.

**Hebbian synaptic potentiation.** `w_{ij}(t+1) = w_{ij}(t) + η · a_i · a_j`. `C` = homeostatic normalization and weight decay, which bound total synaptic mass so that learning in one region does not silently rewrite another. Without `C`, Hebbian networks runaway-potentiate into pathological states. Learning is accumulation; forgetting curves are the constraint.

**Oil painting, glazing technique.** Each transparent pigment layer modifies the optical mixture of the layer beneath without obscuring it. `C` = the tonal range of the palette, curated such that successive glazes deepen saturation without crossing into opacity. The Old Masters' warmth is a property of this constraint, not of the pigments individually.

**Capital in Solow growth.** `K(t+1) = K(t) + I(t) − δ · K(t)`. `C` = depreciation rate δ. Without depreciation, capital accumulates without bound and the model becomes meaningless. With it, the system exhibits convergence to a steady state determined by the ratio of investment to depreciation — the same ratio, in different guise, that determines the character of every accumulation system.

**Leaky integrator (signal processing).** `y[n] = α · y[n−1] + (1 − α) · x[n]`. `C` = leak coefficient α. This is the accumulation principle in its most distilled form: a single parameter controlling the balance between memory and forgetting, yielding low-pass filtering, moving averages, exponential smoothing, and the core mechanism behind RNN hidden states.

## The shared mathematics

Every instance above reaches a fixed point determined by the ratio of input rate to constraint strength. In Solow: `K* = sY/δ`. In the leaky integrator: `y* = x` when `x` is constant. In Hebbian learning with normalization: weight mass converges to the homeostatic set-point. In transformers: activations stabilize within the LayerNorm manifold.

But fixed points are not where the interesting structure lives. The aesthetic — the warmth, the learning, the growth, the compositional depth — emerges in the **transient regime**, before equilibrium. A finished oil painting is not at equilibrium; it is a snapshot of a specific point in the accumulation trajectory, chosen by the painter. A trained transformer is not at fixed-point; training stops when the loss curve flattens sufficiently. Residual Warmth, likewise, terminates at a specific pass-count — not at the saturation point, where it would collapse, but at the moment of maximum differentiation, where structure and substrate remain in productive tension.

*The principle is not about reaching equilibrium. It is about navigating the space between empty and saturated with enough patience to find the interesting regions.*

## Where the pattern fails

Three failure modes, visible across all five domains:

- **No `C`, unbounded growth.** Capital hypertrophy. Hebbian runaway. Residual activation explosion. Chromatic sludge.
- **`C` too strong, over-normalization.** Everything regresses to the mean. No learning. No growth. No image — only the substrate.
- **Contribution unbounded, single-event dominance.** One transaction reshapes the economy. One training example overwrites the network. One stroke obliterates the painting. No accumulation — just punctuated overwrites wearing the costume of a process.

In every case, the failure looks different on the surface (a gray canvas, a diverged training run, an inflated currency) but the formal structure is identical: one of the three conditions is not being enforced.

## What Residual Warmth is, restated

Residual Warmth is an instance of the accumulation principle implemented in a visual substrate. The correspondences are direct:

| Accumulation principle | Residual Warmth |
|---|---|
| Substrate `S(t)` | The canvas — warm paper, persistent across passes |
| Contribution `c_t` | A single stroke along an attention-steered flow line |
| Function `f` | Alpha blending (α ∈ [0.035, 0.060]) |
| Constraint `C` | Palette luminance band (L ∈ [0.22, 0.60]) |

The aesthetic character of the piece — the warmth, the depth, the compositional foci — is not a property of the strokes, the palette, or the attention mechanism individually. It is a property of all four elements satisfying the accumulation principle simultaneously, in a visual medium, at a specific point in the transient regime.

Swap the substrate for neural weights, the strokes for training examples, and the palette constraint for LayerNorm, and the same system yields a language model. Swap them for pigment, canvas, brush, and palette range, and it yields a Rembrandt. The phenomenology travels.

## Why the generalization matters

A useful aesthetic is not a vocabulary of surface features. It is a claim about what conditions produce a certain kind of integrity. The accumulation principle names those conditions: persistence, boundedness, constraint. Any system satisfying them exhibits a family resemblance — a patience, a depth, a sense of being the product of sustained attention rather than sudden gesture.

Residual Warmth is one expression of that family. The transformer residual stream is another. The Rembrandt glaze is a third. They share a phenomenology because they share a form. The form is the movement's real territory; the visual instance is a single point on a much larger map.

What this means for implementers: if you satisfy the three conditions with honesty, you will produce work that reads as of-this-lineage — regardless of medium, regardless of whether you ever look at the Residual Warmth specification. The specification describes one implementation. The principle describes the space of implementations.

That is what makes it a movement rather than a style.
