'use strict';

const SKEY = 'lbdraft:';
const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const searchEl = document.getElementById('search');
const tpl = document.getElementById('row-tpl');

let records = [];
let openKey = null;

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  if (d < 8) return d + (d === 1 ? ' day ago' : ' days ago');
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function metaLine(rec) {
  const bits = [];
  if (rec.meta && rec.meta.rating) bits.push(rec.meta.rating + '★');
  if (rec.meta && rec.meta.liked) bits.push('liked');
  if (rec.meta && rec.meta.rewatch) bits.push('rewatch');
  if (rec.meta && rec.meta.spoilers) bits.push('spoilers');
  if (rec.meta && rec.meta.tags && rec.meta.tags.length) bits.push(rec.meta.tags.join(', '));
  if (rec.meta && rec.meta.watchedDate) bits.push(rec.meta.watchedDate);
  return bits.join(' · ');
}

function snapshots(rec) {
  const out = [];
  const push = (label, snap) => {
    if (!snap || !snap.text || !snap.text.trim()) return;
    if (out.some((s) => s.text.trim() === snap.text.trim())) return;
    out.push({ label, at: snap.at, text: snap.text });
  };
  push('longest version', rec.longest);
  push('before the box went empty', rec.recovery);
  (rec.history || []).slice().reverse().forEach((h) => push(ago(h.at), h));
  return out.filter((s) => s.text.trim() !== (rec.text || '').trim());
}

async function load() {
  const store = await chrome.storage.local.get(null);
  records = Object.entries(store)
    .filter(([k, v]) => k.startsWith(SKEY) && v && typeof v === 'object')
    .map(([, v]) => v)
    .filter((r) => (r.text && r.text.trim()) || snapshots(r).length)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const { settings } = await chrome.storage.local.get('settings');
  document.getElementById('autoRestore').checked = !settings || settings.autoRestore !== false;
  document.getElementById('showPill').checked = !settings || settings.showPill !== false;
  render();
}

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const shown = q
    ? records.filter((r) => (r.title + ' ' + r.text).toLowerCase().includes(q))
    : records;

  const live = records.filter((r) => !(r.submittedAt && r.submittedAt >= r.updatedAt)).length;
  countEl.textContent = records.length
    ? live + ' unposted' + (records.length > live ? ' · ' + (records.length - live) + ' posted' : '')
    : '';

  listEl.textContent = '';

  if (!shown.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = records.length
      ? '<strong>No match</strong>Try part of the film name or a phrase you wrote.'
      : '<strong>Nothing saved yet</strong>Open a review box on Letterboxd and type. Your words land here within a second, and stay here until you post them.';
    listEl.appendChild(d);
    return;
  }

  shown.forEach((rec) => listEl.appendChild(row(rec)));
}

function row(rec) {
  const node = tpl.content.cloneNode(true);
  const art = node.querySelector('.row');
  const posted = !!(rec.submittedAt && rec.submittedAt >= rec.updatedAt);
  if (posted) art.classList.add('posted');

  art.querySelector('.rowtitle').textContent = rec.title || rec.path;
  art.querySelector('.when').textContent = ago(rec.updatedAt);

  const kindLabel = rec.kind === 'review' ? 'review' : rec.kind;
  const snaps = snapshots(rec);
  const line2 = [
    rec.words + (rec.words === 1 ? ' word' : ' words'),
    kindLabel,
    posted ? 'posted' : 'not posted',
    snaps.length ? snaps.length + (snaps.length === 1 ? ' earlier version' : ' earlier versions') : ''
  ].filter(Boolean).join(' · ');
  art.querySelector('.line2').textContent = line2;
  art.querySelector('.excerpt').textContent = rec.text || (snaps[0] && snaps[0].text) || '';

  const detail = art.querySelector('.detail');
  const head = art.querySelector('.rowhead');
  head.addEventListener('click', () => {
    const wasOpen = !detail.hidden;
    listEl.querySelectorAll('.detail').forEach((d) => { d.hidden = true; });
    listEl.querySelectorAll('.row').forEach((r) => r.classList.remove('open'));
    if (!wasOpen) {
      detail.hidden = false;
      art.classList.add('open');
      openKey = rec.key;
      fill(detail, rec);
    } else {
      openKey = null;
    }
  });

  if (openKey === rec.key) {
    detail.hidden = false;
    art.classList.add('open');
    fill(detail, rec);
  }
  return node;
}

