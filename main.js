// Session Transpose: DOM wiring. Connects to LUNA, follows the focused session, shows the
// tracks that will change, and runs AddOnLogic.apply. Every listener is kept so it can be
// released when the session changes.

const $ = (id) => document.getElementById(id);
const TAGS_KEY = `${AddOnLogic.STORE_CONTEXT}.tags`;
let luna;
let session;
let releases = [];
let amount = 0;      // what the stepper shows
let applied = 0;     // what the session is at (saved in the session)
let busy = false;
let rows = [];
const keep = (u) => releases.push(u);
const release = () => { for (const u of releases) u(); releases = []; };

// ---------------------------------------------------------------- tags (this Mac, across sessions)
function loadTags() {
  try {
    const v = JSON.parse(localStorage.getItem(TAGS_KEY));
    if (Array.isArray(v)) return AddOnLogic.normalizeTags(v);
  } catch { /* first run */ }
  return [...AddOnLogic.DEFAULT_TAGS];
}
let tags = loadTags();
function saveTags(next) {
  tags = AddOnLogic.normalizeTags(next);
  try { localStorage.setItem(TAGS_KEY, JSON.stringify(tags)); } catch { /* fine */ }
  renderTags();
  refresh();
}
function renderTags() {
  const root = $('tags');
  root.innerHTML = '';
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = t;
    const x = document.createElement('button');
    x.title = `Stop skipping "${t}"`;
    x.textContent = '×';
    x.onclick = () => saveTags(tags.filter((v) => v !== t));
    chip.appendChild(x);
    root.appendChild(chip);
  }
}
$('addTag').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = e.target.value;
  e.target.value = '';
  if (v.trim()) saveTags([...tags, ...v.split(',')]);
});
$('defaults').onclick = () => saveTags([...AddOnLogic.DEFAULT_TAGS]);

// ---------------------------------------------------------------- stepper and buttons
function paintAmount() {
  if (document.activeElement !== $('amount')) $('amount').value = AddOnLogic.label(amount);
  $('amount').classList.toggle('zero', amount === 0);
  $('current').innerHTML = `Session is at <b>${AddOnLogic.label(applied)}</b>`;
  $('down').disabled = busy || amount <= -AddOnLogic.RANGE;
  $('up').disabled = busy || amount >= AddOnLogic.RANGE;
  $('apply').disabled = busy || !session;
  $('reset').disabled = busy || !session || applied === 0;
}
function message(text, warn = false) {
  $('message').textContent = text;
  $('message').classList.toggle('warn', warn);
}
// type an amount: click the number, type (e.g. -5), Return
$('amount').addEventListener('focus', (e) => e.target.select());
$('amount').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.target.value = AddOnLogic.label(amount); e.target.blur(); }
});
$('amount').addEventListener('blur', (e) => {
  const n = AddOnLogic.parseAmount(e.target.value);
  if (n === null) message(`Type a whole number from -${AddOnLogic.RANGE} to +${AddOnLogic.RANGE}`, true);
  else { amount = n; message(''); }
  paintAmount();
});
$('down').onclick = () => { amount = AddOnLogic.clamp(amount - 1); paintAmount(); };
$('up').onclick = () => { amount = AddOnLogic.clamp(amount + 1); paintAmount(); };
$('apply').onclick = () => run(amount);
$('reset').onclick = () => { amount = 0; paintAmount(); run(0); };
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return;
  if (e.key === 'ArrowUp') { e.preventDefault(); $('up').click(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); $('down').click(); }
});

async function run(target) {
  if (!session || busy) return;
  busy = true; paintAmount();
  message('Transposing...');
  try {
    const r = await AddOnLogic.apply(luna, session, target, tags, (done, total) => message(`Transposing... ${done}/${total}`));
    if (r.blocked.length) {
      message(`Not applied: notes would go past the MIDI range on ${r.blocked.join(', ')}`, true);
    } else {
      const n = r.midiClips + r.audioClips;
      message(n ? `${AddOnLogic.label(target)}: ${r.midiClips} MIDI and ${r.audioClips} audio clips moved (one undo)` : `Already at ${AddOnLogic.label(target)}`);
    }
  } catch (e) {
    message(`Stopped: ${e.message ?? e}`, true);
  } finally {
    busy = false;
    await readState();
    await refresh();
  }
}

