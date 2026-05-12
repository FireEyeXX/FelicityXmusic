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
      const badge = document.getElementById('fpPlaylistBadge');
      if (badge) { badge.textContent = store.playlistMode.name; badge.style.display = ''; }
    }
    // Hydrate local playback queue from Up Next when local state is empty.
    // This recovers the cross-session "what was I listening to" without
    // overriding an in-progress local queue.
    if ((!store.playerQueue || !store.playerQueue.length) && pl.tracks && pl.tracks.length) {
      store.playerQueue = pl.tracks;
      store.playerIndex = 0;
      // Rebuild visible queue panel(s)
      try {
        const q = await import('./queue.js');
        q.renderQueue && q.renderQueue();
      } catch {}
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

// Replace local playback queue AND mirror to Up Next playlist on Navidrome.
// Mirror is fire-and-forget so playback starts immediately; failures are logged
// but don't block. Only mirrors when Up Next is the active playlist (avoid
// clobbering a named playlist the user already opened).
export async function playTracks(tracks) {
  if (!tracks || !tracks.length) return;
  // Local playback first — instant
  store.playerQueue = tracks;
  store.playerIndex = 0;
  const playerMod = await import('./player.js');
  playerMod.loadAndPlay();
  // Mirror in background when Up Next is the current target
  const id = activePlaylistId();
  if (id && isUpNextActive()) {
    replaceByName(id, tracks).catch(e => console.warn('Up Next mirror failed:', e));
  }
}

export { UPNEXT_DISPLAY };
