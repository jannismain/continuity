"""Two-agent therapy simulation on the Claude Messages API.

- The therapist agent has the Memory tool and an append-only conversation.
- The patient agent role-plays Jonas with a private "what happened this week".
- After the session, the therapist curates her own memory, then a supervisor
  call produces a structured assessment (sentiment, depression risk, ADHD
  indicators, safety, interventions).

Every public coroutine here is an async generator of UI events (dicts).
"""

from __future__ import annotations

import datetime as dt
import difflib
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

import anthropic

from . import prompts
from .assessment import SessionAssessment
from .memory_store import MemoryStore

MODEL = os.environ.get("THERAPY_MODEL", "claude-opus-5-5")
PATIENT_MODEL = os.environ.get("PATIENT_MODEL", MODEL)
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FIRST_SESSION_DATE = dt.date(2026, 10, 7)

DATA = Path(os.environ.get("THERAPY_DATA_DIR", Path.cwd() / "data"))
SESSIONS_DIR = DATA / "sessions"

client = anthropic.AsyncAnthropic()
memory = MemoryStore(DATA / "memories")
MEMORY_TOOL = {"type": "memory_20250818", "name": "memory"}


def _block_dicts(content) -> list[dict]:
    # Append the assistant's content unchanged (thinking blocks included).
    return [b.to_dict() for b in content]


@dataclass
class LiveSession:
    id: str
    number: int
    title: str
    experience: str
    date: str
    therapist_msgs: list = field(default_factory=list)
    patient_msgs: list = field(default_factory=list)
    transcript: list = field(default_factory=list)  # {speaker, text}
    memory_ops: list = field(default_factory=list)
    memory_before: dict = field(default_factory=dict)
    patient_system: str = ""
    ended: bool = False
    last_active: float = field(default_factory=time.monotonic)


LIVE: dict[str, LiveSession] = {}


# ---------------------------------------------------------------- persistence
def past_sessions() -> list[dict]:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(SESSIONS_DIR.glob("session_*.json"), key=lambda p: int(p.stem.split("_")[1])):
        out.append(json.loads(p.read_text()))
    return out


def next_number() -> int:
    return len(past_sessions()) + 1


def reset_all() -> None:
    memory.clear()
    for p in SESSIONS_DIR.glob("session_*.json"):
        p.unlink()
    LIVE.clear()


def suggested_week(number: int) -> dict:
    if number <= len(prompts.STORY_ARC):
        w = prompts.STORY_ARC[number - 1]
        return {"title": w["title"], "text": w["text"], "source": "arc"}
    return {"title": "", "text": "", "source": "custom"}


async def generate_week() -> dict:
    prev = "\n".join(f"- {s['title']}: {s['experience']}" for s in past_sessions()) or "(none yet)"
    resp = await client.beta.messages.create(
        model=PATIENT_MODEL,
        max_tokens=4000,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        output_config={
            "effort": "low",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {"title": {"type": "string"}, "text": {"type": "string"}},
                    "required": ["title", "text"],
                    "additionalProperties": False,
                },
            },
        },
        messages=[{"role": "user", "content": prompts.GENERATE_WEEK_PROMPT.format(previous=prev)}],
    )
    text = next(b.text for b in resp.content if b.type == "text")
    data = json.loads(text)
    return {"title": data["title"], "text": data["text"], "source": "generated"}


# ---------------------------------------------------------------- session
class SessionBusy(Exception):
    pass


def start_session(title: str, experience: str, force: bool = False) -> LiveSession:
    # One story, one memory: refuse to interleave two sessions unless the
    # other one has gone quiet (e.g. its browser tab was closed).
    for other in LIVE.values():
        if not force and time.monotonic() - other.last_active < 180:
            raise SessionBusy(f"Session {other.number} is still running in another window.")
    n = next_number()
    past = [
        {"number": s["number"], "title": s["title"], "homework": (s.get("assessment") or {}).get("homework")}
        for s in past_sessions()
    ]
    s = LiveSession(
        id=uuid.uuid4().hex[:10],
        number=n,
        title=title or f"Week {n}",
        experience=experience,
        date=(FIRST_SESSION_DATE + dt.timedelta(days=7 * (n - 1))).isoformat(),
        memory_before=memory.snapshot(),
    )
    s.patient_system = prompts.PATIENT_SYSTEM + prompts.patient_context(n, s.title, experience, past)
    LIVE.clear()
    LIVE[s.id] = s
    return s


