/**
 * dsh-550w-boot — integration assertions, no browser and no dsh restart.
 *
 * Runs the real lib/client.js inside a vm sandbox against the module-loader and
 * slot API the app provides, then checks the plugin contract, the terminal
 * timeline's ordering invariants, and the lifecycle.
 *
 * Usage: node test/render.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const SRC = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ── Sandbox ───────────────────────────────────────────────────────────────
let now = 1_000_000;
const timers = [];
const listeners = [];
const styles = [];
const byId = new Map();

function fakeEl(tag) {
  const el = {
    tagName: tag,
    dataset: {},
    style: { setProperty() {}, display: '' },
    offsetWidth: 0,
    textContent: '',
    _classes: new Set(),
    classList: {
      add: (c) => el._classes.add(c),
      contains: (c) => el._classes.has(c),
    },
    remove: () => { const i = styles.indexOf(el); if (i >= 0) styles.splice(i, 1); },
  };
  return el;
}

const document = {
  head: { appendChild: (el) => styles.push(el) },
  createElement: (tag) => fakeEl(tag),
  getElementById: (id) => byId.get(id) ?? null,
};

const window = {
  __ModuleLoader__: { load: (spec) => { window.__spec = spec; } },
  addEventListener: (type, fn) => listeners.push({ type, fn }),
  removeEventListener: (type, fn) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
};

const sandbox = {
  window,
  document,
  Date: { now: () => now },
  setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
  clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  console,
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

const spec = window.__spec;
const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  }),
};
const plugin = spec.factory((id) => {
  if (id === 'react') return reactStub;
  throw new Error('unexpected require: ' + id);
});

const disposers = [];
const calls = { inject: [], register: [] };
function mount() {
  const ctx = {
    effect: (fn) => { disposers.push(fn()); },
    slots: {
      inject: (name, cb) => { calls.inject.push(name); return cb(); },
      register: (meta, render) => { calls.register.push({ meta, render }); return () => {}; },
    },
  };
  plugin.apply(ctx);
  return ctx;
}

/** Expand function components down to the host tree. */
function resolve(el) {
  let node = el;
  for (let i = 0; i < 200; i++) {
    if (node === null || node === undefined || node === false) return null;
    if (typeof node !== 'object' || typeof node.type !== 'function') return node;
    node = node.type(node.props);
  }
  throw new Error('component tree did not settle');
}

/** Walk a host tree, expanding function components and flattening arrays. */
function walk(n, out = []) {
  if (n === null || n === undefined || typeof n !== 'object' || n === false) return out;
  if (Array.isArray(n)) {
    for (const item of n) walk(item, out);
    return out;
  }
  if (typeof n.type === 'function') return walk(n.type(n.props), out);
  out.push(n);
  const kids = n.props && n.props.children;
  for (const k of Array.isArray(kids) ? kids : [kids]) walk(k, out);
  return out;
}

const ofClass = (nodes, cls) =>
  nodes.filter((n) => typeof n.props.className === 'string' &&
    n.props.className.split(' ').includes(cls));

/** Read the seconds out of "calc(var(--w550-t, 0s) + 1.5s)". */
function delayOf(str) {
  const m = /\+ (\d+(?:\.\d+)?)s/.exec(String(str));
  assert.ok(m, 'no numeric delay in: ' + str);
  return Number(m[1]);
}

const results = [];
const check = (name, fn) => {
  try { fn(); results.push([true, name]); }
  catch (e) { results.push([false, name + ' — ' + e.message]); }
};

// ── Contract ──────────────────────────────────────────────────────────────
check('browser half registers itself through __ModuleLoader__ with the plugin id', () => {
  assert.ok(spec, 'client.js never called __ModuleLoader__.load');
  assert.equal(spec.id, 'dsh-550w-boot');
});

check('declares the slots service and exports apply', () => {
  assert.deepEqual([...plugin.inject], ['slots']);
  assert.equal(typeof plugin.apply, 'function');
});

