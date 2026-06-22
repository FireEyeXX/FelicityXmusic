// player_active.js — single source of truth for the active player engine.
//
// Three engines exist (classic player.js, crossfade player_v2.js, dj player_v3.js)
// and are selected at runtime via localStorage('ms_player_engine'). Cross-module
// callers MUST resolve the engine through getPlayerModule() instead of importing a
// literal './player.js', otherwise crossfade/dj are silently bypassed (the classic
// engine grabs #audioElement and plays through a muted Web Audio gain node).
//
// ES module caching dedupes by resolved specifier, so every getPlayerModule() caller
// shares the exact module instance app.js initialized.

let _modPromise = null;

export function getPlayerEngine() {
  return localStorage.getItem('ms_player_engine') || 'classic';
}

export function getPlayerModule() {
  if (!_modPromise) {
    const engine = getPlayerEngine();
    const path = engine === 'dj' ? './player_v3.js'
      : engine === 'crossfade' ? './player_v2.js'
        : './player.js';
    _modPromise = import(path).catch(e => {
      console.error('Player engine load failed, falling back to classic:', e);
      return import('./player.js');
    });
  }
  return _modPromise;
}
