// remote.js — Spotify-Connect-style device→device remote control.
//
// One device (controller) drives another device's playback over SSE. Both belong
// to the same user. This module:
//   - reports THIS device's playback state every 3s (so controllers can see it),
//   - listens on an SSE stream for `devices` snapshots and `command` events,
//   - applies inbound commands to LOCAL playback when THIS device is the target,
//   - lets the user pick another device to control and intercepts the existing
//     player-bar controls so they drive the remote device instead.

import { store } from './store.js';
import { $, $$, esc, fmtTime, showToast } from './utils.js';
import { apiJson, refreshStreamToken } from './api.js';
import { getPlayerModule } from './player_active.js';

// ── SSE connection ──
let _stopped = false;  // set by stopRemote() to kill any in-flight reconnect after logout

function _scheduleReconnect() {
  clearTimeout(store.remoteReconnectTimer);
  if (_stopped) return;
  store.remoteReconnectTimer = setTimeout(connectSSE, 5000);
}

async function connectSSE() {
  if (_stopped) return;
  await refreshStreamToken();
  // Only ever put a stream-scoped token in the URL — never the full session JWT
  // (query strings leak into logs/history/Referer). Retry if minting failed.
  const token = store.streamToken;
  if (_stopped) return;
  if (!token || !store.deviceId) { _scheduleReconnect(); return; }
  try {
    const url = `/api/remote/events?token=${encodeURIComponent(token)}&device_id=${encodeURIComponent(store.deviceId)}`;
    const es = new EventSource(url);
    store.remoteEventSource = es;

    es.addEventListener('devices', e => {
      try {
        const d = JSON.parse(e.data);
        store.remoteDevices = d.devices || {};
        renderDevicesPanel();
        if (store.remoteTarget) { showControllingBanner(); renderRemoteNowPlaying(); }
      } catch {}
    });

    es.addEventListener('command', e => {
      try {
        const c = JSON.parse(e.data);
        getPlayerModule().then(m => m.applyRemoteCommand(c.action, c.value)).catch(() => {});
      } catch {}
    });

    es.addEventListener('ping', () => {});

    es.onerror = () => {
      // Ignore errors from a stale socket already replaced/torn down.
      if (store.remoteEventSource !== es) return;
      es.close();
      store.remoteEventSource = null;
      // Reconnect with a fresh token (connectSSE re-mints it) unless we've stopped.
      _scheduleReconnect();
    };
  } catch {
    _scheduleReconnect();
  }
}

// ── State reporting (this device → server) ──
async function reportState() {
  if (!store.authToken) return;
  try {
    const m = await getPlayerModule();
    const a = m.getAudio();
    const item = store.playerQueue[store.playerIndex] || null;
    const track = item ? {
      name: item.name || '',
      artist: item.artist || '',
      album: item.album || '',
      image: item.image || '',
      duration_ms: item.duration_ms || 0,
    } : null;
    apiJson('/api/remote/state', {
      method: 'POST',
      body: {
        playing: a ? !a.paused : false,
        position_seconds: a ? (a.currentTime || 0) : 0,
        volume: store.playerVolume,
        track,
      },
    }).catch(() => {});
  } catch {}
}

// ── Remote command sending (controller → target) ──
function sendCommand(action, value) {
  if (!store.remoteTarget) return;
  apiJson('/api/remote/command', {
    method: 'POST',
    body: { target_device_id: store.remoteTarget, action, value },
  }).catch(() => showToast('Device offline', true));
}

async function transferTo(targetId) {
  try {
    const m = await getPlayerModule();
    await m.flushQueue();
    await apiJson('/api/remote/command', {
      method: 'POST',
      body: { target_device_id: targetId, action: 'transfer' },
    });
    showToast('Transferred');
    toggleDevicesPanel(false);
    // Switch into remote-control mode for the target so the local controls now drive
    // it (no local+remote overlap). enterRemoteMode stops local audio via pauseLocal().
    enterRemoteMode(targetId);
  } catch {
    showToast('Transfer failed', true);
  }
}