check('apply() injects the stylesheet once, tagged with the plugin id', () => {
  mount();
  assert.equal(styles.length, 1);
  assert.equal(styles[0].dataset.plugin, 'dsh-550w-boot');
  assert.ok(styles[0].textContent.length > 500, 'stylesheet looks empty');
});

check('registers into shell.overlay at the top of the stack', () => {
  assert.deepEqual(calls.inject, ['shell.overlay']);
  assert.equal(calls.register.length, 1);
  const meta = calls.register[0].meta;
  assert.equal(meta.name, 'shell.overlay');
  assert.equal(meta.id, 'dsh-550w-boot');
  assert.equal(meta.order, 9999);
});

check('arms a keydown enter listener and the hold safety timer', () => {
  assert.deepEqual(listeners.map((l) => l.type), ['keydown']);
  assert.ok(timers.some((t) => t.ms > 1000), 'no retire timer was armed');
});

// ── Render ────────────────────────────────────────────────────────────────
const renderSlot = calls.register[0].render;
const tree = resolve(renderSlot());
const nodes = walk(tree);
const css = styles[0].textContent;

check('renders the overlay root inside the boot window', () => {
  assert.ok(tree, 'slot rendered nothing');
  assert.equal(tree.props.className, 'w550-root');
  assert.equal(tree.props.id, 'dsh-550w-boot-root');
});

check('the overlay never swallows pointer input', () => {
  assert.match(css, /\.w550-root\{[^}]*pointer-events:none/);
});

check('renders the five terminal windows of the pinwheel with their titles', () => {
  const wins = ofClass(nodes, 'w550-win');
  assert.equal(wins.length, 5, 'expected five terminal windows');
  const text = nodes.map((n) => n.props.children).filter((c) => typeof c === 'string');
  for (const title of ['Windows PowerShell', 'root@moss-550w: ~', 'root@cam-01: ~/ws',
    'root@cam-01: ~']) {
    assert.ok(text.includes(title), 'missing window title: ' + title);
  }
  // the layout key: two aligned columns sharing one gutter, a hole in the middle
  const places = wins.map((w) => w.props.style);
  const lefts = places.map((p) => parseFloat(p.left));
  assert.deepEqual(lefts.slice().sort((a, b) => a - b),
    [5.4, 5.4, 34, 52.6, 78.5], 'the panes no longer share the key columns');
  for (const w of wins) {
    assert.ok(w.props.style.left !== undefined,
      'every pane is placed from its left edge so the columns line up');
    assert.ok(w.props.style.height !== undefined,
      'the plan fixes each rectangle, so every pane states its height');
  }
  for (const w of wins) {
    assert.ok(w.props.style.top !== undefined, 'window has no vertical placement');
  }
});

check('every typed command reveals exactly its own character count', () => {
  const typed = ofClass(nodes, 'w550-typed');
  assert.equal(typed.length, 5, 'expected one typed command per window');
  for (const t of typed) {
    const text = String(t.props.children);
    const anim = t.props.style.animation;
    assert.ok(anim, 'typed line has no inline animation');
    assert.match(anim, /steps\((\d+),end\)/, 'typed line is not step-revealed: ' + anim);
    const stepCount = Number(/steps\((\d+),end\)/.exec(anim)[1]);
    assert.equal(stepCount, text.length,
      'step count ' + stepCount + ' does not match command length ' + text.length +
      ' (' + text + ')');
    // The element's own width is the implicit `to` keyframe; without it the
    // reveal interpolates 0 -> 0 and the command never appears.
    assert.equal(t.props.style.width, text.length + 'ch',
      'the typed span must state its full width in ch, or it types nothing');
    // The prompt lives in its own span now, so the command text itself must be
    // a bare command line the way a shell echoes it.
    assert.ok(!/^(PS |root@)/.test(text),
      'the prompt must sit in its own span, not inside the typed command: ' + text);
  }
  // One prompt on the echoed command line plus one on the trailing row where the
  // shell hands control back: that trailing prompt is what makes the window read
  // as a terminal waiting for a programmer instead of a dashboard.
  const ps1 = ofClass(nodes, 'w550-ps1');
  assert.equal(ps1.length, 10, 'expected a prompt per command line and per trailing row');
  for (const p of ps1) {
    assert.match(String(p.props.children), /^(PS [A-Z]:\\|root@[a-z0-9-]+:)/,
      'not a real shell prompt: ' + p.props.children);
  }
  const cursors = ofClass(nodes, 'w550-cursor');
  assert.equal(cursors.length, 5, 'every terminal should end on a blinking cursor');
});

