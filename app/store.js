// Local record store: JSON collections, held in memory and persisted to the browser's IndexedDB.
//
// Every screen reads and writes through this class synchronously, as it did when the collections lived in
// localStorage. What changed underneath (usability cycle 4, S1): localStorage holds about 5 MB per site, which a
// busy lab fills in six months, after which every save threw QuotaExceededError at the user and a save that
// writes several collections could stop halfway. So the collections now live in memory, are loaded once before
// the first screen (`await store.ready()`), and are written to IndexedDB in the background, where the limit is
// a share of the disk rather than 5 MB. Writes made in the same turn of the event loop go out together, as one
// IndexedDB transaction, so they are stored all together or not at all.
//
// A write that cannot be stored is never thrown at the caller: the store keeps the change in memory, says
// plainly what happened (`onProblem`), and tries again with the next write. `transaction(fn)` goes further for
// the saves that touch several collections: if they cannot be stored, they are undone in memory as well, so the
// screen never shows a result whose experiment slot or formulation status was not stored with it.
//
// The persistence backend is passed in (`new Store(ns, { backend })`), so node tests can give it a fake one;
// without one it is IndexedDB in a browser, localStorage where there is no IndexedDB (and in node tests with a
// localStorage stand-in), and memory only as a last resort. Phase 2 (the macOS app) can put a SQLite file
// behind the same backend interface. Keep all access through this class so that swap stays one file.
//
// A backend is a plain object: {kind, load(ns) → Promise<{col: json}>, write(ns, [[col, json|null]]) →
// Promise (all or nothing; null deletes), clear(ns) → Promise}. A synchronous one (localStorage) also has
// `sync: true`, loadSync, writeSync and clearSync, and is written straight away, as before.

export class Store {
  // col → {rows: array|null, text: its JSON or null until asked for, ver: changes made, saved: changes stored}
  // `rows` is never handed out and never changed in place: every write puts a new array (and new records) in
  // its place. That keeps callers from changing stored records by accident, and lets a transaction be undone by
  // putting the old array back.
  #cols = new Map();
  #txn = null; // the transaction whose function is running
  #pending = []; // transactions run, waiting to hear whether their write was stored
  #busy = Promise.resolve(); // the write in progress, so writes go out one after another and in order
  #waiting = null; // the next write, not started yet; flush() calls before it starts share it
  #scheduled = false;
  #opened = null;
  #link = null; // messages to and from the other windows of this origin (windowLink)
  #windows = null; // the option that turns "one window writes" on
  #role = null; // and the window's part in it, once opened (WindowRole)
  #loaded = false;
  #early = null; // collections another window stored while this one was still reading its own
  #watchers = new Set(); // watchOtherWindows
  #marked = false;

  /**
   * `windows`: true (or test stand-ins {link, storage, times}) makes this one of the windows that agree which of
   * them writes this namespace (one window writes, at the end of this file). app/main.js turns it on in a
   * browser; tests and the macOS app's single window leave it off, and the store then always writes.
   */
  constructor(ns, { backend, windows = null } = {}) {
    this.ns = ns;
    this.backend = backend || defaultBackend();
    this.engine = this.backend.kind;
    this.#windows = windows ? (windows === true ? {} : windows) : null;
    /** What went wrong with the last write, while it is still wrong: {kind, message, undone, what}. */
    this.problem = null;
    /** Called with the problem when a write fails, and with null once writes get through again. */
    this.onProblem = null;
    /** Called with true when this window turns read-only (another window writes), and with false when it writes again. */
    this.onRole = null;
    /** Called with {what, kept} when a change is refused because another window writes (kept: the screen keeps its input). */
    this.onRefused = null;
    /** Called, synchronously, before this window hands the role over: what the screens still wait to store goes now. */
    this.beforeYield = null;
    this.persisted = null; // whether the browser agreed to keep the data when space runs low (null: not asked)
    if (this.backend.loadSync) this.#fill(this.backend.loadSync(ns));
  }

  key(col) { return `${this.ns}.${col}`; }

  /**
   * Load every collection, once, before the first screen reads any. Moves collections an earlier version kept
   * in localStorage into the backend, and only then removes them there, so a move that fails loses nothing.
   * Never rejects: if IndexedDB cannot be opened the store falls back to localStorage, as before.
   */
  ready() { return (this.#opened ||= this.#open()); }

  async #open() {
    // Two windows on the same lab each hold the collections in memory. The one that writes says what it stored,
    // and the other reads it back, so it shows what is stored. Who writes is settled before the records are
    // read, so a window that only shows them reads them as the writer last stored them.
    // A single window (the macOS app) keeps to a BroadcastChannel where there is one, as before.
    if (this.#windows || this.engine === 'indexeddb') {
      this.#link = this.#windows?.link || windowLink({ fallback: !!this.#windows });
      this.#link?.listen((msg) => this.#heardStored(msg));
    }
    if (this.#windows) {
      this.#role = new WindowRole(this.ns, { ...this.#windows, link: this.#link }, {
        save: () => { try { this.beforeYield?.(); } catch (err) { console.warn(err); } },
        store: () => this.flush(),
        gain: () => this.#readBack(null, true),
        lost: () => this.#dropUnstored(),
        changed: (writes) => { try { this.onRole?.(!writes); } catch (err) { console.warn(err); } },
      });
      await this.#role.start();
    }
    if (!this.backend.loadSync) { // a synchronous one was read in the constructor
      let stored, opened = true;
      try { stored = await this.backend.load(this.ns); }
      catch (err) {
        // The macOS app's SQLite file did not open: the records stay in the window's IndexedDB, as before 0.13.
        if (this.engine === 'sqlite' && typeof indexedDB !== 'undefined' && indexedDB) {
          console.warn('LNP Lab: the database file could not be opened; using the window\'s own storage', err);
          this.backend = idbBackend(); this.engine = this.backend.kind;
          try { stored = await this.backend.load(this.ns); } catch (err2) { this.#fallBack(err2); opened = false; }
        } else { this.#fallBack(err); opened = false; }
      }
      if (opened && this.engine === 'sqlite' && !Object.keys(stored || {}).length) stored = await this.#adoptIndexedDb(stored);
      if (opened) {
        this.#fill(stored);
        if (Object.keys(stored || {}).length) this.#markMoved();
        // Moving an earlier version's records is a write, and the window that writes makes it.
        if (!this.readOnly) await this.#adoptLegacy();
      }
    }
    this.#loaded = true;
    if (this.#early) { const cols = [...this.#early]; this.#early = null; this.#readBack(cols).catch(() => {}); }
    if (this.engine === 'indexeddb') {
      // Without it, a browser may clear the site's data when the disk runs low. Asked once per start; Chrome
      // and Safari decide without a prompt, Firefox may ask.
      try { navigator.storage?.persist?.().then((p) => { this.persisted = p; }, () => {}); } catch {}
    }
    return this;
  }

  /**
   * The macOS app before 0.13 kept the records in its window's IndexedDB. On the first start with the SQLite file,
   * while that file holds nothing for this lab, they are copied over; IndexedDB is left as it was, as a fallback.
   */
  async #adoptIndexedDb(stored) {
    if (typeof indexedDB === 'undefined' || !indexedDB || this.readOnly) return stored;
    try {
      const old = await idbBackend('lnp-lab', { timeoutMs: 3000 }).load(this.ns);
      const entries = Object.entries(old || {}).filter(([, text]) => text != null);
      if (!entries.length) return stored;
      await this.backend.write(this.ns, entries);
      console.info(`LNP Lab: moved ${entries.length} collections from the window's storage into the database file`);
      return Object.fromEntries(entries);
    } catch (err) { console.warn('LNP Lab: records in the window\'s storage could not be moved', err); return stored; }
  }

  /** IndexedDB did not open. Records already moved there must not be replaced by an empty lab in localStorage. */
  #fallBack(err) {
    console.warn('LNP Lab: the browser database could not be opened', err);
    if (lsGet(this.#movedKey())) {
      // Showing an empty lab here invites the user to start again, and a new Experiment 1 would then collide
      // with the real one when the database opens next time. Nothing is shown, nothing is accepted, and the
      // note says to reload.
      this.backend = unavailableBackend();
      this.engine = this.backend.kind;
      this.#report(err, [], 'unopened');
      return;
    }
    this.backend = lsUsable() ? localStorageBackend() : unavailableBackend();
    this.engine = this.backend.kind;
    if (this.backend.loadSync) this.#fill(this.backend.loadSync(this.ns));
  }

  /**
   * Collections an earlier version kept in localStorage (`<ns>.<collection>`). Merged by id into what the
   * backend already has, which on the first start is nothing; the localStorage keys go only once the backend
   * has stored them. Run on every start, so a move cut off halfway simply happens again.
   */
  async #adoptLegacy() {
    const legacy = legacyCollections(this);
    if (!legacy.length) return;
    for (const { col, rows } of legacy) {
      const have = this.#cols.get(col)?.rows;
      this.#setRows(col, have?.length ? mergeById(have, rows) : rows);
    }
    const done = await this.flush();
    if (!done.ok) return; // still in localStorage, and the note says why it could not be moved
    for (const { key } of legacy) { try { localStorage.removeItem(key); } catch {} }
    this.#markMoved();
  }

