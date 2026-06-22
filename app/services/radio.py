"""Radio module: fetch similar tracks from Deezer, Last.fm, Spotify, or combined."""

import asyncio
import logging
import random

from app.services import bpm as bpm_service
from app.services import lastfm
from app.services import library
from app.services import search_providers
from app.services import spotify
from app.services import settings as app_settings

logger = logging.getLogger(__name__)


def _dedup(tracks: list[dict]) -> list[dict]:
    """Deduplicate tracks by normalized (name, artist)."""
    seen = set()
    result = []
    for t in tracks:
        key = (t.get("name", "").lower().strip(), t.get("artist", "").lower().strip())
        if key not in seen and key[0]:
            seen.add(key)
            result.append(t)
    return result


async def _resolve_lastfm_tracks(tracks: list[dict], provider: str, fallback: str) -> list[dict]:
    """Resolve Last.fm tracks via Deezer search to get cover art and IDs."""
    sem = asyncio.Semaphore(5)

    async def resolve_one(t: dict) -> dict | None:
        async with sem:
            try:
                result = await search_providers.resolve(
                    t["name"], t["artist"], "track", provider=provider, fallback=fallback
                )
                return result
            except Exception:
                return None

    results = await asyncio.gather(*[resolve_one(t) for t in tracks])
    return [r for r in results if r]


async def get_radio_tracks(
    source: str,
    track_name: str = "",
    artist_name: str = "",
    artist_id: str = "",
    limit: int = 25,
) -> list[dict]:
    """Get radio tracks based on source preference.

    source: 'deezer', 'lastfm', or 'combined'
    """
    if source == "deezer":
        return await _get_deezer_radio(artist_id, artist_name, limit)
    elif source == "lastfm":
        return await _get_lastfm_radio(track_name, artist_name, limit)
    else:  # combined
        return await _get_combined_radio(track_name, artist_name, artist_id, limit)


async def _get_deezer_radio(artist_id: str, artist_name: str, limit: int) -> list[dict]:
    """Get radio from Deezer artist radio endpoint."""
    if not artist_id and artist_name:
        # Resolve artist name to Deezer ID
        results = await search_providers.deezer_search(artist_name, "artist", 1)
        if results:
            artist_id = results[0].get("id", "")
    if not artist_id:
        return []
    try:
        tracks = await search_providers.deezer_artist_radio(artist_id)
        return tracks[:limit]
    except Exception as e:
        logger.warning(f"Deezer radio failed: {e}")
        return []


async def _get_lastfm_radio(track_name: str, artist_name: str, limit: int) -> list[dict]:
    """Get radio from Last.fm similar tracks."""
    if not track_name or not artist_name:
        return []
    if not lastfm.LASTFM_API_KEY:
        return []
    try:
        similar = await lastfm.get_similar_tracks(track_name, artist_name, limit)
        if not similar:
            # Fallback: get top tracks from similar artists
            sim_artists = await lastfm.get_similar_artists(artist_name, 5)
            for sa in sim_artists:
                top = await lastfm.get_artist_top_tracks(sa["name"], 5)
                similar.extend(top)
            similar = similar[:limit]
        # Resolve through configured search provider for cover art
        provider = app_settings._settings.get("search_provider", "deezer")
        fallback = app_settings._settings.get("search_fallback", "")
        resolved = await _resolve_lastfm_tracks(similar, provider, fallback)
        return resolved[:limit]
    except Exception as e:
        logger.warning(f"Last.fm radio failed: {e}")
        return []


