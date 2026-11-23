// Session Transpose: logic that does not touch the DOM, so tests can exercise it.
//
// How it works (measured live on LUNA 3.1.2, see ../ideas/transpose-varispeed-feasibility.md):
// - Audio clips: the clip's `pitch` property is a ratio (2^(semitones/12)). Writing it keeps the
//   clip's length and source range; LUNA renders the pitched audio. The write SETS the value.
// - MIDI clips: the edit context's `midi_operation {operation:'transpose', value}` over a timeline
//   selection (tracks + range) shifts the notes in it. It ADDS to what is there.
// - Everything in one batch `session.transaction()` is one undo step, including the session
//   storage write that remembers each clip's offset, so LUNA's undo keeps this panel in step.
//
// The session holds a target transpose (e.g. +3). Apply moves every clip on an included track
// to that target from its own original pitch: clips keep their own offset in session storage,
// so clips added later start at 0 and Back to 0 is exact.

const STORE_CONTEXT = 'com.ranrun.session_transpose';
const STORE_RECORD = 'state';
const STORE_FIELD = 'transpose';
const RANGE = 12;
const DEFAULT_TAGS = ['drum', 'kick', 'snare', 'hat', 'perc', '808', 'clap', 'rim', 'tom', 'cymbal', 'shaker', 'loop'];

