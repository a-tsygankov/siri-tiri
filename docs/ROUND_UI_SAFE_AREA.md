# Round AMOLED safe-area UI: findings and revised mockups

Target: Waveshare ESP32-S3 Touch AMOLED 1.75, 466 × 466, LVGL.

## Observed issues (iPhone ChatGPT mockup review)
- A flex/aspect-ratio based circular preview stretched vertically, separating waveform and controls. Avoid nested auto-height layouts for pixel-accurate previews.
- A later fixed-coordinate SVG preserved the circle, but the second row of buttons crossed the lower circumference.
- Moving the row without checking full button bounds is insufficient. Test the complete rectangle (and its rounded corners), not merely the center.
- Long descriptive text can be truncated; moving text should be an enhancement, never required to identify an action or read microphone status.

## Layout geometry
For a screen centered at (233,233), radius 233 and an inset of 16 px, the conservative safe radius is 217 px. At y, the maximum half-width is sqrt(217²-(y-233)²). For a rectangular component spanning y0..y1, use the farther endpoint from 233 to compute the minimum permitted half-width; add padding and check all four corners. For rounded rectangles, a tighter shape-aware test is possible, but rectangular containment is safer.

**Important correction:** The earlier proposed two-column buttons x=67..227 and x=239..399, y=350..397 are NOT safe: at y=397, the permitted x range is about 91..375, so the outer edges clip. This revised mockup uses a 2×2 grid at x=104..227 and 239..362, y=286..334 and 344..392. At y=392, the conservative permitted x range is approximately 85..381. All buttons fit with margin.

Suggested review zones: header y=54–78; title y=94–128; waveform y=139–181; time y=202; single-line description y=228–252; prompt y=267–287; buttons y=292–340 and 347–395; Later y=411–431. Measure text bounds and bottom hit target carefully; the lower edge is narrow, so Later should be a compact centered button.

## Text overflow
- Fixed labels (Listening, Muted, Food, Play, Unsure, Later) never scroll.
- For optional metadata, use a one-line clipped viewport with a 1.5s initial delay, 25–35 px/s scroll, pause at both ends, and stop when leaving the screen.
- Prefer a back-and-forth scroll over continuous ticker for short descriptions. Honor reduced-motion settings where available. Tap opens full details.
- LVGL 9 offers label long modes including SCROLL and SCROLL_CIRCULAR; test these on the device for timing, clipping and CPU use.
- No animation should change the containing widget's width or height.

## Interaction rules
- The ESP32 uses an event-first, one-tap review flow; Unsure and Later remain visible.
- Saving shows Undo; offline state distinguishes queued feedback from synced feedback.
- Sound detection does not assert the cat's intent or mood.
- Keep microphone state explicit with text and icon, independent of Tiri's silhouette.
- Touch targets should be tested on actual hardware; target 48–56 px where practical and avoid edge interactions.

## Validation checklist
1. Render at native 466 × 466 and on iPhone at scaled sizes without aspect distortion.
2. Programmatically assert every interactive element's bounding box lies inside the inset circle (including full height).
3. Test long localized strings, dynamic text size, and truncation vs scrolling.
4. Test Home, Review, Saved, Muted, Offline, Playback, Settings.
5. Test real capacitive touch hit regions, not just visible SVG shapes.

See [round-safe-area-v3.svg](assets/round-safe-area-v3.svg) for the revised, geometry-safe review mockup. This is a static concept, not running firmware.
