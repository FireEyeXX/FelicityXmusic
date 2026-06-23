// search.js — doSearch, renderResults, checkLibrary, renderCards, infinite scroll, card helpers

import { store } from './store.js';
import { $, $$, esc, formatDuration } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { loadPlaylistDetail, loadShowDetail, loadArtistDetail, loadAlbumDetail } from './spotify.js';
import { attachContextMenu, wasLongPress, makeKebabButton } from './contextmenu.js';
import { makeHeartButton } from './likes.js';

// ── Card Helper Functions ──
export function cardPlayBtn(item) {
  const type = item.type || 'track';
  if (type === 'playlist' || type === 'show' || type === 'artist') return '';
  return '<button class="card-play-btn" title="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>';
}

export function cardDlBtn(item) {
  const type = item.type || 'track';
  if (type === 'playlist' || type === 'show' || type === 'artist') return '';
  return '<button class="card-dl-btn" title="Download"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>';
}

export function cardRadioBtn(item) {
  const type = item.type || 'track';
  if (type === 'playlist' || type === 'show' || type === 'episode') return '';
  return '<button class="card-radio-btn" title="Play Radio">&#x1f4fb;</button>';
}

export function cardFavBtn(item) {
  if ((item.type || 'track') !== 'artist') return '';
  const isFav = store.favoritedArtistIds.has(item.id);
  return `<button class="card-fav-btn${isFav ? ' following' : ''}" title="${isFav ? 'Unfollow' : 'Follow'}">${isFav ? '&#x2665;' : '&#x2661;'}</button>`;
}

export function cardSubHtml(item) {
  const artist = item.artist || '';
  const album = item.album || '';
  const type = item.type || 'track';
  if (type === 'track' && artist) {
    let html = `<span class="clickable" data-search-type="artist" data-search-q="${esc(artist)}">${esc(artist)}</span>`;
    if (album) html += ` · <span class="clickable" data-search-type="album" data-search-q="${esc(album)}">${esc(album)}</span>`;
    return html;
  }
  if ((type === 'album' || type === 'episode') && artist) {
    return `<span class="clickable" data-search-type="artist" data-search-q="${esc(artist)}">${esc(artist)}</span>`;
  }
  return esc(artist);
}

// ── Render Results ──
export function renderResults(items, container, fromPage) {
  const el = $(container);
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
    return;
  }
  el.innerHTML = items.map(item => `
    <div class="card" data-item='${JSON.stringify(item).replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'>
      ${cardPlayBtn(item)}${cardDlBtn(item)}${cardRadioBtn(item)}${cardFavBtn(item)}<img class="card-img" src="${item.image || ''}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
      <div class="card-body">
        <div class="card-title">${esc(item.name)}</div>
        <div class="card-sub">${cardSubHtml(item)}</div>
        <div class="card-meta">
          ${item.year ? `<span>${item.year}</span>` : ''}
          ${item.total_tracks ? `<span>${item.total_tracks} ${item.type === 'show' ? 'episodes' : 'tracks'}</span>` : ''}
          ${item.release_date ? `<span>${item.release_date}</span>` : ''}
          ${item.duration_ms ? `<span>${formatDuration(item.duration_ms)}</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  $$('.card', el).forEach(card => {
    card.addEventListener('click', (e) => {
      if (wasLongPress()) return;
      if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-dl-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-fav-btn')) return;
      let item;
      try { item = JSON.parse(card.dataset.item); } catch { return; }
      if (item.type === 'playlist' && item.id) {
        loadPlaylistDetail(item.id, item.url, fromPage);
      } else if (item.type === 'show' && item.id) {
        loadShowDetail(item.id, item.url, fromPage, item.feed_url);
      } else if (item.type === 'artist' && item.id) {
        loadArtistDetail(item.id, fromPage);
      } else if (item.type === 'album' && item.id) {
        loadAlbumDetail(item, fromPage);
      } else {
        openModal(item);
      }
    });
  });
  _attachCardContextMenu(el);
  addCardKebabs($$('.card', el));
  checkLibrary(items, el);
}

function _attachCardContextMenu(el) {
  attachContextMenu(el, {
    selector: '.card[data-item]',
    getItem: (targetEl) => {
      try {
        const item = JSON.parse(targetEl.dataset.item);
        const type = item.type || 'track';
        return { item, type, context: { inLibrary: !!item.inLibrary } };
      } catch { return null; }
    },
  });
}

// Add a visible ⋯ kebab to each card that opens the same context menu.
// Reads the card's data-item live so it reflects later library-check updates.
export function addCardKebabs(cards) {
  cards.forEach(card => {
    if (!card.dataset.item || card.querySelector('.kebab-btn')) return;
    let item;
    try { item = JSON.parse(card.dataset.item); } catch { return; }
    const type = item.type || 'track';
    const kebab = makeKebabButton(() => {
      try {
        const it = JSON.parse(card.dataset.item);
        return { item: it, type: it.type || 'track', context: { inLibrary: !!it.inLibrary } };
      } catch { return null; }
    });
    card.appendChild(kebab);
    // Heart only makes sense for individual tracks (albums/artists/playlists excluded).
    if (type === 'track' && !card.querySelector('.like-btn')) {
      card.appendChild(makeHeartButton(item));
    }
  });
}

