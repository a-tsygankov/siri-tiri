# Siri-Tiri Device UI Handoff

**Target:** Waveshare ESP32-S3 Touch AMOLED 1.75, ESP-IDF/Arduino + LVGL  
**Display:** round 466 × 466 px AMOLED, capacitive touch  
**User:** Andrey, with one cat at home: Tiri  
**Goal:** quickly see when a likely cat vocalization was detected, teach the system what was happening, and optionally respond in the owner's voice.

## Product direction

Use an **event-first companion**: the device spends most of its time in a quiet listening status, then makes reviewing and labeling a detected sound the main action. It should help Andrey build a personal history of Tiri's patterns, not present an unverified “translation.” Use phrases such as “Meow detected,” “Context unclear,” and “This often happens before dinner” only when backed by enough Tiri-specific examples.

The ESP32 is the room endpoint and touch UI. The Raspberry Pi/Home Assistant service performs the initial YAMNet inference and provides optional household context. Sonos is an optional playback destination; its microphones are not used as an audio input.

## Screen mockups

These are 466 × 466 vector mockups and can be opened directly in a browser or used as LVGL layout references.

### 1. Listening / home

![Listening screen](assets/ui-listening.svg)

Primary purpose: show that the device is powered, whether listening is enabled, and how to get to recent events.

- Center: clear listening state and waveform.
- Lower status: microphone on/off, with a distinct muted state.
- Primary touch target: **Recent events**.
- Do not show fake cat presence, emotional state, or a continuously changing “mood meter.”

### 2. Review and label event

![Event review screen](assets/ui-review-event.svg)

Primary purpose: collect quick, low-friction labels from Andrey.

- Show a short waveform, event time, and duration.
- Use calibrated wording: “Meow detected” and “Context unclear.”
- One tap on a context label completes the annotation.
- Initial labels: **Food**, **Attention**, **Play**, **Door**, **Greeting**, **Brushing/handling**, **Other**, **Unsure**. Show four most useful choices on the first view; a **More** action can expose the remaining categories.
- Never require a label. Allow **Unsure** and later correction.
- Optional second step: what happened next? **Ate**, **Approached**, **Settled**, **Meowed again**, **No clear response**.
- Provide **Replay** only as a secondary control; use low playback volume and pause detection during playback.

### 3. Optional reply

![Reply screen](assets/ui-reply.svg)

Primary purpose: let the user choose whether to respond, without making the device speak on its own.

- Ask “Try a familiar reply?” and make **Play my voice** the primary action.
- Keep **Not now** equally easy to reach.
- Use a small, user-curated set of owner-recorded phrases; do not synthesize or play cat meows by default.
- After playback, show **Did Tiri respond?** with **Approached**, **Settled**, **No**, and **Unsure**.
- Playback is opt-in, volume-limited, and has a cooldown to avoid detecting the device's own audio.

## Core workflows

### A. Normal listening

1. Boot into Listening or Muted according to the persisted user setting; show a brief boot/status state.
2. Home screen displays listening state and recent event count/shortcut.
3. Capture a short rolling audio buffer in RAM. Keep it local and discard it unless a candidate event is detected and retention is enabled.
4. On candidate vocalization, send the clip to the Pi inference service.
5. If likely meow/cat sound, show the event review screen. If uncertain or below threshold, keep it out of the interruptive flow and optionally put it in a low-priority event list.
6. Return to the home screen after a timeout or after annotation.

### B. Label an event

1. Review sound type, time, duration, and confidence band (avoid false precision such as “97% hungry”).
2. Tap a context label or Unsure.
3. Optionally add outcome feedback.
4. Save event metadata and permitted clip locally/on the Pi.
5. Return to Listening with a small “Saved” confirmation.

### C. Play a response

1. User explicitly opens Reply or taps a suggestion.
2. Display the selected recording/phrase and sound level.
3. User taps Play my voice.
4. Pause listening/inference while playing; resume after a short cooldown.
5. Ask whether Tiri reacted only if the user remains on screen; never treat lack of tap as a negative result.

### D. Review history and settings

- Recent events: newest first, date/time, sound type, selected context, and whether a clip is retained.
- Settings: listening enabled, local clip retention duration, inference/Pi connection status, device speaker volume, Sonos target, approved owner recordings, and clear/delete controls.
- Make microphone state visible on every screen. The board has no dedicated physical mic-mute switch, so provide a prominent touch mute control and clear muted indication. Consider adding a real hardware mute control in a future enclosure revision if the microphone path can be safely gated.

## Navigation and controls

### Touch

