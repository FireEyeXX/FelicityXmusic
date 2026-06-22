"""BPM analysis service — ensemble detection optimized for zouk music."""

import asyncio
import json
import logging
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np

from app.services import library
from app.services.player import find_track_file

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
BPM_CACHE_FILE = DATA_DIR / "bpm_analysis.json"

ZOUK_MIN_BPM = 60       # fold window spans exactly one octave (60–120 = 2×) → no dead zone
ZOUK_MAX_BPM = 120
BPM_ALGO_VERSION = 3    # bump to invalidate cached/tagged BPM when the algorithm changes

# Dance-band fold center: zouk is danced ~82 BPM (half-time). Env-overridable.
_DANCE_CENTER = float(os.environ.get("BPM_DANCE_CENTER", "82"))
# Number of evenly-spaced analysis windows across the track body.
_BPM_SEGMENTS = int(os.environ.get("BPM_SEGMENTS", "3"))

CAMELOT_MAP = {
    "A minor": "8A", "E minor": "9A", "B minor": "10A", "F# minor": "11A",
    "Db minor": "12A", "Ab minor": "1A", "Eb minor": "2A", "Bb minor": "3A",
    "F minor": "4A", "C minor": "5A", "G minor": "6A", "D minor": "7A",
    "C major": "8B", "G major": "9B", "D major": "10B", "A major": "11B",
    "E major": "12B", "B major": "1B", "F# major": "2B", "Db major": "3B",
    "Ab major": "4B", "Eb major": "5B", "Bb major": "6B", "F major": "7B",
}

_bpm_cache: dict = {}

# 4 threads — C extensions (librosa/numpy FFT, essentia C++, madmom Cython)
# release the GIL, so threads give real parallelism with shared memory.
# 4 threads ≈ 1.5 GB total vs 16 subprocesses ≈ 10 GB.
_executor = ThreadPoolExecutor(max_workers=int(os.environ.get("BPM_WORKERS", "2")))


def _load_cache() -> dict:
    if BPM_CACHE_FILE.exists():
        try:
            data = json.loads(BPM_CACHE_FILE.read_text())
            # Invalidate entries from older versions that lack beat_grid/outro_start
            return {k: v for k, v in data.items()
                    if isinstance(v, dict) and v.get("beat_grid") and v.get("outro_start") is not None
                    and v.get("algo_version") == BPM_ALGO_VERSION}
        except Exception:
            pass
    return {}


def _save_cache():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BPM_CACHE_FILE.write_text(json.dumps(_bpm_cache, indent=2))


_bpm_cache = _load_cache()


def _cache_key(name: str, artist: str) -> str:
    return f"{artist.lower().strip()}::{name.lower().strip()}"


def normalize_bpm(bpm: float, min_bpm: float = ZOUK_MIN_BPM, max_bpm: float = ZOUK_MAX_BPM) -> float:
    """Dance-aware octave fold. Brings a detected tempo into a sane octave window, then
    folds into ONE clean octave centered (geometrically) on the zouk dance center — a
    STRICT MONOTONE fold (no dead zone, no per-value octave flips) so tracks stay
    comparable/sortable. The band follows BPM_DANCE_CENTER: everything lands in
    [center/√2, center·√2). Lower the center to shift the whole scale toward the
    half-time pulse zouk is danced to. Keeps the original name+signature."""
    if bpm <= 0:
        return bpm
    lo = _DANCE_CENTER / 1.4142135623730951  # center / √2
    hi = lo * 2.0
    while bpm >= hi: bpm /= 2
    while bpm < lo: bpm *= 2
    return round(bpm, 2)


# ── Analysis (runs in thread, C extensions release GIL) ──

def _read_window(file_path: str, start_sec: float, len_sec: float):
    """Read ONLY one window of audio (never the whole track), resampled to 44100Hz.
    Returns (mono_44k, data_44k) where data_44k preserves channels."""
    import soundfile as sf
    import librosa
    info = sf.info(file_path)
    sr = info.samplerate
    data, _ = sf.read(file_path, start=int(start_sec * sr),
                      frames=int(len_sec * sr), dtype="float32")
    if sr != 44100:
        if data.ndim > 1:
            data = librosa.resample(data.T, orig_sr=sr, target_sr=44100).T
        else:
            data = librosa.resample(data, orig_sr=sr, target_sr=44100)
    if data.ndim > 1:
        mono = np.mean(data, axis=1)
    else:
        mono = data
    return mono, data