// ── Devices popover ──
function toggleDevicesPanel(forceState) {
  const panel = $('#remoteDevicesPanel');
  if (!panel) return;
  const willOpen = typeof forceState === 'boolean' ? forceState : panel.style.display === 'none';
  if (willOpen) {
    // Seed from REST if the SSE snapshot hasn't arrived yet.
    if (!Object.keys(store.remoteDevices).length) {
      apiJson('/api/remote/devices').then(d => {
        store.remoteDevices = d.devices || {};
        renderDevicesPanel();
      }).catch(() => {});
    }
    renderDevicesPanel();
    panel.style.display = '';
  } else {
    panel.style.display = 'none';
  }
}

function renderDevicesPanel() {
  const panel = $('#remoteDevicesPanel');
  if (!panel || panel.style.display === 'none') return;
  const devices = store.remoteDevices || {};
  const ids = Object.keys(devices);
  let html = '<div class="rdp-title">Devices</div>';
  if (!ids.length) {
    html += '<div class="remote-device-row"><div class="rdr-info"><div class="rdr-track">No devices found</div></div></div>';
  }
  for (const id of ids) {
    const dev = devices[id] || {};
    const isThis = id === store.deviceId;
    const isTarget = store.remoteTarget === id;
    const online = !!dev.online;
    const fallbackName = `Device ${id.slice(0, 6)}`;
    const name = esc(dev.name || fallbackName) + (isThis ? ' (this device)' : '');
    const tr = dev.track;
    const trackLine = tr ? `<div class="rdr-track">▶ ${esc(tr.name || '')} — ${esc(tr.artist || '')}</div>` : '';
    let actions = '';
    if (!isThis && online) {
      if (isTarget) {
        actions = `<button class="rdr-btn" data-remote-action="stop">Stop controlling</button>`;
      } else {
        actions = `<button class="rdr-btn" data-remote-action="control" data-remote-id="${esc(id)}">Control</button>`
          + `<button class="rdr-btn" data-remote-action="transfer" data-remote-id="${esc(id)}">Send to</button>`;
      }
    }
    html += `<div class="remote-device-row${isTarget ? ' controlling' : ''}">`
      + `<span class="rdr-dot${online ? ' online' : ''}"></span>`
      + `<div class="rdr-info"><div class="rdr-name">${name}</div>${trackLine}</div>`
      + `<div class="rdr-actions">${actions}</div>`
      + `</div>`;
  }
  panel.innerHTML = html;
  $$('[data-remote-action]', panel).forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-remote-action');
      const id = btn.getAttribute('data-remote-id');
      if (act === 'control') enterRemoteMode(id);
      else if (act === 'transfer') transferTo(id);
      else if (act === 'stop') exitRemoteMode();
    });
  });
}

// ── Remote mode (controlling another device) ──
function enterRemoteMode(targetId) {
  store.remoteTarget = targetId;
  document.body.classList.add('remote-active');
  // Fully stop local playback so we don't run two streams at once, and reveal the
  // player bar so the remote now-playing is visible even if we never played locally.
  getPlayerModule().then(m => { try { m.pauseLocal(); m.showPlayerBar?.(); } catch {} }).catch(() => {});
  showControllingBanner();
  renderRemoteNowPlaying();
  renderDevicesPanel();
  toggleDevicesPanel(false);
}

function exitRemoteMode() {
  store.remoteTarget = null;
  document.body.classList.remove('remote-active');
  const banner = $('#remoteControllingBanner');
  if (banner) banner.remove();
  renderDevicesPanel();
  // The local engine keeps the player bar in sync on its next update; nothing else
  // to repaint here.
}

