// player_v2.js — Crossfade player with Web Audio API dual-deck system
// Drop-in replacement for player.js — same exports, same API.

import { store } from './store.js';
import { $, $$, fmtTime, showToast } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderQueue } from './queue.js';
import { syncFullPlayer } from './fullplayer.js';
import { getCachedUrl, waitForCache, getStatus as getPrefetchStatus, prefetchUpcoming, prefetchTrack, cleanup as prefetchCleanup, pausePrefetch, abortPrefetch, resumePrefetch } from './prefetch.js';
import { fetchDjData, scheduleDjTransition, resetDeckAfterTransition, findCrossfadeStartBeat, pickSmartNext, markPlayed, resetSmartQueuePlayed, CrossfadeBeatSync } from './djmix.js';
import * as cast from './cast.js';

// ── Dual-deck Web Audio API crossfade engine with DJ mixing ──

const _deckA = $('#audioElement');
const _deckB = document.createElement('audio');
_deckB.preload = 'none';
document.body.appendChild(_deckB);

let _ctx = null;
let _gainA = null, _gainB = null;
let _levelA = null, _levelB = null; // per-deck LUFS level-match (separate from crossfade gain)
let _sourceA = null, _sourceB = null;
// EQ filters for bass swap transitions
let _lowA = null, _lowB = null;
let _activeDeck = 'A';
let _crossfading = false;
let _crossfadeTriggered = false; // module-scope so loadAndPlay + ended handler share it
let _crossfadeTimer = null;
let _fadingOutDeck = null;
let _rateReturnTimer = null; // Bug #4: stored so we can clear on rapid next
let _beatSync = null;        // real-time beat drift correction during crossfade

// DJ data for current and next track (fetched asynchronously)
let _outDjData = null;
let _inDjData = null;

// DJ settings from localStorage (read fresh each call)
function _djSetting(key, def) { return localStorage.getItem(`ms_dj_${key}`) || def; }
function _crossfadeDur() { return parseInt(_djSetting('crossfade_sec', '5')) || 5; }

function _ensureAudioContext() {
  if (_ctx) return;
  const _AC = window.AudioContext || window.webkitAudioContext;
  try {
    // Match the library's dominant 48 kHz so MediaElementSource doesn't resample in-graph.
    _ctx = new _AC({ sampleRate: 48000, latencyHint: 'playback' });
  } catch (e) {
    _ctx = new _AC();
  }
  _gainA = _ctx.createGain();
  _gainB = _ctx.createGain();

  // Per-deck LUFS level-match gain, SEPARATE from the crossfade gain (which is overwritten
  // every transition). There is NO master limiter on this path, so the level-match helper is
  // attenuate-only (cap 1.0) — a boost here could clip the destination directly.
  _levelA = _ctx.createGain();
  _levelB = _ctx.createGain();

  // Bass EQ filters for DJ bass-swap transitions
  _lowA = _ctx.createBiquadFilter();
  _lowA.type = 'lowshelf'; _lowA.frequency.value = 250; _lowA.gain.value = 0;
  _lowB = _ctx.createBiquadFilter();
  _lowB.type = 'lowshelf'; _lowB.frequency.value = 250; _lowB.gain.value = 0;

  _sourceA = _ctx.createMediaElementSource(_deckA);
  _sourceB = _ctx.createMediaElementSource(_deckB);

  // Chain: source → lowShelf → levelGain → gain → destination
  _sourceA.connect(_lowA).connect(_levelA).connect(_gainA).connect(_ctx.destination);
  _sourceB.connect(_lowB).connect(_levelB).connect(_gainB).connect(_ctx.destination);

  _gainA.gain.value = 1;
  _gainB.gain.value = 0;
}

/**
 * LUFS level-match gain — OFF by default (opt in via ms_dj_level_target, a LUFS target
 * e.g. -12). Attenuate-only (cap 1.0) — MANDATORY here, this engine has no master limiter
 * so a boost would clip. Absent setting or lufs → 1 (no change).
 */
function _levelGainFor(lufs) {
  const target = parseFloat(_djSetting('level_target', ''));
  if (!Number.isFinite(target) || !Number.isFinite(lufs)) return 1;
  const g = Math.pow(10, (target - lufs) / 20);
  return Math.min(1, g);
}

/**
 * Live-apply settings that affect already-playing audio. Only the active deck's
 * LUFS level gain — so a `ms_dj_level_target` change is audible immediately.
 * Selection knobs are read fresh on the next advance, so no action is needed for
 * them here. No-op safe when no AudioContext/deck exists yet.
 */
export function applyDjSettings() {
  if (!_ctx || !_activeLevel()) return;
  _activeLevel().gain.value = _levelGainFor(_outDjData?.lufs);
}

function _activeDeckEl() { return _activeDeck === 'A' ? _deckA : _deckB; }
function _inactiveDeckEl() { return _activeDeck === 'A' ? _deckB : _deckA; }
function _activeGain() { return _activeDeck === 'A' ? _gainA : _gainB; }
function _inactiveGain() { return _activeDeck === 'A' ? _gainB : _gainA; }
function _activeLevel() { return _activeDeck === 'A' ? _levelA : _levelB; }
function _inactiveLevel() { return _activeDeck === 'A' ? _levelB : _levelA; }
function _activeLow() { return _activeDeck === 'A' ? _lowA : _lowB; }
function _inactiveLow() { return _activeDeck === 'A' ? _lowB : _lowA; }

/** Build deck descriptor object for djmix.js */
function _deckDesc(deckEl) {
  const isA = deckEl === _deckA;
  return {
    element: deckEl,
    gain: isA ? _gainA : _gainB,
    lowFilter: isA ? _lowA : _lowB,
  };
}