async def _get_combined_radio(
    track_name: str, artist_name: str, artist_id: str, limit: int
) -> list[dict]:
    """Combined radio: mix Deezer + Last.fm results."""
    tasks = []
    tasks.append(_get_deezer_radio(artist_id, artist_name, limit))
    if track_name and artist_name and lastfm.LASTFM_API_KEY:
        tasks.append(_get_lastfm_radio(track_name, artist_name, limit))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_tracks = []
    for r in results:
        if isinstance(r, list):
            all_tracks.extend(r)

    deduped = _dedup(all_tracks)

    # Interleave: alternate between sources for variety
    if len(results) == 2 and isinstance(results[0], list) and isinstance(results[1], list):
        deezer_tracks = results[0]
        lastfm_tracks = results[1]
        interleaved = []
        i, j = 0, 0
        while i < len(deezer_tracks) or j < len(lastfm_tracks):
            if i < len(deezer_tracks):
                interleaved.append(deezer_tracks[i])
                i += 1
            if j < len(lastfm_tracks):
                interleaved.append(lastfm_tracks[j])
                j += 1
        deduped = _dedup(interleaved)

    return deduped[:limit]


def _norm_artist(a: str) -> str:
    return (a or "").split(",")[0].split("&")[0].split(" feat")[0].split(" Feat")[0].split(" ft.")[0].strip().lower()


_NAME_SUFFIX_RE = None  # lazy compile


def _norm_name(n: str) -> str:
    """Aggressive name normalization: strip remaster/live/feat/version suffixes,
    parenthesized/bracketed clauses, and collapse whitespace/punctuation."""
    global _NAME_SUFFIX_RE
    import re
    if _NAME_SUFFIX_RE is None:
        _NAME_SUFFIX_RE = re.compile(
            r"\s*[\(\[][^\)\]]*(remaster(ed)?|live|version|edit|mix|mono|stereo|deluxe|remix|acoustic|demo|bonus|feat\.?|with\s+|featuring)[^\)\]]*[\)\]]"
            r"|\s*-\s*(remaster(ed)?|live|version|edit|mix|mono|stereo|deluxe|remix|acoustic|demo|bonus).*$",
            re.IGNORECASE,
        )
    s = (n or "").strip()
    # Strip suffixes iteratively (handles "Song (Live) (Remastered 2009)")
    prev = None
    while prev != s:
        prev = s
        s = _NAME_SUFFIX_RE.sub("", s).strip()
    # Collapse non-alphanumeric to single space, lower
    s = re.sub(r"[^\w\s]+", " ", s).strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s


def _norm_key(t: dict) -> tuple[str, str]:
    return (_norm_name(t.get("name") or ""), _norm_artist(t.get("artist") or ""))


def _hash_playlist(tracks: list[dict]) -> str:
    import hashlib
    h = hashlib.md5()
    for t in tracks:
        n, a = _norm_key(t)
        h.update(f"{n}|{a}\n".encode("utf-8", errors="ignore"))
    return h.hexdigest()


# Profile cache: playlist_hash -> (timestamp, profile)
_profile_cache: dict[str, tuple[float, dict]] = {}
_profile_locks: dict[str, asyncio.Lock] = {}
_PROFILE_TTL = 600
_PROFILE_CACHE_MAX = 64
# Global semaphore to bound Last.fm concurrency (5 req/s soft limit)
_lastfm_sem = asyncio.Semaphore(5)


