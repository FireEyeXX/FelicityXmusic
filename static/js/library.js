// library.js — Navidrome library playlists management

import { store } from './store.js';
import { $, $$, esc, showToast, historyBack, showPlaylistPicker } from './utils.js';
import { apiJson } from './api.js';
import { renderResults } from './search.js';
import { fetchPlaylistBpm, addBpmBadges, createBpmFilter, addScanButton } from './bpm.js';
import { attachContextMenu, wasLongPress } from './contextmenu.js';

let libraryCache = null;
let currentLibPlaylistId = null;
let currentLibPlaylistName = '';
let currentLibPlaylistTracks = [];

// ── Load Playlists ──
export async function loadLibrary() {
  const grid = $('#libraryGrid');
  if (!grid) return;
  $('#libraryDetail').style.display = 'none';
  $('#libraryList').style.display = '';
  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = await apiJson('/api/library/playlists');
    libraryCache = data.playlists || [];
    renderLibraryGrid(libraryCache, grid);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><p>Failed to load library playlists</p></div>`;
  }
}

function renderLibraryGrid(playlists, grid) {
  if (!playlists.length) {
    grid.innerHTML = '<div class="empty-state"><p>No playlists in Navidrome yet</p></div>';
    return;
  }
  grid.innerHTML = playlists.map((pl, i) => `
    <div class="card lib-card" data-lib-idx="${i}">
      ${pl.image ? `<img class="card-img" src="${pl.image}" alt="" loading="lazy">` : `<div class="card-img" style="background:linear-gradient(135deg,var(--accent),#1a1a2e);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--text);">&#9835;</div>`}
      <div class="card-body">
        <div class="card-title">${esc(pl.name)}</div>
        <div class="card-sub">${pl.songCount} tracks</div>
      </div>
    </div>`).join('');

  $$('.lib-card', grid).forEach(card => {
    card.addEventListener('click', () => {
      if (wasLongPress(card)) return;
      const pl = playlists[card.dataset.libIdx];
      if (pl) loadLibraryDetail(pl.id);
    });
  });
  attachContextMenu(grid, {
    selector: '.lib-card',
    getItem: (targetEl) => {
      const pl = playlists[parseInt(targetEl.dataset.libIdx)];
      if (!pl) return null;
      return {
        title: pl.name,
        actions: [
          { label: 'Open', icon: '&#128194;', onClick: () => loadLibraryDetail(pl.id) },
          { label: 'Play all', icon: '&#9654;', onClick: () => _playLibraryPlaylist(pl, true) },
          { label: 'Queue all', icon: '+', onClick: () => _playLibraryPlaylist(pl, false) },
          { divider: true },
          { label: 'Rename…', icon: '&#9998;', onClick: () => _renameLibraryPlaylist(pl) },
          { label: 'Delete playlist', icon: '&times;', danger: true, onClick: () => _deleteLibraryPlaylist(pl) },
        ],
      };
    },
  });
}

async function _fetchPlaylistTracks(id) {
  const data = await apiJson(`/api/library/playlist/${id}`);
  return data.tracks || [];
}

async function _playLibraryPlaylist(pl, playNow) {
  try {
    const tracks = await _fetchPlaylistTracks(pl.id);
    if (!tracks.length) { showToast('Empty playlist'); return; }
    store.playlistMode = { id: pl.id, name: pl.name };
    const m = await import('./player.js');
    if (playNow) {
      // Mode is named playlist — playTracks will not mirror (guarded by isUpNextActive)
      const u = await import('./upnext.js');
      u.playTracks(tracks);
    } else {
      m.addToQueue(tracks);
    }
  } catch (e) {
    showToast('Failed: ' + e.message);
  }
}

async function _renameLibraryPlaylist(pl) {
  const name = prompt('Rename playlist:', pl.name);
  if (!name || !name.trim() || name.trim() === pl.name) return;
  try {
    await apiJson(`/api/library/playlist/${pl.id}/rename`, {
      method: 'PUT', body: { name: name.trim() },
    });
    libraryCache = null;
    loadLibrary();
    showToast('Renamed');
  } catch (e) {
    showToast('Rename failed');
  }
}

async function _deleteLibraryPlaylist(pl) {
  if (!confirm(`Delete playlist "${pl.name}"?`)) return;
  try {
    await apiJson(`/api/library/playlist/${pl.id}`, { method: 'DELETE' });
    libraryCache = null;
    loadLibrary();
    showToast('Deleted');
  } catch (e) {
    showToast('Delete failed');
  }
}

// ── Playlist Detail ──
async function loadLibraryDetail(id) {
  currentLibPlaylistId = id;
  $('#libraryList').style.display = 'none';
  $('#libraryDetail').style.display = '';
  history.pushState({ layer: 'libraryDetail' }, '');
  const tracksEl = $('#libraryTracks');
  tracksEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = await apiJson(`/api/library/playlist/${id}`);
    currentLibPlaylistTracks = data.tracks || [];
    currentLibPlaylistName = data.name || '';
    $('#libDetailName').textContent = data.name || '';
    $('#libDetailImg').src = data.image || '';
    if (!data.image) {
      $('#libDetailImg').style.background = 'linear-gradient(135deg,var(--accent),#1a1a2e)';
    } else {
      $('#libDetailImg').style.background = '';
    }
    $('#libDetailCount').textContent = `${currentLibPlaylistTracks.length} tracks`;
    renderResults(currentLibPlaylistTracks, '#libraryTracks');
    _addBulkCheckboxes();
    _addRemoveButtons(id);
    // BPM: filter bar with scan button, fetch cached BPM, add badges
    _initBpmFilter(id);
    fetchPlaylistBpm(id).then(() => {
      addBpmBadges('#libraryTracks');
    });
  } catch (e) {
    tracksEl.innerHTML = `<div class="empty-state"><p>Failed to load playlist</p></div>`;
  }
}

// ── Bulk select ──
let _bulkSelected = new Set();

function _addBulkCheckboxes() {
  _bulkSelected.clear();
  _updateBulkUI();
  const toggle = $('#libBulkToggle');
  if (toggle) toggle.checked = false;
  $$('#libraryTracks .card').forEach((card, i) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lib-bulk-cb';
    cb.style.cssText = 'position:absolute;top:8px;left:8px;width:18px;height:18px;accent-color:var(--accent);z-index:2;cursor:pointer;';
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) _bulkSelected.add(i); else _bulkSelected.delete(i);
      _updateBulkUI();
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
    card.style.position = 'relative';
    card.prepend(cb);
  });
}

function _updateBulkUI() {
  const actions = $('#libBulkActions');
  const count = $('#libBulkCount');
  if (actions) actions.style.display = _bulkSelected.size > 0 ? 'flex' : 'none';
  if (count) count.textContent = `${_bulkSelected.size} selected`;
}

function _addRemoveButtons(playlistId) {
  $$('#libraryTracks .card').forEach((card, i) => {
    const btn = document.createElement('button');
    btn.className = 'lib-track-remove';
    btn.title = 'Remove from playlist';
    btn.innerHTML = '&times;';
    btn.style.cssText = 'position:absolute;top:8px;right:8px;width:24px;height:24px;border:none;background:rgba(0,0,0,.5);color:var(--text-muted);border-radius:50%;cursor:pointer;font-size:16px;line-height:1;z-index:2;display:flex;align-items:center;justify-content:center;';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await apiJson(`/api/library/playlist/${playlistId}/tracks`, {
          method: 'DELETE', body: { indices: [i] },
        });
        card.remove();
        currentLibPlaylistTracks.splice(i, 1);
        $('#libDetailCount').textContent = `${currentLibPlaylistTracks.length} tracks`;
        showToast('Removed from playlist');
        // Re-index remaining buttons
        $$('#libraryTracks .lib-track-remove').forEach((b, j) => {
          b.replaceWith(b); // will lose handler, so just reload
        });
        // Simpler: reload the whole detail
        openLibraryDetail(playlistId);
      } catch (err) { showToast('Failed: ' + (err.message || '')); }
    });
    card.style.position = 'relative';
    card.appendChild(btn);
  });
}

function _initBpmFilter(playlistId) {
  const existing = $('#libraryDetail .bpm-filter');
  if (existing) existing.remove();
  const filter = createBpmFilter('#libraryTracks');
  addScanButton(filter, playlistId, '#libraryTracks');
  const tracksEl = $('#libraryTracks');
  tracksEl.parentNode.insertBefore(filter, tracksEl);
}

export function closeLibraryDetail(fromPopstate) {
  $('#libraryDetail').style.display = 'none';
  $('#libraryList').style.display = '';
  currentLibPlaylistId = null;
  if (!fromPopstate) historyBack();
}

// ── Get current library playlist context (for recommendations) ──
export function getCurrentLibPlaylist() {
  if (!currentLibPlaylistId || !currentLibPlaylistTracks.length) return null;
  return { id: currentLibPlaylistId, tracks: currentLibPlaylistTracks };
}

// ── Init ──
export function init() {
  const backBtn = $('#backToLibrary');
  if (backBtn) backBtn.addEventListener('click', () => closeLibraryDetail());

  // Play All
  const playBtn = $('#playLibPlaylist');
  if (playBtn) playBtn.addEventListener('click', () => {
    const tracks = getLibTracksForPlayer();
    if (tracks.length) {
      store.playlistMode = currentLibPlaylistId ? { id: currentLibPlaylistId, name: currentLibPlaylistName } : null;
      import('./upnext.js').then(m => m.playTracks(tracks));
    }
  });

  // Queue All
  const queueBtn = $('#queueLibPlaylist');
  if (queueBtn) queueBtn.addEventListener('click', () => {
    const tracks = getLibTracksForPlayer();
    if (tracks.length) {
      store.playlistMode = currentLibPlaylistId ? { id: currentLibPlaylistId, name: currentLibPlaylistName } : null;
      import('./player.js').then(m => m.addToQueue(tracks));
    }
  });

  // Delete Playlist
  const delBtn = $('#deleteLibPlaylist');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    if (!confirm('Delete this playlist from Navidrome?')) return;
    try {
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}`, { method: 'DELETE' });
      showToast('Playlist deleted');
      libraryCache = null;
      closeLibraryDetail();
      loadLibrary();
    } catch (e) {
      showToast('Failed to delete playlist');
    }
  });

  // Rename Playlist
  const renameBtn = $('#renameLibPlaylist');
  if (renameBtn) renameBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    const name = prompt('Rename playlist:', currentLibPlaylistName);
    if (!name || !name.trim() || name.trim() === currentLibPlaylistName) return;
    try {
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}/rename`, {
        method: 'PUT',
        body: { name: name.trim() },
      });
      currentLibPlaylistName = name.trim();
      $('#libDetailName').textContent = name.trim();
      if (store.playlistMode && store.playlistMode.id === currentLibPlaylistId) {
        store.playlistMode.name = name.trim();
      }
      libraryCache = null;
      showToast('Playlist renamed');
    } catch (e) {
      showToast('Failed to rename');
    }
  });

  // Duplicate Playlist
  const dupBtn = $('#duplicateLibPlaylist');
  if (dupBtn) dupBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId || !currentLibPlaylistTracks.length) return;
    const name = prompt('Duplicate as:', currentLibPlaylistName + ' (copy)');
    if (!name || !name.trim()) return;
    try {
      // Create new playlist
      await apiJson('/api/library/playlist', { method: 'POST', body: { name: name.trim() } });
      // Find new playlist ID
      const data = await apiJson('/api/library/playlists');
      const pl = (data.playlists || []).find(p => p.name === name.trim());
      if (!pl) throw new Error('Playlist not created');
      // Add all tracks
      const songIds = currentLibPlaylistTracks.map(t => t.id).filter(Boolean);
      if (songIds.length) {
        await apiJson(`/api/library/playlist/${pl.id}/tracks`, {
          method: 'PUT',
          body: { song_ids: songIds },
        });
      }
      libraryCache = null;
      showToast(`Duplicated as "${name.trim()}" (${songIds.length} tracks)`);
    } catch (e) {
      showToast('Failed to duplicate');
    }
  });

  // Bulk: Select All
  const bulkToggle = $('#libBulkToggle');
  if (bulkToggle) bulkToggle.addEventListener('change', () => {
    const cbs = $$('#libraryTracks .lib-bulk-cb');
    cbs.forEach((cb, i) => {
      cb.checked = bulkToggle.checked;
      if (bulkToggle.checked) _bulkSelected.add(i); else _bulkSelected.delete(i);
    });
    _updateBulkUI();
  });

  // Bulk: Copy to playlist
  const bulkCopy = $('#libBulkCopy');
  if (bulkCopy) bulkCopy.addEventListener('click', async () => {
    if (!_bulkSelected.size) return;
    try {
      const data = await apiJson('/api/library/playlists');
      const others = (data.playlists || []).filter(p => p.id !== currentLibPlaylistId);
      if (!others.length) { showToast('No other playlists'); return; }
      const picked = await showPlaylistPicker(others);
      if (!picked || !picked.length) return;
      const songIds = [..._bulkSelected].map(i => currentLibPlaylistTracks[i]?.id).filter(Boolean);
      for (const pl of picked) {
        await apiJson(`/api/library/playlist/${pl.id}/tracks`, {
          method: 'PUT',
          body: { song_ids: songIds },
        });
      }
      showToast(`Copied ${songIds.length} tracks to ${picked.map(p => p.name).join(', ')}`);
    } catch (e) {
      showToast('Failed to copy');
    }
  });

  // Bulk: Remove from playlist
  const bulkRemove = $('#libBulkRemove');
  if (bulkRemove) bulkRemove.addEventListener('click', async () => {
    if (!_bulkSelected.size || !currentLibPlaylistId) return;
    if (!confirm(`Remove ${_bulkSelected.size} tracks from playlist?`)) return;
    try {
      // Remove by indices (descending to avoid shift)
      const indices = [..._bulkSelected].sort((a, b) => b - a);
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}/tracks`, {
        method: 'DELETE',
        body: { indices },
      });
      showToast(`Removed ${indices.length} tracks`);
      loadLibraryDetail(currentLibPlaylistId);
    } catch (e) {
      showToast('Failed to remove');
    }
  });

  // Merge Playlists
  const mergeBtn = $('#mergeLibPlaylist');
  if (mergeBtn) mergeBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    try {
      const data = await apiJson('/api/library/playlists');
      const others = (data.playlists || []).filter(p => p.id !== currentLibPlaylistId);
      if (!others.length) { showToast('No other playlists'); return; }
      const picked = await showPlaylistPicker(others);
      if (!picked || !picked.length) return;
      let added = 0;
      for (const pl of picked) {
        const plData = await apiJson(`/api/library/playlist/${pl.id}`);
        const songIds = (plData.tracks || []).map(t => t.id).filter(Boolean);
        if (songIds.length) {
          await apiJson(`/api/library/playlist/${currentLibPlaylistId}/tracks`, {
            method: 'PUT',
            body: { song_ids: songIds },
          });
          added += songIds.length;
        }
      }
      showToast(`Merged ${added} tracks from ${picked.length} playlist(s)`);
      loadLibraryDetail(currentLibPlaylistId);
    } catch (e) {
      showToast('Failed to merge');
    }
  });

  // New Playlist
  const newBtn = $('#newLibPlaylist');
  if (newBtn) newBtn.addEventListener('click', async () => {
    const name = prompt('New playlist name:');
    if (!name || !name.trim()) return;
    try {
      await apiJson('/api/library/playlist', { method: 'POST', body: { name: name.trim() } });
      showToast('Playlist created');
      libraryCache = null;
      loadLibrary();
    } catch (e) {
      showToast('Failed to create playlist');
    }
  });
}

function getLibTracksForPlayer() {
  const cards = $$('#libraryTracks .card');
  return cards.map(c => { try { return JSON.parse(c.dataset.item); } catch { return null; } }).filter(Boolean);
}