// ── Library Check ──
// cards: optional array of card elements to check (must align 1:1 with items).
// If omitted, all .card children of containerEl are used.
export async function checkLibrary(items, containerEl, cards) {
  try {
    const checkItems = items.map(item => ({ name: item.name, artist: item.artist || '', type: item.type || 'track', id: item.id || '' }));
    const data = await apiJson('/api/library/check', {
      method: 'POST', body: { items: checkItems },
    });
    if (!cards) cards = $$('.card', containerEl);
    data.results.forEach((inLib, i) => {
      if (inLib && cards[i]) {
        cards[i].classList.add('in-library');
        const badge = document.createElement('div');
        badge.className = 'in-library-badge';
        badge.textContent = 'In Library';
        cards[i].appendChild(badge);
        const dlBtn = cards[i].querySelector('.card-dl-btn');
        if (dlBtn) {
          dlBtn.disabled = true;
          dlBtn.style.opacity = '0.3';
          dlBtn.title = 'Already in library';
        }
        if (cards[i].dataset.item) {
          const item = JSON.parse(cards[i].dataset.item);
          item.inLibrary = true;
          cards[i].dataset.item = JSON.stringify(item);
        }
        if (cards[i].dataset.albumIdx != null) {
          const idx = parseInt(cards[i].dataset.albumIdx);
          if (store.currentArtistAlbums && store.currentArtistAlbums[idx]) {
            store.currentArtistAlbums[idx].inLibrary = true;
          }
        }
      }
    });
  } catch {}
}

// ── Persist / Restore Search ──
function saveSearchState() {
  const user = store.currentUser?.username || '';
  const q = $('#searchInput').value.trim();
  if (q) {
    localStorage.setItem(`ms_search_${user}`, JSON.stringify({ q, type: store.searchType }));
  } else {
    localStorage.removeItem(`ms_search_${user}`);
  }
}

