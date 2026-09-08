"""Puts tools/ on sys.path so tests can `import transcribe_sean_calls` etc.
the same way sibling transcribe_*.py scripts already do — same pattern as
tools/dashboard/tests/conftest.py."""
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS_DIR))
