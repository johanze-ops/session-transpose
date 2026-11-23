# Notes for the LUNA Add On reviewer

**What it does:** transposes a whole session by ±12 semitones, every MIDI clip and every audio
clip, as one undo step, skipping tracks whose names (or folder names) match exclude tags, or
that the user unticks. The amount is the session's transpose: each clip's offset is kept in
session storage, so Back to 0 is exact and clips added later catch up.

**How it uses LUNA** (no helper, no network):

- MIDI clips: the `main` edit context's `midi_operation {operation: 'transpose', value}` over a
  timeline selection of exactly that clip (`session.selectTimeline`, then `context.run`). The
  user's selection is saved with `context.snapshot()` and put back after.
- Audio clips: the clip's `pitch` property (a ratio, 2^(semitones/12)), written with
  `luna.raw.set(<clip>/pitch, Luna.float(ratio))`. This isn't a typed SDK method; we measured
  on LUNA 3.1.2 that it keeps the clip's length and source range and LUNA renders the pitched
  audio. The edit context's `separate_and_edit_clips {property: 'pitch'}` answered but
  changed nothing in our tests, so it isn't used.
- Everything, including the session-storage write, runs in one batch `session.transaction()`,
  so one Undo reverts the clips and the panel's state together.
- Session storage context `com.ranrun.session_transpose` (target, per-clip offsets, track
  ticks, a copy of the tags). The tag list is also in the page's `localStorage`, keyed by the
  Add On id.

**Tested on** LUNA 3.1.2 (macOS): a scratch session (MIDI, a sine clip, a drum loop on a
"drums" track) and LUNA's demo session. Checked: notes and pitches read back after Apply and
Back to 0, a skipped track left alone, a single Undo reverting everything, and the panel
following undo/redo.

**Quick test:** open any session with MIDI and audio, open Add Ons > Browsers > Session
Transpose, set +3, Apply, listen, then Undo once.
