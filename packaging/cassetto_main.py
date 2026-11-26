"""The packaged app's entry point (PyInstaller runs this file)."""
import multiprocessing

from cassetto.cli import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main())