function _startCrossfade(seekable = true) {
  if (!_ctx) return;

  // If already crossfading, kill the fading-out deck immediately
  if (_crossfading && _fadingOutDeck) {
    resetDeckAfterTransition(_deckDesc(_fadingOutDeck));
    _fadingOutDeck.pause();
    _fadingOutDeck.src = '';
    clearTimeout(_crossfadeTimer);
    clearInterval(_rateReturnTimer);
    if (_beatSync) { _beatSync.stop(); _beatSync = null; }
    _crossfading = false;
  }

  _fadingOutDeck = _activeDeckEl();
  const outDesc = _deckDesc(_fadingOutDeck);
  const inDesc = _deckDesc(_inactiveDeckEl());

  // Swap active deck NOW
  _activeDeck = _activeDeck === 'A' ? 'B' : 'A';
  _crossfading = true;

  // LUFS level-match the INCOMING deck (now the active deck post-swap) BEFORE the fade.
  // Plain value, never a ramp, so it can't interact with the crossfade gain curve.
  // Attenuate-only (cap 1.0); 1.0 when lufs absent → identical to today.
  if (_activeLevel()) _activeLevel().gain.value = _levelGainFor(_inDjData?.lufs);

  // Read DJ settings
  const numBeats = parseInt(_djSetting('crossfade_beats', '16')) || 16;
  const tr = _djSetting('tempo_range', '8');
  const tempoRange = tr === '0' ? 0 : (parseInt(tr) || 8);
  const transStyle = _djSetting('transition_style', 'auto');
  const introSkip = _djSetting('intro_skip', 'auto');

  // Use seekable flag passed from loadAndPlay (cached blob = seekable)
  const inSeekable = seekable;

  // Use DJ mix engine for beat-synced, key-aware transition
  const result = scheduleDjTransition(_ctx, outDesc, inDesc, _outDjData, _inDjData, {
    numBeats, tempoRange, transitionStyle: transStyle,
    introSkip: inSeekable ? introSkip : '0',  // no seek on non-cached streams
    seekable: inSeekable,
    fallbackSec: _crossfadeDur(),
  });
  const dur = result.duration || _crossfadeDur();
  const beatDelay = (result.crossfadeStartTime - _ctx.currentTime) * 1000;
  const timerDur = dur * 1000 + Math.max(0, beatDelay) + 200;

  // Start real-time beat drift correction during the crossfade overlap
  if (_beatSync) _beatSync.stop();
  if (_outDjData?.bpm && _inDjData?.bpm) {
    _beatSync = new CrossfadeBeatSync(
      _fadingOutDeck, _activeDeckEl(),
      _outDjData.bpm, _inDjData.bpm, result.outRate, result.inRate
    );
    _beatSync.start();
  }

  // After crossfade completes, clean up old deck
  clearTimeout(_crossfadeTimer);
  const deckToStop = _fadingOutDeck;
  const outroFade = _djSetting('outro_fade', '1') === '1';
  // outro_fade=off: quick 20ms fade to avoid pop, then stop
  if (!outroFade) {
    const _dDesc = _deckDesc(deckToStop);
    _dDesc.gain.gain.setValueAtTime(_dDesc.gain.gain.value, _ctx.currentTime);
    _dDesc.gain.gain.linearRampToValueAtTime(0, _ctx.currentTime + 0.02);
    setTimeout(() => { deckToStop.pause(); deckToStop.src = ''; }, 25);
  }
  _crossfadeTimer = setTimeout(() => {
    if (outroFade) { deckToStop.pause(); deckToStop.src = ''; }
    resetDeckAfterTransition(_deckDesc(deckToStop));
    if (_beatSync) { _beatSync.stop(); _beatSync = null; }
    // Now safe to cleanup old blob URLs
    prefetchCleanup(store.playerQueue, store.playerIndex);
    _fadingOutDeck = null;
    _crossfading = false;
    _outDjData = _inDjData;
    _inDjData = null;
    resumePrefetch();
    // Gradually return new deck playbackRate to 1.0 over ~10 seconds
    clearInterval(_rateReturnTimer); // Bug #4: clear previous
    const newDeck = _activeDeckEl();
    if (newDeck.playbackRate !== 1.0) {
      const startRate = newDeck.playbackRate;
      const diff = Math.abs(startRate - 1.0);
      // Slower return for larger tempo differences: 30s for ±8%, 15s for ±2%
      const returnSec = Math.max(15, Math.round(diff * 400));
      const steps = Math.round(returnSec * 2); // 2 steps/sec
      let step = 0;
      _rateReturnTimer = setInterval(() => {
        step++;
        if (step >= steps || newDeck !== _activeDeckEl()) {
          newDeck.playbackRate = 1.0;
          clearInterval(_rateReturnTimer);
        } else {
          // Ease-out curve: fast at first, slowing down as approaching 1.0
          const t = step / steps;
          const eased = 1 - (1 - t) * (1 - t); // quadratic ease-out
          newDeck.playbackRate = startRate + (1.0 - startRate) * eased;
        }
      }, 500);
    }
  }, timerDur);
}

/** Pre-analyze upcoming tracks, predict Smart Queue pick, prefetch it.
 *  1. Analyze next N tracks for BPM/key data
 *  2. Predict which track Smart Queue would pick
 *  3. Prefetch that track's audio for smooth crossfade */
async function _preAnalyzeUpcoming() {
  const PRE_ANALYZE = parseInt(_djSetting('pre_analyze', '10')) || 10;
  const { getDjData } = await import('./bpm.js');

  // Step 1: Analyze tracks — forward first, then backward if Smart Queue
  const smartMode = _djSetting('smart_queue', 'off');
  // Forward: next N tracks
  for (let i = 1; i <= PRE_ANALYZE; i++) {
    const idx = store.playerIndex + i;
    if (idx >= store.playerQueue.length) break;
    const item = store.playerQueue[idx];
    const name = _decodeEntities(item.name || '');
    const artist = _decodeEntities(item.artist || '');
    if (getDjData(name, artist)) continue;
    await fetchDjData(name, artist).catch(() => null);
  }
  // Backward: previous tracks (when Smart Queue searches whole playlist)
  if (smartMode !== 'off') {
    for (let i = store.playerIndex - 1; i >= Math.max(0, store.playerIndex - PRE_ANALYZE); i--) {
      const item = store.playerQueue[i];
      const name = _decodeEntities(item.name || '');
      const artist = _decodeEntities(item.artist || '');
      if (getDjData(name, artist)) continue;
      await fetchDjData(name, artist).catch(() => null);
    }
  }

  // Step 2: Predict Smart Queue pick and set _inDjData
  if (smartMode !== 'off' && !store.shuffleEnabled && _outDjData) {
    const smartIdx = pickSmartNext(store.playerQueue, store.playerIndex, _outDjData, smartMode, store.repeatMode === 'all');
    if (smartIdx != null) {
      const item = store.playerQueue[smartIdx];
      const name = _decodeEntities(item.name || '');
      const artist = _decodeEntities(item.artist || '');
      _inDjData = getDjData(name, artist);
      // Step 3: Prefetch Smart Queue pick (priority) + sequential fallback
      prefetchTrack(name, artist);
      // Also prefetch sequential next as fallback
      const seqNext = store.playerQueue[store.playerIndex + 1];
      if (seqNext) prefetchTrack(_decodeEntities(seqNext.name || ''), _decodeEntities(seqNext.artist || ''));
      return;
    }
  }

  // Fallback: sequential next track
  const nextItem = store.playerQueue[store.playerIndex + 1];
  if (nextItem) {
    _inDjData = getDjData(_decodeEntities(nextItem.name || ''), _decodeEntities(nextItem.artist || ''));
    prefetchTrack(_decodeEntities(nextItem.name || ''), _decodeEntities(nextItem.artist || ''));
  }
}

// Expose active deck as `audio` for backward compatibility
const audio = _deckA;
export function getAudio() { return _activeDeckEl(); }

function _ab() { return window.AndroidBridge || null; }

/** Wait until audio element has buffered enough (30s ahead or full track).
 *  Resolves immediately for blob URLs (fully loaded). Polls every 500ms, max 15s wait. */
