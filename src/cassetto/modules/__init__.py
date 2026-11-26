"""The modules of the suite, in the order they open. A new module is a class here and a page."""
from __future__ import annotations


def all_modules():
    from .plastico import PlasticoModule
    from .puzzles import PuzzlesModule
    return [PlasticoModule(), PuzzlesModule()]
