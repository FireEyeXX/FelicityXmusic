from fastapi import APIRouter, HTTPException, Depends, Request

import asyncio
import json
import os
import threading
import time

from pydantic import BaseModel

from app.models import CreatePlaylistRequest, AddTracksByIdRequest, RemoveTracksRequest, AddTrackByNameRequest, DeleteAlbumRequest, LikeRequest
from app.services import auth, library, downloader, player
from app.services.jobs import create_job
from app.dependencies import _get_device_id
from fastapi.responses import Response


class ReplaceByNameRequest(BaseModel):
    tracks: list[dict]


class BatchAddRequest(BaseModel):
    tracks: list[dict]


router = APIRouter(prefix="/api/library", tags=["library"])


# ── Server-side liked set (per-user, persisted JSON; mirrors users/settings) ──
DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
LIKES_FILE = os.path.join(DATA_DIR, "likes.json")
_likes_lock = threading.Lock()


def _like_key(req: LikeRequest) -> str:
    """Stable per-track key: by id when present, else lowercased 'artist:name'."""
    if req.id:
        return req.id
    return f"{(req.artist or '').lower().strip()}:{(req.name or '').lower().strip()}"


def _load_likes() -> dict:
    """Load the per-user liked map: {username: {key: track_dict}}."""
    if os.path.exists(LIKES_FILE):
        try:
            with open(LIKES_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_likes(data: dict):
    # Atomic write: a crash mid-dump would otherwise truncate likes.json and
    # _load_likes() would silently drop ALL users' likes. Write a temp file in the
    # same dir, then os.replace() (atomic on the same filesystem).
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = LIKES_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, LIKES_FILE)


async def _playlists_containing(playlists: list, name: str, artist: str) -> list:
    """Return [{id, name}] for playlists that contain the given track.

    Fetches playlist details with bounded concurrency (avoids serial N+1
    Navidrome round-trips on large libraries while capping parallel load).
    """
    sem = asyncio.Semaphore(8)

    async def _check(pl: dict):
        async with sem:
            detail = await library.get_playlist(pl["id"])
        if not detail:
            return None
        for t in detail["tracks"]:
            if library._matches(t.get("name", ""), name) and library._artist_matches(t.get("artist", ""), artist):
                return {"id": pl["id"], "name": pl["name"]}
        return None

    results = await asyncio.gather(*[_check(pl) for pl in playlists])
    return [r for r in results if r]


@router.get("/cover/{cover_id}")
async def get_cover_art(cover_id: str):
    data = await library.get_cover_art(cover_id)
    if not data:
        raise HTTPException(404, "Cover art not found")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/playlists")
async def get_playlists(user: dict = Depends(auth.get_current_user)):
    playlists = await library.get_playlists()
    # Hide internal temp playlists (Up Next + Radio) from the library UI
    playlists = [p for p in playlists if not library.is_temp_playlist_name(p.get("name", ""))]
    return {"playlists": playlists}


@router.get("/upnext")
async def get_upnext(request: Request, user: dict = Depends(auth.get_current_user)):
    """Idempotently fetch (or create) the Up Next temp playlist for this user+device."""
    device_id = _get_device_id(request)
    pl = await library.get_or_create_upnext(user["username"], device_id)
    if not pl:
        raise HTTPException(503, "Navidrome unavailable")
    return pl


@router.get("/radio")
async def get_radio_playlist(request: Request, user: dict = Depends(auth.get_current_user)):
    """Idempotently fetch (or create) the Radio temp playlist for this user+device."""
    device_id = _get_device_id(request)
    pl = await library.get_or_create_radio(user["username"], device_id)
    if not pl:
        raise HTTPException(503, "Navidrome unavailable")
    return pl