function _waitForBuffer(deck) {
  return new Promise(resolve => {
    // Blob URLs are fully loaded — no need to wait
    if (deck.src && deck.src.startsWith('blob:')) { resolve(); return; }
    let checks = 0;
    const maxChecks = 30; // 30 × 500ms = 15s max wait
    const check = () => {
      checks++;
      if (checks >= maxChecks || deck.paused || deck !== _activeDeckEl()) { resolve(); return; }
      // Check how far ahead we've buffered
      if (deck.buffered.length > 0) {
        const bufferedEnd = deck.buffered.end(deck.buffered.length - 1);
        const aheadSec = bufferedEnd - deck.currentTime;
        if (aheadSec >= 30 || bufferedEnd >= (deck.duration || Infinity) * 0.9) {
          resolve(); return; // 30s buffered ahead or 90%+ of track
        }
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 500); // first check after 500ms
  });
}

let _lastAbUpdate = 0;

// Android native media action callback (notification buttons → WebView)
window._androidMediaAction = function(action) {
  switch (action) {
    case 'play': _activeDeckEl().play().catch(() => {}); break;
    case 'pause': _activeDeckEl().pause(); break;
    case 'next': nextTrack(); break;
    case 'prev': prevTrack(); break;
  }
};

// Remote control: apply a command from a controlling device to LOCAL playback
// (this device is the target). Mirrors window._androidMediaAction above.
// Prepare the Web Audio graph for an inbound remote play on THIS (target) device:
// resume a suspended context and force the active deck's crossfade gain to 1 (inactive
// to 0), mirroring loadAndPlay's cold-start path. Without this an idle target whose
// context is suspended or whose active gain is 0 plays silently.
// NOTE: browser autoplay policy may still keep the context suspended without a prior
// user gesture on the target — that's an inherent limitation we can't work around here.
function _prepareRemotePlayback() {
  _ensureAudioContext();
  if (_ctx && _ctx.state === 'suspended') _ctx.resume();
  if (_activeGain()) { _activeGain().gain.cancelScheduledValues(0); _activeGain().gain.value = 1; }
  if (_inactiveGain()) { _inactiveGain().gain.cancelScheduledValues(0); _inactiveGain().gain.value = 0; }
}

export function applyRemoteCommand(action, value) {
  const a = getAudio();
  switch (action) {
    case 'play':  _prepareRemotePlayback(); a.play().catch(() => {}); updatePlayPauseIcon(true); break;
    case 'pause': a.pause(); updatePlayPauseIcon(false); break;
    case 'next':  nextTrack(); break;
    case 'prev':  prevTrack(); break;
    case 'seek':  try { a.currentTime = Number(value) || 0; } catch {} break;
    case 'volume': {
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      store.playerVolume = v;
      const el = document.getElementById('playerVolume'); if (el) el.value = Math.round(v * 100);
      const fp = document.getElementById('fpVolume'); if (fp) fp.value = Math.round(v * 100);
      // Crossfade engine sets volume on BOTH decks (matches the #playerVolume handler).
      _deckA.volume = v;
      _deckB.volume = v;
      break;
    }
    case 'enqueue': addToQueue(Array.isArray(value) ? value : [value], false); break;
    case 'transfer':
      // Play through the full engine path (loadAndPlay) so crossfade/engine features
      // are armed for a transfer, matching next/prev. loadAndPlay handles the audio
      // context + deck gain itself, so no separate _prepareRemotePlayback is needed.
      loadQueueState().then(() => { loadAndPlay(); });
      break;
  }
}

// Called by native side when bridge is injected (may be after playback started)
window._androidBridgeReady = function() {
  if (!_activeDeckEl().paused && _ab()) {
    const item = store.playerQueue[store.playerIndex];
    if (item) _ab().onPlay(item.name || '', item.artist || '');
  }
};

// ── Helper: get duration with Safari fallback ──
function _getDuration() {
  let dur = _activeDeckEl().duration;
  if (dur && isFinite(dur) && dur > 0) return dur;
  const item = store.playerQueue[store.playerIndex] || _currentRecItem;
  if (item && item.duration_ms > 0) return item.duration_ms / 1000;
  return null;
}

// ── Play Track ──
export function playTrack(item) {
  store.radioMode = false;
  store.playerQueue = [item];
  store.playerIndex = 0;
  resetSmartQueuePlayed();
  loadAndPlay();
}

// ── Add to Queue ──
export function addToQueue(items, playNow = false) {
  const startIdx = store.playerQueue.length;
  store.playerQueue = store.playerQueue.concat(items);
  if (playNow || store.playerIndex < 0) {
    store.playerIndex = startIdx;
    loadAndPlay();
  }
  renderQueue();
  saveQueueDebounced();
  showToast(`Added ${items.length} track${items.length > 1 ? 's' : ''} to playlist`);
  // Playlist mode: add tracks to Navidrome playlist (one batch call)
  if (store.playlistMode) {
    apiJson(`/api/library/playlist/${store.playlistMode.id}/add-and-download-batch`, {
      method: 'POST',
      body: { tracks: items.map(it => ({ name: it.name || '', artist: it.artist || '', album: it.album || '' })) },
    }).then(data => {
      const parts = [];
      if (data.added) parts.push(`${data.added} added`);
      if (data.queued) parts.push(`${data.queued} downloading`);
      if (parts.length) showToast(`${parts.join(', ')} → ${store.playlistMode.name}`);
    }).catch(() => {});
  }
  if (store.remoteTarget && !playNow && store.playerIndex >= 0) {
    document.dispatchEvent(new CustomEvent('remote:enqueue', { detail: items }));
  }
}

// ── Load and Play Current Track ──
export async function loadAndPlay() {
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) return;
  if (store.remoteTarget) { try { getAudio().currentTime = 0; } catch {} document.dispatchEvent(new Event('remote:play')); return; }
  // Abort prefetch downloads — current track gets all bandwidth
  abortPrefetch();
  _crossfadeTriggered = false;
  // Stop any virtual rec playback — we're back in the real queue
  import('./recommendations.js').then(m => m.stopRecPlayback());
  _currentRecItem = null; // clear stale rec so "Add to playlist" targets the queue track
  const item = store.playerQueue[store.playerIndex];
  $('#playerImg').src = item.image || '';
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  $('#playerProgressFill').style.width = '0%';
  $('#playerTimeCurrent').textContent = '0:00';
  $('#playerTimeTotal').textContent = '0:00';
  document.getElementById('playerBar').style.setProperty('--player-progress', '0%');
  const cleanName = _decodeEntities(item.name || '');
  const cleanArtist = _decodeEntities(item.artist || '');
  const mode = store.deviceOutputMode || 'default';
  // DLNA Only mode: auto-connect to renderer on play
  if (mode === 'dlna_only' && !store.castDevice) {
    cast.autoCastAndPlay(item, cleanName, cleanArtist);
  // Cast mode: send to DLNA renderer (unless local-only)
  } else if (store.castDevice && mode !== 'local') {
    cast.castState.skipAutoAdvance = true;
    cast.castState.transitioning = true;
    const castBody = {
      device_id: store.castDevice.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    };
    apiJson('/api/dlna/cast', { method: 'POST', body: castBody })
      .then(() => { /* cast started */ })
      .catch(e => { showToast('Cast failed: ' + (e.message || '')); cast.castState.transitioning = false; cast.castState.skipAutoAdvance = false; });
  } else {
    _ensureAudioContext();
    if (_ctx.state === 'suspended') _ctx.resume();
    const streamUrl = `/api/player/stream?${new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) })}`;

    const currentDeck = _activeDeckEl();
    if (!currentDeck.paused && currentDeck.src) {
      // Crossfade: wait for cache (blob = seekable = better transitions)
      let cached = getCachedUrl(cleanName, cleanArtist);
      if (!cached) { const w = await waitForCache(cleanName, cleanArtist, 2000); if (w) cached = w; }
      const src = cached || streamUrl;
      pausePrefetch();
      if (!_inDjData) {
        fetchDjData(cleanName, cleanArtist).then(d => { _inDjData = d; }).catch(() => {});
      }
      // IMPORTANT: call _startCrossfade BEFORE setting src on the next deck.
      // _startCrossfade's rapid-skip handler clears _fadingOutDeck.src, and during
      // a rapid skip _fadingOutDeck IS the inactive deck we're about to load.
      // If we set src first, the rapid-skip handler would clear it, causing silence.
      _startCrossfade(!!cached); // pass seekable flag — also swaps _activeDeck
      const nextDeck = _activeDeckEl(); // after swap, the NEW active deck is the one to load
      nextDeck.src = src;
      nextDeck.load();
      nextDeck.play().catch(() => {});
    } else {
      // Cold start — play immediately, no cache wait
      if (_crossfading && _fadingOutDeck) {
        resetDeckAfterTransition(_deckDesc(_fadingOutDeck));
        _fadingOutDeck.pause(); _fadingOutDeck.src = ''; _fadingOutDeck = null;
        clearTimeout(_crossfadeTimer); _crossfading = false;
      }
      const deck = currentDeck;
      deck.src = getCachedUrl(cleanName, cleanArtist) || streamUrl;
      deck.load();
      deck.play().catch(() => {});
      if (_activeGain()) {
        _activeGain().gain.cancelScheduledValues(0);
        _activeGain().gain.value = 1;
      }
      // LUFS level-match: unity until data arrives (helper returns 1 when absent),
      // then set the real attenuation once DJ data resolves. Plain value, never a ramp.
      if (_activeLevel()) _activeLevel().gain.value = 1;
      // Fetch DJ data for current track (needed for crossfade timing)
      _outDjData = null;
      fetchDjData(cleanName, cleanArtist).then(d => {
        if (d) _outDjData = d;
        if (_activeLevel()) _activeLevel().gain.value = _levelGainFor(_outDjData?.lufs);
      }).catch(() => {});
      // Cleanup old blob URLs (safe — no crossfade in progress)
      prefetchCleanup(store.playerQueue, store.playerIndex);
    }
  }
  showPlayerBar();
  updatePlayPauseIcon(true);
  syncFullPlayer();
  updateDownloadButtons(item);
  renderQueue();
  saveQueueDebounced();
  updateMediaSession();
  resolveSource(item);
  updatePlaylistBadge();
}