check('every window collapses only after its own content has printed', () => {
  const wins = ofClass(nodes, 'w550-win');
  const mins = ofClass(nodes, 'w550-min');
  assert.equal(wins.length, 5);
  assert.equal(mins.length, 5);
  const coll = mins.map((m) => delayOf(m.props.style.animationDelay)).sort((a, b) => a - b);
  for (let i = 1; i < coll.length; i++) {
    assert.ok(coll[i] > coll[i - 1], 'windows should minimise one after another');
  }
  // The windows overlap now, so the invariant is per window, not global: a
  // window may not leave while something inside it is still animating in.
  for (const w of wins) {
    const inner = walk(w, []);
    const min = inner.find((n) => String(n.props.className).includes('w550-min'));
    const collapse = delayOf(min.props.style.animationDelay);
    let last = 0;
    for (const n of inner) {
      const cls = String(n.props.className || '');
      if (cls.includes('w550-min') || cls === 'w550-win') continue;
      const style = n.props.style || {};
      const at = /\+\s*([\d.]+)s/.exec(String(style.animationDelay || ''));
      if (at) last = Math.max(last, Number(at[1]));
      const bar = /([\d.]+)s linear/.exec(String(style.animation || ''));
      if (at && bar) last = Math.max(last, Number(at[1]) + Number(bar[1]));
    }
    assert.ok(collapse > last,
      'a window minimises at ' + collapse + 's while content is still due at ' + last + 's');
  }
  for (const w of wins) {
    const pop = delayOf(w.props.style.animationDelay);
    assert.ok(pop < coll[0], 'window pops after the sequence starts collapsing');
  }
});

check('each loading bar reaches 100% before its window collapses', () => {
  const fills = ofClass(nodes, 'w550-fill');
  const dones = ofClass(nodes, 'w550-done');
  assert.equal(fills.length, 1, 'expected one loading bar');
  assert.equal(dones.length, 1, 'expected one completion label');
  const ends = [];
  for (let i = 0; i < fills.length; i++) {
    const anim = fills[i].props.style.animation;
    const at = delayOf(anim);
    const dur = Number(/([\d.]+)s linear/.exec(anim)[1]);
    const label = delayOf(dones[i].props.style.animationDelay);
    assert.ok(Math.abs(label - (at + dur)) < 0.02,
      'the 100% label at ' + label + 's does not match the bar ending at ' + (at + dur) + 's');
    ends.push(at + dur);
  }
  // Each bar belongs to one window, so it only has to beat that window's exit.
  for (const w of ofClass(nodes, 'w550-win')) {
    const inner = walk(w, []);
    const fill = ofClass(inner, 'w550-fill')[0];
    if (!fill) continue;
    const anim = fill.props.style.animation;
    const end = delayOf(anim) + Number(/([\d.]+)s linear/.exec(anim)[1]);
    const min = inner.find((n) => String(n.props.className).includes('w550-min'));
    const collapse = delayOf(min.props.style.animationDelay);
    assert.ok(end < collapse,
      'a bar ends at ' + end + 's but its own window leaves at ' + collapse + 's');
  }
});

/** Read the delay out of the declaration block of one class rule. */
function ruleDelay(cssText, cls) {
  const m = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(cssText);
  assert.ok(m, 'no rule for .' + cls);
  return delayOf(m[1]);
}

