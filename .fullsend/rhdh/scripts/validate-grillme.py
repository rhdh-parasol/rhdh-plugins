#!/usr/bin/env python3
"""Validate the agent's structured grilling turn before runner publication."""

import json
import os
from pathlib import Path
import sys

from jsonschema import ValidationError, validate


def main():
    try:
        schema = json.loads(Path(os.environ["FULLSEND_OUTPUT_SCHEMA"]).read_text())
        result = json.loads(Path("output/agent-result.json").read_text())
        validate(result, schema)
    except (KeyError, OSError, ValueError, ValidationError) as exc:
        print(f"FAIL: invalid grillme result: {exc}")
        return 1
    print("PASS: comment-only grillme result validated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