export function restoreSearch() {
  const user = store.currentUser?.username || '';
  try {
    const saved = JSON.parse(localStorage.getItem(`ms_search_${user}`));
    if (saved && saved.q) {
      $('#searchInput').value = saved.q;
      $('#searchClear').style.display = 'block';
      store.searchType = saved.type || 'track';
      $$('.type-btn[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === store.searchType));
      doSearch();
    }
  } catch {}
}

// ── Recent searches (localStorage, last ~8 distinct queries) ──
const RECENT_KEY = 'ms_recent_searches';
const RECENT_MAX = 8;

function getRecentSearches() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function addRecentSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  let list = getRecentSearches().filter(x => x.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  list = list.slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

function clearRecentSearches() {
  try { localStorage.removeItem(RECENT_KEY); } catch {}
  renderRecentSearches();
}

// Render recent-search chips, but only while the input is focused AND empty.
function renderRecentSearches() {
  const wrap = $('#recentSearches');
  if (!wrap) return;
  const input = $('#searchInput');
  const focused = document.activeElement === input;
  const list = getRecentSearches();
  if (!focused || (input && input.value.trim()) || !list.length) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = list.map(q =>
    `<button type="button" class="recent-chip" data-recent-q="${esc(q)}">${esc(q)}</button>`
  ).join('') + '<button type="button" class="recent-clear" id="recentClear">Clear</button>';
  wrap.style.display = 'flex';
  $$('.recent-chip', wrap).forEach(chip => {
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus
    chip.addEventListener('click', () => {
      const input2 = $('#searchInput');
      input2.value = chip.dataset.recentQ;
      $('#searchClear').style.display = 'block';
      wrap.style.display = 'none';
      clearTimeout(store.searchTimeout);
      doSearch();
    });
  });
  const clearBtn = $('#recentClear', wrap);
  if (clearBtn) {
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', clearRecentSearches);
  }
}

// ── Keyboard navigation through search result cards ──
let _kbdIndex = -1;

function _kbdCards() {
  return $$('#searchResults .card');
}

function _setKbdActive(idx) {
  const cards = _kbdCards();
  cards.forEach(c => c.classList.remove('kbd-active'));
  _kbdIndex = Math.max(-1, Math.min(idx, cards.length - 1));
  if (_kbdIndex >= 0 && cards[_kbdIndex]) {
    cards[_kbdIndex].classList.add('kbd-active');
    cards[_kbdIndex].scrollIntoView({ block: 'nearest' });
  }
}

function _activateKbdCard() {
  const cards = _kbdCards();
  if (_kbdIndex < 0 || !cards[_kbdIndex]) return;
  // Reuse the card's own click handler (play track / open album / artist / etc.).
  cards[_kbdIndex].click();
}

function _handleSearchKeydown(e) {
  if (e.key === 'ArrowDown') {
    const cards = _kbdCards();
    if (!cards.length) return;
    e.preventDefault();
    _setKbdActive(_kbdIndex + 1);
  } else if (e.key === 'ArrowUp') {
    const cards = _kbdCards();
    if (!cards.length) return;
    e.preventDefault();
    _setKbdActive(_kbdIndex - 1);
  } else if (e.key === 'Enter') {
    if (_kbdIndex >= 0) { e.preventDefault(); _activateKbdCard(); return; }
    clearTimeout(store.searchTimeout);
    doSearch();
  } else if (e.key === 'Escape') {
    _setKbdActive(-1);
    const wrap = $('#recentSearches');
    if (wrap) wrap.style.display = 'none';
    $('#searchInput').blur();
  }
}

// ── Do Search ──
export async function doSearch(append) {
  const q = $('#searchInput').value.trim();
  if (!q) { $('#searchResults').innerHTML = ''; saveSearchState(); return; }
  if (!append) {
    store.searchOffset = 0;
    store.searchHasMore = true;
    store.searchQuery = q;
    $('#searchResults').innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  }
  store.searchLoading = true;
  $('#searchLoadMore').style.display = '';
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(q)}&type=${store.searchType}&limit=20&offset=${store.searchOffset}`);
    if (data.results.length < 20) store.searchHasMore = false;
    if (!append) {
      renderResults(data.results, '#searchResults', 'search');
    } else {
      const grid = $('#searchResults');
      const fragment = document.createElement('div');
      fragment.innerHTML = data.results.map(item => `
        <div class="card" data-item='${JSON.stringify(item).replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'>
          ${cardPlayBtn(item)}${cardDlBtn(item)}${cardRadioBtn(item)}${cardFavBtn(item)}<img class="card-img" src="${item.image || ''}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
          <div class="card-body">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub">${cardSubHtml(item)}</div>
            <div class="card-meta">
              ${item.year ? `<span>${item.year}</span>` : ''}
              ${item.total_tracks ? `<span>${item.total_tracks} ${item.type === 'show' ? 'episodes' : 'tracks'}</span>` : ''}
              ${item.release_date ? `<span>${item.release_date}</span>` : ''}
              ${item.duration_ms ? `<span>${formatDuration(item.duration_ms)}</span>` : ''}
            </div>
          </div>
        </div>
      `).join('');
      const newCards = Array.from(fragment.children);
      newCards.forEach(card => {
        card.addEventListener('click', (e) => {
          if (wasLongPress()) return;
          if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-dl-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-fav-btn')) return;
          const item = JSON.parse(card.dataset.item);
          if (item.type === 'playlist' && item.id) {
            loadPlaylistDetail(item.id, item.url, 'search');
          } else if (item.type === 'show' && item.id) {
            loadShowDetail(item.id, item.url, 'search', item.feed_url);
          } else if (item.type === 'artist' && item.id) {
            loadArtistDetail(item.id, 'search');
          } else if (item.type === 'album' && item.id) {
            loadAlbumDetail(item, 'search');
          } else {
            openModal(item);
          }
        });
        grid.appendChild(card);
      });
      addCardKebabs(newCards);
      checkLibrary(data.results, grid, newCards);
    }
    store.searchOffset += data.results.length;
    if (!append) {
      saveSearchState();
      addRecentSearch(q);
      _setKbdActive(-1);
    }
  } catch (e) {
    if (!append) $('#searchResults').innerHTML = `<div class="empty-state"><p>Search failed: ${e.message}</p></div>`;
  }
  store.searchLoading = false;
  $('#searchLoadMore').style.display = 'none';
}

// ── Init (called from app.js) ──
export function init() {
  $('#searchInput').addEventListener('input', () => {
    clearTimeout(store.searchTimeout);
    $('#searchClear').style.display = $('#searchInput').value ? 'block' : 'none';
    _setKbdActive(-1);
    renderRecentSearches();
    store.searchTimeout = setTimeout(doSearch, 400);
  });
  // Recent-search chips appear when the input is focused and empty.
  $('#searchInput').addEventListener('focus', renderRecentSearches);
  $('#searchInput').addEventListener('blur', () => {
    // Delay so a chip click (which blurs the input) still registers.
    setTimeout(() => { const w = $('#recentSearches'); if (w) w.style.display = 'none'; }, 150);
  });
  $('#searchInput').addEventListener('keydown', _handleSearchKeydown);
  $('#searchClear').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#searchClear').style.display = 'none';
    $('#searchResults').innerHTML = '';
    store.searchQuery = '';
    store.searchHasMore = false;
    _setKbdActive(-1);
    saveSearchState();
    $('#searchInput').focus();
    renderRecentSearches();
  });

  $$('.type-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.type-btn[data-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.searchType = btn.dataset.type;
      doSearch();
    });
  });

  // Infinite scroll (search part)
  window.addEventListener('scroll', () => {
    const scrollBottom = window.innerHeight + window.scrollY;
    if (scrollBottom < document.body.offsetHeight - 300) return;

    if (store.currentPage === 'search' && !store.searchLoading && store.searchHasMore && store.searchQuery) {
      doSearch(true);
    }
  });
}