- Touch-first interaction; no small menus or precision gestures.
- Use large targets (target 56 × 56 px or larger where practical). Keep important controls inside an approximately 390 px diameter safe area; avoid text and buttons near the round screen edge.
- Prefer tap, explicit Back, and vertical scrolling for history. Avoid relying on edge swipes, long-presses, or multi-touch for core tasks.
- Keep each screen to one primary action and at most two secondary actions.
- Provide a visible Back/Close control on review and settings. A timeout may return to Listening, but must not discard a label in progress.

### Physical buttons

The PWR and BOOT buttons are board-level controls, not assumed general-purpose app buttons.

- **PWR:** preserve the PMIC/power behavior defined by Waveshare's BSP; do not repurpose without verifying the hardware/firmware behavior.
- **BOOT/GPIO0:** could support a short runtime action (such as mute toggle) only after firmware and enclosure validation. Holding it during reset may enter download mode, so do not assign a hold gesture or rely on it as the sole mute control.
- All essential app actions must remain available through touch.

## UI states and feedback

- **Booting:** logo/title, then connected/offline state; do not block indefinitely waiting for the Pi.
- **Listening:** mic enabled, Pi status, recent event shortcut.
- **Muted:** obvious muted icon and text; no audio capture/transmission.
- **Processing:** brief, non-blocking indicator with cancel/timeout.
- **Event found:** event type and confidence band; no intent claim.
- **Offline:** show that sound detection may be unavailable; local mute and settings remain usable.
- **Saving:** confirm when feedback is persisted; show retry if service is unavailable.
- **Reply playback:** explicit speaker indicator, volume control, listening cooldown, stop control.
- **Low battery/charging:** show only when battery telemetry is valid; board PMIC supports battery status.

## Feature priority

### P0 — first usable build

- Listening/Muted home state and visible mic status.
- Candidate event notification and recent-event review.
- Fast labels including Unsure.
- Pi connection state and graceful offline behavior.
- Delete/retention controls for recorded clips.
- Local device speaker playback for reviewing a clip, with detection paused.

### P1 — after detection and labeling are reliable

- Event history and optional outcome feedback.
- Owner-recorded reply phrases.
- Sonos playback through Home Assistant.
- Simple settings for volume, retention, and reply behavior.
- Context from Home Assistant, shown as supporting evidence rather than a definitive interpretation.

### Later

- Tiri-specific pattern summaries after sufficient reviewed examples.
- Notification/suggestion personalization and quiet hours.
- Multiple cat profiles only if household changes.
- On-device inference only after comparing Pi service and ESP32 performance.

## Visual and interaction guidance

- Dark AMOLED base to take advantage of true black and reduce visual glare; use warm amber for listening, teal for saved/positive feedback, and muted violet for reply controls.
- Use high contrast, short labels, and a type scale roughly 14–28 px; body text should usually be 16 px or larger on the screen.
- Do not encode status by color alone; pair color with text/icon.
- Keep motion subtle: a slow listening pulse is fine; avoid constant animation that suggests sound is being captured when muted.
- Use short haptics only if the board has a supported tactile output added; it has no built-in vibration motor.
- Audible feedback should be off by default or quiet, to avoid disturbing Tiri.

## Developer notes

- Implement as a small set of LVGL screens/components with explicit state transitions: Home, EventReview, LabelMore, Reply, History, Settings.
- Keep audio inference and UI state separate. UI consumes event/state messages from the device/Pi service; it should not infer semantics from raw model scores.
- Surface detector output as “likely meow”/“possible cat sound” plus confidence band. Only the downstream personalized model may produce cautious context suggestions.
- Give event review a stable ID so a label can be retried safely if the Pi is temporarily offline.
- Define clip retention and deletion in the service contract; do not silently upload audio to a cloud endpoint.
- Preserve microphone state during navigation and restore it after playback cooldown.
- Verify actual touch controller orientation, circular edge dead zones, PWR/BOOT access, and screen safe-area against the final enclosure.

## Acceptance criteria

- From the home screen, a user can identify mic state and open recent events in one tap.
- A candidate event can be labeled in one tap, or explicitly marked Unsure.
- Muting stops recording/transmission and is visibly confirmed.
- Pi disconnection does not freeze the UI or prevent local mute/settings access.
- Playback cannot create an immediate self-detection loop.
- No screen claims to know Tiri's exact meaning or emotional state.
- Every retained clip can be reviewed and deleted.

## Hardware reference