def _detect_window(mono_44k_seg, data_44k_seg, want_key: bool):
    """Run the librosa + essentia detectors on a single window.
    Returns (raw_values_dict, beat_positions_rel, detected_key_or_None)."""
    import librosa
    raw = {}

    # ── librosa (hop_length=512 → 2× faster, minimal accuracy loss) ──
    HOP = 512
    mono_22k = librosa.resample(mono_44k_seg, orig_sr=44100, target_sr=22050)
    _, y_perc = librosa.effects.hpss(mono_22k, margin=3.0)
    onset_env = librosa.onset.onset_strength(
        y=y_perc, sr=22050, hop_length=HOP,
        aggregate=np.median, fmax=8000, n_mels=80,
    )
    tempo = librosa.beat.tempo(
        onset_envelope=onset_env, sr=22050, hop_length=HOP,
        start_bpm=85, std_bpm=1.0, ac_size=8.0, max_tempo=120,
    )
    raw["librosa_tempo"] = round(float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo), 1)
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=22050, hop_length=HOP,
        start_bpm=85, tightness=120,
    )
    bt = librosa.frames_to_time(beat_frames, sr=22050, hop_length=HOP)
    raw["librosa_beats"] = round(float(60.0 / np.median(np.diff(bt))), 1) if len(bt) > 1 else raw["librosa_tempo"]
    beat_positions_rel = [round(float(t), 3) for t in bt]
    del y_perc, onset_env, bt, mono_22k

    # ── essentia (hopSize=256 → 2× faster) ──
    detected_key = None
    try:
        import essentia.standard as es
        audio_es = mono_44k_seg.astype(np.float32)
        raw["essentia_percival"] = round(float(es.PercivalBpmEstimator(
            frameSize=2048, hopSize=256, maxBPM=120, minBPM=55, sampleRate=44100,
        )(audio_es)), 1)
        rbpm, _, _, _, _ = es.RhythmExtractor2013(
            method="multifeature", maxTempo=120, minTempo=55,
        )(audio_es)
        raw["essentia_rhythm"] = round(float(rbpm), 1)
        if want_key:
            try:
                key_name, scale, strength = es.KeyExtractor()(audio_es)
                detected_key = f"{key_name} {scale}"
            except Exception as e:
                logger.warning("Key detection failed: %s", e)
                detected_key = None
        del audio_es
    except ImportError:
        detected_key = None

    return raw, beat_positions_rel, detected_key