function _decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

function resolveSource(item) {
  const badge = $('#playerSourceBadge');
  const fpBadge = $('#fpSourceBadge');
  if (badge) { badge.textContent = ''; badge.className = 'source-badge'; }
  if (fpBadge) { fpBadge.textContent = ''; fpBadge.className = 'source-badge'; }
  const params = new URLSearchParams({ name: _decodeEntities(item.name || ''), artist: _decodeEntities(item.artist || '') });
  apiJson(`/api/player/resolve-source?${params}`).then(data => {
    const src = data.source || 'youtube';
    const labels = { local: 'LOCAL', navidrome: 'FLAC', youtube: 'YT' };
    const label = labels[src] || src.toUpperCase();
    if (badge) { badge.textContent = label; badge.className = `source-badge source-${src}`; }
    if (fpBadge) { fpBadge.textContent = label; fpBadge.className = `source-badge source-${src}`; }
  }).catch(() => {});
}

function updateDownloadButtons(item) {
  const inLib = !!item.inLibrary;
  const miniBtn = $('#playerDownloadBtn');
  const fpBtn = $('#fpDownload');
  if (miniBtn) {
    miniBtn.disabled = inLib;
    miniBtn.style.opacity = inLib ? '0.3' : '';
    miniBtn.title = inLib ? 'Already in library' : 'Download current track';
  }
  if (fpBtn) {
    fpBtn.disabled = inLib;
    fpBtn.style.opacity = inLib ? '0.3' : '';
    fpBtn.title = inLib ? 'Already in library' : 'Download';
  }
}

export function updatePlaylistBadge() {
  const badge = $('#fpPlaylistBadge');
  if (badge) {
    if (store.playlistMode) { badge.textContent = store.playlistMode.name; badge.style.display = ''; }
    else badge.style.display = 'none';
  }
  const show = store.playlistMode ? '' : 'none';
  const rm1 = $('#playerRemoveFromPlaylist');
  const rm2 = $('#fpRemoveFromPlaylist');
  if (rm1) rm1.style.display = show;
  if (rm2) rm2.style.display = show;
}

