import asyncio
import time

from app.services import auth

# In-memory, single-process broker for device→device remote control.
# Consistent with the in-memory DLNA session state — the app runs as one
# uvicorn worker in one container.

# {username: {device_id: [asyncio.Queue, ...]}}  — a device may have multiple open tabs
_listeners: dict[str, dict[str, list[asyncio.Queue]]] = {}
# {username: {device_id: state_dict}}
_states: dict[str, dict[str, dict]] = {}

_QUEUE_MAXSIZE = 256          # bound per-connection memory if a consumer stalls
_MAX_QUEUES_PER_DEVICE = 8    # cap concurrent SSE connections per device
_STATE_TTL = 3600.0          # evict device states not refreshed within this window


def register_listener(username: str, device_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    queues = _listeners.setdefault(username, {}).setdefault(device_id, [])
    # Evict the oldest connection past the cap; its generator self-cleans on next write.
    while len(queues) >= _MAX_QUEUES_PER_DEVICE:
        queues.pop(0)
    queues.append(q)
    _broadcast_devices(username)
    return q


def unregister_listener(username: str, device_id: str, q: asyncio.Queue):
    user_listeners = _listeners.get(username)
    if not user_listeners:
        return
    queues = user_listeners.get(device_id)
    if not queues:
        return
    if q in queues:
        queues.remove(q)
    if not queues:
        user_listeners.pop(device_id, None)
    if not user_listeners:
        _listeners.pop(username, None)
    _broadcast_devices(username)


def is_online(username: str, device_id: str) -> bool:
    return bool(_listeners.get(username, {}).get(device_id))


def _push(q: asyncio.Queue, event: str, data: dict):
    try:
        q.put_nowait({"event": event, "data": data})
    except Exception:
        pass


def send_command(username: str, device_id: str, action: str, value=None) -> bool:
    if not is_online(username, device_id):
        return False
    for q in _listeners.get(username, {}).get(device_id, []):
        _push(q, "command", {"action": action, "value": value})
    return True


def update_state(username: str, device_id: str, state: dict):
    now = time.time()
    state["updated_at"] = now
    user_states = _states.setdefault(username, {})
    # Evict stale entries so ghost devices don't accumulate forever.
    for did in [d for d, s in user_states.items() if now - s.get("updated_at", 0.0) > _STATE_TTL]:
        user_states.pop(did, None)
    user_states[device_id] = state
    _broadcast_devices(username)


def _broadcast_devices(username: str):
    devices = snapshot(username)
    for queues in _listeners.get(username, {}).values():
        for q in queues:
            _push(q, "devices", {"devices": devices})


def snapshot(username: str) -> dict:
    registered = auth.get_user_devices(username)
    device_ids = set(registered.keys())
    device_ids |= set(_states.get(username, {}).keys())
    device_ids |= set(_listeners.get(username, {}).keys())

    result: dict = {}
    for device_id in device_ids:
        state = _states.get(username, {}).get(device_id, {})
        result[device_id] = {
            "name": registered.get(device_id, {}).get("name", ""),
            "online": is_online(username, device_id),
            "playing": state.get("playing", False),
            "track": state.get("track", None),
            "position_seconds": state.get("position_seconds", 0.0),
            "volume": state.get("volume", 1.0),
            "updated_at": state.get("updated_at", 0.0),
        }
    return result
