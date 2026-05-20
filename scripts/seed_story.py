"""Run the default 4-week story arc headlessly so the demo starts with history.

Usage:  uv run python scripts/seed_story.py [--sessions 4] [--exchanges 5]
Wipes data/ first. Each session takes ~2-4 minutes.
"""

import argparse
import asyncio
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path.cwd() / ".env")

from continuity import engine, prompts  # noqa: E402


async def run(n_sessions: int, exchanges: int) -> None:
    engine.reset_all()
    for n in range(1, n_sessions + 1):
        week = prompts.STORY_ARC[n - 1]
        s = engine.start_session(week["title"], week["text"])
        print(f"\n=== Session {s.number}: {s.title} ===", flush=True)

        async def drain(gen):
            async for ev in gen:
                if ev["type"] == "memory":
                    print(f"   [memory] {ev['command']} {ev['path']}", flush=True)
                elif ev["type"] == "turn_end":
                    print(
                        f"{ev['speaker'][:1].upper()}: {ev['text'][:140]}...",
                        flush=True,
                    )
                elif ev["type"] == "error":
                    raise RuntimeError(ev["message"])

        await drain(engine.therapist_turn(s))
        for i in range(1, exchanges + 1):
            await drain(engine.patient_turn(s))
            wrap = i >= exchanges - 1
            await drain(engine.therapist_turn(s, wrap_up=wrap))
            if wrap:
                await drain(engine.patient_turn(s))
                break
        async for ev in engine.end_session(s):
            if ev["type"] == "memory":
                print(f"   [memory] {ev['command']} {ev['path']}", flush=True)
            elif ev["type"] == "assessment":
                a = ev["session"]["assessment"]
                print(
                    f"-> {a['headline']} | mood {a['sentiment']} | PHQ-9 {a['depression']['phq9_estimate']} | safety {a['safety']['level']}",
                    flush=True,
                )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=4)
    ap.add_argument("--exchanges", type=int, default=5)
    args = ap.parse_args()
    asyncio.run(run(args.sessions, args.exchanges))