export function showPlayerBar() {
  $('#playerBar').classList.add('active');
  document.body.classList.add('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = '';
  // Hide cast button in local-only mode
  const mode = store.deviceOutputMode || 'default';
  const castBtn = $('#playerCastBtn');
  const fpCastBtn = $('#fpCastBtn');
  if (mode === 'local') {
    if (castBtn) castBtn.style.display = 'none';
    if (fpCastBtn) fpCastBtn.style.display = 'none';
  } else {
    if (castBtn) castBtn.style.display = '';
    if (fpCastBtn) fpCastBtn.style.display = '';
  }
}

export function hidePlayerBar() {
  $('#playerBar').classList.remove('active');
  document.body.classList.remove('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = 'none';
  // Stop Android foreground service when player is hidden
  if (_ab()) _ab().onStop();
}

// ── Next / Prev ──
let _lastNextTime = 0;
export function nextTrack(opts = {}) {
  const reason = opts.reason || 'user';
  // Throttle only rapid USER skips — never drop ended/auto/error advances (an auto
  // crossfade or ended event must always advance, or the track stalls).
  const now = Date.now();
  if (reason === 'user') {
    if (now - _lastNextTime < 500) return;
    _lastNextTime = now;
  }

  // ── Record skip/accept for recommendation feedback (only on user/end paths) ──
  if (reason === 'user' || reason === 'ended') {
    try {
      const cur = store.playerQueue[store.playerIndex];
      if (cur && cur.name) {
        const deck = _activeDeckEl();
        const dur = deck && deck.duration ? deck.duration : 0;
        const pos = deck && deck.currentTime ? deck.currentTime : 0;
        const ratio = dur > 0 ? pos / dur : 0;
        import('./recommendations.js').then(m => {
          if (reason === 'ended') m.recordAccept(cur);
          else if (dur > 0 && ratio < 0.5 && pos < 30) m.recordSkip(cur);
          else if (ratio > 0.7) m.recordAccept(cur);
        });
      }
    } catch {}
  }

  if (store.castDevice) {
    cast.markCastTransition();
  }
  // If playing a virtual rec track, advance to next rec (both local and cast)
  import('./recommendations.js').then(m => {
    if (m.isPlayingRec()) {
      m.playNextRec().then(filled => {
        if (!filled) { _activeDeckEl().pause(); updatePlayPauseIcon(false); }
      });
      return;
    }
    _nextTrackInQueue();
  });
}

function _nextTrackInQueue() {
  if (store.shuffleEnabled && store.playerQueue.length > 1) {
    let next;
    do { next = Math.floor(Math.random() * store.playerQueue.length); } while (next === store.playerIndex);
    store.playerIndex = next;
    loadAndPlay();
  } else if (store.playerIndex < store.playerQueue.length - 1) {
    // Smart Queue: pick best next track by BPM/key instead of sequential
    const smartMode = _djSetting('smart_queue', 'off');
    if (smartMode !== 'off' && _outDjData) {
      const smartIdx = pickSmartNext(store.playerQueue, store.playerIndex, _outDjData, smartMode, store.repeatMode === 'all');
      if (smartIdx != null) {
        markPlayed(store.playerQueue[store.playerIndex]); // pickSmartNext is side-effect-free; mark outgoing item on real advance
        store.playerIndex = smartIdx;
        loadAndPlay();
        return;
      }
    }
    store.playerIndex++;
    loadAndPlay();
  } else if (store.repeatMode === 'all') {
    store.playerIndex = 0;
    loadAndPlay();
  } else if (store.radioMode && !store.radioLoading) {
    // Auto-fill queue with more radio tracks
    store.radioLoading = true;
    const seed = store.playerQueue[store.playerQueue.length - 1] || store.radioSeedTrack;
    if (seed) {
      showToast('Loading more similar tracks...');
      const params = new URLSearchParams({ track: seed.name || '', artist: seed.artist || '', artist_id: seed.id || store.currentArtistId || '' });
      apiJson(`/api/radio?${params}`).then(data => {
        const newTracks = (data.tracks || []).filter(t => {
          const key = (t.name || '').toLowerCase() + '|' + (t.artist || '').toLowerCase();
          return !store.playerQueue.some(q => (q.name || '').toLowerCase() + '|' + (q.artist || '').toLowerCase() === key);
        });
        if (newTracks.length) {
          store.playerQueue = store.playerQueue.concat(newTracks);
          store.playerIndex++;
          loadAndPlay();
          renderQueue();
          saveQueueDebounced();
          import('./upnext.js').then(u => u.mirrorAdd(newTracks));
        } else {
          showToast('No more similar tracks found');
          _activeDeckEl().pause();
          updatePlayPauseIcon(false);
        }
      }).catch(() => {
        showToast('Failed to load more tracks');
        _activeDeckEl().pause();
        updatePlayPauseIcon(false);
      }).finally(() => { store.radioLoading = false; });
    }
  } else {
    // Queue ended — continue with virtual recommendations
    import('./recommendations.js').then(m => {
      m.playNextRec().then(filled => {
        if (!filled) {
          _activeDeckEl().pause();
          updatePlayPauseIcon(false);
        }
      });
    });
  }
}

// ── Play a track from recommendations (virtual, not in queue) ──
let _currentRecItem = null;
export async function playRecTrack(item) {
  if (store.remoteTarget) {
    store.playerQueue = store.playerQueue.concat([item]);
    store.playerIndex = store.playerQueue.length - 1;
    try { getAudio().currentTime = 0; } catch {}
    document.dispatchEvent(new Event('remote:play'));
    return;
  }
  _currentRecItem = item;
  $('#playerImg').src = item.image || '';
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  $('#playerProgressFill').style.width = '0%';
  $('#playerTimeCurrent').textContent = '0:00';
  $('#playerTimeTotal').textContent = '0:00';
  document.getElementById('playerBar').style.setProperty('--player-progress', '0%');
  const fpFill = $('#fpProgressFill');
  if (fpFill) fpFill.style.width = '0%';
  const fpCur = $('#fpTimeCurrent');
  if (fpCur) fpCur.textContent = '0:00';
  const fpTot = $('#fpTimeTotal');
  if (fpTot) fpTot.textContent = '0:00';
  const cleanName = _decodeEntities(item.name || '');
  const cleanArtist = _decodeEntities(item.artist || '');
  // Cast mode: send to DLNA renderer
  if (store.castDevice) {
    cast.castState.skipAutoAdvance = true;
    cast.castState.transitioning = true;
    apiJson('/api/dlna/cast', { method: 'POST', body: {
      device_id: store.castDevice.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    }}).catch(e => { showToast('Cast failed: ' + (e.message || '')); cast.castState.transitioning = false; cast.castState.skipAutoAdvance = false; });
  } else {
    _ensureAudioContext();
    if (_ctx.state === 'suspended') _ctx.resume();
    const streamUrl = `/api/player/stream?${new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) })}`;
    const cached = getCachedUrl(cleanName, cleanArtist);
    const src = cached || streamUrl;
    const curDeck = _activeDeckEl();
    if (!curDeck.paused && curDeck.src && cached) {
      pausePrefetch();
      _startCrossfade();
      const nextDeck = _activeDeckEl(); // after swap
      nextDeck.src = src;
      nextDeck.load();
      nextDeck.play().catch(() => {});
    } else {
      if (_crossfading && _fadingOutDeck) {
        resetDeckAfterTransition(_deckDesc(_fadingOutDeck));
        _fadingOutDeck.pause(); _fadingOutDeck.src = ''; _fadingOutDeck = null;
        clearTimeout(_crossfadeTimer); _crossfading = false;
      }
      curDeck.src = src;
      curDeck.load();
      curDeck.play().catch(() => {});
      if (_activeGain()) {
        _activeGain().gain.cancelScheduledValues(0);
        _activeGain().gain.value = 1;
      }
      // No analyzed LUFS on this direct-play path → reset level-match to unity (no carryover).
      if (_activeLevel()) _activeLevel().gain.value = 1;
    }
  }
  showPlayerBar();
  updatePlayPauseIcon(true);
  // Sync full player directly
  const fpImg = $('#fpImg');
  if (fpImg) fpImg.src = item.image || '';
  const fpTitle = $('#fpTitle');
  if (fpTitle) fpTitle.textContent = item.name || '';
  const fpArtist = $('#fpArtist');
  if (fpArtist) fpArtist.textContent = item.artist || '';
  updateDownloadButtons(item);
  updateMediaSessionWith(item);
  resolveSource(item);
}

function updateMediaSessionWith(item) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.name || '', artist: item.artist || '', album: item.album || '',
    artwork: item.image ? [{ src: item.image, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } _activeDeckEl().play(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } _activeDeckEl().pause(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'prev' } })); return; } prevTrack(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } })); return; } nextTrack(); });
}