def analyze_bpm(file_path: str) -> dict:
    """Multi-segment ensemble BPM analysis — memory efficient (windowed reads only,
    never loads the whole track), with two-level cross-segment confidence
    (within-window detector agreement + cross-segment agreement)."""
    import soundfile as sf

    info = sf.info(file_path)
    track_duration = float(info.duration)

    # ── Plan windows: N windows of 45s evenly spaced across 10%–85% of the body.
    WIN_LEN = 45.0
    if track_duration < 90:
        starts = [0.0]  # very short track: single window at start
    else:
        body_start = 0.10 * track_duration
        body_end = 0.85 * track_duration
        n = max(1, _BPM_SEGMENTS)
        if n == 1:
            starts = [body_start]
        else:
            span = body_end - body_start
            step = span / (n - 1)
            starts = [body_start + i * step for i in range(n)]
        # Clamp so each window fits inside the track.
        max_start = max(0.0, track_duration - WIN_LEN)
        starts = [min(s, max_start) for s in starts]
        # Drop near-duplicate windows (short tracks clamp several starts together).
        dedup = []
        for s in starts:
            if not any(abs(s - d) < WIN_LEN / 2 for d in dedup):
                dedup.append(s)
        starts = dedup

    weights = {
        "essentia_percival": 3.0, "essentia_rhythm": 2.0,
        "librosa_tempo": 1.5, "librosa_beats": 1.0,
    }

    mid_idx = len(starts) // 2
    raw = {}
    detected_key = None
    beat_positions = []           # absolute beat times from the first window
    per_window_folded = []        # list of dicts {detector: folded_bpm}
    within_stds = []              # std of folded detector values within each window

    for wi, s in enumerate(starts):
        try:
            mono_seg, data_seg = _read_window(file_path, s, WIN_LEN)
            if len(mono_seg) == 0:
                del mono_seg, data_seg
                continue
            want_key = (wi == mid_idx)
            win_raw, bt_rel, win_key = _detect_window(mono_seg, data_seg, want_key)
            del mono_seg, data_seg
        except Exception as e:
            # One bad window must not abort the whole analysis (we run N of them).
            logger.warning("BPM window %d failed: %s", wi, e)
            continue
        if want_key and win_key:
            detected_key = win_key
        # First window's beats become the absolute beat_positions / anchor source.
        if wi == 0:
            beat_positions = [round(t + s, 3) for t in bt_rel]
        # Merge raw values with window-index suffix for debugging.
        for k, v in win_raw.items():
            raw[f"{k}_{wi}"] = v
        # Fold this window's detector values.
        folded = {k: round(normalize_bpm(v), 2) for k, v in win_raw.items()}
        per_window_folded.append(folded)
        fvals = list(folded.values())
        within_stds.append(float(np.std(fvals)) if len(fvals) > 1 else 0.0)

    # ── Beat detection for intro/outro (windowed, never whole track) ──
    import librosa
    HOP = 512
    sr22 = 22050
    forced_bpm = raw.get("librosa_tempo_0", 85)
    # Intro: first 30s
    intro_len = min(30.0, track_duration)
    intro_mono, _ = _read_window(file_path, 0.0, intro_len)
    intro_22k = librosa.resample(intro_mono, orig_sr=44100, target_sr=sr22)
    _, intro_frames = librosa.beat.beat_track(y=intro_22k, sr=sr22, hop_length=HOP, bpm=forced_bpm, tightness=120)
    intro_beats = librosa.frames_to_time(intro_frames, sr=sr22, hop_length=HOP).tolist()
    del intro_22k, intro_mono
    # Outro: last 60s
    outro_offset = max(0.0, track_duration - 60.0)
    outro_mono, _ = _read_window(file_path, outro_offset, track_duration - outro_offset)
    outro_22k = librosa.resample(outro_mono, orig_sr=44100, target_sr=sr22)
    _, outro_frames = librosa.beat.beat_track(y=outro_22k, sr=sr22, hop_length=HOP, bpm=forced_bpm, tightness=120)
    outro_beats = [round(t + outro_offset, 3) for t in librosa.frames_to_time(outro_frames, sr=sr22, hop_length=HOP).tolist()]
    del outro_22k, outro_mono
    full_beats = sorted(set(intro_beats + outro_beats))

    # ── Weighted median over ALL (window × detector) folded values ──
    all_pairs = []
    for folded in per_window_folded:
        for k, v in folded.items():
            all_pairs.append((v, weights.get(k, 1.0)))
    all_pairs.sort(key=lambda x: x[0])
    if all_pairs:
        cumw = np.cumsum([w for _, w in all_pairs])
        idx = int(np.searchsorted(cumw, cumw[-1] / 2))
        final_bpm = all_pairs[idx][0]
    else:
        final_bpm = round(normalize_bpm(forced_bpm), 2)
    if not final_bpm or final_bpm <= 0:
        final_bpm = round(normalize_bpm(85), 2)  # floor — never let beat_period divide by 0

    # ── Two-level confidence: within-window agreement × segment agreement ──
    within_std_max = max(within_stds) if within_stds else 0.0
    seg_medians = [float(np.median(list(f.values()))) for f in per_window_folded if f]
    segment_std = float(np.std(seg_medians)) if len(seg_medians) > 1 else 0.0
    spread = max(within_std_max, segment_std)
    confidence = 0.95 if spread < 1 else 0.85 if spread < 2 else 0.70 if spread < 4 else 0.50 if spread < 8 else 0.30

    # (Downbeat tie-break intentionally omitted: with single-octave band folding every
    # value already collapses into the same octave, so a downbeat estimate cannot
    # disambiguate the metrical level — the cross-segment confidence above is the
    # uncertainty signal instead, and it flags tracks where segments genuinely disagree.)

    # Merge per-window folded values into one normalized dict (suffixed keys).
    normalized = {}
    for wi, folded in enumerate(per_window_folded):
        for k, v in folded.items():
            normalized[f"{k}_{wi}"] = v

    # ── Beat grid (quantized from final BPM, full track) ──
    beat_period = 60.0 / final_bpm
    anchor = full_beats[0] if full_beats else 0
    beat_grid = [round(anchor + i * beat_period, 3)
                 for i in range(int((track_duration - anchor) / beat_period) + 1)]

    # ── Intro detection: first beat in the track ──
    intro_end = round(full_beats[0], 3) if full_beats else 0

    # ── Outro detection: scan full-track beats from end ──
    outro_start = track_duration
    if len(full_beats) > 8:
        for i in range(len(full_beats) - 1, 0, -1):
            gap = full_beats[i] - full_beats[i - 1]
            if gap > beat_period * 1.5:
                candidate = round(full_beats[i - 1], 3)
                if candidate > track_duration * 0.5:
                    outro_start = candidate
                break

    # ── Key / Camelot ──
    camelot = CAMELOT_MAP.get(detected_key) if detected_key else None

    return {
        "bpm": round(final_bpm, 1), "confidence": confidence,
        "raw": raw, "normalized": normalized,
        "beat_positions": beat_positions,
        "beat_grid": beat_grid,
        "key": detected_key,
        "camelot": camelot,
        "intro_end": intro_end,
        "outro_start": outro_start,
        "algo_version": BPM_ALGO_VERSION,
    }