function showControllingBanner() {
  let banner = $('#remoteControllingBanner');
  const dev = store.remoteDevices[store.remoteTarget] || {};
  const name = esc(dev.name || 'device');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'remoteControllingBanner';
    banner.className = 'remote-controlling-banner';
    const bar = $('#playerBar');
    if (bar && bar.parentNode) bar.parentNode.insertBefore(banner, bar);
    else document.body.appendChild(banner);
  }
  banner.innerHTML = `<span>Controlling ${name}</span><button title="Stop controlling">⨯</button>`;
  const closeBtn = banner.querySelector('button');
  if (closeBtn) closeBtn.addEventListener('click', exitRemoteMode);
}

// Paint the player bar from the remote device's reported state.
function renderRemoteNowPlaying() {
  if (!store.remoteTarget) return;
  const dev = store.remoteDevices[store.remoteTarget];
  if (!dev) return;
  if (!dev.online) {
    showToast('Device went offline', true);
    exitRemoteMode();
    return;
  }
  const tr = dev.track || {};
  const durSec = tr.duration_ms ? tr.duration_ms / 1000 : 0;
  const pos = dev.position_seconds || 0;
  const pct = durSec > 0 ? Math.max(0, Math.min(100, (pos / durSec) * 100)) : 0;
  const playPath = '<path d="M8 5v14l11-7z"/>';
  const pausePath = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  const iconHtml = dev.playing ? pausePath : playPath;
  const volPct = typeof dev.volume === 'number' ? Math.round(dev.volume * 100) : null;

  // Paint both the mini player bar and the full player (whichever is visible).
  const setText = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  const setSrc = (sel, v) => { const el = $(sel); if (el) el.src = v; };

  setSrc('#playerImg', tr.image || ''); setSrc('#fpImg', tr.image || '');
  setText('#playerTitle', tr.name || ''); setText('#fpTitle', tr.name || '');
  setText('#playerArtist', tr.artist || ''); setText('#fpArtist', tr.artist || '');

  const miniFill = $('#playerProgressFill'); if (miniFill) miniFill.style.width = pct + '%';
  const fpFill = $('#fpProgressFill'); if (fpFill) fpFill.style.width = pct + '%';
  setText('#playerTimeCurrent', fmtTime(pos)); setText('#fpTimeCurrent', fmtTime(pos));
  setText('#playerTimeTotal', fmtTime(durSec)); setText('#fpTimeTotal', fmtTime(durSec));

  const miniIcon = $('#playPauseIcon'); if (miniIcon) miniIcon.innerHTML = iconHtml;
  const fpIcon = $('#fpPlayPauseIcon'); if (fpIcon) fpIcon.innerHTML = iconHtml;

  if (volPct !== null) {
    const miniVol = $('#playerVolume'); if (miniVol) miniVol.value = volPct;
    const fpVol = $('#fpVolume'); if (fpVol) fpVol.value = volPct;
  }
}

// ── Capture-phase control interceptors ──
// When controlling a remote device, the existing player-bar controls must drive
// the REMOTE device instead of local audio. Capture-phase listeners run before the
// engine's bubble-phase handlers, so we stop propagation and send a remote command.
function installInterceptors() {
  // Bound for BOTH the mini player bar and the full player — same remote-mode guard.
  const onClick = (sel, fn) => {
    const el = $(sel);
    if (el) el.addEventListener('click', e => {
      if (!store.remoteTarget) return;
      e.stopImmediatePropagation(); e.preventDefault();
      fn(e);
    }, true);
  };

  // play/pause — toggles based on the target's reported state
  const togglePlay = () => {
    const d = store.remoteDevices[store.remoteTarget];
    sendCommand(d && d.playing ? 'pause' : 'play');
  };
  onClick('#playerPlayPause', togglePlay);
  onClick('#fpPlayPause', togglePlay);

  onClick('#playerNext', () => sendCommand('next'));
  onClick('#fpNext', () => sendCommand('next'));
  onClick('#playerPrev', () => sendCommand('prev'));
  onClick('#fpPrev', () => sendCommand('prev'));

  // seek — translate click position on the progress bar into seconds
  const seekFrom = bar => e => {
    const rect = bar.getBoundingClientRect();
    const x = e.clientX ?? 0;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    const d = store.remoteDevices[store.remoteTarget];
    const dur = (d && d.track && d.track.duration_ms) ? d.track.duration_ms / 1000 : 0;
    sendCommand('seek', pct * dur);
  };
  const miniBar = $('#playerProgressBar');
  if (miniBar) onClick('#playerProgressBar', seekFrom(miniBar));
  const fpBar = $('#fpProgressBar');
  if (fpBar) onClick('#fpProgressBar', seekFrom(fpBar));

  // volume — range inputs fire 'input', not 'click'
  const onVolume = sel => {
    const el = $(sel);
    if (el) el.addEventListener('input', e => {
      if (!store.remoteTarget) return;
      e.stopImmediatePropagation(); e.preventDefault();
      sendCommand('volume', e.target.value / 100);
    }, true);
  };
  onVolume('#playerVolume');
  onVolume('#fpVolume');
}

