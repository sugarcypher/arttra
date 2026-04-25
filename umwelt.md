# Umwelt

## An Algorithmic Philosophy

**Umwelt** — Jakob von Uexküll's term for the self-world of an organism — is the premise that there is no universal sensorium, only apertures. The tick inhabits a world of butyric acid and skin-temperature; nothing else exists for it, not as lack but as sheer absence of category. The dog inhabits a world of smell-time, where the freshness of a trail is a direction. The mantis shrimp sees along twelve channels of color across a spectrum we cannot even name. Each creature's reality is the precise shape of its perceptual window, and what falls outside that window simply is not — not for it, not as experience. To hold this idea with any seriousness is to realize that one's own experienced world is also an umwelt: a cut reality, a slice, a narrow band of what lies available. The world is not what is there. The world is what the aperture admits.

This piece makes that cut perceptible. Beneath the canvas there exists a continuous scalar field composed of many simultaneously superimposed spatial-frequency components — a hundred overlapping melodies sung at once, slow and fast, vast and fine. No rendering could contain the whole. Instead the viewer is given a single instrument: a Gaussian aperture on the frequency axis that admits only a narrow band of the field into visibility. What appears on the canvas is precisely and only what the aperture allows. Everything else exists — the math computes it, the field contains it — but it stays below the limen, the psychophysical threshold of perception. Along the edges of the admitted band, ghosts leak through: out-of-band echoes rendered at low opacity, the whispered interference of what cannot quite be seen. Slide the aperture across the spectrum and the same underlying reality wears entirely different faces. Low center frequencies reveal slow cloud-forms and weather; middle frequencies yield readable structure, pattern, contour; high frequencies dissolve into granular, hair-like noise-texture. Each position is another organism's umwelt. The seed fixes the world; the aperture chooses who inhabits it.

The computational craft lives in the interference. A meticulously tuned summation of many hundreds of sinusoidal harmonics — each with its own frequency, orientation, phase, and amplitude drawn from a configurable spectral slope — produces a field that is genuinely multi-scale rather than layered noise wearing pretension. The window is not a hard cutoff but a soft aperture with Gaussian falloff in log-frequency, so that the transition between admitted and excluded is itself a gradient, a suggestion rather than a wall. The out-of-band channel is rendered as a low-opacity ghost in a desaturated hue — the ambient pressure of a larger reality leaning on the edge of what is seen. Every ratio, every falloff, every color-pole was refined across countless iterations by someone operating at the absolute top of their field in computational psychophysics; the piece should feel like the output of that level of care, which is to say, inevitable.

The representation is deliberately unorthodox. This is not flow, not particles, not branching growth. It is the continuous field sampled and rendered as contour — topographic bands that quantize the scalar into discrete visible layers, a perceptual simplification that is itself an act of umwelt-imposition. Humans read contoured fields the way we read maps, the way we read interference patterns, the way cortical columns read Gabor filters: by categorical thresholding of a continuum we cannot see entire. The piece makes this imposition explicit. Here is the field. Here are the levels we are equipped to discriminate. Here is everything between them, rendered invisible by our own perception. The palette, too, participates in the argument: a warm pole for positive values, a cool pole for negative, deep graphite for the substrate — a dark-field reading that inverts the paper metaphor precisely because perception is not inscription onto brightness but extraction from darkness.

What Umwelt finally argues is this: the question is not what the world contains but what your aperture admits. A reality larger than perception is not hypothetical; it is computed, literally present, and directly available by moving the window. The interactivity is not decoration but argument. Every adjustment of the Aperture Center is a reminder that what you take to be the world is a choice of instrument — and that another instrument, equally available, equally present, would yield a different and equally complete reality.

## Conceptual DNA

The work carries a subtle reference to the structure of receptive fields in biological sensory systems — the Gabor-like filters that tile primary visual cortex, each tuned to a narrow band of spatial frequency and orientation. Our perception is already a forest of such small apertures summing into what we mistake for seeing whole. The algorithm inverts the trick: one aperture, many frequencies, and the user at the dial where cortex usually is.

---

## Technical Specification

**Underlying field.** Sum of N sinusoidal harmonics:
```
F(x, y) = Σᵢ  Aᵢ · sin(kᵢₓ · x + kᵢᵧ · y + φᵢ)
```
Frequencies `|kᵢ|` are log-uniform across `[f_min, f_max]`. Orientations and phases are seed-uniform. Amplitudes follow `Aᵢ ∝ |kᵢ|^(−α)` where α is the spectral slope (α=1 is pink noise).

**Aperture (the load-bearing operator).** Gaussian window in log-frequency:
```
W(f) = exp(−(log(f/f_c))² / (2σ²))
```
Visible signal = `Σᵢ Aᵢ · W(|kᵢ|) · sin(...)`. Ghost signal = `Σᵢ Aᵢ · (1 − W(|kᵢ|)) · sin(...)`. The two are always complements and always simultaneously computed — the ghost is not a visual effect, it is half of the underlying reality.

**Color mapping.** Field value is tanh-compressed, optionally quantized to L contour levels (L=0 for continuous), and mapped through a three-point ramp: cool pole (negative) → substrate (zero) → warm pole (positive). Ghost value is overlaid at low opacity in a desaturated hue.

**Invariants.** For a work to be Umwelt:
1. The underlying field must span a spectral range wider than the aperture can admit at any setting.
2. The aperture must be soft (Gaussian or equivalent), not a hard cutoff.
3. The out-of-band ghost must be directly computed from the excluded signal, not synthesized.
4. The same seed must produce a fixed underlying reality; only the aperture parameters select what is visible.
5. The user can move the aperture across the full frequency range interactively.

**Failure modes.**

| Symptom | Cause | Mitigation |
|---|---|---|
| Flat featureless wash | Aperture too wide, averaging the field | Narrow σ; center on a resonant frequency |
| Pure noise | Aperture too wide at high frequencies | Reduce σ; lower f_c |
| Solid color | Aperture misses all harmonics | Verify f_c within [f_min, f_max]; increase σ |
| Posterized and ugly | Contour level count mismatched to contrast | Tune levels 5–10; contrast 1.0–1.5 |
| Ghost overpowers signal | Ghost intensity too high | Cap at 0.3 |

## Relation to the Accumulation Principle

Umwelt is *not* an instance of the Accumulation Principle. It is a distinct philosophical system — the Aperture Principle, one might provisionally name it — where reality is not built up through layered contribution but selected from a pre-existent whole through a perceptual operator. Where Residual Warmth and Ink Blooms both satisfy the three accumulation conditions (persistent substrate, bounded additive contribution, structural constraint), Umwelt satisfies a different triad:

1. **A reality larger than any single rendering.** The underlying field must exceed what the display can show.
2. **A perceptual operator.** Some tunable filter selects what becomes visible.
3. **A trace of the excluded.** Ghosts, edges, or artifacts that testify to the un-shown.

These two principles — accumulation and aperture — are different answers to the question *what makes an image?* Accumulation: patient building onto a substrate. Aperture: selection from a larger whole. A full generative taxonomy would probably include at least a third (emergence from interaction, perhaps) and a fourth (inscription of rule onto void). That mapping is for another document.
