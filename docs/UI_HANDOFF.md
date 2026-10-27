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