export function prevTrack() {
  if (store.castDevice) {
    cast.markCastTransition();
  }
  // If playing a virtual rec track, go to previous rec or back to queue
  import('./recommendations.js').then(m => {
    if (m.isPlayingRec()) {
      const went = m.playPrevRec();
      if (!went) {
        // Back to last track in queue
        if (store.playerIndex >= 0) loadAndPlay();
      }
      return;
    }
    // Normal queue navigation
    if (!store.castDevice && _activeDeckEl().currentTime > 3) {
      _activeDeckEl().currentTime = 0;
    } else if (store.playerIndex > 0) {
      store.playerIndex--;
      loadAndPlay();
    }
  });
}

// ── Play/Pause Icon ──
export function updatePlayPauseIcon(playing) {
  store.playerPlaying = playing;
  const playPath = '<path d="M8 5v14l11-7z"/>';
  const pausePath = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  $('#playPauseIcon').innerHTML = playing ? pausePath : playPath;
  const fpIcon = $('#fpPlayPauseIcon');
  if (fpIcon) fpIcon.innerHTML = playing ? pausePath : playPath;
}

export function pauseLocal() { try { _deckA.pause(); _deckB.pause(); } catch {} updatePlayPauseIcon(false); }

// ── Resolve Item Tracks (album/artist → track list) ──
export async function resolveItemTracks(item) {
  const type = item.type || 'track';
  if (type === 'album' && item.id) {
    const data = await apiJson(`/api/album/${item.id}/tracks`);
    return (data.tracks || []).map(t => ({ ...t, type: 'track' }));
  }
  if (type === 'artist' && item.id) {
    const data = await apiJson(`/api/artist/${item.id}/albums`);
    const albums = data.albums || [];
    const allTracks = [];
    for (const album of albums.slice(0, 10)) {
      try {
        const ad = await apiJson(`/api/album/${album.id}/tracks`);
        (ad.tracks || []).forEach(t => allTracks.push({ ...t, type: 'track' }));
      } catch {}
    }
    return allTracks;
  }
  return [item];
}

// ── Queue Persistence ──
export function saveQueueDebounced() {
  clearTimeout(store.playerSaveTimer);
  store.playerSaveTimer = setTimeout(saveQueueNow, 2000);
  // Trigger recommendations refresh
  import('./recommendations.js').then(m => m.onQueueChanged());
}

async function saveQueueNow() {
  if (!store.currentUser) return;
  try {
    return await apiJson('/api/player/queue', {
      method: 'PUT',
      body: {
        queue: store.playerQueue,
        current_index: store.playerIndex,
        position_seconds: _activeDeckEl().currentTime || 0,
        volume: store.playerVolume,
        playlist_mode: store.playlistMode,
      },
    });
  } catch {}
}

// Synchronous (awaitable) flush of the pending queue save — cancels the debounce
// timer and performs the PUT immediately. Used before engine-switch reloads so
// recent queue/position changes are persisted to the server before unload.
export async function flushQueue() {
  clearTimeout(store.playerSaveTimer);
  return saveQueueNow();
}

export async function loadQueueState() {
  try {
    const data = await apiJson('/api/player/queue');
    if (data.queue && data.queue.length) {
      store.playerQueue = data.queue;
      store.playerIndex = data.current_index >= 0 ? data.current_index : 0;
      store.playerVolume = data.volume ?? 1.0;
      _deckA.volume = store.playerVolume;
      _deckB.volume = store.playerVolume;
      $('#playerVolume').value = Math.round(store.playerVolume * 100);
      const item = store.playerQueue[store.playerIndex];
      if (item) {
        $('#playerImg').src = item.image || '';
        $('#playerTitle').textContent = item.name || '';
        $('#playerArtist').textContent = item.artist || '';
        const deck = _activeDeckEl();
        const params = new URLSearchParams({ name: item.name || '', artist: item.artist || '', token: (store.streamToken || store.authToken) });
        deck.src = `/api/player/stream?${params}`;
        deck.preload = 'none';
        if (data.position_seconds > 0) {
          deck.addEventListener('loadedmetadata', () => { deck.currentTime = data.position_seconds; }, { once: true });
        }
        syncFullPlayer();
        updateDownloadButtons(item);
        showPlayerBar();
      }
      // Restore playlist mode
      if (data.playlist_mode) {
        store.playlistMode = data.playlist_mode;
        updatePlaylistBadge();
      }
      import('./queue.js').then(m => m.updateSaveButton());
    }
  } catch {}
}

// ── Media Session API ──
function updateMediaSession() {
  if (!('mediaSession' in navigator) || store.playerIndex < 0) return;
  const item = store.playerQueue[store.playerIndex];
  if (!item) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.name || '', artist: item.artist || '', album: item.album || '',
    artwork: item.image ? [{ src: item.image, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } _activeDeckEl().play(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } _activeDeckEl().pause(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'prev' } })); return; } prevTrack(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } })); return; } nextTrack(); });
}

// ── Audio Element Reference (exported for other modules) ──
// Export deckA as `audio` for backward compat — other modules use it for
// paused state checks and currentTime. During crossfade both decks play
// but UI modules only need the active one.
export { _deckA as audio };

