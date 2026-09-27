/* Letterboxd Draft Saver — service worker
 * Housekeeping only: seeds settings, prunes stale drafts, keeps the badge
 * showing how many unposted drafts are sitting in storage.
 */
const SKEY = 'lbdraft:';
const KEEP_POSTED_MS = 7 * 24 * 60 * 60 * 1000;   // posted reviews: kept a week as a backup
const KEEP_EMPTY_MS = 3 * 24 * 60 * 60 * 1000;    // empty boxes with nothing to recover
const MAX_RECORDS = 300;

const DEFAULTS = { autoRestore: true, showPill: true, trackEverything: true };

async function all() {
  const store = await chrome.storage.local.get(null);
  const recs = [];
  for (const [k, v] of Object.entries(store)) {
    if (k.startsWith(SKEY) && v && typeof v === 'object') recs.push([k, v]);
  }
  return recs;
}

function isLive(rec) {
  const hasText = !!(rec.text && rec.text.trim());
  const posted = rec.submittedAt && rec.submittedAt >= (rec.updatedAt || 0);
  return hasText && !posted;
}

async function prune() {
  const recs = await all();
  const now = Date.now();
  const drop = [];

  for (const [k, rec] of recs) {
    const stamp = rec.updatedAt || rec.createdAt || 0;
    const posted = rec.submittedAt && rec.submittedAt >= stamp;
    const hasText = !!(rec.text && rec.text.trim());
    const hasRecovery = !!(rec.recovery && rec.recovery.text) || !!(rec.longest && rec.longest.text);
    if (posted && now - rec.submittedAt > KEEP_POSTED_MS) drop.push(k);
    else if (!hasText && !hasRecovery && now - stamp > KEEP_EMPTY_MS) drop.push(k);
  }

  const keep = recs.filter(([k]) => !drop.includes(k));
  if (keep.length > MAX_RECORDS) {
    keep.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    keep.slice(MAX_RECORDS).forEach(([k]) => drop.push(k));
  }
  if (drop.length) await chrome.storage.local.remove(drop);
}

async function badge() {
  const recs = await all();
  const n = recs.filter(([, r]) => isLive(r)).length;
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ff8000' });
}

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULTS });
  await prune();
  await badge();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

let badgeTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const touched = Object.keys(changes).some((k) => k.startsWith(SKEY));
  if (!touched) return;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(badge, 800);
});