function fill(detail, rec) {
  const meta = metaLine(rec);
  detail.querySelector('.meta').textContent =
    [meta, 'started ' + ago(rec.createdAt), rec.chars + ' characters'].filter(Boolean).join(' · ');
  detail.querySelector('.full').textContent = rec.text || '(box is empty — the earlier versions below are still here)';

  detail.querySelectorAll('.actions button').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'copy') {
        await navigator.clipboard.writeText(rec.text || (snapshots(rec)[0] || {}).text || '');
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy text'; }, 1200);
      } else if (act === 'open') {
        chrome.tabs.create({ url: rec.url || 'https://letterboxd.com' + rec.path });
      } else if (act === 'delete') {
        if (b.dataset.armed !== '1') {
          b.dataset.armed = '1';
          b.textContent = 'Really delete?';
          setTimeout(() => { b.dataset.armed = '0'; b.textContent = 'Delete'; }, 3000);
          return;
        }
        await chrome.storage.local.remove(SKEY + rec.key);
        openKey = null;
        load();
      }
    };
  });

  const snapWrap = detail.querySelector('.snaps');
  snapWrap.textContent = '';
  const snaps = snapshots(rec);
  if (!snaps.length) return;
  const t = document.createElement('div');
  t.className = 'snaptitle';
  t.textContent = 'Earlier versions kept as a fallback';
  snapWrap.appendChild(t);
  snaps.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'snap';
    const w = document.createElement('span');
    w.className = 'sw';
    w.textContent = s.text.slice(0, 90);
    const label = document.createElement('span');
    label.textContent = s.label;
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = 'Copy';
    btn.onclick = async () => {
      await navigator.clipboard.writeText(s.text);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    };
    el.append(w, label, btn);
    snapWrap.appendChild(el);
  });
}

function download(name, text, type) {
  const blob = new Blob([text], { type: type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

searchEl.addEventListener('input', render);

async function setSetting(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: Object.assign({}, settings, patch) });
}

document.getElementById('autoRestore').addEventListener('change', (e) => setSetting({ autoRestore: e.target.checked }));
document.getElementById('showPill').addEventListener('change', (e) => setSetting({ showPill: e.target.checked }));

document.getElementById('exportTxt').addEventListener('click', () => {
  const parts = records.map((r) => {
    const head = [r.title, metaLine(r), 'last typed ' + new Date(r.updatedAt).toLocaleString(), r.url]
      .filter(Boolean).join('\n');
    const snaps = snapshots(r).map((s) => '\n--- earlier version (' + s.label + ') ---\n' + s.text).join('');
    return head + '\n\n' + (r.text || '') + snaps;
  });
  download('letterboxd-drafts-' + stamp() + '.txt', parts.join('\n\n========================================\n\n'), 'text/plain');
});

document.getElementById('exportJson').addEventListener('click', () => {
  download('letterboxd-drafts-' + stamp() + '.json', JSON.stringify(records, null, 2), 'application/json');
});

document.getElementById('clearPosted').addEventListener('click', async (e) => {
  const keys = records
    .filter((r) => r.submittedAt && r.submittedAt >= r.updatedAt)
    .map((r) => SKEY + r.key);
  if (!keys.length) { e.target.textContent = 'Nothing posted'; setTimeout(() => { e.target.textContent = 'Clear posted'; }, 1500); return; }
  if (e.target.dataset.armed !== '1') {
    e.target.dataset.armed = '1';
    e.target.textContent = 'Clear ' + keys.length + '?';
    setTimeout(() => { e.target.dataset.armed = '0'; e.target.textContent = 'Clear posted'; }, 3000);
    return;
  }
  await chrome.storage.local.remove(keys);
  e.target.dataset.armed = '0';
  e.target.textContent = 'Clear posted';
  load();
});

// Ask any open Letterboxd tab to flush what's in its box before we list.
(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://letterboxd.com/*', 'https://*.letterboxd.com/*'] });
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'lbds:flush' }).catch(() => {})));
  } catch (e) { /* no tabs, no problem */ }
  setTimeout(load, 120);
})();