  /* ---------------- reading ---------------- */

  all(col) { const c = this.#cols.get(col); return c?.rows ? JSON.parse(this.#text(c)) : []; }
  count(col) { return this.#cols.get(col)?.rows?.length || 0; }
  get(col, id) { const r = this.#cols.get(col)?.rows?.find((x) => x?.id === id); return r === undefined ? null : copy(r); }

  /* ---------------- writing ---------------- */

  put(col, rec) {
    const rows = this.#cols.get(col)?.rows || [];
    const now = new Date().toISOString();
    const text = JSON.stringify({ ...rec, updatedAt: now, createdAt: rec.createdAt || now });
    const i = rows.findIndex((r) => r?.id === rec.id);
    const next = rows.slice();
    if (i >= 0) next[i] = JSON.parse(text); else next.push(JSON.parse(text));
    this.#setRows(col, next);
    return JSON.parse(text);
  }

  remove(col, id) {
    const rows = this.#cols.get(col)?.rows;
    this.#setRows(col, (rows || []).filter((r) => r?.id !== id));
  }

  /** Put a whole collection in place as given (no timestamps added). For restores and the test door. */
  replace(col, rows) { this.#setRows(col, Array.isArray(rows) ? rows.map(copy) : []); }

  /**
   * Run `fn` (synchronous) as one write: what it puts and removes is stored all together or not at all. When it
   * cannot be stored, everything `fn` changed is undone in memory too, and the note says what was undone
   * (`what`, e.g. "the result for E3-F1_final"). Returns what `fn` returns, straight away, so callers that
   * worked with put() work unchanged; `onSaved` is called once the write is stored. If `fn` throws, its
   * changes are undone at once and the error goes on to the caller.
   *
   * `onUndone()` is for a screen that waits to hear how the write went before it moves on, such as the
   * experiment wizard: it is called once the change has been undone, and returns true when the screen is still
   * showing, with what was typed into it (usability cycle 5, K4). The note then says so, and names the button to
   * press again (`again`, e.g. "Create experiment"), instead of the screen being drawn again from what is
   * stored. A screen the user has left returns false, and whatever is showing now is drawn again (cycle 6, W5).
   */
  transaction(fn, { what = '', onSaved = null, onUndone = null, again = '' } = {}) {
    if (this.#txn) { // already inside one: these writes join it
      if (onSaved) { const prev = this.#txn.onSaved; this.#txn.onSaved = () => { prev?.(); onSaved(); }; }
      if (onUndone) { const prev = this.#txn.onUndone; this.#txn.onUndone = () => { const kept = prev ? prev() === true : true; return onUndone() === true && kept; }; }
      return fn(this);
    }
    // In a window that only shows the records (another window writes them, see WindowRole), fn still runs, so
    // the caller gets what it expects, and everything it changed goes back at once, as when it throws: nothing
    // is stored and nothing is half-done. onUndone then hears of it, as of a write the browser refused.
    const refused = !this.#writes();
    const marks = refused ? counterMarks(this.ns) : null;
    const t = { before: new Map(), ver: new Map(), after: new Map(), target: new Map(), what, onSaved, onUndone, again };
    this.#txn = t;
    let value;
    try { value = fn(this); }
    catch (err) {
      this.#txn = null;
      // Nothing else can have run in between, so the collections go back exactly, unchanged ones included.
      for (const [col, rows] of t.before) { const c = this.#cols.get(col); c.rows = rows; c.text = null; c.ver = t.ver.get(col); }
      throw err;
    }
    this.#txn = null;
    if (refused) {
      for (const [col, rows] of t.before) { const c = this.#cols.get(col); c.rows = rows; c.text = null; c.ver = t.ver.get(col); }
      putMarksBack(this.ns, marks);
      this.#refuse(what, !!onUndone);
      if (onUndone) queueMicrotask(() => { try { onUndone(readOnlyProblem(what)); } catch (err) { console.warn(err); } });
      return value;
    }
    for (const col of t.before.keys()) { const c = this.#cols.get(col); t.after.set(col, c.rows); t.target.set(col, c.ver); }
    if (!t.target.size) { t.onSaved?.(); return value; }
    this.#pending.push(t);
    this.#persistSoon();
    return value;
  }

  /**
   * Store everything changed so far. Resolves (never rejects) with {ok, error}: ok when nothing is left
   * unsaved. Writes happen on their own a moment after each change; this is for waiting on them.
   */
  flush() {
    if (this.backend.sync) return Promise.resolve(this.#writeSync());
    if (!this.#waiting) {
      this.#waiting = this.#busy.then(() => { this.#waiting = null; return this.#writeAsync(); });
      this.#busy = this.#waiting.catch(() => {});
    }
    return this.#waiting;
  }

  /** True while some change exists only in memory. */
  unsaved() { for (const c of this.#cols.values()) if (c.ver > c.saved) return true; return false; }

  /**
   * Erase everything this namespace holds in this browser: the collections, in memory and in the backend, and
   * the preferences kept under its prefix in localStorage (what "Delete all data" and the demo's "Start over"
   * always did), and this window's drafts of new records (app/ui/kit.js), which would otherwise offer back,
   * after a fresh start, forms that name stocks and lots that are gone. Resolves with {ok, error}.
   */
  async clear() {
    if (!this.#writes()) { this.#refuse('the delete'); return { ok: false, error: new Error(READ_ONLY_REASON) }; }
    const cols = [...this.#cols.keys()];
    this.#cols.clear();
    this.#pending = [];
    await this.#busy; // a write still in flight lands first, then goes with the rest
    let error = null;
    try { await this.backend.clear(this.ns); } catch (err) { error = err; }
    // Another window open on this lab reads the emptied collections back: it showed every record still, and
    // used to write them back with its next change (usability cycle 6, W1).
    if (!error) this.#link?.post({ ns: this.ns, cols });
    // Which window writes is not a preference of the lab: it stays, or another window would take the role.
    try { lsKeys(this.ns + '.').filter((k) => k !== this.#role?.key).forEach((k) => localStorage.removeItem(k)); } catch {}
    try { const ss = globalThis.sessionStorage; for (let i = ss.length - 1; i >= 0; i--) { const k = ss.key(i); if (k?.startsWith(this.ns + '.draft.')) ss.removeItem(k); } } catch {}
    this.#marked = false;
    if (error) this.#report(error, []);
    else if (this.problem && this.problem.kind !== 'unopened') this.#resolved();
    return { ok: !error, error };
  }

  /**
   * Read a collection of any namespace, the one in memory or another one straight from the backend (the
   * demo's switch leaves one of the two closed). For the test door and tools; screens use all().
   */
  async peek(ns, col) {
    if (ns === this.ns) { await this.ready(); return this.all(col); }
    let v = null;
    try { v = (await this.backend.load(ns))[col] ?? null; } catch {}
    if (v == null) v = lsGet(`${ns}.${col}`); // a namespace not opened since the move still has it there
    const rows = parseRows(v);
    return rows || [];
  }

  /** Write a whole collection of any namespace, resolving once it is stored. The counterpart of peek(). */
  async poke(ns, col, rows) {
    if (ns === this.ns) {
      await this.ready();
      if (!this.#writes()) throw new Error(READ_ONLY_REASON);
      this.replace(col, rows);
      const done = await this.flush();
      if (!done.ok) throw done.error || new Error('not stored');
      return;
    }
    await this.backend.write(ns, [[col, JSON.stringify(rows || [])]]);
  }

  /** What the records take, for the storage meter: JSON characters per collection. */
  usage() {
    const collections = [...this.#cols].filter(([, c]) => c.rows).map(([col, c]) => ({ col, records: c.rows.length, chars: this.#text(c).length }));
    return { chars: collections.reduce((s, c) => s + c.chars, 0), collections };
  }

  /* ---------------- inside ---------------- */

  #text(c) { return (c.text ??= JSON.stringify(c.rows)); }

  /** Every change goes through here: a new array (or null: the collection is gone) in place of the old. */
  #setRows(col, rows) {
    // Refused, and said so, in a window that only shows the records; a transaction's changes go back at its end.
    if (!this.#txn && !this.#writes()) { this.#refuse(); return; }
    let c = this.#cols.get(col);
    if (!c) { c = { rows: null, text: null, ver: 0, saved: 0 }; this.#cols.set(col, c); }
    if (this.#txn && !this.#txn.before.has(col)) { this.#txn.before.set(col, c.rows); this.#txn.ver.set(col, c.ver); }
    c.rows = rows; c.text = null; c.ver++;
    if (!this.#txn) this.#persistSoon();
  }

  #fill(entries) {
    for (const [col, value] of Object.entries(entries || {})) {
      if (!COLLECTION.test(col) || !this.holdsCollection(col)) continue;
      const rows = parseRows(value);
      if (!rows) { if (value != null) console.warn(`LNP Lab: the stored "${col}" list is damaged and was not loaded`); continue; }
      this.#cols.set(col, { rows, text: typeof value === 'string' ? value : null, ver: 0, saved: 0 });
    }
  }

  // A synchronous backend (localStorage) is written straight away, as it always was; the others a moment
  // later, so that the puts of one click go out as one write.
  #persistSoon() {
    if (this.backend.sync) { this.#writeSync(); return; }
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => { this.#scheduled = false; this.flush(); });
  }

  #batch() {
    // Only the window that writes stores anything (WindowRole): another window's collections may be older than
    // what is stored, and storing them whole would undo the writer's changes.
    if (this.#role && !this.#role.mayStore()) return [];
    const out = [];
    for (const [col, c] of this.#cols) if (c.ver > c.saved) out.push([col, c.ver, c.rows ? this.#text(c) : null]);
    return out;
  }

  // Nothing to write is not a write that got through: the note about a failed one stays (an undone change and
  // the one built on it leave nothing behind, and the write queued for the second then finds nothing).
  #writeSync() {
    const batch = this.#batch();
    if (!batch.length) return { ok: true, error: null };
    let error = null;
    try { this.backend.writeSync(this.ns, batch.map(([col, , text]) => [col, text])); } catch (err) { error = err || new Error('write failed'); }
    return this.#settle(batch, error);
  }

  async #writeAsync() {
    const batch = this.#batch();
    if (!batch.length) return { ok: true, error: null };
    let error = null;
    try { await this.backend.write(this.ns, batch.map(([col, , text]) => [col, text])); } catch (err) { error = err || new Error('write failed'); }
    return this.#settle(batch, error);
  }

  /** After a write: mark what was stored, decide the transactions it carried, and say how things stand. */
  #settle(batch, error) {
    const tried = new Map(batch.map(([col, ver]) => [col, ver]));
    if (!error) {
      for (const [col, ver] of batch) { const c = this.#cols.get(col); if (c) c.saved = Math.max(c.saved, ver); }
      if (this.engine === 'indexeddb') this.#markMoved();
      this.#link?.post({ ns: this.ns, cols: [...tried.keys()] });
    }
    // Every collection a transaction changed went out in the same write (the write takes all that is unsaved),
    // so one write decides each transaction whole.
    const undone = [];
    for (const t of [...this.#pending]) {
      if (![...t.target].every(([col, ver]) => (tried.get(col) ?? -1) >= ver)) continue;
      this.#pending.splice(this.#pending.indexOf(t), 1);
      if (error) undone.push(t); else { try { t.onSaved?.(); } catch (err) { console.warn(err); } }
    }
    if (error && undone.length) {
      // A transaction still waiting for its own write was run after these, and one that changed a record an
      // undone one made or changed was built on it: a second result on the same experiment, a formulation of
      // the experiment being created, the next number of a series. Stored on its own, it would hold a slot
      // closed by a result that is gone, or a number past one never stored; it is undone with them (cycle 6, W3).
      for (const t of [...this.#pending]) {
        if (!undone.some((u) => builtOn(t, u))) continue;
        this.#pending.splice(this.#pending.indexOf(t), 1);
        undone.push(t);
      }
      // Newest first, so each undo finds its own rows in place.
      for (const t of [...undone].reverse()) this.#undo(t);
      // Each screen that waited says whether it is still there, with its input, before the note is written.
      for (const t of undone) { try { t.kept = t.onUndone?.() === true; } catch (err) { console.warn(err); } }
      this.#report(error, undone);
    } else if (error) this.#report(error, []);
    return this.#status(error);
  }

  #status(error = null) {
    const ok = !error && !this.unsaved();
    if (ok && this.problem && this.problem.kind !== 'unopened') this.#resolved();
    return { ok, error };
  }

  /**
   * Put back what a transaction changed. Usually nothing has touched those collections since, and the old
   * arrays go back as they were. If something has, only the transaction's own records are taken out and the
   * ones it replaced or removed put back, so a later change to other records survives (see revert()).
   */
  #undo(t) {
    for (const [col, before] of t.before) {
      const c = this.#cols.get(col);
      const after = t.after.get(col);
      if (c.rows === after) {
        // Exactly as before the transaction, so its change count goes back too: unsaved() then says whether
        // anything is still waiting to be written, and the note offers "Try again" only when something is.
        c.rows = before; c.ver = t.ver.get(col);
      } else {
        c.rows = revert(before || [], after || [], c.rows || []);
        c.ver++; // the later change in this collection is still to be written
      }
      c.text = null;
    }
  }

  #report(error, undone, kind = failureKind(error)) {
    // While the database is not open, every write fails for that reason, and the note keeps saying to reload.
    if (this.problem?.kind === 'unopened') kind = 'unopened';
    const what = undone.map((t) => t.what).filter(Boolean);
    // Kept: every change undone came from a screen that is still showing, with its input (onUndone), so the
    // screen is not drawn again and the note can say to press its button again.
    const kept = undone.length > 0 && undone.every((t) => t.kept);
    const again = kept ? undone.map((t) => t.again).find(Boolean) || '' : '';
    this.problem = { kind, undone: undone.length > 0, kept, what, message: describeFailure({ kind, undone: undone.length > 0, kept, again, what, reason: error?.message }), error };
    console.warn('LNP Lab could not store a change:', error);
    try { this.onProblem?.(this.problem); } catch (err) { console.warn(err); }
  }

  #resolved() {
    this.problem = null;
    try { this.onProblem?.(null); } catch (err) { console.warn(err); }
  }

  #movedKey() { return `${this.ns}.storage.idb`; }
  #markMoved() {
    if (this.#marked || this.engine !== 'indexeddb') return;
    try { localStorage.setItem(this.#movedKey(), '1'); this.#marked = true; } catch {}
  }

  /** Another window stored these collections: they are read back, once this window has read its own. */
  #heardStored(msg) {
    if (!msg || msg.ns !== this.ns || !Array.isArray(msg.cols)) return;
    if (!this.#loaded) { this.#early ||= new Set(); msg.cols.forEach((col) => this.#early.add(col)); return; }
    this.#readBack(msg.cols).catch(() => {});
  }

  /**
   * Read collections back from the backend (`cols`, or all of them) and tell the screens watching. One changed
   * here and not stored yet is kept, being newer, unless `whole`: a window that gains or loses the role takes
   * what is stored, as it is, and one that only shows the records has nothing it could store anyway.
   */
  async #readBack(cols = null, whole = false) {
    const stored = (await this.backend.load(this.ns)) || {};
    const read = [];
    for (const col of cols || new Set([...this.#cols.keys(), ...Object.keys(stored)])) {
      if (!cols && (!COLLECTION.test(col) || !this.holdsCollection(col))) continue;
      const c = this.#cols.get(col);
      if (!whole && c && c.ver > c.saved && this.#writes()) continue; // ours is newer and about to be written
      const rows = parseRows(stored[col] ?? null);
      const next = { rows, text: typeof stored[col] === 'string' ? stored[col] : null, ver: (c?.ver || 0) + 1, saved: (c?.ver || 0) + 1 };
      this.#cols.set(col, next);
      read.push(col);
    }
    if (read.length) for (const fn of [...this.#watchers]) { try { fn(read); } catch (err) { console.warn(err); } }
  }

  /**
   * Call `fn(cols)` each time collections another window stored have been read back into this one, so that a
   * screen showing one of their records can show what is stored now. Returns the function that stops it.
   */
  watchOtherWindows(fn) {
    this.#watchers.add(fn);
    return () => this.#watchers.delete(fn);
  }

  /* ---------------- one window writes (WindowRole, below) ---------------- */

  /** True while another window writes this lab: this one shows the records, and every change is refused. */
  get readOnly() { return !this.#writes(); }

  /**
   * Make this window the one that writes. The window that wrote until now first stores what it has pending, then
   * only shows the records; this one reads back what is stored before it writes anything. Resolves true once
   * this window writes.
   */
  takeOver() { return this.#role ? this.#role.takeOver() : Promise.resolve(true); }

  /** The page is going (pagehide), after its last flush(): another window may take the role at once. */
  leave() { this.#role?.leave(); }

  /**
   * The page came back from the browser's page cache (pageshow): who writes is settled again, and the records
   * read back. Resolves false, having done nothing, where windows do not take turns.
   */
  async rejoin() {
    if (!this.#role) return false;
    await this.#role.start(true);
    if (this.readOnly) await this.#readBack(null, true).catch(() => {});
    return true;
  }

  #writes() { return !this.#role || this.#role.writes(); }

  #refuse(what = '', kept = false) {
    try { this.onRefused?.({ what, kept }); } catch (err) { console.warn(err); }
  }

  /**
   * The role went to another window without a handover: this one did not answer in time (a frozen or sleeping
   * tab), and the other has written since. What this window still held unstored cannot be stored any more: its
   * transactions are undone, and what is stored is read back.
   */
  async #dropUnstored() {
    const undone = this.#pending.splice(0);
    await this.#readBack(null, true).catch(() => {});
    for (const t of undone) { try { t.onUndone?.(readOnlyProblem(t.what)); } catch (err) { console.warn(err); } }
  }

  // There is deliberately no id counter here: a count of the records gives a deleted record's number to the
  // next one. New ids come from usedIds() in app/schema.js, which counts the trash and every reference.
  /**
   * Every data collection in this namespace, for a backup. The same `<ns>.` prefix in localStorage also holds
   * this browser's preferences (`mode` = "advanced", `theme`, `navExperiments`, `lastExport` and `lastExportAt`, the demo switch
   * `demo`, `reminders`, `notified.<date>`, `schemaVersion`); those were never data and are not loaded as
   * collections, so the export holds the data and nothing else. (Reading "advanced" as JSON once made the
   * whole export throw: one stray key must never cost the user their backup.)
   */
  exportAll() {
    const out = { exportedAt: new Date().toISOString(), ns: this.ns, collections: {} };
    for (const [col, c] of this.#cols) {
      if (c.rows && COLLECTION.test(col) && this.holdsCollection(col)) out.collections[col] = JSON.parse(this.#text(c));
    }
    return out;
  }

  /**
   * Restore a backup: merged by id into what is there, or replacing each collection it carries. As forgiving
   * as the export: a file from an older version, or one edited by hand, may carry preferences or damaged
   * entries, and those are skipped rather than stopping the restore halfway. A key that holds a preference
   * here is never written over, whatever the file calls it. Returns what was done, so it can be reported:
   * `skipped` names the lists that were refused, not the odd values that were never data to begin with.
   * One transaction: a restore that cannot be stored is undone whole, not left half in.
   */
  importAll(obj, { merge = true } = {}) {
    return this.transaction(() => {
      const done = { collections: 0, records: 0, skipped: [] };
      const cols = obj && typeof obj.collections === 'object' && obj.collections ? obj.collections : {};
      for (const [col, rows] of Object.entries(cols)) {
        if (!Array.isArray(rows)) continue; // not a collection (an older export's schemaVersion, say): nothing to say
        if (!COLLECTION.test(col) || !this.holdsCollection(col)) { done.skipped.push(col); continue; }
        const records = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
        const existing = merge ? this.all(col) : [];
        // A record without an id cannot be merged by id. Keep each one rather than fold it into another, and
        // recognise it by its content, so importing the same file twice does not add it twice.
        const byId = new Map(existing.filter((r) => r?.id != null).map((r) => [r.id, r]));
        const unnamed = existing.filter((r) => r && r.id == null);
        const seen = new Set(unnamed.map((r) => JSON.stringify(r)));
        for (const r of records) {
          if (r.id != null) { byId.set(r.id, r); continue; }
          const k = JSON.stringify(r); if (!seen.has(k)) { seen.add(k); unnamed.push(r); }
        }
        this.replace(col, [...byId.values(), ...unnamed]);
        done.collections++; done.records += records.length;
      }
      return done;
    }, { what: 'the restore' });
  }

  /**
   * False when the key is one of this browser's preferences, true otherwise. Judged by name, not by what the
   * key holds now: a collection damaged by a cut-off write does not parse either, and a restore is exactly how
   * it gets repaired. The demo switch lives in the real namespace; in the demo namespace `demo` is data.
   */
  holdsCollection(col) {
    return !(PREFS.has(col) || (col === 'demo' && this.ns === 'lnp-lab'));
  }

  /*
   * The trash. Deleting an experiment, a stock or a buffer moves the records into the `trash` collection
   * instead of erasing them (usability cycle 2, F7): one entry per delete, holding every record it took and
   * where each one sat in its collection, so that restoring puts back exactly what went, in the same place.
   * It is an ordinary collection, so a backup carries it and a restore brings it back like any other.
   * Entries are kept for TRASH_DAYS; older ones are dropped the next time something is deleted.
   */

  /**
   * Move records to the trash as one entry. `refs` is [[collection, id], …]; ids that are not there are
   * skipped. `meta` = {kind, label} says what the entry is in the restore list. Returns the entry, or null
   * when there was nothing to move. One transaction: the entry and the removals are stored together, so an
   * interrupted delete leaves the records where they were, never in neither place.
   */
  moveToTrash(refs, meta = {}, now = new Date()) {
    // Nothing moved, so the screen offers no "Undo" of a delete that did not happen.
    if (!this.#writes()) { this.#refuse(meta.label || 'the delete'); return null; }
    return this.transaction(() => {
      const cols = new Map();
      const rowsOf = (col) => { if (!cols.has(col)) cols.set(col, this.all(col)); return cols.get(col); };
      const records = [];
      const idOf = (r) => (r?.id != null ? r.id : undefined);
      for (const [col, id] of refs) {
        const rows = rowsOf(col);
        const index = rows.findIndex((r) => r?.id === id);
        if (index < 0) continue;
        // Where it sat: between which neighbours (null at either end), and at which index. Taken after the
        // earlier removals in this entry, so putting the records back in reverse order lands each one where it
        // was, and the neighbours keep that true when other deletes are restored in between.
        records.push({ col, index, after: index === 0 ? null : idOf(rows[index - 1]), before: index === rows.length - 1 ? null : idOf(rows[index + 1]), rec: rows[index] });
        rows.splice(index, 1);
      }
      if (!records.length) return null;
      const entry = { id: `trash-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, kind: meta.kind || records[0].col, label: meta.label || records.map((r) => r.rec.id).join(', '), deletedAt: now.toISOString(), records };
      const cutoff = now.getTime() - TRASH_DAYS * 864e5;
      const kept = this.all('trash').filter((t) => !(Date.parse(t?.deletedAt) < cutoff));
      this.replace('trash', [...kept, entry]);
      for (const [col, rows] of cols) this.replace(col, rows);
      return entry;
    }, { what: 'the delete' });
  }

  /**
   * Put a trash entry back. Every record goes back unchanged, where it was (beside its old neighbours, or at
   * its old index when they are gone), and the entry leaves the trash. A record whose id has meanwhile been given to a
   * new record (a new experiment after the last one was deleted takes its number) is not overwritten: then
   * nothing is restored and `reason` says which ids are in the way. Returns {ok, entry?, reason?, taken?}.
   */
  restoreFromTrash(trashId) {
    if (!this.#writes()) { this.#refuse('the restore'); return { ok: false, reason: READ_ONLY_REASON }; }
    const trash = this.all('trash');
    const entry = trash.find((t) => t?.id === trashId);
    if (!entry || !Array.isArray(entry.records) || entry.records.some((r) => !r?.col || r.rec?.id == null)) return { ok: false, reason: entry ? 'the entry is damaged' : 'it is no longer in the trash' };
    // A record that is already back exactly as it was (a delete cut off halfway) is not in the way.
    const taken = entry.records.filter((r) => { const cur = this.get(r.col, r.rec.id); return cur && JSON.stringify(cur) !== JSON.stringify(r.rec); }).map((r) => r.rec.id);
    if (taken.length) return { ok: false, taken, reason: `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} in use again by a newer record` };
    return this.transaction(() => {
      for (const r of [...entry.records].reverse()) {
        const rows = this.all(r.col);
        if (rows.some((x) => x?.id === r.rec.id)) continue;
        rows.splice(slotFor(rows, r), 0, r.rec);
        this.replace(r.col, rows);
      }
      this.replace('trash', trash.filter((t) => t !== entry));
      return { ok: true, entry };
    }, { what: `the restore of ${entry.label}` });
  }

  /** Trash entries from the last `days` days, newest first. */
  recentTrash({ days = TRASH_DAYS, now = new Date() } = {}) {
    const cutoff = now.getTime() - days * 864e5;
    // Reversed before the (stable) sort, so two deletes in the same millisecond still list the later first.
    return this.all('trash').filter((t) => t && Array.isArray(t.records) && !(Date.parse(t.deletedAt) < cutoff))
      .reverse().sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  /** Erase everything in the trash for good. */
  emptyTrash() { this.#setRows('trash', null); }
}

/** How long a deleted record can still be restored. */
export const TRASH_DAYS = 30;

/* ---------------- failures, said plainly ---------------- */

/**
 * What kind of failure an error is: 'quota' (the browser's storage for this site is full), 'unavailable'
 * (the browser does not let the page store anything: a private window, site data blocked) or 'other'.
 */
export function failureKind(err) {
  const name = String(err?.name || ''), msg = String(err?.message || err || '');
  if (/QuotaExceeded|QUOTA_REACHED/i.test(name) || err?.code === 22 || err?.code === 1014 || /quota|storage is full|disk is full/i.test(msg)) return 'quota';
  if (/StorageUnavailable|SecurityError/.test(name)) return 'unavailable';
  return 'other';
}

/** The storage problem an error stands for, or null when it is not about storage. For the global error handlers. */
export function storageProblem(err) {
  const kind = failureKind(err);
  if (kind !== 'quota' && !/localStorage|IndexedDB|IDB|storage/i.test(String(err?.message || ''))) return null;
  return { kind, undone: false, what: [], message: describeFailure({ kind, reason: err?.message }), error: err };
}

/**
 * The note a failed save leaves on the screen. Plain words, what happened to the change, and what to do; never
 * the exception's text alone (cycle 4: "Error: Uncaught QuotaExceededError: Failed to execute 'setItem'…").
 */
export function describeFailure({ kind = 'other', undone = false, kept = false, again = '', what = [], reason = '' } = {}) {
  if (kind === 'unopened') {
    return 'Your records could not be opened: this browser\'s database did not answer. Nothing is lost. Reload the page; until the records open, nothing new can be saved.';
  }
  const head = kind === 'quota' ? 'Not saved: this browser\'s storage is full.'
    : kind === 'unavailable' ? 'Not saved: this browser is not letting LNP Lab store anything (a private window, or site data blocked for this page).'
    : `Not saved: the browser refused to store the change${reason ? ` (${String(reason).replace(/\.$/, '')})` : ''}.`;
  const list = Array.isArray(what) ? what : [what];
  const named = list.length ? list.slice(0, 2).join(' and ') + (list.length > 2 ? ` and ${list.length - 2} more` : '') : 'the change';
  const middle = undone ? ` ${named[0].toUpperCase()}${named.slice(1)} ${list.length > 1 ? 'were' : 'was'} undone, so nothing is half-saved.${kept ? ' Everything on this screen is still here.' : ''}`
    : ' Your latest changes are only in this window for now.';
  // After an undone change there is nothing waiting to be written, so "try again" means doing it again: the
  // screen kept its input, and the note names the button.
  const redo = kept && again ? ` press “${again}” again` : ' try again';
  const tail = kind === 'quota' ? ` Export a backup under Settings, then free space (empty the trash there, or free disk space) and${redo}.`
    : kind === 'unavailable' ? ' Export a backup under Settings before you close this window.'
    : ` Export a backup under Settings, then${redo}.`;
  return head + middle + tail;
}

/* ---------------- one window writes ---------------- */

/*
 * Usability cycle 6, W1. Every window holds the collections in memory and stores them whole, so two windows on
 * one lab wrote over each other: Settings typed in one undid the other's limits, an experiment page left open in
 * another tab wrote its old copies back, a record neither had stored yet got the untouched window's defaults,
 * and "Delete all data" was undone by a keystroke in the other window. Merging records field by field
 * (sharedRecord in app/ui/kit.js) fixed the common case only, and a lab has no need for two windows that write.
 *
 * So one window writes each namespace: the first one opened. Another window on the same namespace only shows
 * the records, refuses every change whole (onRefused says so), and reads back what the writer stores. Asked to
 * ("Use this window instead"), it takes over: the writer first stores what it has pending, then only shows the
 * records itself. A window that closes hands the role on at once; one that crashed, or stopped answering, loses
 * it within a few seconds. The real lab and the demo are separate namespaces, so a window on each writes.
 *
 * The writer's id and when it last said it was there are kept in localStorage (`<ns>.window.writer`), which
 * every window of the origin reads at once, and the windows talk over a BroadcastChannel, or where there is none
 * (Safari before 15.4, the floor in tests/compat.test.mjs) through localStorage's storage event (windowLink).
 */

/** Why a change was refused in a window that only shows the records. */
const READ_ONLY_REASON = 'LNP Lab is open in another window, and this one only shows your records';
const readOnlyProblem = (what) => ({ kind: 'readonly', undone: true, kept: true, what: what ? [what] : [], message: `Not saved: ${READ_ONLY_REASON}.` });

// In ms. A background tab may run its timers only once a minute, so the writer's heartbeat can go quiet while
// it is there: a writer not heard from is asked first, and a question is answered at once in any tab.
const WINDOW_TIMES = {
  beat: 1000, // how often the writer says it is there, and the others look
  stale: 3000, // a writer not heard from for this long is asked whether it is there
  ask: 700, // and given this long to answer
  settle: 120, // two windows claiming the role at once each wait this long, and the lower id has it
  handover: 4000, // how long a takeover waits for the writer to store what it has
  // How long the role stays free after the writer went: a window being reloaded takes it back in that time, and
  // the writer's last write has landed before another window reads the records.
  bye: 1500,
};

/**
 * Messages to and from the other windows of this origin: {post(msg), listen(fn)}. A BroadcastChannel, or the
 * storage event that every other window of the origin gets when one writes a localStorage key; without
 * `fallback`, null where there is no BroadcastChannel.
 */
export function windowLink({ storage = globalThis.localStorage, target = globalThis, fallback = true } = {}) {
  const fns = new Set();
  const hear = (msg) => { for (const fn of [...fns]) { try { fn(msg); } catch (err) { console.warn(err); } } };
  const listen = (fn) => { fns.add(fn); };
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel('lnp-lab.store');
    channel.onmessage = (e) => hear(e.data);
    channel.unref?.(); // node (tests) only: an open channel must not keep the process running
    return { post: (msg) => channel.postMessage(msg), listen };
  }
  if (!fallback) return null;
  const key = 'lnp-lab.window.message';
  let n = 0;
  target.addEventListener?.('storage', (e) => {
    if (e.key !== key || !e.newValue) return;
    try { hear(JSON.parse(e.newValue).msg); } catch {}
  });
  // Each message differs from the last (`n`), so two alike in a row are both heard.
  return { post: (msg) => { try { storage.setItem(key, JSON.stringify({ msg, n: `${Date.now()}.${++n}.${Math.random()}` })); } catch {} }, listen };
}

/**
 * This window's part in deciding which window writes a namespace. `hooks`, from the store: save() puts what the
 * screens wait to store into memory; store() stores it; gain() reads back what is stored before this window
 * writes; lost() drops what it can no longer store; changed(writes) says the role changed.
 */
class WindowRole {
  #timer = null;
  #rivals = null; // while claiming: the other windows that claimed at the same time
  #waiters = new Set();
  #busy = null; // asking, claiming or taking over
  #taking = null;
  #leaving = false;
  #freeSince = null; // when this window first saw the role free
  #solo = false; // localStorage refuses: there is no way to agree, and this window writes, as every window did before

  constructor(ns, { link, storage = globalThis.localStorage, times = {} }, hooks) {
    this.ns = ns;
    this.key = `${ns}.window.writer`;
    // Ids sort by when the window opened, so of two windows claiming at once the older one keeps writing.
    this.id = `${Date.now().toString(36).padStart(9, '0')}-${Math.random().toString(36).slice(2, 10)}`;
    this.link = link; this.storage = storage; this.times = { ...WINDOW_TIMES, ...times }; this.hooks = hooks;
    this.writing = false;
    link.listen((msg) => this.#heard(msg));
  }

  /** Settle the role: this window writes when no other one does, or none answers. `read`: read the records back first. */
  async start(read = false) {
    this.#leaving = false;
    const lease = this.#lease();
    if (lease && lease.id !== this.id && (this.#fresh(lease) || await this.#writerThere())) this.#set(false);
    else await this.#claim(read);
    if (!this.#timer) { this.#timer = setInterval(() => this.#tick(), this.times.beat); this.#timer.unref?.(); }
  }

  /** Whether this window writes. The lease is read as well, so a window that lost the role unheard stops at once. */
  writes() {
    if (this.#solo) return true;
    if (!this.writing) return false;
    const lease = this.#lease();
    if (lease && lease.id !== this.id) { this.#lost(); return false; }
    return true;
  }

  /** Whether what this window holds may still be stored: it writes, hands over or closes, and no other window took the role. */
  mayStore() {
    if (this.#solo) return true;
    const lease = this.#lease();
    return lease ? lease.id === this.id : this.writing || this.#leaving;
  }

  takeOver() {
    if (this.writing || this.#solo) return Promise.resolve(true);
    if (this.#taking) return this.#taking;
    const before = this.#busy; // a question or a claim already under way is let finish
    return (this.#taking = this.#run(async () => {
      await before;
      if (this.writing) return true;
      const lease = this.#lease();
      if (lease && lease.id !== this.id && (this.#fresh(lease) || await this.#writerThere())) {
        // The writer stores what it has and says so; one that does not answer (crashed, asleep) is not waited for.
        const yielded = this.#wait((m) => m.t === 'yielded' && m.to === this.id, this.times.handover);
        this.#post('take', { to: lease.id });
        await yielded;
      }
      return this.#claim(true);
    }).finally(() => { this.#taking = null; }));
  }

  leave() {
    clearInterval(this.#timer); this.#timer = null;
    if (!this.writing || this.#solo) return;
    // The last flush() is already on its way and may still store (mayStore); nothing new is accepted.
    this.#leaving = true; this.writing = false;
    try { if (this.#lease()?.id === this.id) this.storage.removeItem(this.key); } catch {}
    this.#post('bye');
  }

  #run(fn) {
    const p = fn().catch((err) => { console.warn('LNP Lab: which window writes could not be settled', err); return false; })
      .finally(() => { if (this.#busy === p) this.#busy = null; });
    return (this.#busy = p);
  }

  #set(writing) { if (this.writing === writing) return; this.writing = writing; this.hooks.changed?.(writing); }

  /** Take the role: say so, wait for a window claiming at the same time, and keep it unless that one is older. */
  async #claim(read) {
    try { this.storage.setItem(this.key, JSON.stringify({ id: this.id, at: Date.now() })); }
    catch (err) { console.warn('LNP Lab: windows cannot agree which one writes', err); this.#solo = true; this.#set(true); return true; }
    const rivals = this.#rivals = new Set();
    this.#post('claim');
    await sleep(this.times.settle);
    this.#rivals = null;
    if ([...rivals].some((id) => id < this.id)) { if (this.writing) await this.#lost(); else this.#set(false); return false; }
    this.#hold(); // whichever window wrote it last, the lease now names the one that has the role
    if (read) await this.hooks.gain?.();
    if (this.#lease()?.id !== this.id) { this.#set(false); return false; } // taken meanwhile
    this.#set(true);
    return true;
  }

  /** Hand the role to window `to`: what is pending is stored first, and nothing new is accepted from then on. */
  async #handOver(to) {
    this.hooks.save?.();
    this.#set(false);
    await this.hooks.store?.(); // the lease still names this window until the other one claims it
    this.#post('yielded', { to });
  }

  /** Another window took the role while this one did not answer: nothing more is stored from here. */
  async #lost() {
    if (!this.writing) return;
    this.writing = false;
    await this.hooks.lost?.();
    this.hooks.changed?.(false);
  }

  #tick() {
    if (this.#busy || this.#leaving || this.#solo) return;
    const lease = this.#lease();
    if (this.writing) { if (lease && lease.id !== this.id) this.#lost(); else this.#hold(); return; }
    if (!lease) { this.#freeSince ??= Date.now(); if (Date.now() - this.#freeSince >= this.times.bye) this.#run(() => this.#claim(true)); return; }
    this.#freeSince = null;
    if (!this.#fresh(lease)) this.#run(async () => (await this.#writerThere()) || this.#claim(true));
  }

  #heard(m) {
    if (!m || m.ns !== this.ns || typeof m.t !== 'string' || m.from === this.id) return;
    for (const fn of [...this.#waiters]) fn(m);
    if (m.t === 'who' && this.writing) { this.#hold(); this.#post('here'); }
    else if (m.t === 'claim') { if (this.#rivals) this.#rivals.add(m.from); else if (this.writing) this.#lost(); }
    else if (m.t === 'take' && this.writing) this.#run(() => this.#handOver(m.from));
    else if (m.t === 'bye' && !this.writing && !this.#solo) {
      setTimeout(() => { if (!this.writing && !this.#busy && !this.#leaving && !this.#lease()) this.#run(() => this.#claim(true)); }, this.times.bye);
    }
  }

  /** Whether the writer is there: true once it, or a window claiming the role, answers. */
  #writerThere() {
    const answered = this.#wait((m) => m.t === 'here' || m.t === 'claim', this.times.ask);
    this.#post('who');
    return answered;
  }

  #wait(match, ms) {
    return new Promise((resolve) => {
      const done = (yes) => { clearTimeout(timer); this.#waiters.delete(fn); resolve(yes); };
      const fn = (m) => { if (match(m)) done(true); };
      const timer = setTimeout(() => done(false), ms);
      this.#waiters.add(fn);
    });
  }

  #post(t, extra = {}) { this.link.post({ ns: this.ns, from: this.id, t, ...extra }); }
  #lease() { try { const v = JSON.parse(this.storage.getItem(this.key) || 'null'); return v && typeof v.id === 'string' ? v : null; } catch { return null; } }
  #hold() { try { this.storage.setItem(this.key, JSON.stringify({ id: this.id, at: Date.now() })); } catch {} }
  #fresh(lease) { return Date.now() - Number(lease.at) < this.times.stale; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The id high-water marks (`<ns>.counter.<series>`, app/schema.js) sit in localStorage beside the records. A create
// refused in a window that only shows the records puts them back too, or it would use up its number.
function counterMarks(ns) {
  const out = new Map();
  try { for (const k of lsKeys(`${ns}.counter.`)) out.set(k, localStorage.getItem(k)); } catch {}
  return out;
}
function putMarksBack(ns, marks) {
  try {
    for (const k of lsKeys(`${ns}.counter.`)) if (!marks.has(k)) localStorage.removeItem(k);
    for (const [k, v] of marks) localStorage.setItem(k, v);
  } catch {}
}

/* ---------------- backends ---------------- */

function defaultBackend() {
  // The macOS app keeps the records in a SQLite file of its own (tauri-plugin-sql); a browser in IndexedDB.
  if (globalThis.__TAURI__?.core?.invoke) return sqliteBackend();
  if (typeof indexedDB !== 'undefined' && indexedDB) return idbBackend();
  if (lsUsable()) return localStorageBackend();
  return memoryBackend();
}

/**
 * IndexedDB: one database for the app, one object store, one entry per collection keyed `<ns>.<collection>`
 * holding the collection's JSON. Whole collections, because the order of the records is part of the data (the
 * trash puts records back where they sat) and a collection is what the rest of the app reads at once.
 */
export function idbBackend(name = 'lnp-lab', { timeoutMs = 10000 } = {}) {
  let dbp = null;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    // An open that never answers (a stuck database process) must not leave the app blank for good.
    const timer = setTimeout(() => reject(Object.assign(new Error('the database did not answer'), { name: 'TimeoutError' })), timeoutMs);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('collections')) req.result.createObjectStore('collections'); };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      // A connection the browser closed (Safari drops it after the app was in the background) is opened again
      // on the next write instead of failing every write from then on.
      db.onclose = () => { dbp = null; };
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  }).catch((err) => { dbp = null; throw err; }));
  const range = (ns) => IDBKeyRange.bound(ns + '.', ns + '.￿');
  const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('collections', mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    const out = fn(tx.objectStore('collections'));
    // Said at once rather than left to auto-commit at the end of the task: a transaction still open when the
    // page goes (a reload, a closed window) is aborted, and a large write could otherwise be lost that way.
    if (mode === 'readwrite') tx.commit?.();
    tx.oncomplete = () => resolve(out.value);
    tx.onabort = tx.onerror = () => reject(tx.error || out.error || Object.assign(new Error('the write was aborted'), { name: 'AbortError' }));
  }));
  // One more try on a fresh connection, unless the database said it is full or did not answer at all: then
  // trying again cannot help, and a second wait would only keep the app blank for longer.
  const retry = (mode, fn) => run(mode, fn).catch((err) => { if (failureKind(err) === 'quota' || err?.name === 'TimeoutError') throw err; dbp = null; return run(mode, fn); });
  return {
    kind: 'indexeddb',
    load: (ns) => retry('readonly', (st) => {
      const out = { value: {} };
      const keys = st.getAllKeys(range(ns)), vals = st.getAll(range(ns));
      vals.onsuccess = () => { keys.result.forEach((k, i) => { out.value[String(k).slice(ns.length + 1)] = vals.result[i]; }); };
      return out;
    }),
    write: (ns, entries) => retry('readwrite', (st) => {
      for (const [col, text] of entries) { if (text == null) st.delete(`${ns}.${col}`); else st.put(text, `${ns}.${col}`); }
      return {};
    }),
    clear: (ns) => retry('readwrite', (st) => { st.delete(range(ns)); return {}; }),
  };
}

/**
 * SQLite, in the macOS app: one file, `lnp-lab.db` in the app's data folder
 * (~/Library/Application Support/org.lnplab.app/), through tauri-plugin-sql. Same shape as IndexedDB: one row per
 * collection, keyed `<ns>.<collection>`, holding its JSON. A write is one INSERT … ON CONFLICT statement, so the
 * collections of one save are stored together or not at all; a collection to delete is written as NULL in the same
 * statement and left out when reading, for the same reason. `invoke` is Tauri's (the plugin's own JS wrapper calls
 * the same commands); tests pass a stand-in.
 */
export function sqliteBackend(invoke = (...a) => globalThis.__TAURI__.core.invoke(...a), file = 'sqlite:lnp-lab.db') {
  let ready = null;
  const db = () => (ready ||= (async () => {
    const name = await invoke('plugin:sql|load', { db: file });
    await invoke('plugin:sql|execute', { db: name, query: 'CREATE TABLE IF NOT EXISTS collections (key TEXT PRIMARY KEY, json TEXT)', values: [] });
    return name;
  })().catch((err) => { ready = null; throw err; }));
  const range = (ns) => [ns + '.', ns + '.\uffff'];
  return {
    kind: 'sqlite', file,
    async load(ns) {
      const name = await db();
      const rows = await invoke('plugin:sql|select', { db: name, query: 'SELECT key, json FROM collections WHERE key >= $1 AND key < $2 AND json IS NOT NULL', values: range(ns) });
      const out = {};
      for (const r of rows || []) out[String(r.key).slice(ns.length + 1)] = r.json;
      return out;
    },
    async write(ns, entries) {
      if (!entries.length) return;
      const name = await db();
      const values = [], rows = [];
      entries.forEach(([col, text], i) => { rows.push(`($${2 * i + 1}, $${2 * i + 2})`); values.push(`${ns}.${col}`, text == null ? null : text); });
      await invoke('plugin:sql|execute', { db: name, query: `INSERT INTO collections (key, json) VALUES ${rows.join(', ')} ON CONFLICT(key) DO UPDATE SET json = excluded.json`, values });
    },
    async clear(ns) {
      const name = await db();
      await invoke('plugin:sql|execute', { db: name, query: 'DELETE FROM collections WHERE key >= $1 AND key < $2', values: range(ns) });
    },
  };
}

/** localStorage, as before cycle 4: written straight away, ~5 MB. The fallback where IndexedDB does not open. */
export function localStorageBackend(ls = globalThis.localStorage) {
  const b = {
    kind: 'localStorage', sync: true,
    loadSync(ns) {
      const out = {};
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.startsWith(ns + '.') && COLLECTION.test(k.slice(ns.length + 1))) out[k.slice(ns.length + 1)] = ls.getItem(k);
      }
      return out;
    },
    // Several keys cannot be written atomically, so on a failure the ones already written get their old
    // values back: all or nothing, as the IndexedDB backend is.
    writeSync(ns, entries) {
      const done = [];
      try {
        for (const [col, text] of entries) {
          const k = `${ns}.${col}`;
          done.push([k, ls.getItem(k)]);
          if (text == null) ls.removeItem(k); else ls.setItem(k, text);
        }
      } catch (err) {
        for (const [k, old] of done.reverse()) { try { if (old == null) ls.removeItem(k); else ls.setItem(k, old); } catch {} }
        throw err;
      }
    },
    clearSync(ns) { Object.keys(b.loadSync(ns)).forEach((col) => ls.removeItem(`${ns}.${col}`)); },
    load: async (ns) => b.loadSync(ns),
    write: async (ns, entries) => b.writeSync(ns, entries),
    clear: async (ns) => b.clearSync(ns),
  };
  return b;
}

/** Memory only: nothing survives a reload. For tests, and where the browser allows no storage at all. */
export function memoryBackend() {
  const data = new Map();
  return {
    kind: 'memory', data,
    load: async (ns) => Object.fromEntries([...data].filter(([k]) => k.startsWith(ns + '.')).map(([k, v]) => [k.slice(ns.length + 1), v])),
    write: async (ns, entries) => { for (const [col, text] of entries) { if (text == null) data.delete(`${ns}.${col}`); else data.set(`${ns}.${col}`, text); } },
    clear: async (ns) => { for (const k of [...data.keys()]) if (k.startsWith(ns + '.')) data.delete(k); },
  };
}

/** Every write refused: the records are there to read in this window, and the note says nothing is kept. */
function unavailableBackend() {
  const refuse = async () => { throw Object.assign(new Error('this browser does not let the page store data'), { name: 'StorageUnavailable' }); };
  return { kind: 'none', load: async () => ({}), write: refuse, clear: refuse };
}

/* ---------------- helpers ---------------- */

const copy = (v) => JSON.parse(JSON.stringify(v));
function parseRows(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try { const rows = JSON.parse(v); return Array.isArray(rows) ? rows : null; } catch { return null; }
}
function lsKeys(prefix) {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) out.push(k); }
  return out;
}
function lsGet(k) { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } }
function lsUsable() { try { return !!globalThis.localStorage && typeof globalThis.localStorage.getItem === 'function'; } catch { return false; } }

/** The collections an earlier version kept in localStorage under this namespace: [{key, col, rows}]. */
function legacyCollections(store) {
  const out = [];
  try {
    const prefix = store.ns + '.';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const col = key.slice(prefix.length);
      if (!COLLECTION.test(col) || !store.holdsCollection(col)) continue;
      const rows = parseRows(localStorage.getItem(key));
      if (rows) out.push({ key, col, rows }); // a damaged one stays where it is: nothing in it can be moved
    }
  } catch { /* localStorage blocked: there is nothing to move */ }
  return out;
}

/** `extra` laid over `base` by id (a row of `extra` wins); rows without an id added unless already there. */
function mergeById(base, extra) {
  const out = base.slice();
  const at = new Map();
  out.forEach((r, i) => { if (r?.id != null) at.set(r.id, i); });
  const unnamed = new Set(out.filter((r) => r?.id == null).map((r) => JSON.stringify(r)));
  for (const r of extra) {
    if (r?.id != null) { if (at.has(r.id)) out[at.get(r.id)] = r; else { at.set(r.id, out.length); out.push(r); } continue; }
    const k = JSON.stringify(r); if (!unnamed.has(k)) { unnamed.add(k); out.push(r); }
  }
  return out;
}

/**
 * A transaction taken out of `now`: `before` and `after` are the collection around it, `now` what it is today.
 *
 * Records are matched by id, not by object. Every put makes a new object, so a record the transaction made or
 * changed and a later put changed again is a different object by now, and matching objects left it behind
 * (usability cycle 6, W3): the formulation of an undone experiment, set to "produced" while the experiment was
 * being stored, stayed and was stored without it. A record the transaction made goes, whatever happened to it
 * since. One it changed gets back what it had before in what the transaction changed, and keeps a later change
 * to anything else (a remark typed into a formulation whose result was undone). One it removed comes back
 * where it was, unless something has put it back already. Records without an id are matched by object.
 */
function revert(before, after, now) {
  const byId = (rows) => new Map(rows.filter((r) => r?.id != null).map((r) => [r.id, r]));
  const was = byId(before), is = byId(after);
  const wasBefore = new Set(before), isAfter = new Set(after);
  const out = [];
  for (const r of now) {
    if (r?.id == null) { if (wasBefore.has(r) || !isAfter.has(r)) out.push(r); continue; }
    if (!is.has(r.id)) out.push(r); // not the transaction's: added since, or removed by it and put back since
    else if (was.has(r.id)) out.push(was.get(r.id) === is.get(r.id) ? r : unchange(was.get(r.id), is.get(r.id), r));
  }
  const present = new Set(out);
  const ids = new Set(out.filter((r) => r?.id != null).map((r) => r.id));
  before.forEach((r, i) => {
    const removed = r?.id != null ? !is.has(r.id) : !isAfter.has(r);
    if (!removed || present.has(r) || (r?.id != null && ids.has(r.id))) return;
    out.splice(Math.min(i, out.length), 0, r);
  });
  return out;
}

/**
 * A record a transaction changed from `was` to `became`, and that a later change made `now`: `was` again
 * wherever the transaction changed it, field by field, and `now` wherever it did not. Where the later change
 * altered what the transaction had changed, it was built on that change, and goes with it.
 */
function unchange(was, became, now) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(was, became)) return now;
  if (same(now, became)) return was;
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(was) || !plain(became) || !plain(now)) return was;
  const out = {};
  for (const k of new Set([...Object.keys(was), ...Object.keys(became), ...Object.keys(now)])) {
    const v = unchange(was[k], became[k], now[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The ids of the records a transaction made, changed or removed in one collection, worked out once. */
function touchedBy(t, col) {
  t.touched ||= new Map();
  if (!t.touched.has(col)) {
    const before = t.before.get(col) || [], after = t.after.get(col) || [];
    const kept = new Set(before), old = new Map(before.filter((r) => r?.id != null).map((r) => [r.id, r]));
    const ids = new Set();
    for (const r of after) {
      if (r?.id == null || kept.has(r)) continue;
      if (JSON.stringify(old.get(r.id)) !== JSON.stringify(r)) ids.add(r.id);
    }
    const still = new Set(after.filter((r) => r?.id != null).map((r) => r.id));
    for (const id of old.keys()) if (!still.has(id)) ids.add(id);
    t.touched.set(col, ids);
  }
  return t.touched.get(col);
}

/** Whether transaction `t`, run after `u`, changed a record that `u` made, changed or removed. */
function builtOn(t, u) {
  for (const col of t.before.keys()) {
    if (!u.before.has(col)) continue;
    const mine = touchedBy(t, col), theirs = touchedBy(u, col);
    for (const id of mine) if (theirs.has(id)) return true;
  }
  return false;
}

/** Where a trashed record goes back: after its old predecessor, else before its old successor, else its old index. */
function slotFor(rows, r) {
  const at = (id) => (id == null ? -1 : rows.findIndex((x) => x?.id === id));
  if (r.after === null) return 0;
  if (at(r.after) >= 0) return at(r.after) + 1;
  if (r.before === null) return rows.length;
  if (at(r.before) >= 0) return at(r.before);
  return Math.min(r.index ?? rows.length, rows.length);
}

// Collection names are plain identifiers. Dotted keys under the prefix (`notified.2026-10-27`, `ui.formulations`,
// `hidden.orphans`, `storage.idb`) are bookkeeping and stay in localStorage.
const COLLECTION = /^[A-Za-z_]\w*$/;
// This browser's settings that share the namespace prefix with the data (see app/main.js, app/demo.js).
const PREFS = new Set(['mode', 'theme', 'navExperiments', 'lastExport', 'lastExportAt', 'reminders', 'schemaVersion']);
