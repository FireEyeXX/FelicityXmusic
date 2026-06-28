// djpanel.js — Live DJ quick-control drawer inside the full player.
//
// Surfaces a CURATED subset of the Settings DJ knobs so a DJ mixing live can
// tweak them without leaving the player. SINGLE SOURCE OF TRUTH: every control
// reads from and writes to the SAME `ms_dj_*` localStorage keys the engine reads
// via _djSetting(), so the panel and Settings stay perfectly consistent.
//
// Only visible when the active engine is 'dj' (ms_player_engine === 'dj').

import { $ } from './utils.js';
import { getPlayerModule } from './player_active.js';
import { switchPage } from './router.js';

// Curated controls. `key` is the EXACT localStorage suffix after `ms_dj_`
// (i.e. the literal _djSetting() argument the engine reads).
// NOTE the double `dj_` on energy: the engine reads it via
// _djSetting('dj_energy_weight') → localStorage key `ms_dj_dj_energy_weight`.
const PANEL_CONFIG = {
  smart_queue:      { sel: '#fpDjSmartQueue',      def: 'off' },
  crossfade_beats:  { sel: '#fpDjCrossfadeBeats',  def: '16' },
  transition_style: { sel: '#fpDjTransitionStyle', def: 'auto' },
  dj_energy_weight: { sel: '#fpDjEnergyWeight',    def: '10', badge: '#fpValDjEnergyWeight' },
};

let _savedTimer = null;
function _savedStatus() {
  const el = $('#fpDjSavedStatus');
  if (!el) return;
  el.textContent = 'saved ✓';
  clearTimeout(_savedTimer);
  _savedTimer = setTimeout(() => { el.textContent = ''; }, 1500);
}

// Per-key debounce timers — each control debounces independently so rapid changes
// to different knobs never coalesce and no write is silently dropped.
const _keyTimers = new Map();
function _writeKey(key, val) {
  clearTimeout(_keyTimers.get(key));
  _keyTimers.set(key, setTimeout(() => {
    _keyTimers.delete(key);
    localStorage.setItem(`ms_dj_${key}`, val);
    _savedStatus();
    getPlayerModule().then(m => m.applyDjSettings?.());
  }, 300));
}

// Pull current values from localStorage into the panel controls. Called on every
// open so the panel reflects any change made in Settings since last time.
export function syncDjPanel() {
  for (const [key, cfg] of Object.entries(PANEL_CONFIG)) {
    const el = $(cfg.sel);
    if (!el) continue;
    const stored = localStorage.getItem(`ms_dj_${key}`);
    const val = (stored != null && stored !== '') ? stored : cfg.def;
    el.value = val;
    if (cfg.badge) { const b = $(cfg.badge); if (b) b.textContent = val; }
  }
}

function _isDjEngine() {
  return (localStorage.getItem('ms_player_engine') || 'classic') === 'dj';
}

let _isOpen = false;

// Synchronous flag read by router.js Esc handler BEFORE any async work.
// Set/cleared in open/close so the decision is always coherent with the DOM state.
export function isDjPanelOpen() { return _isOpen; }

function openDjPanel() {
  if (!_isDjEngine()) return;
  syncDjPanel();
  $('#fpDjBackdrop')?.classList.add('open');
  const panel = $('#fpDjPanel');
  if (panel) { panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); }
  const btn = $('#fpDjPanelBtn');
  if (btn) { btn.classList.add('active'); btn.setAttribute('aria-expanded', 'true'); }
  _isOpen = true;
  window.__djPanelOpen = true;
  // OPT: move focus to close button for keyboard accessibility
  setTimeout(() => $('#fpDjPanelClose')?.focus(), 50);
}

function closeDjPanel() {
  $('#fpDjBackdrop')?.classList.remove('open');
  const panel = $('#fpDjPanel');
  if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
  const btn = $('#fpDjPanelBtn');
  if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-expanded', 'false'); }
  _isOpen = false;
  window.__djPanelOpen = false;
  // OPT: restore focus to trigger button
  $('#fpDjPanelBtn')?.focus();
}

// Exported so router.js can close the drawer after its synchronous flag check.
export function closeDjPanelFromRouter() { closeDjPanel(); }

function toggleDjPanel() {
  _isOpen ? closeDjPanel() : openDjPanel();
}

// Open Settings and expand+scroll the Playback (DJ) <details> section.
function openSettingsDjSection() {
  closeDjPanel();
  switchPage('settings');
  setTimeout(() => {
    const sec = $('#djModeSection');
    if (sec) {
      sec.open = true;
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 60);
}

// Show or hide buttons based on the active engine. Safe to call anytime.
// FIX 2: in the DJ engine the new panel's Smart Queue select supersedes the
// #fpDjMode cycle button (both write ms_dj_smart_queue). Hide the cycle button
// when engine === 'dj' to eliminate the desync; keep it for 'crossfade'.
// Panel button is only shown for 'dj'; crossfade keeps the original cycle button.
export function refreshDjPanelVisibility() {
  const engine = localStorage.getItem('ms_player_engine') || 'classic';
  const isDj = engine === 'dj';
  const isCf = engine === 'crossfade';

  const panelBtn = $('#fpDjPanelBtn');
  if (panelBtn) panelBtn.style.display = isDj ? '' : 'none';

  // #fpDjMode: visible only for crossfade engine (original behaviour was cf+dj,
  // but for dj we now hide it since the panel owns smart_queue).
  const cycleBtn = $('#fpDjMode');
  if (cycleBtn) cycleBtn.style.display = isCf ? '' : 'none';

  if (!isDj && _isOpen) closeDjPanel();
}

export function init() {
  const btn = $('#fpDjPanelBtn');
  if (!btn) return; // markup absent — nothing to wire

  refreshDjPanelVisibility();

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleDjPanel(); });
  $('#fpDjPanelClose')?.addEventListener('click', closeDjPanel);
  $('#fpDjBackdrop')?.addEventListener('click', closeDjPanel);
  $('#fpDjMoreSettings')?.addEventListener('click', openSettingsDjSection);

  // Esc is owned exclusively by router.js (synchronous flag check via window.__djPanelOpen).
  // No local keydown listener here — avoids the race where djpanel's handler fires
  // after router's, flips _isOpen to false, then router's async callback sees false
  // and also closes the player.

  // FIX 3: re-sync panel controls when Settings changes a ms_dj_* key while the
  // drawer may be open. Two sources:
  // a) cross-tab: the 'storage' event fires when another tab writes localStorage.
  // b) same-tab: the page regains focus (user went to Settings page in a new tab,
  //    or returned focus to the window). document 'visibilitychange' covers this.
  //    openFullPlayer() in fullplayer.js also calls syncDjPanel() on re-entry for
  //    the in-app navigation case (Settings → back to full player).
  window.addEventListener('storage', (e) => {
    if (_isOpen && e.key && e.key.startsWith('ms_dj_')) syncDjPanel();
  });
  document.addEventListener('visibilitychange', () => {
    if (_isOpen && document.visibilityState === 'visible') syncDjPanel();
  });

  // Wire each control to the shared ms_dj_* key.
  for (const [key, cfg] of Object.entries(PANEL_CONFIG)) {
    const el = $(cfg.sel);
    if (!el) continue;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      if (cfg.badge) { const b = $(cfg.badge); if (b) b.textContent = el.value; }
      _writeKey(key, el.value);
    });
  }
}