# ── File tag read/write ──

def _open_tags(file_path: str):
    """Open mutagen tags for reading/writing. Returns (tags, format) or (None, None)."""
    try:
        if file_path.endswith(".flac"):
            from mutagen.flac import FLAC
            return FLAC(file_path), "flac"
        elif file_path.endswith(".mp3"):
            from mutagen.easyid3 import EasyID3
            try:
                return EasyID3(file_path), "mp3"
            except Exception:
                tags = EasyID3()
                tags.filename = file_path
                return tags, "mp3"
    except Exception:
        pass
    return None, None


def read_bpm_tag(file_path: str) -> int | None:
    tags, _ = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("BPM") or tags.get("bpm")
    if val:
        try:
            return int(float(val[0]))
        except Exception:
            pass
    return None


def read_key_tag(file_path: str) -> str | None:
    """Read musical key from INITIALKEY/KEY tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    if fmt == "flac":
        val = tags.get("INITIALKEY") or tags.get("KEY") or tags.get("key")
    else:
        # EasyID3 doesn't map TKEY by default, try raw
        val = tags.get("initialkey") or tags.get("key")
    if val:
        return val[0]
    return None


def read_anchor_tag(file_path: str) -> float | None:
    """Read beat anchor (time of first beat in seconds) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("BEAT_ANCHOR") or tags.get("beat_anchor")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_intro_tag(file_path: str) -> float | None:
    """Read intro end time (first beat) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("INTRO_END") or tags.get("intro_end")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_outro_tag(file_path: str) -> float | None:
    """Read outro start time (seconds) from custom tag."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("OUTRO_START") or tags.get("outro_start")
    if val:
        try:
            return float(val[0])
        except Exception:
            pass
    return None