// ── Init ──
export function init() {
  // Audio events
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('play', () => {
      if (deck !== _activeDeckEl() && !_crossfading) return;
      updatePlayPauseIcon(true);
      if (_ab()) {
        const item = store.playerQueue[store.playerIndex];
        if (item) _ab().onPlay(item.name || '', item.artist || '');
      }
    });
    deck.addEventListener('playing', () => {
      if (deck !== _activeDeckEl()) return;
      // Fetch DJ data for current track (lightweight API call, doesn't compete)
      if (!_outDjData) {
        const item = store.playerQueue[store.playerIndex];
        if (item) {
          fetchDjData(_decodeEntities(item.name || ''), _decodeEntities(item.artist || ''))
            .then(d => { if (d) _outDjData = d; }).catch(() => {});
        }
      }
      // Wait for current track to buffer enough before starting prefetch/pre-analyze
      _waitForBuffer(deck).then(() => {
        if (deck !== _activeDeckEl() || deck.paused) return;
        const sm = _djSetting('smart_queue', 'off');
        if (sm === 'off') {
          // Sequential mode: prefetch next N tracks in order
          resumePrefetch();
        }
        // Pre-analyze handles Smart Queue prefetch via prefetchTrack()
        _preAnalyzeUpcoming();
      });
    });
    deck.addEventListener('pause', () => {
      if (deck !== _activeDeckEl()) return;
      updatePlayPauseIcon(false);
      pausePrefetch();
      if (_ab()) _ab().onPause();
    });
  });
  // Both decks need ended/error handlers
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('ended', () => {
      if (deck !== _activeDeckEl() || _crossfading || _crossfadeTriggered || !deck.src) return;
      if (store.repeatMode === 'one') {
        deck.currentTime = 0;
        deck.play().catch(() => {});
      } else {
        nextTrack({ reason: 'ended' });
      }
    });
    deck.addEventListener('error', () => {
      if (deck !== _activeDeckEl() || !deck.src) return; // ignore error from cleared src
      if (_crossfading) {
        // Error on incoming deck during crossfade — abort crossfade, skip track
        if (_fadingOutDeck) {
          _fadingOutDeck.pause(); _fadingOutDeck.src = '';
          resetDeckAfterTransition(_deckDesc(_fadingOutDeck));
          _fadingOutDeck = null;
        }
        clearTimeout(_crossfadeTimer);
        clearInterval(_rateReturnTimer);
        if (_beatSync) { _beatSync.stop(); _beatSync = null; }
        _crossfading = false;
      }
      showToast('Stream error, skipping...');
      setTimeout(() => nextTrack({ reason: 'error' }), 1000);
    });
  });

  // Timeupdate on both decks, but only UI-update from active deck
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('timeupdate', () => {
      if (deck !== _activeDeckEl()) return;
      const dur = _getDuration();
      if (!dur) return;
      const pct = (deck.currentTime / dur) * 100;
      $('#playerProgressFill').style.width = pct + '%';
      $('#playerTimeCurrent').textContent = fmtTime(deck.currentTime);
      $('#playerTimeTotal').textContent = fmtTime(dur);
      document.getElementById('playerBar').style.setProperty('--player-progress', pct + '%');
      const fpFill = $('#fpProgressFill');
      if (fpFill) fpFill.style.width = pct + '%';
      const fpCur = $('#fpTimeCurrent');
      if (fpCur) fpCur.textContent = fmtTime(deck.currentTime);
      const fpTot = $('#fpTimeTotal');
      if (fpTot) fpTot.textContent = fmtTime(dur);
      // Update prefetch status indicator (~2/sec)
      if (!window._pfLastUpdate || Date.now() - window._pfLastUpdate > 500) {
        window._pfLastUpdate = Date.now();
        const curItem = store.playerQueue[store.playerIndex];
        const nextItem = store.playerQueue[store.playerIndex + 1];
        // Now: is current track from cache (blob) or streaming?
        const nowCached = deck.src && deck.src.startsWith('blob:');
        const nowSt = curItem ? getPrefetchStatus(_decodeEntities(curItem.name || ''), _decodeEntities(curItem.artist || '')) : null;
        const nowReady = nowCached || (nowSt && nowSt.state === 'ready');
        // Next: prefetch progress
        const nextSt = nextItem ? getPrefetchStatus(_decodeEntities(nextItem.name || ''), _decodeEntities(nextItem.artist || '')) : null;
        const nextPct = nextSt ? nextSt.progress : -1;
        let html = '';
        // Now dot
        html += `<span class="prefetch-dot ${nowReady ? 'ready' : 'loading'}" title="Now"></span>`;
        // Next dot + progress
        if (nextItem) {
          html += `<span class="prefetch-dot ${nextPct >= 100 ? 'ready' : nextPct >= 0 ? 'loading' : ''}" title="Next"></span>`;
          if (nextPct >= 0 && nextPct < 100) html += `${nextPct}%`;
        }
        for (const id of ['prefetchStatus', 'fpPrefetchStatus']) {
          const el = $(`#${id}`);
          if (el) el.innerHTML = html;
        }
      }
      if (_ab() && Math.abs(deck.currentTime - (_lastAbUpdate || 0)) >= 1) {
        _lastAbUpdate = deck.currentTime;
        _ab().onProgress(Math.floor(deck.currentTime * 1000), Math.floor(dur * 1000));
      }
      // ── Auto-crossfade: trigger nextTrack when approaching end ──
      // Wait for DJ data before calculating trigger (avoids premature 5s fallback)
      if (!_outDjData && deck.currentTime < dur - _crossfadeDur() - 5) {
        // DJ data not loaded yet and we're far from end — skip check this tick
      } else {
        // Outro skip: use detected outro_start or manual setting as effective end
        let effectiveEnd = dur;
        const outroSkip = _djSetting('outro_skip', 'auto');
        if (outroSkip === 'auto' && _outDjData && _outDjData.outro_start
            && _outDjData.outro_start > dur * 0.5) { // ignore outro in first half
          effectiveEnd = _outDjData.outro_start;
        } else if (outroSkip !== '0' && outroSkip !== 'auto') {
          effectiveEnd = dur - (parseInt(outroSkip) || 0);
        }

        const remaining = effectiveEnd - deck.currentTime;
        // Calculate trigger point: use beat grid or fallback to fixed duration
        let triggerAt = _crossfadeDur();
        if (_outDjData && _outDjData.beat_grid && _outDjData.bpm) {
          const numBeats = parseInt(_djSetting('crossfade_beats', '16')) || 16;
          const startBeat = findCrossfadeStartBeat(_outDjData.beat_grid, effectiveEnd, numBeats);
          triggerAt = effectiveEnd - startBeat;
          if (triggerAt > dur * 0.5) triggerAt = _crossfadeDur();
        }
        if (remaining <= triggerAt && remaining > -5 && !_crossfadeTriggered
            && store.repeatMode !== 'one' && !store.castDevice
            && deck.currentTime > 10) { // don't trigger in first 10s
          const hasNext = store.playerIndex < store.playerQueue.length - 1 || store.repeatMode === 'all';
          if (hasNext) {
            _crossfadeTriggered = true;
            nextTrack({ reason: 'auto' });
          }
        }
        if (remaining > triggerAt + 1) {
          _crossfadeTriggered = false;
        }
      }
    });
  });
  // (error handlers registered in the deck loop above)

  // Controls
  $('#playerPlayPause').addEventListener('click', () => {
    if (store.castDevice) {
      if (store.playerPlaying) apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {});
      else apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {});
    } else {
      _ensureAudioContext();
      if (_ctx.state === 'suspended') _ctx.resume();
      const deck = _activeDeckEl();
      if (deck.paused) {
        deck.play().catch(() => {});
      } else {
        deck.pause();
        // Also pause fading-out deck if crossfading
        if (_fadingOutDeck && !_fadingOutDeck.paused) _fadingOutDeck.pause();
      }
    }
  });
  $('#playerNext').addEventListener('click', nextTrack);
  $('#playerPrev').addEventListener('click', prevTrack);
  $('#playerVolume').addEventListener('input', (e) => {
    store.playerVolume = e.target.value / 100;
    if (store.castDevice) {
      apiJson('/api/dlna/volume', { method: 'POST', body: { volume: parseInt(e.target.value) } }).catch(() => {});
    } else {
      _deckA.volume = store.playerVolume;
      _deckB.volume = store.playerVolume;
    }
  });
  async function _seekFromEvent(bar, e) {
    const dur = _getDuration();
    if (!dur) return;
    const rect = bar.getBoundingClientRect();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    if (store.castDevice) {
      apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: pct * dur } }).catch(() => {});
    } else {
      try { _activeDeckEl().currentTime = pct * dur; } catch {}
    }
  }
  const miniBar = $('#playerProgressBar');
  miniBar.addEventListener('click', (e) => _seekFromEvent(miniBar, e));
  miniBar.addEventListener('touchstart', (e) => { e.preventDefault(); _seekFromEvent(miniBar, e); }, { passive: false });

  // Add to playlist
  async function _addToPlaylist() {
    const item = (typeof _currentRecItem !== 'undefined' && _currentRecItem)
      ? _currentRecItem
      : (store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null);
    if (!item) return;
    try {
      const data = await apiJson('/api/library/playlists');
      const playlists = data.playlists || [];
      if (!playlists.length) { showToast('No playlists. Create one in Library first.'); return; }
      const { showPlaylistPicker } = await import('./utils.js');
      const picked = await showPlaylistPicker(playlists, { multi: false });
      if (!picked) return;
      const cleanName = _decodeEntities(item.name || '');
      const cleanArtist = _decodeEntities(item.artist || '');
      await apiJson(`/api/library/playlist/${picked.id}/add-and-download`, {
        method: 'POST',
        body: { name: cleanName, artist: cleanArtist, album: item.album || '' },
      });
      showToast(`Added to ${picked.name}`);
      if (store.playlistMode && store.playlistMode.id === picked.id) {
        const key = (cleanName + '|' + cleanArtist).toLowerCase();
        const exists = store.playerQueue.some(t =>
          (_decodeEntities(t.name || '').toLowerCase() + '|' + _decodeEntities(t.artist || '').toLowerCase()) === key);
        if (!exists) {
          store.playerQueue.push({ ...item, name: cleanName, artist: cleanArtist });
          renderQueue();
          saveQueueDebounced();
        }
      }
    } catch (e) { showToast('Failed: ' + (e.message || '')); }
  }
  $('#playerAddToPlaylist').addEventListener('click', _addToPlaylist);
  if ($('#fpAddToPlaylist')) $('#fpAddToPlaylist').addEventListener('click', _addToPlaylist);

  async function _removeFromPlaylist() {
    const idx = store.playerIndex;
    const item = idx >= 0 ? store.playerQueue[idx] : null;
    if (!item || !store.playlistMode) return;
    try {
      const cleanName = _decodeEntities(item.name || '');
      const cleanArtist = _decodeEntities(item.artist || '');
      await apiJson(`/api/library/playlist/${store.playlistMode.id}/remove-by-name`, {
        method: 'POST', body: { name: cleanName, artist: cleanArtist },
      });
      showToast(`Removed from ${store.playlistMode.name}`);
      // Mirror the backend removal in the local queue / now-playing UI.
      if (idx >= 0 && idx < store.playerQueue.length) {
        const wasCurrent = (idx === store.playerIndex);
        store.playerQueue.splice(idx, 1);
        if (idx < store.playerIndex) store.playerIndex--;
        else if (wasCurrent) {
          if (store.playerIndex >= store.playerQueue.length) store.playerIndex = store.playerQueue.length - 1;
          if (store.playerIndex >= 0) {
            try { const a = getAudio(); if (a) a.pause(); } catch (e) {}
            loadAndPlay();
          } else {
            // Queue emptied: stop the track that was just removed.
            try { const a = getAudio(); if (a) a.pause(); } catch (e) {}
          }
        }
        renderQueue();
        saveQueueDebounced();
      }
    } catch (e) { showToast('Failed: ' + (e.message || '')); }
  }
  $('#playerRemoveFromPlaylist').addEventListener('click', _removeFromPlaylist);
  if ($('#fpRemoveFromPlaylist')) $('#fpRemoveFromPlaylist').addEventListener('click', _removeFromPlaylist);

  // Download current track
  $('#playerDownloadBtn').addEventListener('click', async () => {
    const item = store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
    if (!item) return;
    const btn = $('#playerDownloadBtn');
    btn.style.color = 'var(--accent)';
    try {
      await apiJson('/api/download', { method: 'POST', body: {
        url: item.url || '', title: `${item.artist || ''} - ${item.name || ''}`,
        method: store.appSettings.default_method || 'yt-dlp', format: store.appSettings.default_format || 'flac',
        type: item.type || 'track',
      }});
      showToast('Download started');
    } catch (e) { showToast('Download failed: ' + e.message); }
    finally { setTimeout(() => { btn.style.color = ''; }, 1000); }
  });

  // ── Cast (DLNA) — shared module (cast.js) ──
  cast.initCast({ getAudioEl: getAudio, nextTrack });
  cast.wireControls();

  // Play button on cards (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.card-play-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    const item = JSON.parse(card.dataset.item);
    const tracks = await resolveItemTracks(item);
    if (tracks.length) {
      const u = await import('./upnext.js');
      u.playTracks(tracks);
    }
  });

  // Download button on cards (event delegation)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.card-dl-btn');
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    // Artist detail album cards use data-album-idx
    if (card.dataset.albumIdx !== undefined) return; // handled locally
    const item = JSON.parse(card.dataset.item);
    openModal(item);
    if (!item.inLibrary) setTimeout(() => $('#modalDownload').click(), 100);
  });

  // Keyboard controls (when not in input)
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (!store.playerQueue.length && !_activeDeckEl().src) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } })); return; }
        if (store.castDevice) {
          if (store.playerPlaying) apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {});
          else apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {});
        } else {
          _ensureAudioContext();
          if (_ctx.state === 'suspended') _ctx.resume();
          const deck = _activeDeckEl();
          if (deck.paused) {
            deck.play().catch(() => {});
          } else {
            deck.pause();
            if (_fadingOutDeck && !_fadingOutDeck.paused) _fadingOutDeck.pause();
          }
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        nextTrack();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        prevTrack();
        break;
      case 'ArrowUp':
        e.preventDefault();
        store.playerVolume = Math.min(1, store.playerVolume + 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else { _deckA.volume = store.playerVolume; _deckB.volume = store.playerVolume; }
        break;
      case 'ArrowDown':
        e.preventDefault();
        store.playerVolume = Math.max(0, store.playerVolume - 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else { _deckA.volume = store.playerVolume; _deckB.volume = store.playerVolume; }
        break;
    }
  });

  // Periodic save while playing
  setInterval(() => { if (store.playerPlaying && store.currentUser) saveQueueNow(); }, 30000);

  // Save on page unload (sync XHR since sendBeacon can't set auth headers)
  window.addEventListener('beforeunload', () => {
    if (store.playerQueue.length && store.currentUser) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/player/queue', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        const token = store.authToken;
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(JSON.stringify({
          queue: store.playerQueue, current_index: store.playerIndex,
          position_seconds: _activeDeckEl().currentTime || 0, volume: store.playerVolume,
          playlist_mode: store.playlistMode,
        }));
      } catch {}
    }
  });

  // ── Swipe up on mini player to open full player ──
  const playerBar = document.getElementById('playerBar');
  if (playerBar) {
    let sy = 0, tracking = false;
    playerBar.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sy = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    playerBar.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const dy = sy - e.touches[0].clientY;
      if (dy > 40) {
        tracking = false;
        import('./fullplayer.js').then(m => m.openFullPlayer());
      }
    }, { passive: true });
    playerBar.addEventListener('touchend', () => { tracking = false; }, { passive: true });
    playerBar.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  }
}
