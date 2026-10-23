# Landing page polish: design measurements

Design measurements only, taken with headless Playwright at 1440x900 and 390x844 while scrolling the reference slowly. No text, imagery, code or assets from the reference are in this repo; the page uses its own copy, CSS/SVG sky, UI illustrations and implementation. Reference screenshots stayed in a scratch folder.

| Item | Reference | Ours before | Ours now |
|---|---|---|---|
| Background | Full-page twilight gradient photo, cloud layers at top and bottom | Flat near-black, hex glow | Generated sky: CSS gradient (dusk to navy to violet) plus SVG fractal-noise clouds top and bottom, faint hex motif. Light theme gets a dawn sky |
| Body font / weight | Inter, 300 for headings and large copy | Inter 600 headings | Inter 300 headings, 300 body |
| H1 | 75.6px at 1440 (`clamp(38px,5.25vw,80px)`), weight 300, line-height 1.06, centered, 1088px wide, starts y=171 | clamp(30,3.9vw,56) weight 600, line-height 1.08 | `clamp(36px,5.25vw,76px)`, 300, 1.06, max 1088px, top padding 171px (three balanced lines for our longer headline) |
| H1 motion | Per word: opacity 0 to 1, blur 10px to 0, translateY about 0.38em to 0, about 0.65s each, about 0.14s stagger | Block fade | Per word, same blur/rise, 0.65s, 90ms stagger |
| H2 / H3 | H2 38px (feature headings), 300, tracking -0.025em, line-height 1.1 | H2 56px 600 | H2 `clamp(30,3.6vw,48)`, H3 `clamp(26,2.6vw,38)`, 300, -0.025em, 1.1 |
| Feature copy | 22px / 29.7px, weight 300, white at 48% | 16px, muted | `clamp(17,1.5vw,21)` / 1.45, 300, white at 62% (kept higher for contrast) |
| Header | 1280px max, 24px vertical padding, 41px logo tile radius 9px, 1px white/22 border, blur; wordmark 22px 300; right link 14px/500 white/70 | 1120px, 28px logo, 17px text | Same 41px tile, 22px/300 wordmark, 14px/500 link, 1280px |
| Sticky corner button | Fixed top-right, 149x42, md and up, appears after the hero | None | Fixed top-right glass button, shown from the screenshot onward, hidden under 768px |
| Buttons | 48px tall, radius 5px, 1px white/30, bg white/8, blur 12px, 14px/500, padding 0 28px, arrow | 999px pill, 16px | Same: 48px, 5px radius, white/30 border, white/8, blur 12px, 14px/500, arrow |
| Screenshot frame | 1280px wide, 8px padding, 1px white/22 border, white/6 fill, blur, radius 4px, inner radius 4px, gradient ring; overlaps the hero from y=483 | 14px radius, fake window bar, offset shadow | Same padding, border, fill, blur and 4px radii, gradient ring via masked border, begins in the hero at about y=560 |
| Story section | Height 5040px (5.6 viewports) with a `sticky top-0 h-[100svh]` inner; scroll position selects one of nine steps; headline fixed top-left; progress dashes bottom-left; step crossfade 0.5s `cubic-bezier(.4,0,.2,1)` | Three stacked rows | Height 4 viewports, sticky 100svh inner, three problems advance by scroll progress, crossfade 0.5s same easing (opacity, rise, blur), dashes bottom-left. Stacks under 861px and with reduced motion |
| Feature rows | 12-col grid, text 4 cols and image 8, gap 40 (64 at xl), section padding 128px, alternating | Three equal cards | 12-col grid, text 5 and panel 6, gap 40, rows alternate, padding 128px section / 64px row |
| Panels | `rounded-[6px]`, border white/12, bg `#090a0d`, shadow `0 40px 120px -40px rgba(0,0,0,.78)` | 12-14px radii, solid | 6px radius (4-5px inside), white/12 to 22 borders, glass dark fill, same shadow |
| Footer | Overlaps the sky by -160px, top padding 256px; dark card max 1280, radius 6, closing line 40px/300 left and button right; link row 14px white/70 over a 1px white/10 rule; wordmark SVG 258px bold, gradient highlight sweeping on a 3.4s loop, cropped at the card bottom | Plain centered footer | Closing line (`clamp(40,6.4vw,96)`, 300) over the sky with the download buttons, then a dark card with the same border, radius, shadow, link row, and a bold HIVEMIND wordmark with a 4s gradient sweep cropped at the bottom |
| Scroll reveal | Fade, rise and blur on entry | 28px rise, fade | 24px rise, 8px blur, 0.8s `cubic-bezier(.22,.8,.2,1)` |

Not matched on purpose: our headline is longer, so it sets in three lines at the same scale; nine-step story becomes three; copy stays contrast-safe in light and dark.