async def _therapist_loop(s: LiveSession, user_content: str, effort: str, speak: bool) -> AsyncIterator[dict]:
    """Run the therapist until she stops calling tools. Streams text + memory ops."""
    s.therapist_msgs.append({"role": "user", "content": user_content})
    spoken = []
    for _ in range(12):  # tool-loop guard
        async with client.beta.messages.stream(
            model=MODEL,
            max_tokens=16000,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            system=prompts.THERAPIST_SYSTEM,
            cache_control={"type": "ephemeral"},
            tools=[MEMORY_TOOL],
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": effort},
            messages=s.therapist_msgs,
        ) as stream:
            async for ev in stream:
                if ev.type == "content_block_delta":
                    d = ev.delta
                    if d.type == "text_delta" and d.text:
                        spoken.append(d.text)
                        yield {"type": "text" if speak else "note", "delta": d.text}
                    elif d.type == "thinking_delta" and d.thinking:
                        yield {"type": "thinking", "delta": d.thinking}
            msg = await stream.get_final_message()

        s.therapist_msgs.append({"role": "assistant", "content": _block_dicts(msg.content)})
        if msg.stop_reason == "refusal":
            yield {"type": "error", "message": "The model declined this turn."}
            return

        tool_uses = [b for b in msg.content if b.type == "tool_use"]
        if not tool_uses:
            break
        results = []
        for tu in tool_uses:
            cmd = dict(tu.input)
            before = memory.snapshot()
            out = memory.execute(cmd)
            path = cmd.get("path") or cmd.get("old_path") or "/memories"
            op = {
                "type": "memory",
                "command": cmd.get("command"),
                "path": path,
                "new_path": cmd.get("new_path"),
                "ok": not out.startswith("Error"),
                "phase": "recall" if cmd.get("command") == "view" else "write",
            }
            after = memory.snapshot()
            if before != after:
                op["memory"] = after
            s.memory_ops.append({k: v for k, v in op.items() if k != "memory"})
            yield op
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
        s.therapist_msgs.append({"role": "user", "content": results})

    if speak:
        text = "".join(spoken).strip()
        s.transcript.append({"speaker": "therapist", "text": text})


async def therapist_turn(s: LiveSession, wrap_up: bool = False) -> AsyncIterator[dict]:
    if not s.therapist_msgs:
        content = (
            f"[Session {s.number} is starting. Date: {s.date}. Jonas has just sat down. "
            "Check your memory first, then open the session.]"
        )
    else:
        last = next(t["text"] for t in reversed(s.transcript) if t["speaker"] == "patient")
        content = f"Jonas: {last}"
        if wrap_up:
            content += "\n\n[Only a couple of minutes are left. Begin wrapping up the session now.]"
    yield {"type": "turn_start", "speaker": "therapist"}
    async for ev in _therapist_loop(s, content, effort=os.environ.get("THERAPIST_EFFORT", "medium"), speak=True):
        yield ev
    yield {"type": "turn_end", "speaker": "therapist", "text": s.transcript[-1]["text"]}


