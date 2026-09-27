/* Letterboxd Draft Saver — content script
 *
 * Watches every review / description box on letterboxd.com and writes what you
 * type to two places: chrome.storage.local (the real store, readable from the
 * toolbar popup) and window.localStorage (a synchronous mirror, written on the
 * same tick as the keystroke so a hard crash can't lose the last few words).
 * On page load the two are reconciled and the newer one wins.
 */
(() => {
  'use strict';
  if (window.__LBDS_LOADED__) return;
  window.__LBDS_LOADED__ = true;

  const SKEY = 'lbdraft:';        // chrome.storage.local key prefix
  const MKEY = 'lbdraft.v1:';     // localStorage mirror prefix
  const DEBOUNCE_MS = 400;        // save this long after you stop typing
  const HEARTBEAT_MS = 4000;      // ...and at least this often while typing
  const HISTORY_MAX = 8;
  const MILESTONE_CHARS = 180;
  const MILESTONE_MS = 120000;
  const RESTORE_DELAY_MS = 350;   // let Letterboxd prefill the box first
  const VERIFY_DELAY_MS = 1600;   // then check nothing overwrote us

  const cache = new Map();        // key -> record
  const states = new WeakMap();   // element -> per-field state
  const suppressed = new Set();   // keys the user chose not to restore, this page
  let settings = { autoRestore: true, showPill: true, trackEverything: true };
  let contextAlive = true;

  /* ------------------------------------------------------------------ utils */

  const now = () => Date.now();
  const countWords = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

  function ago(ts) {
    const s = Math.max(0, Math.round((now() - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24);
    return d + 'd ago';
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    return el.isContentEditable === true;
  }

  function isOurs(el) {
    const r = el.getRootNode && el.getRootNode();
    return !!(r && r.host && r.host.id === 'lbds-root');
  }

  function isOnScreenish(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 16) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function readValue(el) {
    if (el.tagName === 'TEXTAREA') return el.value || '';
    return el.innerText || '';
  }

  // Letterboxd's form is React-driven, so write through the native setter and
  // fire the events its own handlers listen for. Plain text only — nothing
  // stored is ever injected back as markup.
  function writeValue(el, text) {
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------------------------------------------------------------- storage */

  function ok() {
    if (!contextAlive) return false;
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { contextAlive = false; return false; }
  }

  function sget(keys) {
    return new Promise((resolve) => {
      if (!ok()) return resolve({});
      try {
        chrome.storage.local.get(keys, (res) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(res || {});
        });
      } catch (e) { contextAlive = false; resolve({}); }
    });
  }

  function sset(obj) {
    if (!ok()) return;
    try { chrome.storage.local.set(obj); } catch (e) { contextAlive = false; }
  }

  function mirrorWrite(rec) {
    try { localStorage.setItem(MKEY + rec.key, JSON.stringify(rec)); } catch (e) { /* quota / disabled */ }
  }

  function mirrorRead(key) {
    try {
      const raw = localStorage.getItem(MKEY + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function mirrorKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(MKEY)) out.push(k.slice(MKEY.length));
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  // Crash recovery: anything the mirror knows that the store doesn't gets
  // promoted back into the store before we touch the page.
  async function reconcile() {
    const keys = mirrorKeys();
    const stored = await sget(keys.map((k) => SKEY + k).concat(['settings']));
    if (stored.settings) settings = Object.assign(settings, stored.settings);

    const promote = {};
    for (const key of keys) {
      const mine = mirrorRead(key);
      const theirs = stored[SKEY + key];
      if (!mine) continue;
      if (!theirs || (mine.updatedAt || 0) > (theirs.updatedAt || 0)) {
        promote[SKEY + key] = mine;
        cache.set(key, mine);
      } else {
        cache.set(key, theirs);
      }
    }
    if (Object.keys(promote).length) sset(promote);
  }

  async function loadRecord(key) {
    if (cache.has(key)) return cache.get(key);
    const res = await sget(SKEY + key);
    const stored = res[SKEY + key] || null;
    const mine = mirrorRead(key);
    let rec = stored;
    if (mine && (!stored || (mine.updatedAt || 0) > (stored.updatedAt || 0))) rec = mine;
    if (rec) cache.set(key, rec);
    return rec;
  }

  /* --------------------------------------------------- identity & metadata */

  function formOf(el) {
    return el.form || el.closest('form') || null;
  }

  function isDiaryForm(form) {
    if (!form) return false;
    return (
      form.classList.contains('js-diary-entry-form') ||
      form.classList.contains('diary-entry-form') ||
      (form.getAttribute('action') || '').includes('save-diary-entry') ||
      form.getAttribute('data-js-target') === 'diary-entry-form'
    );
  }

  function classify(el, form) {
    const name = (el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.className || '');
    if (/review/i.test(name) || isDiaryForm(form)) return 'review';
    const action = form ? (form.getAttribute('action') || '') : '';
    if (/list/i.test(action) || /^\/list\//.test(location.pathname) || /\/list\/new/.test(location.pathname)) return 'list';
    if (/comment/i.test(name)) return 'comment';
    if (/bio|about/i.test(name)) return 'profile';
    return 'note';
  }

  function filmFromForm(form) {
    if (!form) return null;
    // Step 1 of the diary form is a film search; its results also carry
    // data-item-slug, so skip anything inside it and read the compose step.
    const notSearch = (n) => !n.closest('[data-js-wizard-step="search"]');
    const slugNode = Array.prototype.find.call(form.querySelectorAll('[data-item-slug]'), notSearch);
    if (slugNode) {
      return {
        slug: slugNode.getAttribute('data-item-slug'),
        name: slugNode.getAttribute('data-item-name') || slugNode.getAttribute('data-item-full-display-name') || '',
        link: slugNode.getAttribute('data-item-link') || ''
      };
    }
    const a = Array.prototype.find.call(form.querySelectorAll('a[href*="/film/"]'), notSearch);
    if (a) {
      const m = a.getAttribute('href').match(/\/film\/([^/?#]+)/);
      const title = form.querySelector('.primaryname, .headline-1, h2');
      const year = form.querySelector('.releasedate');
      if (m) {
        return {
          slug: m[1],
          name: title ? (title.textContent.trim() + (year ? ' (' + year.textContent.trim() + ')' : '')) : '',
          link: '/film/' + m[1] + '/'
        };
      }
    }
    return null;
  }

  function filmFromPage() {
    const m = location.pathname.match(/\/film\/([^/?#]+)/);
    if (!m) return null;
    const h1 = document.querySelector('h1.headline-1, .film-title-wrapper .headline-1, h1 .name');
    const year = document.querySelector('.film-title-wrapper .metablock a, .releasedate a');
    return {
      slug: m[1],
      name: h1 ? (h1.textContent.trim() + (year ? ' (' + year.textContent.trim() + ')' : '')) : m[1],
      link: '/film/' + m[1] + '/'
    };
  }

  function subjectOf(el, form, kind) {
    if (kind === 'review') {
      const film = filmFromForm(form) || filmFromPage();
      if (film && film.slug) return 'film/' + film.slug;
      return 'path' + location.pathname + ':pending';
    }
    return 'path' + location.pathname;
  }

  function fieldIdOf(el, form) {
    const name = el.getAttribute('name');
    if (name) return name;
    if (el.id && !/^\s*$/.test(el.id)) return el.id;
    const peers = (form || document).querySelectorAll('textarea, [contenteditable="true"]');
    return 'f' + Array.prototype.indexOf.call(peers, el);
  }

  function keyOf(el) {
    const form = formOf(el);
    const kind = classify(el, form);
    return kind + '|' + subjectOf(el, form, kind) + '|' + fieldIdOf(el, form);
  }

  function titleOf(el, kind) {
    const form = formOf(el);
    if (kind === 'review') {
      const film = filmFromForm(form) || filmFromPage();
      if (film && (film.name || film.slug)) return film.name || film.slug;
      return 'Diary entry (film not chosen yet)';
    }
    if (kind === 'list') {
      const t = document.querySelector('input[name="name"], #frm-name');
      if (t && t.value) return 'List: ' + t.value;
      return 'List';
    }
    return (document.title || location.pathname).replace(/\s*[–—|].*Letterboxd.*$/i, '').trim() || location.pathname;
  }

  // Everything around the review box that's also annoying to retype.
  function harvestMeta(form) {
    const meta = {};
    if (!form) return meta;
    const rating = form.querySelector('input[name="rating"], #frm-rating');
    if (rating && Number(rating.value) > 0) meta.rating = Number(rating.value) / 2;
    const liked = form.querySelector('input[name="liked"], .like-checkbox');
    if (liked) meta.liked = !!liked.checked;
    const spoilers = form.querySelector('input[name="containsSpoilers"], #frm-spoilers');
    if (spoilers) meta.spoilers = !!spoilers.checked;
    const rewatch = form.querySelector('input[name="rewatch"], #frm-rewatch');
    if (rewatch) meta.rewatch = !!rewatch.checked;

    const tags = [];
    const live = form.querySelector('input[name="tags"], #frm-tags');
    if (live && live.value.trim()) tags.push(live.value.trim());
    form.querySelectorAll('#current-tags input[type="hidden"]').forEach((n) => {
      if (n.value) tags.push(n.value);
    });
    form.querySelectorAll('#current-tags .tag, .js-autocomplete-current-tags .tag').forEach((n) => {
      const t = n.textContent.trim();
      if (t) tags.push(t);
    });
    if (tags.length) meta.tags = Array.from(new Set(tags));

    const dateLabel = form.querySelector('[data-js-trigger="datepicker"] .label, .js-specify-date-label');
    if (dateLabel && dateLabel.textContent.trim()) meta.watchedDate = dateLabel.textContent.trim().slice(0, 60);
    return meta;
  }

  function metaSummary(meta) {
    if (!meta) return '';
    const bits = [];
    if (meta.rating) bits.push(meta.rating + '★');
    if (meta.liked) bits.push('liked');
    if (meta.rewatch) bits.push('rewatch');
    if (meta.spoilers) bits.push('spoilers');
    if (meta.tags && meta.tags.length) bits.push(meta.tags.join(', '));
    if (meta.watchedDate) bits.push(meta.watchedDate);
    return bits.join(' · ');
  }

  /* ------------------------------------------------------------ record save */

  function buildRecord(el, prev) {
    const form = formOf(el);
    const kind = classify(el, form);
    const key = keyOf(el);
    const text = readValue(el);
    const t = now();
    const rec = {
      key: key,
      kind: kind,
      title: titleOf(el, kind),
      url: location.href,
      path: location.pathname,
      text: text,
      meta: harvestMeta(form),
      chars: text.length,
      words: countWords(text),
      createdAt: prev ? prev.createdAt : t,
      updatedAt: t,
      submittedAt: prev ? prev.submittedAt || null : null,
      recovery: prev ? prev.recovery || null : null,
      longest: prev ? prev.longest || null : null,
      history: prev ? (prev.history || []).slice() : [],
      milestoneAt: prev ? prev.milestoneAt || 0 : 0,
      milestoneChars: prev ? prev.milestoneChars || 0 : 0
    };

    const prevText = prev ? prev.text || '' : '';

    // Text vanished (select-all + delete, a bad paste, their JS resetting the
    // form). Never let that erase the backup.
    if (!text.trim() && prevText.trim().length > 8) {
      rec.recovery = { text: prevText, at: prev.updatedAt || t };
    }

    // Keep the longest thing ever typed here. If a stray select-all-and-type
    // flattens 900 words into one, this is what gets them back.
    let longest = rec.longest;
    const lenOf = (s) => (s && s.text ? s.text.length : 0);
    if (prevText.length > lenOf(longest)) longest = { text: prevText, at: prev.updatedAt || t };
    if (text.length > lenOf(longest)) longest = { text: text, at: t };
    rec.longest = longest && longest.text.trim().length > 8 ? longest : null;

    const grew = Math.abs(text.length - rec.milestoneChars) >= MILESTONE_CHARS;
    const aged = t - rec.milestoneAt >= MILESTONE_MS;
    if (text.trim() && (grew || aged)) {
      rec.history.push({ at: t, text: text });
      if (rec.history.length > HISTORY_MAX) rec.history.splice(0, rec.history.length - HISTORY_MAX);
      rec.milestoneAt = t;
      rec.milestoneChars = text.length;
    }
    return rec;
  }

  function saveNow(el, reason) {
    const st = states.get(el);
    if (!st) return null;
    if (!el.isConnected) return null;
    if (!isOnScreenish(el)) return null;         // hidden modal: keep what we have

    const key = keyOf(el);
    if (key !== st.key) {                        // film chosen mid-session, etc.
      st.key = key;
    }
    const prev = cache.get(key) || null;
    const rec = buildRecord(el, prev);
    if (prev && prev.text === rec.text && reason !== 'submit' && reason !== 'flush') {
      if (JSON.stringify(prev.meta) === JSON.stringify(rec.meta)) {
        st.dirty = false;                        // nothing moved, stop the heartbeat
        return prev;
      }
    }
    cache.set(key, rec);
    mirrorWrite(rec);                            // synchronous, survives a crash
    sset({ [SKEY + key]: rec });                 // async, feeds the popup
    st.savedAt = rec.updatedAt;
    st.dirty = false;
    if (rec.text.trim()) paintPill(el, 'saved');
    else paintPill(el, 'idle');
    return rec;
  }

  function scheduleSave(el) {
    const st = states.get(el);
    if (!st) return;
    st.dirty = true;
    paintPill(el, 'typing');
    clearTimeout(st.timer);
    st.timer = setTimeout(() => saveNow(el, 'debounce'), DEBOUNCE_MS);
    if (!st.heartbeat) {
      st.heartbeat = setInterval(() => {
        if (!el.isConnected) { clearInterval(st.heartbeat); st.heartbeat = null; return; }
        if (st.dirty) saveNow(el, 'heartbeat');
      }, HEARTBEAT_MS);
    }
  }

  function flushAll(reason) {
    fields().forEach((el) => {
      const st = states.get(el);
      if (st && st.dirty) saveNow(el, reason || 'flush');
    });
  }

  /* ----------------------------------------------------------------- the UI */

  let root = null;
  let shadow = null;
  let toastEl = null;

  const CSS = `
    :host { all: initial; display: block; }
    .wrap { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .pill { position: fixed; pointer-events: none; display: flex; align-items: center; gap: 6px;
            padding: 3px 8px; border-radius: 999px; font-size: 11px; line-height: 1.4;
            background: rgba(10, 14, 17, .82); color: #cfd9e0; border: 1px solid rgba(255,255,255,.08);
            backdrop-filter: blur(4px); transition: opacity .18s ease; }
    .pill.hide { opacity: 0; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #00e054; }
    .pill.typing .dot { background: #40bcf4; }
    .pill.idle { opacity: .55; }
    .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
             width: min(480px, calc(100vw - 32px)); pointer-events: auto;
             background: #171e24; color: #e6ecef; border: 1px solid #2b353e;
             border-left: 3px solid #ff8000; border-radius: 6px;
             box-shadow: 0 12px 32px rgba(0,0,0,.45); padding: 12px 14px; font-size: 13px; }
    .toast h4 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: #fff; }
    .toast p { margin: 0; color: #93a2ad; font-size: 12px; line-height: 1.5; }
    .toast .excerpt { margin-top: 8px; padding-left: 9px; border-left: 2px solid #2b353e;
                      color: #c3ccd4; font-size: 12px; line-height: 1.55;
                      max-height: 72px; overflow: hidden; }
    .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    button { font: inherit; font-size: 12px; cursor: pointer; border-radius: 4px;
             padding: 5px 10px; border: 1px solid #36424c; background: #212a32; color: #dce4ea; }
    button:hover { background: #2a343d; }
    button.primary { background: #ff8000; border-color: #ff8000; color: #201000; font-weight: 600; }
    button.primary:hover { background: #ff9426; }
    button.ghost { background: transparent; border-color: transparent; color: #8b9aa5; }
    button.ghost:hover { color: #dce4ea; }
    button:focus-visible { outline: 2px solid #79b8ff; outline-offset: 1px; }
    .spacer { flex: 1; }
    @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
  `;

  function ui() {
    if (shadow) return shadow;
    root = document.createElement('div');
    root.id = 'lbds-root';
    root.setAttribute('aria-live', 'polite');
    shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    shadow.append(style, wrap);
    (document.body || document.documentElement).appendChild(root);
    return shadow;
  }

  function wrapEl() { return ui().querySelector('.wrap'); }

  function paintPill(el, mode) {
    if (!settings.showPill) return;
    const st = states.get(el);
    if (!st) return;
    // Don't decorate boxes nobody is using.
    if (mode === 'idle' && document.activeElement !== el && !readValue(el).trim()) {
      if (st.pill) { st.pill.remove(); st.pill = null; }
      return;
    }
    if (!st.pill) {
      st.pill = document.createElement('div');
      st.pill.className = 'pill';
      st.pill.innerHTML = '<span class="dot"></span><span class="txt"></span>';
      wrapEl().appendChild(st.pill);
    }
    const txt = st.pill.querySelector('.txt');
    if (mode === 'typing') txt.textContent = 'Saving…';
    else if (mode === 'saved') txt.textContent = 'Draft saved ' + ago(st.savedAt || now());
    else txt.textContent = 'Draft saver on';
    st.pill.className = 'pill ' + (mode === 'typing' ? 'typing' : mode === 'idle' ? 'idle' : '');
    positionPill(el);
  }

  function positionPill(el) {
    const st = states.get(el);
    if (!st || !st.pill) return;
    if (!el.isConnected || !isOnScreenish(el)) { st.pill.classList.add('hide'); return; }
    const r = el.getBoundingClientRect();
    const offscreen = r.bottom < 40 || r.top > innerHeight - 10;
    st.pill.classList.toggle('hide', offscreen);
    st.pill.style.left = Math.max(8, r.right - st.pill.offsetWidth - 10) + 'px';
    st.pill.style.top = Math.min(innerHeight - 28, r.bottom - st.pill.offsetHeight - 8) + 'px';
  }

  function tick() {
    fields().forEach((el) => {
      const st = states.get(el);
      if (st && st.pill && !st.dirty && st.savedAt) {
        st.pill.querySelector('.txt').textContent = 'Draft saved ' + ago(st.savedAt);
        st.pill.classList.toggle('idle', now() - st.savedAt > 10000);
      }
      positionPill(el);
    });
  }

  function closeToast() {
    if (toastEl) { toastEl.remove(); toastEl = null; }
  }

  function showToast(opts) {
    closeToast();
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    const h = document.createElement('h4');
    h.textContent = opts.title;
    const p = document.createElement('p');
    p.textContent = opts.body;
    toastEl.append(h, p);
    if (opts.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'excerpt';
      ex.textContent = opts.excerpt;
      toastEl.appendChild(ex);
    }
    const row = document.createElement('div');
    row.className = 'row';
    (opts.actions || []).forEach((a, i) => {
      if (a.spacer) { const s = document.createElement('div'); s.className = 'spacer'; row.appendChild(s); return; }
      const b = document.createElement('button');
      b.textContent = a.label;
      b.className = a.style || '';
      b.addEventListener('click', () => { closeToast(); a.onClick && a.onClick(); });
      row.appendChild(b);
    });
    toastEl.appendChild(row);
    wrapEl().appendChild(toastEl);
    if (opts.autoHideMs) setTimeout(() => { if (toastEl) closeToast(); }, opts.autoHideMs);
  }

  const excerptOf = (t) => (t.length > 260 ? t.slice(0, 260).trimEnd() + '…' : t);

  /* --------------------------------------------------------------- restore */

  function restoreInto(el, rec, opts) {
    const before = readValue(el);
    writeValue(el, rec.text);

    const form = formOf(el);
    if (form && rec.meta) {
      const set = (sel, val) => {
        const n = form.querySelector(sel);
        if (n && typeof val === 'boolean' && n.checked !== val && !n.disabled) {
          n.checked = val;
          n.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      set('input[name="liked"], .like-checkbox', rec.meta.liked);
      set('input[name="rewatch"], #frm-rewatch', rec.meta.rewatch);
      set('input[name="containsSpoilers"], #frm-spoilers', rec.meta.spoilers);
    }

    const leftover = [];
    if (rec.meta && rec.meta.rating) leftover.push('rating ' + rec.meta.rating + '★');
    if (rec.meta && rec.meta.tags && rec.meta.tags.length) leftover.push('tags: ' + rec.meta.tags.join(', '));

    showToast({
      title: 'Draft restored',
      body: 'Written ' + ago(rec.updatedAt) + ' · ' + rec.words + ' words' +
            (leftover.length ? '. Set again by hand: ' + leftover.join('; ') + '.' : '.'),
      actions: [
        { label: 'Undo', style: 'ghost', onClick: () => { writeValue(el, before); suppressed.add(rec.key); } },
        { spacer: true },
        { label: 'Keep it', style: 'primary' }
      ],
      autoHideMs: 14000
    });

    const st = states.get(el);
    if (st) {
      st.restoredText = rec.text;
      clearTimeout(st.verify);
      st.verify = setTimeout(() => {
        if (!el.isConnected) return;
        const v = readValue(el);
        if (st.restoredText && v.trim() === '' ) {
          // Letterboxd wiped the box after we filled it — offer it again.
          offerRestore(el, rec);
        }
      }, VERIFY_DELAY_MS);
    }
  }

  function offerRestore(el, rec) {
    showToast({
      title: 'Saved draft for ' + rec.title,
      body: 'Last typed ' + ago(rec.updatedAt) + ' · ' + rec.words + ' words' +
            (metaSummary(rec.meta) ? ' · ' + metaSummary(rec.meta) : ''),
      excerpt: excerptOf(rec.text),
      actions: [
        { label: 'Restore draft', style: 'primary', onClick: () => restoreInto(el, rec) },
        { spacer: true },
        { label: 'Not now', style: 'ghost', onClick: () => suppressed.add(rec.key) }
      ]
    });
  }

  async function maybeRestore(el) {
    const st = states.get(el);
    if (!st || st.restoreTried) return;
    st.restoreTried = true;
    const key = keyOf(el);       // the film may have been picked after we started watching
    st.key = key;
    if (suppressed.has(key)) return;
    const rec = await loadRecord(key);
    if (!rec || !rec.text || !rec.text.trim()) return;
    if (rec.submittedAt && rec.submittedAt >= rec.updatedAt) return;   // already posted
    const current = readValue(el);
    if (current.trim() === rec.text.trim()) return;                    // nothing to do

    if (current.trim() === '') {
      if (settings.autoRestore) restoreInto(el, rec);
      else offerRestore(el, rec);
    } else {
      // Box already has text (editing a posted review, or a newer draft).
      // Never clobber it — just offer.
      offerRestore(el, rec);
    }
  }

  /* -------------------------------------------------------------- tracking */

  const trackedEls = new Set();

  function fields() {
    const live = [];
    trackedEls.forEach((el) => {
      if (el.isConnected) { live.push(el); return; }
      const st = states.get(el);
      if (st) {
        clearTimeout(st.timer);
        clearInterval(st.heartbeat);
        if (st.pill) st.pill.remove();
      }
      trackedEls.delete(el);
    });
    return live;
  }

  function track(el) {
    if (states.has(el)) return;
    if (!isEditable(el)) return;
    if (isOurs(el)) return;
    const kind = classify(el, formOf(el));
    if (!settings.trackEverything && kind !== 'review') return;

    states.set(el, { key: keyOf(el), dirty: false, savedAt: 0, timer: null, heartbeat: null, restoreTried: false });
    trackedEls.add(el);
    paintPill(el, 'idle');
    setTimeout(() => {
      if (el.isConnected && isOnScreenish(el)) maybeRestore(el);
      else { const st = states.get(el); if (st) st.restoreTried = false; }
    }, RESTORE_DELAY_MS);
  }

  function scan() {
    document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]').forEach((el) => {
      if (!isEditable(el)) return;
      if (!isOnScreenish(el)) return;
      track(el);
    });
    // fields tracked while hidden get a restore pass once they show up
    fields().forEach((el) => {
      const st = states.get(el);
      if (st && !st.restoreTried && isOnScreenish(el)) maybeRestore(el);
    });
  }

  /* --------------------------------------------- submit / delete detection */

  function resolveForm(node) {
    if (!node) return null;
    if (node.tagName === 'FORM') return node;
    const attr = node.getAttribute && node.getAttribute('form');
    if (attr) {
      const byId = document.getElementById(attr);
      if (byId) return byId;
    }
    const near = node.closest ? node.closest('form') : null;
    if (near) return near;
    // Letterboxd's Save button sits outside the form, wired up by its form
    // attribute; if that lookup missed, fall back to the diary form on screen.
    return document.querySelector('form.js-diary-entry-form, form[action*="save-diary-entry"]');
  }

  function markSubmittedKeys(keys) {
    keys.forEach((key) => {
      const rec = cache.get(key);
      if (!rec || !rec.text || !rec.text.trim()) return;
      rec.submittedAt = now();
      cache.set(key, rec);
      mirrorWrite(rec);
      sset({ [SKEY + key]: rec });
    });
  }

  // A click on Save is not proof of a save — validation can fail, the network
  // can drop. Wait for the form to actually disappear before calling it posted;
  // until then the draft stays restorable.
  function onSubmitish(node) {
    const form = resolveForm(node);
    if (!form) return;
    const keys = fields()
      .filter((el) => formOf(el) === form)
      .map((el) => { saveNow(el, 'submit'); return states.get(el).key; });
    if (!keys.length) return;
    setTimeout(() => {
      const gone = !form.isConnected || !isOnScreenish(form);
      if (gone) markSubmittedKeys(keys);
    }, 2000);
  }

  /* ----------------------------------------------------------------- wiring */

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!isEditable(el) || isOurs(el)) return;
    if (!states.has(el)) { track(el); }
    if (states.has(el)) scheduleSave(el);
  }, true);

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (isEditable(el) && !states.has(el)) track(el);
    if (isEditable(el) && states.has(el)) paintPill(el, states.get(el).savedAt ? 'saved' : 'idle');
  }, true);

  document.addEventListener('submit', (e) => onSubmitish(e.target), true);

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t.closest) return;
    const submit = t.closest('[data-js-trigger="submit"], button[type="submit"], input[type="submit"]');
    if (submit) { flushAll('submit'); onSubmitish(submit); return; }
    const close = t.closest('[data-bs-dismiss="modal"], .modal-close, [data-js-trigger="cancel"]');
    if (close) flushAll('modal-close');
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') flushAll('escape');
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      const el = document.activeElement;
      if (isEditable(el) && states.has(el)) { e.preventDefault(); saveNow(el, 'manual'); }
    }
  }, true);

  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll('hidden');
  });
  addEventListener('pagehide', () => flushAll('pagehide'));
  addEventListener('beforeunload', () => flushAll('beforeunload'));
  addEventListener('blur', () => flushAll('blur'));
  addEventListener('scroll', tick, true);
  addEventListener('resize', tick);
  setInterval(tick, 700);

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  });

  (async function boot() {
    await reconcile();
    ui();
    scan();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (ok()) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
          settings = Object.assign(settings, changes.settings.newValue || {});
          if (!settings.showPill) {
            fields().forEach((el) => {
              const st = states.get(el);
              if (st && st.pill) { st.pill.remove(); st.pill = null; }
            });
          } else {
            fields().forEach((el) => paintPill(el, 'idle'));
          }
        }
      });
      chrome.runtime.onMessage.addListener((msg, _s, reply) => {
        if (msg && msg.type === 'lbds:flush') { flushAll('popup'); reply({ ok: true }); }
        return true;
      });
    }
  })();
})();