check('turns the wordmark a half turn — an ambigram needs no second face', () => {
  const flip = ofClass(nodes, 'w550-flip')[0];
  assert.ok(flip, 'the closing plate is missing');
  const marks = ofClass(nodes, 'w550-mark');
  assert.equal(marks.length, 1, 'the mark should be drawn exactly once');
  assert.equal(marks[0].type, 'svg', 'the mark must be the traced svg');
  const d = String(marks[0].props.children.props.d);
  assert.ok(d.length > 3000, 'the traced outline is short (got ' + d.length
    + ' chars — did the segments lose their + operators?)');
  assert.match(d, /^[MZ\d,.\s]+$/, 'the path should carry only path numbers');
  assert.ok((d.match(/M/g) || []).length >= 4, 'four glyphs worth of subpaths expected');
  // The half turn alone has to do the work, so the old face swap must be gone.
  for (const gone of ['w550-face', 'w550-front', 'w550-back']) {
    assert.equal(ofClass(nodes, gone).length, 0, gone + ' is the old glyph-swap hack');
  }
  assert.ok(!/w550-hide/.test(css), 'the face-hiding keyframes should be gone too');
  assert.match(css, /@keyframes w550-turn\{from\{transform:rotate\(0deg\)\}to\{transform:rotate\(180deg\)\}\}/,
    'the plate does not turn a full 180°');
  assert.match(css, /@keyframes w550-tint\{from\{color:#f2f6ff\}to\{color:#ff6a5a\}\}/,
    'the mark should end as MOSS red');
  const plate = /\.w550-flip\{([^}]*)\}/.exec(css)[1];
  const delays = [...plate.matchAll(/\+ ([\d.]+)s/g)].map((m) => Number(m[1]));
  assert.equal(delays.length, 3, 'appearance, the turn and the tint all live on the plate');
  const [fadeIn, turnAt, tintAt] = delays;
  assert.ok(turnAt > fadeIn, 'the plate must appear before it turns');
  assert.ok(tintAt > turnAt && tintAt < turnAt + 1.1,
    'the tint should land while the plate is still turning');
  assert.equal(flip.props.style, undefined,
    'an inline animation-delay on the plate would override the shorthand delays');
  assert.ok(ruleDelay(css, 'w550-name') > tintAt,
    'the designation should land after the mark has turned');
});

check('keeps the quote, and drops the 550W→MOSS explainer line', () => {
  const quote = ofClass(nodes, 'w550-quote')[0];
  assert.ok(quote, 'the closing line is missing');
  const kids = quote.props.children.filter(Boolean);
  assert.match(String(kids[0].props.children), /让人类永远保持理智/);
  assert.equal(ofClass(nodes, 'w550-flipnote').length, 0, 'the explainer element must be gone');
  const text = nodes.map((n) => n.props.children).filter((c) => typeof c === 'string').join(' ');
  assert.ok(!text.includes('倒过来'), 'the 550W→MOSS explainer must not be rendered');
  const lastCollapse = Math.max(
    ...ofClass(nodes, 'w550-min').map((m) => delayOf(m.props.style.animationDelay)));
  assert.ok(ruleDelay(css, 'w550-quote') > lastCollapse,
    'the quote should arrive after the windows have gone');
});

const WINDOW_TITLES = ['Windows PowerShell', 'Windows PowerShell', 'root@moss-550w: ~',
  'root@cam-01: ~/ws', 'root@cam-01: ~'];

check('the close is the dark block: lens, ambigram, notices — no plaque furniture', () => {
  const lens = ofClass(nodes, 'w550-fineye');
  assert.equal(lens.length, 1, 'the closing lens is missing');
  const close = ofClass(nodes, 'w550-close')[0];
  assert.ok(close, 'the closing block is missing');
  assert.equal(ofClass(nodes, 'w550-plaque').length, 0, 'the superevent plaque must be gone');
  assert.equal(ofClass(nodes, 'w550-tenon').length, 0, 'no tenons');
  assert.equal(ofClass(nodes, 'w550-banner').length, 0, 'no banner');
  assert.equal(ofClass(nodes, 'w550-groove').length, 0, 'no groove');
  const kids = close.props.children.filter(Boolean);
  assert.ok(kids.some((c) => c.props && c.props.className === 'w550-quote'),
    'the closing line must sit inside the close');
  assert.equal(ofClass(nodes, 'w550-mark').length, 1, 'the ambigram mark is missing');
  assert.equal(ofClass(nodes, 'w550-name').length, 2, 'the bilingual designation is missing');
  const tk = ofClass(nodes, 'w550-takeover')[0];
  assert.ok(tk, 'the takeover notice is missing');
  const tkText = tk.props.children.filter(Boolean).map((c) => String(c.props.children)).join(' ');
  assert.match(tkText, /MOSS 已全面接管/, 'the takeover line the user asked for');
  assert.match(tkText, /ASSUMED FULL CONTROL/, 'and its English half');
  const quote = ofClass(nodes, 'w550-quote')[0];
  assert.match(String(quote.props.children[0].props.children), /让人类永远保持理智/);
  assert.match(String(quote.props.children[1].props.children), /延续人类文明/,
    'the prime directive belongs on the closing line');
  assert.match(String(quote.props.children[2].props.children), /8192/,
    'the spec line belongs there too');
  // the lens must stay round: no polygon anywhere, and the iris is rounds only.
  // A six-pointed shape here reads as a hexagram, and the user called that out
  // as severe, so this one is worth a guard.
  const lenses = ofClass(nodes, 'w550-eye').concat(ofClass(nodes, 'w550-fineye'));
  const allShapes = lenses.reduce((acc, n) => acc.concat(walk(n.props.children)), [])
    .map((x) => x.type);
  assert.equal(allShapes.filter((t) => t === 'polygon').length, 0,
    'no polygon in the lens — a hexagon here reads as a hexagram');
  const iris = ofClass(nodes, 'w550-iris')[0];
  const ROUND = ['g', 'circle', 'ellipse', 'line'];
  const irisShapes = walk(iris.props.children).map((x) => x.type);
  const notRound = irisShapes.filter((t) => !ROUND.includes(t));
  assert.equal(notRound.length, 0, 'the iris must be rounds only — found ' + notRound.join(','));
  assert.ok(allShapes.includes('circle'), 'the lens needs its rings');
  // and the housing is the drawing the image model made, keyed to a sprite, with
  // the vector lens seated on the ring it already has
  const unit = ofClass(nodes, 'w550-unit')[0];
  assert.ok(unit, 'the camera unit is missing');
  const img = walk(unit.props.children).find((x) => x.type === 'img');
  assert.ok(img, 'the housing must be the drawn sprite');
  assert.match(String(img.props.src), /^data:image\/png;base64,[A-Za-z0-9+/=]{1000,}$/,
    'the sprite travels inline as a PNG data URI');
  const seat = ofClass(nodes, 'w550-opticseat')[0];
  assert.ok(seat, 'the lens has no seat on the drawing');
  assert.ok(walk(seat.props.children).some((x) => x.type === 'svg'),
    'the vector lens must sit inside the seat');
});

check('the taskbar carries one tab per window, each arriving as its window goes', () => {
  const tabs = ofClass(nodes, 'w550-tab');
  const mins = ofClass(nodes, 'w550-min');
  assert.equal(tabs.length, mins.length, 'every window needs a taskbar tab');
  const titles = tabs.map((t) => String(t.props.children[1].props.children));
  assert.deepEqual(titles, WINDOW_TITLES);
  for (let i = 0; i < tabs.length; i++) {
    const tab = delayOf(tabs[i].props.style.animationDelay);
    const collapse = delayOf(mins[i].props.style.animationDelay);
    assert.ok(tab <= collapse, 'a tab must not appear after its window is already gone');
    assert.ok(collapse - tab < 0.5, 'the tab should land as its window minimises');
  }
});

check('the prompt says 按任意键进入 and arrives after the closing line', () => {
  const prompt = ofClass(nodes, 'w550-prompt')[0];
  assert.ok(prompt, 'the enter prompt is missing');
  assert.equal(String(prompt.props.children), '按任意键进入');
  assert.ok(ofClass(nodes, 'w550-caret').length >= 1, 'the prompt caret is missing');
  assert.ok(ruleDelay(css, 'w550-promptwrap') > ruleDelay(css, 'w550-quote'),
    'the prompt must arrive after the quote');
});

/** The instant the plate turns, read from the sheet rather than hard-coded. */
const turnAt = (() => {
  const plate = /\.w550-flip\{[^}]*\}/.exec(css)[0];
  return [...plate.matchAll(/\+ ([\d.]+)s/g)].map((m) => Number(m[1]))[1];
})();

