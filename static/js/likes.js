// Track-level "Like" / "Liked Songs" — client module.
// Backend contract (see app/routers/library.py):
//   POST /api/library/like   {name, artist?, album?, id?, image?} -> {liked:true}
//   POST /api/library/unlike {name, artist?, album?, id?, image?} -> {liked:false}
//   GET  /api/library/likes  -> {tracks:[{name,artist,album,id,image,type}]}
// Liked state is keyed exactly like the backend `_like_key`: id if present, else
// lowercased "artist:name". A single in-memory Set drives all heart icons; any UI
// that renders a heart should listen for the 'likeschange' window event to re-sync.
import { apiJson } from './api.js';
import { showToast } from './utils.js';

const _likedKeys = new Set();   // keys currently liked
let _likedTracks = [];          // full liked track objects (newest first), for the Liked Songs view
let _loaded = false;
let _loadPromise = null;

/** Stable key matching the backend `_like_key`. */
export function likeKey(item) {
  if (!item) return '';
  if (item.id != null && item.id !== '') return String(item.id);
  // Mirror backend _like_key exactly (lowercase + trim) so an id-less like made in the
  // UI is found by GET /api/library/likes after reload.
  return ((item.artist || '').trim() + ':' + (item.name || '').trim()).toLowerCase();
}

export function isLiked(item) {
  return _likedKeys.has(likeKey(item));
}

export function getLikedTracks() {
  return _likedTracks.slice();
}

export function likedCount() {
  return _likedKeys.size;
}

/** Fetch the liked set once (idempotent; pass force=true to refresh). */
export async function loadLikes(force = false) {
  if (_loaded && !force) return _likedTracks;
  if (_loadPromise && !force) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const data = await apiJson('/api/library/likes');
      _likedTracks = Array.isArray(data?.tracks) ? data.tracks : [];
      _likedKeys.clear();
      for (const t of _likedTracks) _likedKeys.add(likeKey(t));
      _loaded = true;
    } catch (e) {
      // Not logged-in or backend down — degrade to empty; hearts just render unfilled.
      _likedTracks = [];
      _likedKeys.clear();
    }
    return _likedTracks;
  })();
  return _loadPromise;
}

function _emitChange(item) {
  window.dispatchEvent(new CustomEvent('likeschange', {
    detail: { key: likeKey(item), liked: isLiked(item) },
  }));
}

/**
 * Toggle like state for a track. Optimistic: flips local state + UI immediately,
 * then calls the API and reverts on failure. Returns the new liked boolean.
 */
export async function toggleLike(item) {
  if (!item || !(item.name || item.id)) return false;
  const key = likeKey(item);
  const wasLiked = _likedKeys.has(key);
  const body = {
    name: item.name || '',
    artist: item.artist || '',
    album: item.album || '',
    id: item.id != null ? String(item.id) : undefined,
    image: item.image || '',
  };

  // Optimistic local update
  if (wasLiked) {
    _likedKeys.delete(key);
    _likedTracks = _likedTracks.filter(t => likeKey(t) !== key);
  } else {
    _likedKeys.add(key);
    _likedTracks.unshift({ name: body.name, artist: body.artist, album: body.album, id: body.id, image: body.image, type: 'track' });
  }
  _emitChange(item);

  try {
    await apiJson(wasLiked ? '/api/library/unlike' : '/api/library/like', { method: 'POST', body });
    showToast(wasLiked ? 'Removed from Liked Songs' : 'Added to Liked Songs');
    return !wasLiked;
  } catch (e) {
    // Revert on failure
    if (wasLiked) {
      _likedKeys.add(key);
    } else {
      _likedKeys.delete(key);
      _likedTracks = _likedTracks.filter(t => likeKey(t) !== key);
    }
    _emitChange(item);
    showToast('Could not update Liked Songs');
    return wasLiked;
  }
}

const _HEART_FILLED = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.9-10-9.2C.6 9.1 1.6 5.5 5 4.6c2-.5 3.9.5 5 2 1.1-1.5 3-2.5 5-2 3.4.9 4.4 4.5 3 7.2C19.5 16.1 12 21 12 21z"/></svg>';
const _HEART_OUTLINE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 20s-6.8-4.5-9.1-8.4C1.5 9 2.4 5.9 5.3 5.1c1.8-.5 3.6.4 4.7 1.9 1.1-1.5 2.9-2.4 4.7-1.9 2.9.8 3.8 3.9 2.4 6.5C18.8 15.5 12 20 12 20z"/></svg>';

function _paintHeart(btn, liked) {
  btn.innerHTML = liked ? _HEART_FILLED : _HEART_OUTLINE;
  btn.classList.toggle('liked', liked);
  btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  btn.title = liked ? 'Remove from Liked Songs' : 'Add to Liked Songs';
}

/**
 * Build a heart toggle button bound to `item`. The button carries data-like-key so a
 * global 'likeschange' listener can re-sync it. `getItem` may be a function returning the
 * current item (use for the player bar where the track changes).
 */
export function makeHeartButton(itemOrGetter, { className = 'like-btn' } = {}) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.type = 'button';
  const getItem = typeof itemOrGetter === 'function' ? itemOrGetter : () => itemOrGetter;
  const refresh = () => {
    const it = getItem();
    btn.dataset.likeKey = likeKey(it);
    _paintHeart(btn, isLiked(it));
  };
  refresh();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleLike(getItem());
  });
  // NOTE: no per-button `likeschange` listener — rows are re-rendered constantly and
  // detached buttons would leak listeners forever. Instead a SINGLE module-level
  // listener (below) calls syncHearts(), which repaints every heart still in the DOM.
  // Expose a manual refresh so callers can re-bind when the player's current track changes.
  btn._refreshLike = refresh;
  return btn;
}

/** Re-sync every heart currently in the DOM to the in-memory state. */
export function syncHearts() {
  document.querySelectorAll('[data-like-key]').forEach(btn => {
    if (typeof btn._refreshLike === 'function') btn._refreshLike();
    else _paintHeart(btn, _likedKeys.has(btn.dataset.likeKey));
  });
}

// One delegated listener for the whole app — repaints all live hearts on any change.
// (Per-button listeners would accumulate on detached row buttons across re-renders.)
window.addEventListener('likeschange', syncHearts);