@router.post("/playlist/{playlist_id}/replace-by-name")
async def replace_playlist_by_name(playlist_id: str, req: ReplaceByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Atomically replace a playlist's tracks by name/artist matching."""
    result = await library.replace_playlist_by_names(playlist_id, req.tracks)
    return result


@router.get("/playlist/{playlist_id}")
async def get_playlist(playlist_id: str, user: dict = Depends(auth.get_current_user)):
    pl = await library.get_playlist(playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")
    return pl


@router.post("/playlist")
async def create_playlist(req: CreatePlaylistRequest, user: dict = Depends(auth.get_current_user)):
    ok = await library.create_playlist(req.name, [])
    if not ok:
        raise HTTPException(500, "Failed to create playlist")
    return {"status": "created"}


@router.put("/playlist/{playlist_id}/tracks")
async def add_tracks_to_playlist(playlist_id: str, req: AddTracksByIdRequest, user: dict = Depends(auth.get_current_user)):
    ok = await library.update_playlist(playlist_id, song_ids_to_add=req.song_ids)
    if not ok:
        raise HTTPException(500, "Failed to add tracks")
    return {"status": "ok"}


@router.post("/playlist/{playlist_id}/add-by-name")
async def add_track_by_name(playlist_id: str, req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    song_id = await library.find_song_id(req.name, req.artist, req.album)
    if not song_id:
        raise HTTPException(404, "Track not found in Navidrome library")
    ok = await library.update_playlist(playlist_id, song_ids_to_add=[song_id])
    if not ok:
        raise HTTPException(500, "Failed to add track")
    return {"status": "ok", "song_id": song_id}


@router.delete("/playlist/{playlist_id}/tracks")
async def remove_tracks_from_playlist(playlist_id: str, req: RemoveTracksRequest, user: dict = Depends(auth.get_current_user)):
    ok = await library.update_playlist(playlist_id, song_indices_to_remove=req.indices)
    if not ok:
        raise HTTPException(500, "Failed to remove tracks")
    return {"status": "ok"}


@router.put("/playlist/{playlist_id}/rename")
async def rename_playlist(playlist_id: str, req: CreatePlaylistRequest, user: dict = Depends(auth.get_current_user)):
    """Rename a playlist."""
    ok = await library.rename_playlist(playlist_id, req.name)
    if not ok:
        raise HTTPException(500, "Failed to rename playlist")
    return {"status": "ok"}


@router.put("/playlist/{playlist_id}/reorder")
async def reorder_playlist(playlist_id: str, req: AddTracksByIdRequest, user: dict = Depends(auth.get_current_user)):
    """Reorder playlist tracks. Receives full ordered list of song_ids."""
    ok = await library.reorder_playlist(playlist_id, req.song_ids)
    if not ok:
        raise HTTPException(500, "Failed to reorder playlist")
    return {"status": "ok"}


@router.post("/playlist/{playlist_id}/remove-by-name")
async def remove_track_by_name(playlist_id: str, req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Remove a track from playlist by name/artist match."""
    ok = await library.remove_track_by_name(playlist_id, req.name, req.artist)
    if not ok:
        raise HTTPException(404, "Track not found in playlist")
    return {"status": "removed"}


@router.post("/playlist/{playlist_id}/add-and-download")
async def add_and_download(playlist_id: str, req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Add track to playlist. If not in Navidrome, download first then add."""
    # Try to find in Navidrome first
    song_id = await library.find_song_id(req.name, req.artist, req.album)
    if song_id:
        ok = await library.update_playlist(playlist_id, song_ids_to_add=[song_id])
        if not ok:
            raise HTTPException(500, "Failed to add track to playlist")
        return {"status": "added"}

    # Not in library — start download with playlist_id callback
    from app.services import settings as app_settings
    fmt = app_settings._settings.get("default_format", "flac")
    method = app_settings._settings.get("default_method", "yt-dlp")
    title = f"{req.artist} - {req.name}" if req.artist else req.name
    job = create_job(
        type_="track", title=title, url="", method=method, fmt=fmt,
        playlist_id=playlist_id,
        playlist_tracks=[{"name": req.name, "artist": req.artist, "album": req.album}],
        username=user["username"],
    )
    asyncio.create_task(downloader.run_download(job))
    return {"status": "downloading", "job_id": job.id}


@router.post("/playlist/{playlist_id}/add-and-download-batch")
async def add_and_download_batch(playlist_id: str, req: BatchAddRequest, user: dict = Depends(auth.get_current_user)):
    """Add a batch of tracks to a playlist in one call.

    Resolves Navidrome song IDs in parallel; adds matched IDs in batches;
    creates a download job per missing track (with playlist_id callback so the
    track lands in the playlist after the download completes).
    """
    tracks = req.tracks or []
    if not tracks:
        return {"added": 0, "queued": 0, "missing": []}

    sem = asyncio.Semaphore(6)

    async def _resolve(t: dict):
        async with sem:
            sid = await library.find_song_id(t.get("name", ""), t.get("artist", ""), t.get("album", ""))
            return (t, sid)

    pairs = await asyncio.gather(*[_resolve(t) for t in tracks])
    song_ids = [sid for _, sid in pairs if sid]
    missing = [t for t, sid in pairs if not sid]

    added = 0
    if song_ids:
        ok = await library.update_playlist(playlist_id, song_ids_to_add=song_ids)
        if ok:
            added = len(song_ids)

    queued = 0
    if missing:
        from app.services import settings as app_settings
        fmt = app_settings._settings.get("default_format", "flac")
        method = app_settings._settings.get("default_method", "yt-dlp")
        for t in missing:
            title = f"{t.get('artist','')} - {t.get('name','')}".strip(" -")
            job = create_job(
                type_="track", title=title, url="", method=method, fmt=fmt,
                playlist_id=playlist_id,
                playlist_tracks=[{"name": t.get("name", ""), "artist": t.get("artist", ""), "album": t.get("album", "")}],
                username=user["username"],
            )
            asyncio.create_task(downloader.run_download(job))
            queued += 1

    return {"added": added, "queued": queued, "missing": missing}


@router.post("/track/delete")
async def delete_track(req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Delete a track file from disk. Returns playlists it belongs to for confirmation."""
    # Check which playlists contain this track (bounded parallel fetches)
    playlists = await library.get_playlists()
    in_playlists = await _playlists_containing(playlists, req.name, req.artist)

    # Delete the file
    ok = player.delete_track_file(req.name, req.artist)
    if not ok:
        raise HTTPException(404, "Track file not found")

    # Trigger Navidrome scan to update index
    await downloader._trigger_navidrome_scan()

    return {"status": "deleted", "in_playlists": in_playlists}


@router.post("/album/delete")
async def delete_album(req: DeleteAlbumRequest, user: dict = Depends(auth.get_current_user)):
    """Delete all files for an album from disk."""
    deleted = player.delete_album_files(req.artist, req.album)
    if deleted == 0:
        raise HTTPException(404, "Album files not found")
    await downloader._trigger_navidrome_scan()
    return {"status": "deleted", "files_removed": deleted}


@router.post("/track/check-playlists")
async def check_track_playlists(req: AddTrackByNameRequest, user: dict = Depends(auth.get_current_user)):
    """Check which playlists contain a track (for delete confirmation)."""
    playlists = await library.get_playlists()
    in_playlists = await _playlists_containing(playlists, req.name, req.artist)
    has_file = player.find_track_file(req.name, req.artist) is not None
    return {"has_file": has_file, "in_playlists": in_playlists}


@router.delete("/playlist/{playlist_id}")
async def delete_playlist(playlist_id: str, user: dict = Depends(auth.get_current_user)):
    ok = await library.delete_playlist(playlist_id)
    if not ok:
        raise HTTPException(500, "Failed to delete playlist")
    return {"status": "deleted"}


@router.post("/like")
async def like_track(req: LikeRequest, user: dict = Depends(auth.get_current_user)):
    """Like a track: star in Navidrome if it resolves locally, AND always record
    in the server-side liked set (likes.json). Robust when Navidrome is down."""
    # Star in Navidrome (best-effort)
    song_id = req.id
    if not song_id:
        try:
            song_id = await library.find_song_id(req.name, req.artist, req.album)
        except Exception:
            song_id = None
    if song_id:
        try:
            await library.star_song(song_id)
        except Exception:
            pass

    # Always persist to liked.json (per-user)
    key = _like_key(req)
    with _likes_lock:
        likes = _load_likes()
        user_likes = likes.setdefault(user["username"], {})
        user_likes[key] = {
            "name": req.name,
            "artist": req.artist,
            "album": req.album,
            "id": song_id or req.id,
            "image": req.image,
            "ts": int(time.time()),
        }
        _save_likes(likes)
    return {"liked": True}


@router.post("/unlike")
async def unlike_track(req: LikeRequest, user: dict = Depends(auth.get_current_user)):
    """Unlike a track: unstar in Navidrome if local, AND remove from liked.json."""
    song_id = req.id
    if not song_id:
        try:
            song_id = await library.find_song_id(req.name, req.artist, req.album)
        except Exception:
            song_id = None
    if song_id:
        try:
            await library.unstar_song(song_id)
        except Exception:
            pass

    key = _like_key(req)
    with _likes_lock:
        likes = _load_likes()
        user_likes = likes.get(user["username"], {})
        # Remove by computed key and also by resolved song_id (in case it was stored differently)
        user_likes.pop(key, None)
        if song_id:
            user_likes.pop(song_id, None)
        likes[user["username"]] = user_likes
        _save_likes(likes)
    return {"liked": False}


@router.get("/likes")
async def get_likes(user: dict = Depends(auth.get_current_user)):
    """Return the merged liked list: Navidrome getStarred2 ∪ local likes.json,
    newest first. Robust when Navidrome is unreachable (local-only fallback)."""
    merged: dict[str, dict] = {}

    # Local liked set (carries ts for ordering)
    with _likes_lock:
        likes = _load_likes()
    user_likes = likes.get(user["username"], {})
    for key, t in user_likes.items():
        merged[key] = {
            "name": t.get("name", ""),
            "artist": t.get("artist", ""),
            "album": t.get("album", ""),
            "id": t.get("id", ""),
            "image": t.get("image", ""),
            "ts": t.get("ts", 0),
            "type": "track",
        }

    # Navidrome starred (best-effort; degrades to local-only)
    try:
        starred = await library.get_starred()
    except Exception:
        starred = []
    for s in starred:
        sid = s.get("id", "")
        key = sid or f"{(s.get('artist') or '').lower().strip()}:{(s.get('name') or '').lower().strip()}"
        if key in merged:
            # Prefer Navidrome image/id but keep local ts for ordering
            ts = merged[key].get("ts", 0)
            merged[key] = {**s, "ts": ts}
        else:
            merged[key] = {**s, "ts": 0}

    items = sorted(merged.values(), key=lambda x: x.get("ts", 0), reverse=True)
    for it in items:
        it.pop("ts", None)
    return {"tracks": items}