const AddOnLogic = {
  RANGE,
  DEFAULT_TAGS,
  STORE_CONTEXT,

  // ------------------------------------------------------------ tags (pure)
  /** Tidy a tag list: trimmed, lower case, no blanks or repeats, in the order given. */
  normalizeTags(tags) {
    const out = [];
    for (const t of tags ?? []) {
      const v = String(t).trim().toLowerCase().replace(/\s+/g, ' ');
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  },

  /** The first tag that `name` contains (case-insensitive), or null. */
  matchTag(name, tags) {
    const n = String(name ?? '').toLowerCase();
    return AddOnLogic.normalizeTags(tags).find((t) => n.includes(t)) ?? null;
  },

  /** Merge tag lists (e.g. this Mac's list and one saved in a session), keeping order. */
  mergeTags(...lists) {
    return AddOnLogic.normalizeTags(lists.flat());
  },

  /**
   * The overrides after the user ticks or unticks a track. wantIn: the box's new state;
   * tagged: whether the tags alone would skip it.
   */
  toggleOverride(overrides, trackId, wantIn, tagged) {
    const skip = (overrides.skip ?? []).filter((id) => id !== trackId);
    const include = (overrides.include ?? []).filter((id) => id !== trackId);
    if (!wantIn) skip.push(trackId);
    else if (tagged) include.push(trackId);
    return { skip, include };
  },

  /** A typed amount: "+5", "-3", "7", "−2" (minus sign) -> a whole number in range, or null. */
  parseAmount(text) {
    const m = String(text ?? '').trim().replace(/[\u2212\u2013]/g, '-').match(/^([+-]?)\s*(\d{1,2})$/);
    if (!m) return null;
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    return Math.abs(n) > RANGE ? null : n;
  },

  // ------------------------------------------------------------ amounts (pure)
  clamp(n) {
    return Math.max(-RANGE, Math.min(RANGE, Math.round(Number(n) || 0)));
  },

  ratio(semitones) {
    return Math.pow(2, semitones / 12);
  },

  /** An audio clip's new pitch ratio: its original (current / what was applied) moved to target. */
  pitchFor(currentRatio, fromSemitones, targetSemitones) {
    return (currentRatio / AddOnLogic.ratio(fromSemitones)) * AddOnLogic.ratio(targetSemitones);
  },

  /** "+3", "-2", "0" */
  label(n) {
    return n > 0 ? `+${n}` : String(n);
  },

  /**
   * The edits that bring each clip to `target`. clips: [{uid, kind: 'midi'|'audio', ...}],
   * offsets: {uid: semitones already applied}. Returns [{...clip, from, delta}] for clips
   * that change.
   */
  deltas(clips, offsets, target) {
    const out = [];
    for (const c of clips) {
      const from = offsets?.[c.uid] ?? 0;
      const delta = target - from;
      if (delta !== 0) out.push({ ...c, from, delta });
    }
    return out;
  },

  /** MIDI notes that would leave 0..127. edits: [{delta, low, high, name}] (low/high = note range). */
  outOfRange(edits) {
    return edits.filter((e) => e.kind === 'midi' && e.low !== undefined && (e.low + e.delta < 0 || e.high + e.delta > 127));
  },

  // ------------------------------------------------------------ the session
  /** The folders a channel sits in, innermost first (names). */
  folderNames(session, channel) {
    const names = [];
    let uid = channel.folderUid?.value;
    for (let guard = 0; uid && guard < 32; guard++) {
      const bus = session.buses.byId(uid);
      if (!bus) break;
      names.push(bus.name.value ?? '');
      uid = bus.folderUid?.value;
    }
    return names;
  },

  /**
   * Why a track is left out ({tag, where} or {manual: true}) or null when it is included.
   * overrides: {skip: [trackId], include: [trackId]} chosen with the track checkboxes; they win
   * over the tags.
   */
  exclusion(session, track, tags, overrides = {}) {
    if (overrides.skip?.includes(track.id)) return { manual: true };
    if (overrides.include?.includes(track.id)) return null;
    const own = AddOnLogic.matchTag(track.name.value, tags);
    if (own) return { tag: own, where: 'name' };
    for (const f of AddOnLogic.folderNames(session, track)) {
      const t = AddOnLogic.matchTag(f, tags);
      if (t) return { tag: t, where: `folder "${f}"` };
    }
    return null;
  },

  /**
   * Every visible track with its clips: [{track, id, name, excluded, midi: [clip], audio: [clip]}].
   * Clips are loaded from the track's active playlist.
   */
  async scan(session, tags, overrides = {}) {
    await session.playlists.load();
    const rows = [];
    for (const track of session.visibleTracks) {
      const lane = session.playlistFor(track);
      if (lane) await lane.clips.load();
      const clips = lane ? [...lane.clips.items] : [];
      rows.push({
        track,
        id: track.id,
        name: track.name.value ?? track.id,
        excluded: AddOnLogic.exclusion(session, track, tags, overrides),
        tagMatch: AddOnLogic.exclusion(session, track, tags),
        midi: clips.filter((c) => c.clipType.value === 'midi'),
        audio: clips.filter((c) => c.clipType.value === 'audio'),
      });
    }
    return rows;
  },

  // ------------------------------------------------------------ saved state
  async loadState(session) {
    const store = session.storage.context(STORE_CONTEXT);
    await store.load();
    const v = store.value(STORE_RECORD, STORE_FIELD).value;
    return {
      target: AddOnLogic.clamp(v?.target ?? 0),
      offsets: { ...(v?.offsets ?? {}) },
      tags: Array.isArray(v?.tags) ? v.tags : [],
      overrides: { skip: [...(v?.overrides?.skip ?? [])], include: [...(v?.overrides?.include ?? [])] },
    };
  },

  async saveState(session, state, options = {}) {
    const store = session.storage.context(STORE_CONTEXT);
    await store.load();
    const value = { target: state.target, offsets: state.offsets, tags: state.tags ?? [], overrides: state.overrides ?? { skip: [], include: [] } };
    if (store.value(STORE_RECORD, STORE_FIELD).value === undefined) await store.add(STORE_RECORD, STORE_FIELD, value, options);
    else await store.set(STORE_RECORD, STORE_FIELD, value, options);
  },

  /** Save the track checkboxes (not an undo step: it changes no audio). */
  async setOverrides(session, overrides) {
    const state = await AddOnLogic.loadState(session);
    state.overrides = overrides;
    await AddOnLogic.saveState(session, state);
  },

  // ------------------------------------------------------------ apply
  /**
   * Bring every clip on the included tracks to `target` semitones, as one undo step.
   * Returns {midiClips, audioClips, skipped: [names], blocked: [names]} — blocked is non-empty
   * (and nothing changes) when MIDI notes would leave 0..127.
   */
  async apply(luna, session, target, tags, onProgress = () => {}) {
    target = AddOnLogic.clamp(target);
    const state = await AddOnLogic.loadState(session);
    const rows = await AddOnLogic.scan(session, tags, state.overrides);
    const included = rows.filter((r) => !r.excluded);

    // what has to change
    const clips = [];
    for (const r of included) {
      for (const c of r.midi) clips.push({ uid: c.id, kind: 'midi', clip: c, row: r, name: r.name });
      for (const c of r.audio) clips.push({ uid: c.id, kind: 'audio', clip: c, row: r, name: r.name });
    }
    const edits = AddOnLogic.deltas(clips, state.offsets, target);
    for (const e of edits.filter((x) => x.kind === 'midi')) {
      await e.clip.midi.ready();
      const notes = e.clip.midi.notes.items;
      if (notes.length) { e.low = Math.min(...notes.map((n) => n.pitch)); e.high = Math.max(...notes.map((n) => n.pitch)); }
    }
    const blocked = AddOnLogic.outOfRange(edits);
    if (blocked.length) return { midiClips: 0, audioClips: 0, skipped: [], blocked: [...new Set(blocked.map((b) => b.name))] };

    const snap = session.context.snapshot?.();
    let midiClips = 0, audioClips = 0;
    try {
      await session.transaction(`Transpose ${AddOnLogic.label(target)}`, async () => {
        // MIDI: one midi_operation per clip, over exactly that clip's range on its track, so
        // a clip that needs a different shift (or none) is never caught in the range
        for (const e of edits.filter((x) => x.kind === 'midi')) {
          await session.selectTimeline({ tracks: [e.row.track], startTick: e.clip.start.value, stopTick: e.clip.stop.value });
          await session.context.run('midi_operation', { session_uid: session.uid, context_type: 'main', midi_operation: { operation: 'transpose', value: e.delta } });
          midiClips++;
          onProgress(midiClips + audioClips, edits.length);
        }
        // audio: the clip's pitch is a ratio and a write SETS it, so work from the clip's own
        // original pitch (its current ratio without what this Add On applied before)
        for (const e of edits.filter((x) => x.kind === 'audio')) {
          const now = Number((await luna.raw.get(e.clip.path, { children: false, commands: false, flatvalue: true, propfilter: 'pitch' }))?.properties?.pitch) || 1;
          await luna.raw.set(`${e.clip.path}/pitch`, Luna.float(AddOnLogic.pitchFor(now, e.from, target)));
          audioClips++;
          onProgress(midiClips + audioClips, edits.length);
        }
        for (const e of edits) state.offsets[e.uid] = target;
        for (const uid of Object.keys(state.offsets)) if (state.offsets[uid] === 0) delete state.offsets[uid];
        state.target = target;
        state.tags = AddOnLogic.mergeTags(tags);
        await AddOnLogic.saveState(session, state, { undoable: true });
      });
    } finally {
      if (snap) await session.context.restore(snap);
    }
    return { midiClips, audioClips, skipped: rows.filter((r) => r.excluded).map((r) => r.name), blocked: [] };
  },
};

globalThis.AddOnLogic = AddOnLogic;
