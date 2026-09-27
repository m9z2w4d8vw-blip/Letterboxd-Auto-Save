# Letterboxd Draft Saver

Saves your Letterboxd review while you type. If Chrome crashes, the laptop dies, the
tab closes, or you hit the wrong key, the words are still there when you come back.

## Install

1. Unzip this folder somewhere permanent — Chrome loads it from disk every launch,
   so don't leave it in Downloads if you're the type to empty that folder.
2. Go to `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one with `manifest.json` in it).
4. Open any film on Letterboxd, click the review box, type a few words. A small
   "Draft saved" marker appears in the corner of the box.

## How it works

Every keystroke in a review box (or a list description, or a comment) is written
to two places:

- **`chrome.storage.local`** — the real store. This is what the toolbar popup reads,
  and it survives crashes, restarts, and closing Chrome entirely.
- **`localStorage` on letterboxd.com** — a synchronous mirror written on the same
  tick as the keystroke. `chrome.storage` writes are asynchronous, so a hard crash
  can in theory eat the last few hundred milliseconds; the mirror can't, because it
  lands before the browser gets a chance to die. On the next page load the two are
  compared and the newer one wins.

Writes happen 400ms after you stop typing, at least every 4 seconds while you keep
typing, and immediately when you switch tabs, minimise, close the modal, hit Escape,
or navigate away. Ctrl/Cmd+S forces a save.

### Getting a draft back

Open the review box again. If it's empty and a draft exists, the draft goes straight
back in and a toast offers **Undo**. If the box already has something in it (you're
editing a posted review, say), nothing is overwritten — the toast offers to restore
instead, and shows you what it's holding first.

The toolbar icon shows how many unposted drafts exist. Click it for the full list:
search, read, copy, or open the film page. Two things are kept besides the current
text, and both show up under a draft as earlier versions:

- **the longest version ever typed** — the parachute for a select-all-and-type accident
- **the text from just before the box went empty**

plus up to eight periodic snapshots as you write.

### When drafts go away

Nothing is deleted while a draft is unposted. Once Letterboxd actually saves the entry
(confirmed by the form closing, not just by you clicking Save), the draft is marked as
posted and kept for another seven days as a backup, then pruned. You can clear posted
ones by hand from the popup footer, and export everything as text or JSON any time.

## Limits worth knowing

- **Rating and tags are recorded but not re-applied.** The star widget and the tag
  typeahead are custom controls, and forcing values into them tends to leave the form
  in a state Letterboxd disagrees with. The restore toast and the popup tell you what
  the rating and tags were so you can click them again in two seconds. Liked, rewatch,
  and the spoiler checkbox *are* restored.
- **Only letterboxd.com.** No other site, no background network access. Nothing ever
  leaves your machine — there's no server, no analytics, no remote anything.
- **Site-data clearing wipes the mirror**, not the real store. Clearing extension data
  (or removing the extension) wipes both.
- Letterboxd redesigns things. The field detection falls back to "any review-ish
  textarea in a diary form", so a rename of `#frm-review` shouldn't break it, but if
  drafts stop appearing in the popup, that's the first thing to check.

## Files

| file | what it does |
| --- | --- |
| `content.js` | the whole watcher: field detection, saving, restoring, in-page toast |
| `background.js` | prunes stale drafts, keeps the badge count |
| `popup.html/.css/.js` | the drafts list |
| `manifest.json` | MV3 manifest, `storage` + letterboxd.com host permission only |

## Icon and colours

The icon borrows Letterboxd's three-dot rhythm and its palette (`#ff8000`,
`#00e054`, `#40bcf4`) but reads as an ellipsis — a sentence not finished yet —
rather than reproducing their overlapping-circles mark. The third dot is left
open: the one still being written. The same three colours carry state through
the rest of the extension: orange for a draft that isn't posted, green for one
that is, blue while a save is in flight.

Deliberately not their actual logo. That mark is a trademark, so a companion
extension shouldn't wear it — fine as a personal unpacked build either way, but
it would be a problem in the Chrome Web Store, which rejects extensions using a
brand's marks in a way that implies the brand made them.