- Board: [Waveshare ESP32-S3 Touch AMOLED 1.75 hardware reference](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75/blob/main/HARDWARE_REFERENCE.md)
- Project: [siri-tiri](https://github.com/a-tsygankov/siri-tiri)


## Round-screen event review refinement

![Compact event review](assets/ui-review-event.svg)

![Optional event details](assets/ui-review-details.svg)

The panel is a true 466 × 466 circle. Treat the outer edge as unavailable for essential text or controls. Use a centered safe circle about 390 px in diameter (roughly 38 px of inset from the panel edge), then verify real touch coordinates and any bezel/enclosure occlusion on the hardware. Keep the title, event facts, all primary actions, and navigation inside that safe circle. The older review mockup placed some lower button corners too near the rim; use the compact mockup below as the revised layout reference.

### Event review options

| Pattern | First screen | Optional details | Trade-off |
|---|---|---|---|
| **Quick label + More (recommended)** | “Meow detected,” brief timestamp, and four large context choices: Food, Attention, Play, Unsure. One tap saves. | “More” opens additional context labels, clip playback, model confidence band, and outcome feedback. | Fast for routine examples; details stay available without crowding every event. |
| **One question at a time** | Ask “What was happening?” and show one large choice with previous/next arrows; tap choice to save. | Browse all labels, replay, and add an outcome on a second page. | Largest tap target and clearest focus, but slower when labeling many events. |
| **Event card first** | Show “Meow detected,” time, and a large “Review” action. | The next screen contains labels, playback, and details. | Very calm and uncluttered, but adds a tap before the main task. |

Use **Quick label + More** as the default because the common task remains one tap while the optional fields are genuinely optional. If the four labels prove too dense at the device’s actual viewing distance, fall back to **One question at a time** rather than shrinking the controls.

### Compact review workflow

1. The event alert opens directly to the quick-label screen.
2. The screen shows the event type and time in the upper half, plus four context buttons in a centered 2 × 2 grid.
3. Tapping a context button saves immediately and returns to Listening. A small **More details** link opens the optional page.
4. The optional page can include:
   - Replay clip (explicit tap; pause listening during playback).
   - Approximate duration and time.
   - Detector label and confidence band, such as “Likely meow” / “Possible cat sound”; avoid false precision.
   - Additional context: Greeting, Door, Brushing/handling, Other.
   - “What happened next?”: Ate, Approached, Settled, Meowed again, No clear response, Unsure.
5. A visible Back/Close action returns to the quick-label page without losing any choice. A label is not required to dismiss the event.

Do not show waveform, exact model scores, confidence percentages, inferred intent, household context, and feedback controls all at once. Optional evidence should be disclosed on demand and described as evidence, not a translation.

### Round-layout and touch rules

- Keep important content inside a centered safe circle about 390 px across. Avoid placing button corners, status text, or back controls at the very bottom or far sides.
- Prefer a 2 × 2 button grid centered below the event facts. Target at least 48 px control height and leave visible gaps between hit areas.
- Use short labels and 1–2 text lines. Truncate secondary metadata instead of wrapping into the curved edge.
- Avoid radial menus that put small targets around the circumference. A circular screen does not make edge targets easier to reach.
- Avoid swipe-only navigation. A tap target for **More details**, plus visible Back, works for either hand and avoids accidental edge gestures.
- Use display masks or circular clipping only for artwork and background decoration; place actual text and hit targets inside the safe circle.
- Validate the layout on the 466 × 466 panel with the bezel and enclosure installed. The SVG is a layout guide, not a touch-calibration guarantee.

## UI framework options

| Option | What it provides | Fit for this device |
|---|---|---|
| **LVGL 9 with Waveshare’s board support package (recommended)** | Embedded widgets, layouts, touch input, and display refresh; Waveshare publishes examples for this exact 466 × 466 panel, including LVGL 9, touch, and an LVGL SquareLine demo. | Best match for this app and the exact hardware. Start from the board vendor’s LVGL example/BSP rather than mixing in another board’s display driver. Choose ESP-IDF or Arduino based on the existing firmware; keep the LVGL major version aligned with that example. |
| **SquareLine Studio (optional visual editor)** | Desktop UI editor that exports LVGL UI code; supports round-display project settings. | Use it to explore layout and generate static screen structure/assets, while keeping event logic, network state, and component behavior in hand-written firmware. It complements LVGL; it is not a replacement GUI runtime. Confirm its LVGL export version matches the firmware. |
| **Arduino_GFX / direct drawing** | Lower-level drawing primitives and text rendering. | Fine for a tiny fixed screen with a few hand-drawn controls, but it provides less reusable widget and interaction structure. The vendor supports it for basic display examples, while its richer touch UI examples use LVGL. |
| **ESP-Brookesia** | Espressif’s broader product/HMI framework, including app/runtime/service layers on top of GUI components. | Technically available in the vendor’s firmware examples, but likely more framework than this small, single-purpose companion needs. Borrow patterns or examples only if the project later grows into a multi-app device. |

**Recommendation:** Keep the product UI on LVGL using the Waveshare BSP and its compatible LVGL version. Use SquareLine Studio only if it speeds up screen composition. The strongest evidence is the board vendor’s exact-device LVGL examples and factory SquareLine/LVGL demo; the recommendation is an engineering judgment based on the app’s small screen count and interaction needs.

### Framework references

- [Waveshare board repository and example catalog](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75)
- [Waveshare examples: LVGL widgets, touch, SquareLine, and board-specific requirements](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75/blob/main/docs/examples.md)
- [Waveshare board support component](https://components.espressif.com/components/waveshare/esp32_s3_touch_amoled_1_75)
- [LVGL](https://github.com/lvgl/lvgl)
- [SquareLine Studio](https://squareline.io/)
- [Espressif ESP-Brookesia](https://github.com/espressif/esp-brookesia)


## Small-screen interaction: swipes and moving text

The Android Wear and Apple Watch guidance is useful as a reference for a round, glanceable surface, but this ESP32 has no watch bezel or crown. Keep input touch-first and borrow only the patterns that translate.

![Gesture and text behavior exploration](assets/ui-small-screen-gestures-text.svg)

### Touch strokes / swipes

Use gestures as **shortcuts that duplicate visible actions**, not as the only way to act.

- Good candidate: on Recent Events, a horizontal swipe moves to the previous or next event; keep visible previous/next tap targets as well.
- Also reasonable: a standard swipe-back to close an optional detail page, provided a visible Back control remains.
- Keep event labeling, mute/unmute, playback, and any action that commits or deletes data as explicit taps. A swipe may be misread or performed accidentally.
- Avoid custom drawn shapes, multi-finger strokes, or gestures that depend on starting from an invisible region. The device is stationary, so these patterns add memorization without a clear benefit.
- Do not make vertical swipes compete with a vertically scrolling page. If a screen scrolls, use the swipe for scrolling and reserve other gesture directions for a distinct navigation purpose.
- Give each gesture a clear hint the first few times, or a small persistent affordance such as “Swipe to browse”; keep the visible controls usable even after the hint is dismissed.

### Running / marquee text

Moving text can help when the exact content matters and is too long to fit, but it should be an exception.

- For the usual event screen, keep short event facts stationary. Prefer a short label, a second line, or ellipsis with a tap-to-expand details action.
- Reserve marquee for a rare long title or device/room name that the user needs to identify in full. Show at most one moving line at a time, with a short delay before it starts and a pause at each end; do not animate every status field.
- If the exact full text is important for a decision or annotation, tapping to open a stationary details view is more reliable than requiring the user to catch a moving line.
- LVGL supports label overflow modes including scrolling/back-and-forth and circular scroll; that is a rendering capability, not a reason to make every long string move.
- Treat sustained automatic movement as an accessibility concern. WCAG 2.2.2 recommends a way to pause, stop, or hide automatically moving or scrolling content that persists over five seconds alongside other content. For this device, the simpler design is to avoid persistent marquee or provide a tap/pause affordance.

### Practical recommendation for Siri-Tiri

- Use horizontal swipe only for browsing between events, as a duplicate of visible event navigation controls.
- Use tap-to-reveal for long context and detector metadata. Do not auto-scroll the event alert or home screen.
- Consider a slow, single-line marquee only for future user-provided names (for example, a long room or speaker name) after testing it on the actual panel. Keep the label fixed while its text moves, and stop motion when the user touches or leaves the screen.
- The new comparison mockup demonstrates these choices; it is an interaction study, not a requirement to implement marquee.

### Sources and limits

- [Apple Human Interface Guidelines: Designing for watchOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-watchos/) recommends glanceable, focused interactions; its hardware-specific crown guidance does not apply to this ESP32.
- [Apple Human Interface Guidelines: Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures/) describes swipe as a familiar way to reveal actions, dismiss views, and scroll.
- [Android Wear: adaptive design for round displays](https://developer.android.com/design/ui/wear/guides/foundations/adaptive-design) describes distinct layout needs for round scrolling and non-scrolling screens.
- [Android Wear: media controls](https://developer.android.com/design/ui/wear/guides/patterns/media/controls) provides a useful precedent: long media titles can scroll while secondary artist text truncates, with minimum tap targets preserved.
- [LVGL 9 label overflow](https://lvgl.io/docs/open/9.4/details/widgets/label.html) documents the available label scrolling modes.
- [W3C WCAG 2.2.2: Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide) explains the pause/stop/hide guideline for persistent moving content. Its formal applicability depends on the interface and context; here it is used as a general accessibility design reference.
