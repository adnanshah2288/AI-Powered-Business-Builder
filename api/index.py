# ============================================================
# VERCEL ENTRY POINT
# ============================================================
# PURPOSE: Vercel looks for an `app` object in api/index.py.
# PROCESS: add the project root to the import path, then expose the FastAPI app.
# FAILURE CASES: none in this file; import errors appear in the Vercel build log.

import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from app.main import app  # noqa: E402,F401
