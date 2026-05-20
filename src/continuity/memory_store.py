"""Client-side backend for Claude's Memory tool (memory_20250818).

The therapist agent decides what to read, write, update and delete. We only
execute its commands against a sandboxed folder (data/memories) and report
every operation to the UI so the audience can watch memory being used.
"""

from __future__ import annotations

import shutil
from pathlib import Path


class MemoryError_(Exception):
    pass


class MemoryStore:
    PREFIX = "/memories"

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    # ---------- path safety ----------
    def _resolve(self, path: str) -> Path:
        if not path or not path.startswith(self.PREFIX):
            raise MemoryError_(f"Path must start with {self.PREFIX}: {path!r}")
        rel = path[len(self.PREFIX):].lstrip("/")
        full = (self.root / rel).resolve()
        if full != self.root.resolve() and self.root.resolve() not in full.parents:
            raise MemoryError_(f"Path escapes memory directory: {path!r}")
        return full

    def _virtual(self, p: Path) -> str:
        rel = p.resolve().relative_to(self.root.resolve()).as_posix()
        return f"{self.PREFIX}/{rel}" if rel != "." else self.PREFIX

    # ---------- commands ----------
    def execute(self, cmd: dict) -> str:
        c = cmd.get("command")
        try:
            if c == "view":
                return self.view(cmd["path"], cmd.get("view_range"))
            if c == "create":
                return self.create(cmd["path"], cmd.get("file_text", ""))
            if c == "str_replace":
                return self.str_replace(cmd["path"], cmd["old_str"], cmd.get("new_str", ""))
            if c == "insert":
                return self.insert(cmd["path"], int(cmd["insert_line"]), cmd.get("insert_text", ""))
            if c == "delete":
                return self.delete(cmd["path"])
            if c == "rename":
                return self.rename(cmd["old_path"], cmd["new_path"])
            return f"Error: unknown command {c!r}"
        except MemoryError_ as e:
            return f"Error: {e}"
        except KeyError as e:
            return f"Error: missing parameter {e}"

    def view(self, path: str, view_range: list[int] | None = None) -> str:
        p = self._resolve(path)
        if not p.exists():
            raise MemoryError_(f"The path {path} does not exist.")
        if p.is_dir():
            lines = [f"Here are the files and directories up to 2 levels deep in {path}:"]
            entries = sorted(x for x in p.rglob("*") if len(x.relative_to(p).parts) <= 2)
            if not entries:
                lines.append("(empty — no memories yet)")
            for x in entries:
                size = x.stat().st_size if x.is_file() else 0
                lines.append(f"{size:>6}B\t{self._virtual(x)}" + ("/" if x.is_dir() else ""))
            return "\n".join(lines)
        text = p.read_text()
        rows = text.split("\n")
        start, end = 1, len(rows)
        if view_range:
            start = max(1, view_range[0])
            end = len(rows) if view_range[1] == -1 else min(len(rows), view_range[1])
        return "\n".join(f"{i:>6}\t{rows[i - 1]}" for i in range(start, end + 1))

    def create(self, path: str, text: str) -> str:
        p = self._resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return f"File created successfully at {path}"

    def str_replace(self, path: str, old: str, new: str) -> str:
        p = self._resolve(path)
        if not p.is_file():
            raise MemoryError_(f"The path {path} does not exist.")
        text = p.read_text()
        n = text.count(old)
        if n == 0:
            raise MemoryError_(f"No replacement was performed, old_str did not appear verbatim in {path}.")
        if n > 1:
            raise MemoryError_(f"No replacement was performed. Multiple occurrences of old_str in {path}.")
        p.write_text(text.replace(old, new, 1))
        return "The memory file has been edited."

    def insert(self, path: str, line: int, text: str) -> str:
        p = self._resolve(path)
        if not p.is_file():
            raise MemoryError_(f"The path {path} does not exist.")
        rows = p.read_text().split("\n")
        if line < 0 or line > len(rows):
            raise MemoryError_(f"Invalid insert_line {line}; file has {len(rows)} lines.")
        rows[line:line] = text.rstrip("\n").split("\n")
        p.write_text("\n".join(rows))
        return f"Text inserted at line {line} in {path}."

    def delete(self, path: str) -> str:
        p = self._resolve(path)
        if p == self.root.resolve():
            raise MemoryError_("Refusing to delete the memory root.")
        if not p.exists():
            raise MemoryError_(f"The path {path} does not exist.")
        shutil.rmtree(p) if p.is_dir() else p.unlink()
        return f"Deleted {path}"

    def rename(self, old: str, new: str) -> str:
        po, pn = self._resolve(old), self._resolve(new)
        if not po.exists():
            raise MemoryError_(f"The path {old} does not exist.")
        if pn.exists():
            raise MemoryError_(f"The destination {new} already exists.")
        pn.parent.mkdir(parents=True, exist_ok=True)
        po.rename(pn)
        return f"Renamed {old} to {new}"

    # ---------- helpers for the UI ----------
    def snapshot(self) -> dict[str, str]:
        return {
            self._virtual(p): p.read_text()
            for p in sorted(self.root.rglob("*"))
            if p.is_file()
        }

    def clear(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)