def _prune_profile_cache(now: float) -> None:
    if len(_profile_cache) <= _PROFILE_CACHE_MAX:
        # cheap TTL prune
        stale = [k for k, (ts, _) in _profile_cache.items() if now - ts >= _PROFILE_TTL]
        for k in stale:
            _profile_cache.pop(k, None)
            _profile_locks.pop(k, None)
        return
    # Over cap: drop oldest half
    items = sorted(_profile_cache.items(), key=lambda kv: kv[1][0])
    for k, _ in items[: len(items) // 2]:
        _profile_cache.pop(k, None)
        _profile_locks.pop(k, None)


async def _build_profile(tracks: list[dict]) -> dict:
    """Aggregate playlist into artist weights + tag centroid via Last.fm.
    Single-flight via per-key lock to avoid duplicate concurrent Last.fm work."""
    import time as _t
    key = _hash_playlist(tracks)
    now = _t.time()
    cached = _profile_cache.get(key)
    if cached and now - cached[0] < _PROFILE_TTL:
        return cached[1]
    lock = _profile_locks.setdefault(key, asyncio.Lock())
    async with lock:
        # Re-check after acquiring lock (another coroutine may have populated it)
        cached = _profile_cache.get(key)
        if cached and now - cached[0] < _PROFILE_TTL:
            return cached[1]
        return await _build_profile_uncached(tracks, key, now)


async def _build_profile_uncached(tracks: list[dict], key: str, now: float) -> dict:

    # Artist weights
    artist_weights: dict[str, float] = {}
    for t in tracks:
        a = _norm_artist(t.get("artist") or "")
        if not a:
            continue
        artist_weights[a] = artist_weights.get(a, 0) + 1.0
    total = sum(artist_weights.values()) or 1.0
    for a in artist_weights:
        artist_weights[a] /= total
    top_artists = sorted(artist_weights.items(), key=lambda kv: -kv[1])[:8]

    # Tag aggregation via Last.fm (top 5 artists; cheap-ish with cache)
    tags: dict[str, float] = {}
    if lastfm.LASTFM_API_KEY:
        async def _artist_tags(name: str, weight: float):
            async with _lastfm_sem:
                ts = await lastfm.get_artist_top_tags(name, limit=8)
                for ti, tag in enumerate(ts):
                    tname = tag["name"].lower().strip()
                    if not tname or tname in ("seen live", "favorites", "favourite"):
                        continue
                    # rank decay × artist weight × normalized count
                    score = (1.0 / (1 + ti)) * weight * (tag.get("count", 0) / 100 + 0.3)
                    tags[tname] = tags.get(tname, 0) + score

        await asyncio.gather(*[
            _artist_tags(name, w) for name, w in top_artists[:5]
        ], return_exceptions=True)

    top_tags = sorted(tags.items(), key=lambda kv: -kv[1])[:5]

    profile = {
        "artist_weights": artist_weights,
        "top_artists": top_artists,
        "tags": tags,
        "top_tags": top_tags,
    }
    _profile_cache[key] = (now, profile)
    _prune_profile_cache(now)
    return profile


# ── Persistent taste profile (Spotify → Navidrome → queue) ──────────
# Per-user cache: username -> (timestamp, taste_tracks)
_taste_cache: dict[str, tuple[float, list[dict]]] = {}
_taste_locks: dict[str, asyncio.Lock] = {}
_TASTE_TTL = 600  # 10 min, mirrors the profile cache


async def _gather_taste_tracks(user: dict | None) -> list[dict]:
    """Collect durable-taste tracks from Spotify, then Navidrome, gracefully.

    Fallback chain: Spotify (liked + top) → Navidrome (starred + top-played) → [].
    Each source failure degrades to []; absence of all sources = empty list, so
    the caller falls back to queue-only behavior (today's behavior)."""
    tracks: list[dict] = []

    # (a) Spotify: liked + me/top/tracks (needs per-user OAuth or global token)
    creds = None
    have_spotify = False
    if user is not None and spotify.SPOTIFY_CLIENT_ID:
        try:
            from app.dependencies import _user_spotify_creds
            creds = _user_spotify_creds(user)
            # creds is a dict (per-user) OR None with a global refresh token present
            have_spotify = bool(creds) or bool(spotify._get_global_refresh_token())
        except Exception:
            have_spotify = False

    if have_spotify:
        async def _liked():
            try:
                data = await spotify.get_liked_tracks(creds=creds)
                return (data or {}).get("tracks", [])[:50]
            except Exception as e:
                logger.warning("Taste: Spotify liked tracks failed: %s", e)
                return []

        async def _top():
            try:
                return await spotify.get_top_tracks("medium_term", 50, creds=creds)
            except Exception as e:
                logger.warning("Taste: Spotify top tracks failed: %s", e)
                return []

        sp_results = await asyncio.gather(_liked(), _top(), return_exceptions=True)
        for r in sp_results:
            if isinstance(r, list):
                tracks.extend(r)

    # (b) Navidrome: starred + top-played (always attempted; degrades to [])
    nav_results = await asyncio.gather(library.get_starred(), return_exceptions=True)
    for r in nav_results:
        if isinstance(r, list):
            tracks.extend(r)

    return _dedup(tracks)


async def _build_taste_profile(user: dict | None) -> dict | None:
    """Build a durable taste profile (artist weights + tag centroid) from Spotify
    likes/top + Navidrome starred. Cached per-user with a short TTL. Returns None
    when no durable-taste source is available (so caller stays queue-only)."""
    import time as _t
    uname = (user or {}).get("username", "_anon")
    now = _t.time()
    cached = _taste_cache.get(uname)
    if cached and now - cached[0] < _TASTE_TTL:
        taste_tracks = cached[1]
    else:
        lock = _taste_locks.setdefault(uname, asyncio.Lock())
        async with lock:
            cached = _taste_cache.get(uname)
            if cached and now - cached[0] < _TASTE_TTL:
                taste_tracks = cached[1]
            else:
                taste_tracks = await _gather_taste_tracks(user)
                _taste_cache[uname] = (now, taste_tracks)
                # cheap prune of stale entries
                for k in [k for k, (ts, _) in _taste_cache.items()
                          if now - ts >= _TASTE_TTL and k != uname]:
                    _taste_cache.pop(k, None)
                    _taste_locks.pop(k, None)

    if not taste_tracks:
        return None
    return await _build_profile(taste_tracks)


def _merge_profiles(queue_profile: dict, taste_profile: dict | None,
                    taste_weight: float = 0.6) -> dict:
    """Blend the current-queue profile with the durable taste profile.

    The queue stays the recency/context signal; taste adds durable direction.
    Returns a new profile dict with merged artist_weights / tags and recomputed
    top_artists / top_tags. When taste_profile is None, returns queue_profile."""
    if not taste_profile:
        return queue_profile

    def _blend(a: dict, b: dict, bw: float) -> dict:
        out = dict(a)
        for k, v in b.items():
            out[k] = out.get(k, 0.0) + v * bw
        return out

    artist_weights = _blend(queue_profile["artist_weights"],
                            taste_profile["artist_weights"], taste_weight)
    total = sum(artist_weights.values()) or 1.0
    artist_weights = {k: v / total for k, v in artist_weights.items()}
    top_artists = sorted(artist_weights.items(), key=lambda kv: -kv[1])[:8]

    tags = _blend(queue_profile["tags"], taste_profile["tags"], taste_weight)
    top_tags = sorted(tags.items(), key=lambda kv: -kv[1])[:5]

    return {
        "artist_weights": artist_weights,
        "top_artists": top_artists,
        "tags": tags,
        "top_tags": top_tags,
    }


def _weighted_sample_seeds(tracks: list[dict], profile: dict, k: int = 5) -> list[dict]:
    """Pick seeds weighted by artist frequency, with light shuffling."""
    if not tracks:
        return []
    weights = []
    for t in tracks:
        a = _norm_artist(t.get("artist") or "")
        w = profile["artist_weights"].get(a, 0.01)
        weights.append(w)
    # Weighted sampling without replacement
    pool = list(zip(tracks, weights))
    picked: list[dict] = []
    seen_artists: set[str] = set()
    while pool and len(picked) < k:
        total_w = sum(w for _, w in pool)
        if total_w <= 0:
            break
        r = random.uniform(0, total_w)
        acc = 0.0
        idx = len(pool) - 1  # fallback to last (avoids index-0 bias on tiny rounding)
        for i, (_, w) in enumerate(pool):
            acc += w
            if acc >= r:
                idx = i
                break
        track, _ = pool.pop(idx)
        a = _norm_artist(track.get("artist") or "")
        # Prefer artist diversity in seeds
        if a in seen_artists and len(pool) > 0:
            # 50% chance to skip a duplicate artist
            if random.random() < 0.5:
                continue
        seen_artists.add(a)
        picked.append(track)
    return picked


def _parse_camelot(code: str | None) -> tuple[int, str] | None:
    """Parse a Camelot code like '8A' into (number, letter)."""
    if not code or not isinstance(code, str):
        return None
    import re as _re
    m = _re.match(r"^(\d{1,2})([AB])$", code.strip(), _re.IGNORECASE)
    if not m:
        return None
    num = int(m.group(1))
    if num < 1 or num > 12:
        return None
    return num, m.group(2).upper()


def _camelot_bonus(seed_camelot: str | None, cand_camelot: str | None) -> float:
    """Harmonic-key bonus mirroring djmix.getTransitionStyle: same/relative key →
    'blend' (best), ±1/±2 on the wheel (same letter) → 'bass_swap', else neutral."""
    a = _parse_camelot(seed_camelot)
    b = _parse_camelot(cand_camelot)
    if not a or not b:
        return 0.0
    # same key or relative major/minor (same number)
    if a[0] == b[0]:
        return 3.0
    if a[1] == b[1]:
        diff = abs(a[0] - b[0])
        dist = min(diff, 12 - diff)
        if dist <= 2:
            return 1.0
    return 0.0


def _seed_tempo_context(seeds: list[dict]) -> tuple[float | None, str | None]:
    """Derive a coherent BPM (median) + dominant Camelot key from seeds, using the
    bpm cache. Only locally-analyzed tracks have BPM; returns (None, None) when no
    seed has known tempo (→ no tempo penalty/bonus applied)."""
    import numpy as _np
    bpms: list[float] = []
    camelots: list[str] = []
    for s in seeds:
        c = bpm_service.get_cached_bpm(s.get("name", ""), s.get("artist", ""))
        if not c:
            continue
        b = c.get("bpm")
        if b and b > 0 and (c.get("confidence") or 0) >= 0.5:
            bpms.append(float(b))
        if c.get("camelot"):
            camelots.append(c["camelot"])
    if not bpms:
        return None, None
    seed_bpm = float(_np.median(bpms))
    # Only treat the key as coherent if the seeds largely agree on it.
    seed_camelot = None
    if camelots:
        top = max(set(camelots), key=camelots.count)
        if camelots.count(top) >= max(1, len(camelots) // 2):
            seed_camelot = top
    return seed_bpm, seed_camelot


def _tempo_coherence_score(track: dict, seed_bpm: float, seed_camelot: str | None) -> float:
    """Confidence-aware tempo/key term (DJ context). Penalizes candidates whose
    BPM falls outside a ±8 band, bonuses harmonic-key matches. Candidate BPM is
    only known for locally-analyzed tracks → no penalty when unknown."""
    BAND = 8.0
    c = bpm_service.get_cached_bpm(track.get("name", ""), track.get("artist", ""))
    if not c:
        return 0.0  # unknown BPM → degrade gracefully, no penalty
    cand_bpm = c.get("bpm")
    conf = c.get("confidence") or 0.3
    if not cand_bpm or cand_bpm <= 0 or conf < 0.5:
        return 0.0  # untrusted BPM → treat as unknown
    score = 0.0
    delta = abs(float(cand_bpm) - seed_bpm)
    if delta <= BAND:
        # In-band: small reward scaled by how tight the match is.
        score += 2.0 * (1.0 - delta / BAND)
    else:
        # Out-of-band: penalty grows with distance, capped.
        score -= min(4.0, (delta - BAND) / BAND * 2.0)
    score += _camelot_bonus(seed_camelot, c.get("camelot"))
    return score


async def get_playlist_recommendations(
    tracks: list[dict],
    source: str = "combined",
    limit: int = 20,
    exclude: list[dict] | None = None,
    skipped: list[dict] | None = None,
    accepted: list[dict] | None = None,
    user: dict | None = None,
    tempo_coherent: bool = False,
) -> list[dict]:
    """Profile-driven recommendations.

    1. Build playlist profile (artist weights + Last.fm tag centroid), blended
       with a durable per-user taste profile (Spotify likes/top + Navidrome starred)
    2. Weighted seed selection
    3. Multi-source recall: per-artist radio, per-tag tracks, similar-artists,
       per-track similar, Navidrome similar (library-grounded)
    4. Score+rerank by tag overlap, multi-source agreement, library bonus,
       optional tempo coherence, feedback
    5. Diversify (max 2 per artist)
    """
    if not tracks:
        return []

    queue_profile = await _build_profile(tracks)
    taste_profile = await _build_taste_profile(user)
    profile = _merge_profiles(queue_profile, taste_profile)
    seeds = _weighted_sample_seeds(tracks, profile, k=5)

    playlist_artists = set(profile["artist_weights"].keys())
    skipped_artists = {_norm_artist(t.get("artist") or "") for t in (skipped or [])}
    skipped_keys = {_norm_key(t) for t in (skipped or [])}
    accepted_artists = {_norm_artist(t.get("artist") or "") for t in (accepted or [])}
    top_tag_names = {t[0] for t in profile["top_tags"]}

    provider = app_settings._settings.get("search_provider", "deezer")
    fallback = app_settings._settings.get("search_fallback", "")

    # ── Candidate recall (parallel) ────────────────────────────────
    tasks: list = []
    source_map: list[str] = []  # parallel list: which source each task belongs to

    # A) per-seed radio (existing combined radio)
    for seed in seeds[:3]:
        tasks.append(get_radio_tracks(
            source if source != "spotify" else "combined",
            seed.get("name", ""),
            _norm_artist(seed.get("artist") or ""),
            seed.get("id", ""),
            limit=10,
        ))
        source_map.append("seed_radio")

    # B) per-top-artist radio for variety
    for name, _w in profile["top_artists"][:3]:
        tasks.append(_get_deezer_radio("", name, 10))
        source_map.append("artist_radio")

    # C) per-tag top tracks (centroid)
    if lastfm.LASTFM_API_KEY:
        for tname, _score in profile["top_tags"][:3]:
            async def _tag_resolve(tn=tname):
                raw = await lastfm.get_tag_tracks(tn, limit=15, page=1)
                return await _resolve_lastfm_tracks(raw, provider, fallback)
            tasks.append(_tag_resolve())
            source_map.append("tag")

    # D) similar-artists chain for top artist
    if lastfm.LASTFM_API_KEY and profile["top_artists"]:
        top_name = profile["top_artists"][0][0]
        async def _sim_artists_chain(name=top_name):
            sim = await lastfm.get_similar_artists(name, 6)
            sub = await asyncio.gather(*[
                lastfm.get_artist_top_tracks(s["name"], 3) for s in sim[:6]
            ], return_exceptions=True)
            collected = []
            for r in sub:
                if isinstance(r, list):
                    collected.extend(r)
            return await _resolve_lastfm_tracks(collected, provider, fallback)
        tasks.append(_sim_artists_chain())
        source_map.append("similar_artists")

    # E) Spotify recommendations (best-effort; may 404 for new apps post-Nov 2024)
    if spotify.SPOTIFY_CLIENT_ID:
        tasks.append(_get_spotify_playlist_recs(seeds, limit=15))
        source_map.append("spotify")

    # F) Navidrome similar songs per seed (library-grounded recall; degrades to [])
    if library.NAVIDROME_PASSWORD:
        for seed in seeds[:3]:
            tasks.append(library.get_similar_songs(
                _norm_artist(seed.get("artist") or ""),
                seed.get("name", ""),
                count=15,
            ))
            source_map.append("navidrome")

    results = await asyncio.gather(*tasks, return_exceptions=True)

    # ── Aggregate candidates with source tracking ──────────────────
    # candidate_key -> {"track": dict, "sources": set, "lastfm_match": float}
    candidates: dict[tuple[str, str], dict] = {}
    for src, res in zip(source_map, results):
        if not isinstance(res, list):
            continue
        for t in res:
            k = _norm_key(t)
            if not k[0]:
                continue
            entry = candidates.get(k)
            if entry is None:
                entry = {"track": t, "sources": set(), "match": 0.0}
                candidates[k] = entry
            entry["sources"].add(src)
            m = float(t.get("match") or 0)
            if m > entry["match"]:
                entry["match"] = m

    # ── Exclude already-in-playlist + skipped ──────────────────────
    exclude_keys = {_norm_key(t) for t in (exclude or [])}
    exclude_keys |= skipped_keys

    # ── Tempo context for DJ-style coherence (gated by tempo_coherent) ──
    seed_bpm, seed_camelot = (_seed_tempo_context(seeds) if tempo_coherent else (None, None))

    # ── Score candidates ───────────────────────────────────────────
    scored: list[tuple[float, dict]] = []

    async def _score_one(key: tuple[str, str], entry: dict):
        if key in exclude_keys:
            return
        track = entry["track"]
        artist_n = _norm_artist(track.get("artist") or "")
        score = 0.0
        # Multi-source agreement (strongest signal)
        score += len(entry["sources"]) * 2.0
        # Last.fm direct similarity score
        score += entry["match"] * 3.0
        # Tag overlap with playlist centroid (needs Last.fm lookup; gated)
        if top_tag_names and lastfm.LASTFM_API_KEY and len(entry["sources"]) >= 1:
            async with _lastfm_sem:
                cand_tags = await lastfm.get_artist_top_tags(artist_n, limit=6)
            cand_tag_set = {ct["name"].lower().strip() for ct in cand_tags}
            overlap = len(cand_tag_set & top_tag_names)
            score += overlap * 1.5
        # Slight bonus if artist already in playlist (familiar) but not too strong
        if artist_n in playlist_artists:
            score += 0.5
        # Library-grounded bonus: tracks Navidrome surfaced as similar are "in your library"
        if "navidrome" in entry["sources"]:
            score += 1.5
        # Tempo coherence (DJ context only): confidence-aware, degrades when BPM unknown
        if seed_bpm is not None:
            score += _tempo_coherence_score(track, seed_bpm, seed_camelot)
        # Penalty for skipped artists
        if artist_n in skipped_artists:
            score -= 4.0
        # Boost for accepted artists (user-confirmed direction)
        if artist_n in accepted_artists:
            score += 2.0
        scored.append((score, track))

    await asyncio.gather(*[_score_one(k, v) for k, v in candidates.items()])

    scored.sort(key=lambda x: -x[0])

    # ── Diversify: max 2 per artist ────────────────────────────────
    per_artist: dict[str, int] = {}
    final: list[dict] = []
    for _s, t in scored:
        a = _norm_artist(t.get("artist") or "")
        if per_artist.get(a, 0) >= 2:
            continue
        per_artist[a] = per_artist.get(a, 0) + 1
        final.append(t)
        if len(final) >= limit:
            break

    return final


async def _get_spotify_playlist_recs(seeds: list[dict], limit: int = 15) -> list[dict]:
    """Get Spotify recommendations by resolving seed tracks to Spotify IDs."""
    sem = asyncio.Semaphore(3)

    async def resolve_id(track: dict) -> str | None:
        async with sem:
            try:
                result = await spotify.resolve_url(track.get("name", ""), track.get("artist", ""), "track")
                return result.get("id") if result else None
            except Exception:
                return None

    ids = await asyncio.gather(*[resolve_id(s) for s in seeds[:5]])
    track_ids = [i for i in ids if i]

    if not track_ids:
        return []

    return await spotify.get_recommendations(seed_tracks=track_ids, limit=limit)
