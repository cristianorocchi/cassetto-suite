"""What happened in the open project, in order, for the pages to follow (long polling, no websockets).

Every event has a sequence number, a type ("world.changed", "puzzles.changed", "project.opened"...),
the module or source that caused it, and a small payload. Pages ask for what came after the last
number they saw and wait until there is something."""
from __future__ import annotations

import threading
import time
from collections import deque

KEEP = 400


class EventLog:
    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._seq = 0
        self._items: deque[dict] = deque(maxlen=KEEP)

    @property
    def seq(self) -> int:
        return self._seq

    def publish(self, type_: str, source: str = "core", **data) -> dict:
        with self._cond:
            self._seq += 1
            ev = {"seq": self._seq, "type": type_, "source": source, "time": int(time.time() * 1000), "data": data}
            self._items.append(ev)
            self._cond.notify_all()
            return ev

    def since(self, after: int) -> list[dict]:
        with self._cond:
            return [e for e in self._items if e["seq"] > after]

    def wait(self, after: int, timeout: float = 25.0) -> dict:
        """Events after `after`; waits up to `timeout` seconds for the first one. If the page is so far
        behind that some were dropped, `reset` tells it to reload what it shows."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._seq <= after:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self._cond.wait(left)
            oldest = self._items[0]["seq"] if self._items else self._seq + 1
            reset = after < oldest - 1 and after != 0
            return {"seq": self._seq, "events": [e for e in self._items if e["seq"] > after], "reset": reset}