let _docClickBound = false;
function bindOutsideClick() {
  if (_docClickBound) return;
  _docClickBound = true;
  document.addEventListener('click', e => {
    const panel = $('#remoteDevicesPanel');
    if (!panel || panel.style.display === 'none') return;
    if (panel.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#playerDevicesBtn, #fpDevicesBtn')) return;
    panel.style.display = 'none';
  });
}

// ── Engine playback events → remote commands ──
// Engines stay decoupled from this module: when controlling a remote target they
// dispatch DOM events instead of importing remote.js. We translate them here.
function installPlaybackBridge() {
  document.addEventListener('remote:play', async () => {
    if (!store.remoteTarget) return;
    try {
      const m = await getPlayerModule();
      await m.flushQueue();
      await apiJson('/api/remote/command', { method: 'POST', body: { target_device_id: store.remoteTarget, action: 'transfer' } });
    } catch { showToast('Device offline', true); }
  });
  document.addEventListener('remote:enqueue', e => {
    if (!store.remoteTarget) return;
    const items = (e.detail && e.detail.length) ? e.detail : [];
    if (!items.length) return;
    apiJson('/api/remote/command', { method: 'POST', body: { target_device_id: store.remoteTarget, action: 'enqueue', value: items } }).catch(() => showToast('Device offline', true));
  });
  // Transport intents from engine keyboard/mediaSession handlers (Space, OS media keys)
  // route here so they drive the remote target instead of producing local audio.
  document.addEventListener('remote:cmd', e => {
    if (!store.remoteTarget) return;
    const action = e.detail && e.detail.action;
    if (action === 'toggle') {
      const d = store.remoteDevices[store.remoteTarget];
      sendCommand(d && d.playing ? 'pause' : 'play');
    } else if (action === 'play' || action === 'pause' || action === 'next' || action === 'prev') {
      sendCommand(action);
    }
  });
}

let _wired = false;
function wireUI() {
  if (_wired) return;
  _wired = true;
  const btn = $('#playerDevicesBtn');
  if (btn) btn.addEventListener('click', () => toggleDevicesPanel());
  const fpBtn = $('#fpDevicesBtn');
  if (fpBtn) fpBtn.addEventListener('click', () => toggleDevicesPanel());
  installInterceptors();
  installPlaybackBridge();
  bindOutsideClick();
}

// ── Lifecycle ──
export function initRemote() {
  _stopped = false;
  connectSSE();
  reportState();
  if (store.remoteStateTimer) clearInterval(store.remoteStateTimer);
  store.remoteStateTimer = setInterval(reportState, 3000);
  wireUI();
}

export function stopRemote() {
  _stopped = true;
  if (store.remoteEventSource) { try { store.remoteEventSource.close(); } catch {} store.remoteEventSource = null; }
  if (store.remoteStateTimer) { clearInterval(store.remoteStateTimer); store.remoteStateTimer = null; }
  if (store.remoteReconnectTimer) { clearTimeout(store.remoteReconnectTimer); store.remoteReconnectTimer = null; }
  store.remoteTarget = null;
  exitRemoteMode();
  const panel = $('#remoteDevicesPanel');
  if (panel) panel.style.display = 'none';
}
