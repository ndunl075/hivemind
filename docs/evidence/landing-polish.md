# Landing page polish: design measurements

Plain design measurements of the reference (a marketing site Nico likes), taken with headless Playwright at 1440x900 and 390x844 while scrolling slowly: sizes, spacing and layout proportions only. The reference's text, images, icons, markup, class names, stylesheet values copied verbatim, and animation code or timing are not used. The page here has its own copy, its own generated sky, its own UI illustrations and its own implementation; our values for colors, shadows, easing and durations were chosen independently. Reference screenshots stayed in a scratch folder. (An earlier revision of the footer wordmark mirrored the reference's gradient-sweep construction too closely; it was replaced in review by a static hex-textured wordmark.)

| Item | Reference (measured) | Ours before | Ours now |
|---|---|---|---|
| Background | Photographic dusk sky spanning the whole page, cloud layers at the top and bottom | Flat near-black with hex glow | Generated sky: CSS gradient, SVG fractal-noise clouds top and bottom, faint hex motif; dark only, like the reference (`color-scheme: dark`, no light theme) |
| Heading weight | Light (300) for headings and large copy | 600 | 300 |
| H1 | About 76px at 1440, line-height 1.06, centered, about 1090px wide, starts about 170px from top, two lines | 56px, 600 | `clamp(36px,5.25vw,76px)`, 1.06, max 1088px, 171px top padding; three balanced lines because our headline is longer |
| H2 / H3 | Feature headings 38px; section text 26-32px on small screens | H2 56px | H2 up to 48px, H3 up to 38px, line-height 1.1 |
| Feature copy | 22px / 1.35, light, white at about 48% | 16px | 17-21px / 1.45, light, higher contrast than the reference |
| Header | 1280px max width, 24px vertical padding, 41px logo tile with 9px radius, light 22px wordmark, 14px medium link | 1120px, 28px logo | Same sizes |
| Corner button | Fixed top-right, about 149x42, desktop only, shown after the hero | None | Fixed top-right button, shown after the hero, removed from tab order while hidden |
| Buttons | 48px tall, 5px radius, 1px translucent border, blur, 14px medium, 28px side padding, arrow | Pill | 48px, 5px radius, blur, 14px medium, arrow |
| Screenshot frame | 1280px wide, 8px padding, 1px border, translucent fill, 4px radii, gradient edge; overlaps the hero from about y=483 | 14px radius, fake window bar | Same padding and radii, own gradient edge, overlaps from about y=560 |
| Story section | About 5.6 viewport heights tall with a full-height pinned inner scene; headline top-left, centered visual, progress dashes bottom-left | Three stacked rows | 4 viewport heights, pinned scene, three problems advance by scroll, dashes bottom-left; stacked below 861px wide, below 620px tall and with reduced motion; all three problems stay readable to assistive tech |
| Feature rows | 12-column grid, text 4 columns / image 8, gap 40-64px, section padding 128px, alternating | Three cards | 12-column grid, text 5 / panel 6, gap 40px, 128px section padding, alternating |
| Panels | 6px outer radius, thin translucent borders, near-black fill, large soft shadow | 12-14px radii | 6px outer radius, 4-5px inner, own fill (`#0b0c14`) and shadow |
| Footer | Overlaps the sky, about 256px top padding; dark card at 1280px; closing line about 40px; link row 14px; very large bold wordmark cropped at the bottom | Plain centered footer | Large closing line over the sky with the download buttons, dark card with link row and a large HIVEMIND wordmark (static, hex-cell texture over a lavender gradient, cropped at the bottom) |

## First screen at 1920x1080

| Measure | Reference | Ours |
|---|---|---|
| Headline | 80px, two lines, top at y=205 | 68px (our headline is longer), two lines, top at y=228 |
| Button | y=415, 169x48 | y=412, 168x48 |
| Dashboard frame top | y=527, 1280px wide | y=544, 1248px wide |
| Dashboard visible above the fold | about 553px | about 536px |

Screenshot: .

## Contrast of hero text over the sky

Measured with : hides all text, screenshots, samples every background pixel under each text box, and reports the worst WCAG ratio for the real text color. The hero text sits on a deepened sky top plus a soft scrim. Large text needs 3:1, small text 4.5:1.

| Element | 1920 | 1440 | 390 |
|---|---|---|---|
| Tagline (68px / 76px / 36px, large) | 4.55 | 4.01 | 3.44 |
| Hero label (12px) | 7.42 | 6.74 | 5.03 |
| Download link (14px) | 11.41 | 10.09 | 9.98 |
| Brand name (22px light) | 7.53 | 7.72 | 6.13 |
| Get Hivemind button (14px, includes its own fill) | 4.71 | 4.78 | 4.77 |

Before the fix, dark mode measured as low as 1.7:1 for the tagline and 1.8:1 for the Download link.

## Downloads and paths

Download links are built from one constant,  on the  element in  (currently the v0.1.0-preview release); without JavaScript they fall back to the releases page. All asset references are relative, so the page works from a sub-path.
