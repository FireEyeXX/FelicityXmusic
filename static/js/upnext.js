// upnext.js — Up Next temp playlist: the unified queue/playlist abstraction.
// Maintains a single Navidrome playlist per (user, device) used as the active
// playback context. Queue mutations write through to this playlist.

import { store } from './store.js';
import { apiJson } from './api.js';
import { showToast } from './utils.js';

const UPNEXT_DISPLAY = 'Up Next';

function _isUpnextRaw(name) {
  return typeof name === 'string' && name.startsWith('__upnext_');
}

// Friendly display name: hide internal prefix from the UI.
export function displayPlaylistName(rawName) {
  return _isUpnextRaw(rawName) ? UPNEXT_DISPLAY : (rawName || '');
}

// Initialize on boot: idempotently fetch/create Up Next, set as playlistMode
// only if user is not currently in a named playlist context.
export async function initUpNext() {
  try {
    const pl = await apiJson('/api/library/upnext');
    if (!pl || !pl.id) return null;
    // Only adopt Up Next as the active playlist mode if not already in a named one
    if (!store.playlistMode) {
      store.playlistMode = { id: pl.id, name: displayPlaylistName(pl.name) };
      // Refresh playlist badge in UI (avoid circular import via lazy dynamic import)
      const badge = document.getElementById('fpPlaylistBadge');
      if (badge) { badge.textContent = store.playlistMode.name; badge.style.display = ''; }
    }
    return pl;
  } catch (e) {
    // Navidrome unavailable — keep legacy behaviour (ad-hoc queue)
    return null;
  }
}

// Atomic replace of a playlist's contents by name/artist matching.
// Returns the API response: { matched: int, missing: [{name, artist, album}] }.
export async function replaceByName(playlistId, tracks) {
  if (!playlistId || !tracks || !tracks.length) return { matched: 0, missing: [] };
  return await apiJson(`/api/library/playlist/${playlistId}/replace-by-name`, {
    method: 'POST',
    body: { tracks },
  });
}

// Returns the playlist ID currently treated as the active context (Up Next
// or a named playlist). Null when neither.
export function activePlaylistId() {
  return store.playlistMode && store.playlistMode.id;
}

// Returns true when the active playlist is Up Next (the temp one).
export function isUpNextActive() {
  // We display "Up Next"; the raw name starts with __upnext_. Easiest check:
  // compare to display constant.
  return !!(store.playlistMode && store.playlistMode.name === UPNEXT_DISPLAY);
}

export { UPNEXT_DISPLAY };
