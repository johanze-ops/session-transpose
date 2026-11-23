// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
// The engine edits themselves (clip pitch, midi_operation) were proven live on LUNA 3.1.2;
// these tests cover the decisions around them.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const logic = globalThis.AddOnLogic;

async function connected(tracks = ['Keys', 'Kick In', 'Pad', 'Riser FX']) {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  return { engine, luna, session };
}

describe('tags', () => {
  it('tidies a list: trimmed, lower case, single spaces, no repeats or blanks', () => {
    expect(logic.normalizeTags([' Drum', 'drum', '', 'White  Noise ', 'FX'])).toEqual(['drum', 'white noise', 'fx']);
  });

  it('matches anywhere in a name, ignoring case', () => {
    expect(logic.matchTag('Kick In', ['kick'])).toBe('kick');
    expect(logic.matchTag('Big White Noise Riser', ['white noise'])).toBe('white noise');
    expect(logic.matchTag('Piano', logic.DEFAULT_TAGS)).toBe(null);
  });

  it('merges this Mac’s list with one saved in a session, keeping order', () => {
    expect(logic.mergeTags(['drum', 'fx'], ['FX', 'crash'])).toEqual(['drum', 'fx', 'crash']);
  });
});

describe('amounts', () => {
  it('reads a typed amount', () => {
    expect(['+5', '-3', '7', ' 12 ', '\u22122', '13', 'x', '', '+'].map((t) => logic.parseAmount(t))).toEqual([5, -3, 7, 12, -2, null, null, null, null]);
  });

  it('clamps to an octave each way and rounds', () => {
    expect([logic.clamp(15), logic.clamp(-13), logic.clamp(2.4), logic.clamp('x')]).toEqual([12, -12, 2, 0]);
  });

  it('labels with a sign', () => {
    expect([logic.label(3), logic.label(-2), logic.label(0)]).toEqual(['+3', '-2', '0']);
  });

  it('works out each clip’s shift from its own offset, so new clips catch up and Back to 0 is exact', () => {
    const clips = [{ uid: 'a', kind: 'midi' }, { uid: 'b', kind: 'audio' }, { uid: 'new', kind: 'audio' }];
    const offsets = { a: 3, b: 3 };
    expect(logic.deltas(clips, offsets, 5).map((e) => [e.uid, e.from, e.delta])).toEqual([['a', 3, 2], ['b', 3, 2], ['new', 0, 5]]);
    expect(logic.deltas(clips, offsets, 0).map((e) => [e.uid, e.delta])).toEqual([['a', -3], ['b', -3]]);
    expect(logic.deltas(clips, { a: 4, b: 4, new: 4 }, 4)).toEqual([]);
  });

  it('keeps an audio clip’s own pitch underneath what it applies', () => {
    // a clip the user had already pitched to 1.5, then +3 by this Add On, moved to +5
    const now = 1.5 * logic.ratio(3);
    expect(logic.pitchFor(now, 3, 5)).toBeCloseTo(1.5 * logic.ratio(5), 12);
    expect(logic.pitchFor(now, 3, 0)).toBeCloseTo(1.5, 12);
    expect(logic.pitchFor(1, 0, 12)).toBeCloseTo(2, 12);
  });

  it('refuses MIDI shifts that would push notes past 0 or 127', () => {
    const edits = [
      { kind: 'midi', name: 'Lead', low: 60, high: 120, delta: 8 },
      { kind: 'midi', name: 'Bass', low: 3, high: 40, delta: -4 },
      { kind: 'midi', name: 'Keys', low: 48, high: 84, delta: 12 },
      { kind: 'audio', name: 'Vox', delta: 12 },
    ];
    expect(logic.outOfRange(edits).map((e) => e.name)).toEqual(['Lead', 'Bass']);
  });
});

describe('the session', () => {
  it('leaves out tracks whose names match a tag, and says which tag', async () => {
    const { session } = await connected();
    const tags = [...logic.DEFAULT_TAGS, 'fx'];
    const out = session.visibleTracks.map((t) => [t.name.value, logic.exclusion(session, t, tags)?.tag ?? null]);
    expect(out).toEqual([['Keys', null], ['Kick In', 'kick'], ['Pad', null], ['Riser FX', 'fx']]);
  });

  it('lets the track checkboxes override the tags either way', async () => {
    const { session } = await connected(['Keys', 'Big SN', 'Kick In']);
    const [keys, sn, kick] = session.visibleTracks;
    let o = { skip: [], include: [] };
    o = logic.toggleOverride(o, sn.id, false, false);    // untick "Big SN" (no tag catches it)
    o = logic.toggleOverride(o, kick.id, true, true);    // tick "Kick In" back in despite "kick"
    expect(o).toEqual({ skip: [sn.id], include: [kick.id] });
    expect(logic.exclusion(session, sn, logic.DEFAULT_TAGS, o)).toEqual({ manual: true });
    expect(logic.exclusion(session, kick, logic.DEFAULT_TAGS, o)).toBe(null);
    expect(logic.exclusion(session, keys, logic.DEFAULT_TAGS, o)).toBe(null);
    o = logic.toggleOverride(o, sn.id, true, false);     // tick it again: back to the tags' say
    expect(o).toEqual({ skip: [], include: [kick.id] });
  });

  it('remembers the target, clip offsets and tags in session storage', async () => {
    const { engine, session } = await connected();
    const none = { skip: [], include: [] };
    expect(await logic.loadState(session)).toEqual({ target: 0, offsets: {}, tags: [], overrides: none });
    await logic.saveState(session, { target: 3, offsets: { a: 3 }, tags: ['drum', 'fx'], overrides: none });
    await engine.settled();
    expect(await logic.loadState(session)).toEqual({ target: 3, offsets: { a: 3 }, tags: ['drum', 'fx'], overrides: none });
    await logic.saveState(session, { target: 0, offsets: {}, tags: ['drum', 'fx'] });
    await engine.settled();
    expect((await logic.loadState(session)).target).toBe(0);
  });
});