def read_algover_tag(file_path: str) -> int | None:
    """Read the BPM algorithm version the file was last analyzed with."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return None
    val = tags.get("BPM_ALGO_VER") or tags.get("bpm_algo_ver")
    if val:
        try:
            return int(val[0])
        except Exception:
            pass
    return None


def write_tags(file_path: str, bpm: int = None, key: str = None,
               beat_anchor: float = None, intro_end: float = None,
               outro_start: float = None, algo_ver: int = None):
    """Write BPM, key, beat anchor, intro end, and outro start to file tags."""
    tags, fmt = _open_tags(file_path)
    if not tags:
        return
    try:
        if bpm is not None:
            if fmt == "flac":
                tags["BPM"] = str(bpm)
            else:
                tags["bpm"] = str(bpm)
        if key is not None:
            if fmt == "flac":
                tags["INITIALKEY"] = key
            else:
                from mutagen.easyid3 import EasyID3
                if "initialkey" not in EasyID3.valid_keys:
                    from mutagen.id3 import TKEY
                    EasyID3.RegisterTextKey("initialkey", "TKEY")
                tags["initialkey"] = key
        if beat_anchor is not None:
            if fmt == "flac":
                tags["BEAT_ANCHOR"] = str(round(beat_anchor, 3))
            else:
                # MP3: store in TXXX custom frame
                from mutagen.easyid3 import EasyID3
                if "beat_anchor" not in EasyID3.valid_keys:
                    from mutagen.id3 import TXXX
                    EasyID3.RegisterTXXXKey("beat_anchor", "BEAT_ANCHOR")
                tags["beat_anchor"] = str(round(beat_anchor, 3))
        for tag_name, value in [("INTRO_END", intro_end), ("OUTRO_START", outro_start)]:
            if value is not None:
                if fmt == "flac":
                    tags[tag_name] = str(round(value, 3))
                else:
                    from mutagen.easyid3 import EasyID3
                    lk = tag_name.lower()
                    if lk not in EasyID3.valid_keys:
                        from mutagen.id3 import TXXX
                        EasyID3.RegisterTXXXKey(lk, tag_name)
                    tags[lk] = str(round(value, 3))
        if algo_ver is not None:
            if fmt == "flac":
                tags["BPM_ALGO_VER"] = str(algo_ver)
            else:
                from mutagen.easyid3 import EasyID3
                if "bpm_algo_ver" not in EasyID3.valid_keys:
                    from mutagen.id3 import TXXX
                    EasyID3.RegisterTXXXKey("bpm_algo_ver", "BPM_ALGO_VER")
                tags["bpm_algo_ver"] = str(algo_ver)
        tags.save()
    except Exception as e:
        logger.error("Failed to write tags to %s: %s", file_path, e)


def _reconstruct_beat_grid(bpm: float, anchor: float, file_path: str) -> tuple[list, float]:
    """Reconstruct beat grid from BPM + anchor. Returns (beat_grid, duration)."""
    try:
        import soundfile as sf
        info = sf.info(file_path)
        duration = info.duration
    except Exception:
        duration = 300  # fallback 5 min
    beat_period = 60.0 / bpm
    grid = [round(anchor + i * beat_period, 3)
            for i in range(int((duration - anchor) / beat_period) + 1)]
    return grid, duration


def _analyze_or_read_tag(file_path: str) -> dict:
    """Check file tags first, run full analysis if any tag missing."""
    existing_bpm = read_bpm_tag(file_path)
    existing_key = read_key_tag(file_path)
    existing_anchor = read_anchor_tag(file_path)
    existing_intro = read_intro_tag(file_path)
    existing_outro = read_outro_tag(file_path)
    existing_ver = read_algover_tag(file_path)

    if (existing_bpm and existing_key and existing_anchor is not None
            and existing_intro is not None and existing_outro is not None
            and existing_ver == BPM_ALGO_VERSION):
        # All tags present AND analyzed by the current algorithm — fast path.
        bpm = float(existing_bpm)
        camelot = CAMELOT_MAP.get(existing_key)
        beat_grid, track_duration = _reconstruct_beat_grid(bpm, existing_anchor, file_path)
        return {
            "bpm": bpm, "confidence": 1.0,
            "raw": {"tag_bpm": existing_bpm, "tag_key": existing_key},
            "normalized": {"tag": bpm},
            "key": existing_key, "camelot": camelot,
            "beat_positions": beat_grid, "beat_grid": beat_grid,
            "intro_end": existing_intro,
            "outro_start": existing_outro,
            "algo_version": BPM_ALGO_VERSION,
        }

    # Need full analysis (missing tag(s))
    result = analyze_bpm(file_path)
    # Write all tags
    anchor = (result.get("beat_positions") or [None])[0]
    write_tags(file_path,
               bpm=int(round(result["bpm"])),
               key=result.get("key"),
               beat_anchor=anchor,
               intro_end=result.get("intro_end"),
               outro_start=result.get("outro_start"),
               algo_ver=BPM_ALGO_VERSION)
    return result


# ── Audio file access ──

async def _get_audio_file(song_id: str, name: str, artist: str) -> str | None:
    local = find_track_file(name, artist)
    if local:
        return local

    if not library.NAVIDROME_PASSWORD or not song_id:
        return None

    cache_dir = os.path.join(tempfile.gettempdir(), "ms-bpm-cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, f"{song_id}.flac")

    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path

    params = library._params(id=song_id)
    url = f"{library.NAVIDROME_URL}/rest/stream"
    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            async with client.stream("GET", url, params=params) as resp:
                resp.raise_for_status()
                with open(cache_path + ".tmp", "wb") as f:
                    async for chunk in resp.aiter_bytes(8192):
                        f.write(chunk)
        os.rename(cache_path + ".tmp", cache_path)
        return cache_path
    except Exception as e:
        logger.error("Failed to stream from Navidrome for BPM analysis: %s", e)
        for p in (cache_path + ".tmp", cache_path):
            if os.path.exists(p):
                os.unlink(p)
        return None


# ── Public API ──

# Per-track locks to prevent duplicate concurrent analysis (#10 fix)
_analysis_locks: dict[str, asyncio.Lock] = {}


async def analyze_track(song_id: str, name: str, artist: str,
                        force: bool = False) -> dict | None:
    key = _cache_key(name, artist)
    if not force and key in _bpm_cache:
        return _bpm_cache[key]

    # Per-track lock: only one analysis at a time per track
    if key not in _analysis_locks:
        _analysis_locks[key] = asyncio.Lock()
    async with _analysis_locks[key]:
        # Re-check cache after acquiring lock (another request may have finished)
        if not force and key in _bpm_cache:
            return _bpm_cache[key]

        file_path = await _get_audio_file(song_id, name, artist)
        if not file_path:
            return None

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, _analyze_or_read_tag, file_path)
        result["name"] = name
        result["artist"] = artist
        _bpm_cache[key] = result
        _save_cache()
        return result


async def analyze_playlist(playlist_id: str, force: bool = False,
                           limit: int = 0, on_progress=None) -> list[dict]:
    pl = await library.get_playlist(playlist_id)
    if not pl:
        return []

    cached_results = {}
    to_analyze = []
    for track in pl["tracks"]:
        c = get_cached_bpm(track["name"], track["artist"])
        if c and not force:
            cached_results[_cache_key(track["name"], track["artist"])] = c
        else:
            to_analyze.append(track)

    if limit:
        to_analyze = to_analyze[:limit]

    # Download + analyze (thread pool handles concurrency, max 4 parallel)
    async def _do_one(track):
        fp = await _get_audio_file(track["id"], track["name"], track["artist"])
        if not fp:
            return
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, _analyze_or_read_tag, fp)
        result["name"] = track["name"]
        result["artist"] = track["artist"]
        key = _cache_key(track["name"], track["artist"])
        _bpm_cache[key] = result
        cached_results[key] = result

    await asyncio.gather(*[_do_one(t) for t in to_analyze], return_exceptions=True)
    _save_cache()

    results = []
    for track in pl["tracks"]:
        key = _cache_key(track["name"], track["artist"])
        if key in cached_results:
            results.append(cached_results[key])
    return results


def get_cached_bpm(name: str, artist: str) -> dict | None:
    return _bpm_cache.get(_cache_key(name, artist))


def get_all_cached() -> dict:
    return dict(_bpm_cache)


async def analyze_and_tag(file_path: str, name: str, artist: str) -> dict | None:
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(_executor, _analyze_or_read_tag, file_path)
    result["name"] = name
    result["artist"] = artist
    _bpm_cache[_cache_key(name, artist)] = result
    _save_cache()
    return result
