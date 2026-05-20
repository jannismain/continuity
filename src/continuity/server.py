"""FastAPI server: JSON state + Server-Sent-Event streams for each turn."""

from __future__ import annotations

import json
import time
import traceback
from pathlib import Path
from typing import AsyncIterator

from dotenv import load_dotenv

load_dotenv(Path.cwd() / ".env")

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import engine, prompts  # noqa: E402

STATIC = Path(__file__).parent / "static"
app = FastAPI(title="continuity.")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def sse(gen: AsyncIterator[dict]) -> StreamingResponse:
    async def body():
        try:
            async for ev in gen:
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as e:  # surface errors to the UI instead of a dead stream
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        yield 'data: {"type": "done"}\n\n'

    return StreamingResponse(
        body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


def _live(sid: str) -> engine.LiveSession:
    s = engine.LIVE.get(sid)
    if not s:
        raise HTTPException(404, "No such live session")
    s.last_active = time.monotonic()
    return s


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/state")
async def state():
    n = engine.next_number()
    return {
        "therapist": prompts.THERAPIST_NAME,
        "patient": prompts.PATIENT_NAME,
        "sessions": engine.past_sessions(),
        "memory": engine.memory.snapshot(),
        "next_number": n,
        "suggested_week": engine.suggested_week(n),
        "arc": [{"title": w["title"], "text": w["text"]} for w in prompts.STORY_ARC],
        "model": engine.MODEL,
    }


@app.post("/api/reset")
async def reset():
    engine.reset_all()
    return {"ok": True}


@app.post("/api/week/generate")
async def week_generate():
    return await engine.generate_week()


class StartReq(BaseModel):
    title: str
    experience: str


@app.post("/api/session/start")
async def session_start(req: StartReq):
    if not req.experience.strip():
        raise HTTPException(400, "Describe what happened this week.")
    try:
        s = engine.start_session(req.title.strip(), req.experience.strip())
    except engine.SessionBusy as e:
        raise HTTPException(409, str(e))
    return {"id": s.id, "number": s.number, "date": s.date, "title": s.title}


class TherapistReq(BaseModel):
    wrap_up: bool = False


@app.post("/api/session/{sid}/therapist")
async def therapist(sid: str, req: TherapistReq):
    return sse(engine.therapist_turn(_live(sid), wrap_up=req.wrap_up))


class PatientReq(BaseModel):
    text: str | None = None


@app.post("/api/session/{sid}/patient")
async def patient(sid: str, req: PatientReq):
    return sse(engine.patient_turn(_live(sid), manual_text=req.text))


@app.post("/api/session/{sid}/end")
async def end(sid: str):
    return sse(engine.end_session(_live(sid)))


def main() -> None:
    import uvicorn

    uvicorn.run("continuity.server:app", host="127.0.0.1", port=8765, reload=False)
