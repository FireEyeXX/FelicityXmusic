from fastapi import APIRouter, HTTPException, Depends

from app.services import auth
from app.services import recognize_history as rh

router = APIRouter(prefix="/api/recognize", tags=["recognize"])


@router.get("/history")
async def get_history(user: dict = Depends(auth.get_current_user)):
    items = rh.get_history(user["username"])
    return {"items": items}


@router.delete("/history")
async def clear_history(user: dict = Depends(auth.get_current_user)):
    rh.clear_history(user["username"])
    return {"status": "cleared"}


@router.delete("/history/{ts}")
async def remove_history_entry(ts: float, user: dict = Depends(auth.get_current_user)):
    if not rh.remove_entry(user["username"], ts):
        raise HTTPException(404, "Entry not found")
    return {"status": "removed"}