check('wears the TFR glitch set: grain, flicker, tear bands, fracture, killer flash', () => {
  // ① grain, generated in CSS so there is no asset to ship or fetch
  assert.equal(ofClass(nodes, 'w550-grain').length, 1, 'no grain layer');
  assert.match(css, /\.w550-grain\{[^}]*url\("data:image\/svg\+xml[^"]*feTurbulence/,
    'the grain must be an inline turbulence tile');
  assert.match(css, /\.w550-grain\{[^}]*steps\(6,end\)/, 'the grain must jitter in steps');

  // ② backlight flicker: hard cuts, irregular, and never a strobe
  assert.equal(ofClass(nodes, 'w550-flick').length, 1, 'no flicker layer');
  assert.match(css, /\.w550-flick\{[^}]*steps\(1,end\)/, 'the flicker must cut, not fade');
  const flick = css.slice(css.indexOf('@keyframes w550-flick'), css.indexOf('.w550-bands{'));
  assert.ok((flick.match(/opacity:/g) || []).length >= 8, 'the flicker should be irregular');
  const peaks = [...flick.matchAll(/opacity:\.(\d+)/g)].map((m) => Number('0.' + m[1]));
  assert.ok(peaks.length >= 4 && Math.max(...peaks) <= 0.1,
    'the flicker must stay a hint, not a strobe');

  // ③ tear bands: the TFR magenta→cyan slices, deliberately out of lockstep
  assert.equal(ofClass(nodes, 'w550-band').length, 7, 'expected seven tear bands');
  assert.match(css, /\.w550-band\{[^}]*rgba\(255,0,130/, 'the tear should lead with magenta');
  assert.match(css, /\.w550-band\{[^}]*rgba\(0,225,255/, 'the tear should fall to cyan');
  assert.match(css, /\.w550-band\{[^}]*mix-blend-mode:screen/, 'tears must screen, not cover');
  const durs = [...css.matchAll(/--dur:([\d.]+)s/g)].map((m) => m[1]);
  assert.ok(new Set(durs).size >= 4, 'the tear bands must not blink in lockstep');

  // ④ the fracture, landing exactly on the turn
  const shards = ofClass(nodes, 'w550-shard');
  assert.equal(shards.length, 7, 'expected seven fracture lines');
  for (const s of shards) {
    assert.match(String(s.props.style['--rot']), /deg$/, 'a shard needs its own angle');
    assert.match(String(s.props.style['--dx']), /px$/, 'a shard needs its own drift');
    const at = delayOf(s.props.style.animationDelay);
    assert.ok(at >= turnAt && at <= turnAt + 0.3,
      'the fracture at ' + at + 's must land on the turn at ' + turnAt + 's');
  }

  // ⑤ two kicks: the tube striking on, and the impact as the plate turns
  const flashes = ofClass(nodes, 'w550-flash');
  assert.equal(flashes.length, 2, 'expected a boot kick and an impact flash');
  const kicks = flashes.map((f) => delayOf(f.props.style.animationDelay)).sort((a, b) => a - b);
  assert.ok(kicks[0] < 0.5, 'the boot kick should strike as the screen comes on');
  assert.ok(Math.abs(kicks[1] - turnAt) < 0.01,
    'the impact flash at ' + kicks[1] + 's must land on the turn at ' + turnAt + 's');
});

check('the effect layers sit above the picture and never take input', () => {
  const rule = (cls) => {
    const m = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(css);
    assert.ok(m, 'no rule for .' + cls);
    return m[1];
  };
  for (const [cls, z] of [['w550-grain', 8], ['w550-flick', 9], ['w550-bands', 10],
    ['w550-shards', 11], ['w550-flash', 12]]) {
    assert.match(rule(cls), /pointer-events:none/, cls + ' would swallow clicks');
    assert.match(rule(cls), new RegExp('z-index:' + z + '(?![0-9])'), cls + ' is not on layer ' + z);
  }
  for (const cls of ['w550-grain', 'w550-flick', 'w550-band', 'w550-shard', 'w550-flash']) {
    assert.match(rule(cls), /var\(--w550-t/, cls + ' is not on the frozen timeline');
  }
});

check('the picture is built in depth, not flat black', () => {
  assert.equal(ofClass(nodes, 'w550-grid').length, 1, 'no grid texture');
  assert.equal(ofClass(nodes, 'w550-halo').length, 1, 'no halo behind the reveal');
  assert.equal(ofClass(nodes, 'w550-hud').length, 1, 'no HUD strip');
  // TFR's plate recipe puts the outer hairline first and the lit/shaded bevel
  // after it, so the bevel is "an inset shadow somewhere in the value".
  assert.match(css, /\.w550-win \.w550-box\{[^}]*box-shadow:[^;}]*inset/, 'the plates need a bevel');
  assert.match(css, /\.w550-mark\{[^}]*drop-shadow\(-2\.2px 0 rgba\(255,0,90/,
    'the wordmark needs an RGB split');
  assert.match(css, /\.w550-mark\{[^}]*drop-shadow\(2\.2px 0 rgba\(0,225,255/,
    'and the cyan half of it');
  const streaks = ofClass(nodes, 'w550-streak');
  assert.ok(streaks.length >= 10, 'the light trails are missing');
  for (const n of streaks) {
    assert.match(String(n.props.style['--off']), /^-\d/, 'trails should start mid-fall');
    assert.match(String(n.props.style['--dur']), /s$/, 'each trail needs its own duration');
  }
});

check('the sky is layered: gas at the bottom, then stars that crowd into the distance', () => {
  const cls = nodes.map((n) => String(n.props.className || ''));
  const at = (name) => cls.findIndex((c) => c.split(' ').includes(name));
  const neb = at('w550-nebula');
  assert.ok(neb >= 0, 'the gas clouds are missing');
  assert.ok(ofClass(nodes, 'w550-stars').length === 1, 'the starfield photo is missing');
  // the box-shadow list is what draws the field: hundreds of stars, no image
  const far = ofClass(nodes, 'w550-field').find((n) => /far/.test(n.props.className));
  const near = ofClass(nodes, 'w550-field').find((n) => /near/.test(n.props.className));
  assert.ok(far && near, 'both star fields must exist');
  const shadows = (n) => String(n.props.style.boxShadow).split('),');
  assert.ok(shadows(far).length >= 400, 'the far field should be crowded — got ' + shadows(far).length);
  assert.ok(shadows(near).length < shadows(far).length, 'the near field must be sparser than the far one');
  // density is weighted upwards: the deep field is the crowded one
  const ys = shadows(far).map((s) => parseFloat((s.match(/-?[\d.]+vh/) || [''])[0])).filter((v) => !isNaN(v));
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  assert.ok(mean < 46, 'stars must crowd towards the far top of the frame — mean y ' + mean.toFixed(1) + 'vh');
  // a seeded generator, so a frozen frame is the same picture every run
  assert.match(SRC, /starShadow\(430, 550251, true\)/, 'the far field must be seeded, not random');
  assert.match(SRC, /starShadow\(64, 81920, false\)/, 'and so must the near one');
});

check('never hides itself on a timer: the root ends opaque and nothing sets visibility', () => {
  assert.match(css, /@keyframes w550-root\{from\{opacity:0\}to\{opacity:1\}\}/);
  assert.ok(!/visibility:hidden/.test(css), 'the splash must wait for a key, not a timer');
  assert.ok(!/w550-kill/.test(css), 'no timer-driven kill rule should exist');
});

check('every delayed animation is offset by the freeze-frame variable', () => {
  const timed = css.split('\n').filter((l) => /animation:/.test(l) && !/animation:none/.test(l));
  assert.ok(timed.length >= 10, 'expected the stylesheet to carry the timeline');
  for (const line of timed) {
    assert.match(line, /var\(--w550-t,0s\)/, 'unguarded animation: ' + line.trim().slice(0, 60));
  }
  const inline = [...ofClass(nodes, 'w550-typed'), ...ofClass(nodes, 'w550-fill'),
    ...ofClass(nodes, 'w550-win'), ...ofClass(nodes, 'w550-min'), ...ofClass(nodes, 'w550-out'),
    ...ofClass(nodes, 'w550-done'), ...ofClass(nodes, 'w550-shard'), ...ofClass(nodes, 'w550-flash'),
    ...ofClass(nodes, 'w550-tab')];
  assert.ok(inline.length >= 16, 'expected the tree to carry inline timings');
  for (const n of inline) {
    const val = String(n.props.style.animation || n.props.style.animationDelay);
    assert.match(val, /var\(--w550-t/, 'inline delay without the freeze variable: ' + val.slice(0, 60));
  }
});

check('a key press fades the live node out and retires the sheet', () => {
  const root = fakeEl('div');
  byId.set('dsh-550w-boot-root', root);
  const leave = listeners.find((l) => l.type === 'keydown').fn;
  leave();
  assert.equal(root.style.animation, 'none',
    'a running CSS animation outranks !important, so it must be cleared before fading');
  assert.equal(root.style.opacity, '0');
  assert.match(root.style.transition, /opacity 1s ease/);
  const exit = timers.find((t) => t.ms === 1100);
  assert.ok(exit, 'no exit timer was armed');
  leave(); // a second key press must not arm a second exit
  assert.equal(timers.filter((t) => t.ms === 1100).length, 1);
  exit.fn();
  assert.equal(root.style.display, 'none');
  assert.equal(styles.length, 0, 'stylesheet was not removed');
  assert.equal(resolve(renderSlot()), null, 'a render after retiring would paint unstyled');
});

check('dispose() clears every timer, listener and sheet it created', () => {
  for (const d of disposers.splice(0)) d();
  assert.equal(styles.length, 0, 'dispose left a stylesheet behind');
  assert.equal(listeners.length, 0, 'dispose left the keydown listener behind');
  assert.ok(timers.every((t) => t.cleared || t.ms < 1000), 'dispose left a timer armed');

  mount(); // a second, clean lifecycle must behave the same
  assert.equal(styles.length, 1);
  assert.equal(listeners.length, 1);
  for (const d of disposers.splice(0)) d();
  assert.equal(styles.length, 0);
  assert.equal(listeners.length, 0);
});

check('does not render again after the boot window closes', () => {
  mount();
  now += 5001;
  assert.equal(resolve(renderSlot()), null);
});

// ── Report ────────────────────────────────────────────────────────────────
let failed = 0;
for (const [ok, name] of results) {
  if (!ok) failed++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name);
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' assertions passed');
process.exit(failed === 0 ? 0 : 1);