// ---------------------------------------------------------------- session state and preview
async function readState() {
  if (!session) return;
  const st = await AddOnLogic.loadState(session);
  applied = st.target;
  // tags saved in this session come back into this Mac's list (so an Add On update that clears
  // the page's storage doesn't lose them)
  const merged = AddOnLogic.mergeTags(tags, st.tags);
  if (merged.length !== tags.length) saveTags(merged);
  paintAmount();
}

let refreshTimer;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(renderTracks, 150);
}
async function renderTracks() {
  if (!session) return;
  const st = await AddOnLogic.loadState(session);
  rows = await AddOnLogic.scan(session, tags, st.overrides);
  const root = $('tracks');
  root.innerHTML = '';
  let tracksIn = 0, clipsIn = 0, skipped = 0;
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = `row${r.excluded ? ' skip' : ''}`;
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = !r.excluded;
    box.title = r.excluded ? 'Tick to transpose this track' : 'Untick to skip this track';
    box.onchange = async () => {
      box.disabled = true;
      const fresh = await AddOnLogic.loadState(session);
      await AddOnLogic.setOverrides(session, AddOnLogic.toggleOverride(fresh.overrides, r.id, box.checked, !!r.tagMatch));
      refresh();
    };
    const name = document.createElement('span'); name.className = 'name'; name.textContent = r.name;
    const what = document.createElement('span'); what.className = 'what';
    const at = document.createElement('span'); at.className = 'at';
    if (r.excluded) {
      what.textContent = r.excluded.manual ? 'skipped (unticked)' : `skipped: ${r.excluded.tag}${r.excluded.where === 'name' ? '' : ` (${r.excluded.where})`}`;
      skipped++;
    } else {
      const parts = [];
      if (r.midi.length) parts.push(`${r.midi.length} MIDI`);
      if (r.audio.length) parts.push(`${r.audio.length} audio`);
      what.textContent = parts.join(' · ') || 'no clips';
      const offs = [...r.midi, ...r.audio].map((c) => st.offsets[c.id] ?? 0);
      const all = [...new Set(offs)];
      at.textContent = all.length === 1 ? (all[0] ? AddOnLogic.label(all[0]) : '') : 'mixed';
      if (r.midi.length + r.audio.length) { tracksIn++; clipsIn += r.midi.length + r.audio.length; }
    }
    const label = document.createElement('label');
    label.append(box, name);
    el.append(label, what, at);
    root.appendChild(el);
  }
  $('summary').textContent = `Will change ${clipsIn} clip${clipsIn === 1 ? '' : 's'} on ${tracksIn} track${tracksIn === 1 ? '' : 's'}; skipping ${skipped}.`;
}

async function bindSession() {
  release();
  session = luna.sessions.current();
  if (!session) {
    $('status').textContent = 'no session open';
    $('tracks').innerHTML = '';
    $('summary').textContent = '';
    applied = 0; paintAmount();
    return;
  }
  await session.ready();
  $('status').textContent = session.name.value ?? session.uid;
  await readState();
  amount = applied;
  paintAmount();
  await renderTracks();
  // follow track changes, names, folders and clips
  keep(session.tracks.onChange(refresh));
  keep(session.buses.onChange(refresh));
  for (const t of session.visibleTracks) keep(t.name.onChange(refresh));
  await session.playlists.load();
  for (const t of session.visibleTracks) {
    const lane = session.playlistFor(t);
    if (lane) keep(lane.clips.onChange(refresh));
  }
  // LUNA's undo/redo puts the saved state back: follow it
  const store = session.storage.context(AddOnLogic.STORE_CONTEXT);
  await store.load();
  keep(store.records.onChange(() => readState().then(refresh)));
  keep(store.value('state', 'transpose').onChange(() => readState().then(refresh)));
}

async function connect() {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'waiting for LUNA...' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') $('status').textContent = 'reconnecting...';
  });
  await bindSession();
}

renderTags();
paintAmount();
connect();