async def patient_turn(s: LiveSession, manual_text: str | None = None) -> AsyncIterator[dict]:
    last = s.transcript[-1]["text"]
    s.patient_msgs.append({"role": "user", "content": f"{prompts.THERAPIST_NAME}: {last}"})
    yield {"type": "turn_start", "speaker": "patient"}
    if manual_text is not None:
        text = manual_text.strip()
        s.patient_msgs.append({"role": "assistant", "content": text})
        yield {"type": "text", "delta": text}
    else:
        async with client.beta.messages.stream(
            model=PATIENT_MODEL,
            max_tokens=8000,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            system=s.patient_system,
            cache_control={"type": "ephemeral"},
            output_config={"effort": os.environ.get("PATIENT_EFFORT", "low")},
            messages=s.patient_msgs,
        ) as stream:
            async for ev in stream:
                if ev.type == "content_block_delta" and ev.delta.type == "text_delta":
                    yield {"type": "text", "delta": ev.delta.text}
            msg = await stream.get_final_message()
        s.patient_msgs.append({"role": "assistant", "content": _block_dicts(msg.content)})
        text = "".join(b.text for b in msg.content if b.type == "text").strip()
    s.transcript.append({"speaker": "patient", "text": text})
    yield {"type": "turn_end", "speaker": "patient", "text": text}


def _transcript_text(s: LiveSession) -> str:
    who = {"therapist": prompts.THERAPIST_NAME, "patient": "Jonas"}
    return "\n\n".join(f"{who[t['speaker']]}: {t['text']}" for t in s.transcript)


def _memory_diff(before: dict, after: dict) -> list[dict]:
    out = []
    for path in sorted(set(before) | set(after)):
        a, b = before.get(path, ""), after.get(path, "")
        if a == b:
            continue
        added = sum(1 for l in difflib.ndiff(a.splitlines(), b.splitlines()) if l.startswith("+ "))
        removed = sum(1 for l in difflib.ndiff(a.splitlines(), b.splitlines()) if l.startswith("- "))
        status = "created" if path not in before else "deleted" if path not in after else "updated"
        out.append({"path": path, "status": status, "added": added, "removed": removed})
    return out


async def end_session(s: LiveSession) -> AsyncIterator[dict]:
    s.ended = True
    # 1) The therapist curates her own memory (append-only continuation).
    yield {"type": "phase", "phase": "consolidating"}
    async for ev in _therapist_loop(
        s,
        "[The session has ended and Jonas has left. Update your memory files now so that "
        "future-you can pick up exactly where you left off. Reply with one short line "
        "when done.]",
        effort="medium",
        speak=False,
    ):
        yield ev

    after = memory.snapshot()
    diff = _memory_diff(s.memory_before, after)
    yield {"type": "memory_diff", "diff": diff}

    # 2) Supervisor assessment with structured outputs.
    yield {"type": "phase", "phase": "assessing"}
    prev = [
        {
            "session": p["number"],
            "sentiment": p["assessment"]["sentiment"],
            "phq9": p["assessment"]["depression"]["phq9_estimate"],
            "gad7": p["assessment"]["anxiety_gad7_estimate"],
            "safety": p["assessment"]["safety"]["level"],
            "headline": p["assessment"]["headline"],
        }
        for p in past_sessions()
        if p.get("assessment")
    ]
    mem_text = "\n\n".join(f"### {k}\n{v}" for k, v in after.items()) or "(empty)"
    user = (
        f"# Session {s.number} transcript ({s.date})\n\n{_transcript_text(s)}\n\n"
        f"# Therapist's memory notes (after this session)\n\n{mem_text}\n\n"
        f"# Your previous assessments\n{json.dumps(prev, indent=1) if prev else '(none: this is the baseline)'}"
    )
    resp = await client.beta.messages.parse(
        model=MODEL,
        max_tokens=16000,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        system=prompts.ANALYST_SYSTEM,
        output_config={"effort": "high"},
        output_format=SessionAssessment,
        messages=[{"role": "user", "content": user}],
    )
    if resp.stop_reason == "refusal" or resp.parsed_output is None:
        yield {"type": "error", "message": "Assessment could not be produced."}
        return
    assessment = resp.parsed_output.model_dump()

    record = {
        "number": s.number,
        "title": s.title,
        "date": s.date,
        "experience": s.experience,
        "transcript": s.transcript,
        "memory_ops": s.memory_ops,
        "memory_diff": diff,
        "memory_after": after,
        "assessment": assessment,
    }
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    (SESSIONS_DIR / f"session_{s.number}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False))
    LIVE.pop(s.id, None)
    yield {"type": "assessment", "session": record}
