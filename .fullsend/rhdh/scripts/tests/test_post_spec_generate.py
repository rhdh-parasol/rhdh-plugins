"""Regression tests for the fs-spec runner handoff."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1]
SCRIPTS_SHA = "a" * 64


class PostSpecGenerateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_dir = self.root / "run"
        self.repo = self.run_dir / "repo"
        self.workspace = self.root / "workspace"
        self.result = self.root / "result.txt"
        self.calls = self.root / "calls.jsonl"
        self.github_output = self.root / "github-output.txt"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.repo.mkdir(parents=True)

        self.env = dict(
            os.environ,
            PATH=f"{self.bin}:{os.environ['PATH']}",
            GITHUB_WORKSPACE=str(self.workspace),
            GITHUB_OUTPUT=str(self.github_output),
            REPO_DIR="repo",
            REPO_FULL_NAME="example/repo",
            PUSH_TOKEN="test-push-token",
            FULLSEND_WORK_ITEM_KEY="RHDHPLAN-1745",
            FULLSEND_WORK_ITEM_URL="https://issues.example.test/browse/RHDHPLAN-1745",
            SPEC_GENERATE_BASE_SCRIPTS_SHA256=SCRIPTS_SHA,
            TEST_CALLS=str(self.calls),
            TEST_RESULT=str(self.result),
            GIT_CONFIG_GLOBAL=os.devnull,
            GIT_CONFIG_NOSYSTEM="1",
        )

        self.write_tool("fullsend", """
import json, os, pathlib, sys
args = sys.argv[1:]
assert args[0] == 'post-comment', args
body = pathlib.Path(args[args.index('--result') + 1]).read_text()
args[args.index('--token') + 1] = '[fixture]'
with open(os.environ['TEST_CALLS'], 'a') as log:
    log.write(json.dumps({'args': args, 'body': body}) + '\\n')
if os.environ.get('TEST_COMMENT_FAILURE'):
    sys.exit(1)
""")

        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Spec test")
        (self.repo / "seed.txt").write_text("seed\n")
        self.git("add", "seed.txt")
        self.git("commit", "-m", "chore: seed")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")

        base_script = (
            self.workspace
            / ".fullsend/.fullsend-cache/resources/sha256"
            / SCRIPTS_SHA
            / "scripts/post-code.sh"
        )
        base_script.parent.mkdir(parents=True)
        base_script.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            "git -C \"${REPO_DIR}\" branch --show-current > \"${TEST_RESULT}\"\n"
            "pwd >> \"${TEST_RESULT}\"\n"
            "if [[ -n \"${TEST_PR_URL:-}\" ]]; then\n"
            "  printf 'pr_url=%s\\n' \"${TEST_PR_URL}\" >> \"${GITHUB_OUTPUT}\"\n"
            "fi\n"
        )

    def write_tool(self, name, code):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n{code}")
        path.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", str(self.repo), *args],
            env=self.env,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()

    def commit_change(self):
        spec = self.repo / "openspec/changes/rhdhplan-1745-generated/proposal.md"
        spec.parent.mkdir(parents=True)
        spec.write_text("spec\n")
        self.git("add", "openspec")
        self.git("commit", "-m", "feat(openspec): add generated spec")

    def commit_workspace_change(self):
        spec = (
            self.repo
            / "workspaces/boost/openspec/changes/rhdhplan-1745-generated/proposal.md"
        )
        spec.parent.mkdir(parents=True)
        spec.write_text("spec\n")
        self.git("add", "workspaces/boost/openspec")
        self.git("commit", "-m", "feat(openspec): add generated workspace spec")

    def run_script(self, **env):
        return subprocess.run(
            ["bash", str(SCRIPTS / "post-spec-generate.sh")],
            cwd=self.run_dir,
            env=dict(self.env, **env),
            text=True,
            capture_output=True,
        )

    def result_lines(self):
        return self.result.read_text().splitlines()

    def published(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_moves_commit_from_main_to_scoped_feature_branch(self):
        self.commit_change()

        completed = self.run_script()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = self.result_lines()
        self.assertEqual(result[0], "agent/RHDHPLAN-1745-spec")
        self.assertEqual(Path(result[1]).resolve(), self.run_dir.resolve())
        self.assertIn("Moving 1 spec commit(s)", completed.stdout)

    def test_moves_commit_from_detached_head_to_scoped_feature_branch(self):
        self.commit_change()
        self.git("checkout", "--detach")

        completed = self.run_script()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.result_lines()[0], "agent/RHDHPLAN-1745-spec")

    def test_leaves_existing_feature_branch_unchanged(self):
        self.git("switch", "-c", "agent/RHDHPLAN-1745-custom")
        self.commit_change()

        completed = self.run_script()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.result_lines()[0], "agent/RHDHPLAN-1745-custom")

    def test_delegates_without_branching_when_agent_made_no_commit(self):
        completed = self.run_script()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.result_lines()[0], "main")
        self.assertNotIn("Moving", completed.stdout)

    def test_rejects_unsafe_work_item_key_before_branching(self):
        self.commit_change()

        completed = self.run_script(FULLSEND_WORK_ITEM_KEY="../unsafe")

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("safe work-item key", completed.stdout)
        self.assertFalse(self.result.exists())

    def test_comments_on_generated_pr_with_links_and_next_step(self):
        self.commit_change()
        pr_url = "https://github.com/example/repo/pull/42"

        completed = self.run_script(TEST_PR_URL=pr_url)

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.github_output.read_text(), f"pr_url={pr_url}\n")
        calls = self.published()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["args"][:3], ["post-comment", "--repo", "example/repo"])
        self.assertIn("<!-- fullsend:spec-generate -->", calls[0]["args"])
        self.assertIn("https://github.com/example/repo/pull/42", calls[0]["body"])
        self.assertIn("openspec/changes/rhdhplan-1745-generated", calls[0]["body"])
        self.assertIn("https://issues.example.test/browse/RHDHPLAN-1745", calls[0]["body"])
        self.assertIn("`/fs-code`", calls[0]["body"])

    def test_comments_with_workspace_nested_openspec_path(self):
        self.commit_workspace_change()

        completed = self.run_script(
            TEST_PR_URL="https://github.com/example/repo/pull/42"
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(
            "workspaces/boost/openspec/changes/rhdhplan-1745-generated",
            self.published()[0]["body"],
        )

    def test_does_not_comment_when_publisher_returns_no_pr(self):
        self.commit_change()

        completed = self.run_script()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(self.calls.exists())
        self.assertIn("skipping the PR comment", completed.stdout)

    def test_rejects_pr_url_for_a_different_repository(self):
        self.commit_change()

        completed = self.run_script(
            TEST_PR_URL="https://github.com/attacker/repo/pull/42"
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("invalid spec PR URL", completed.stderr)
        self.assertFalse(self.calls.exists())

    def test_comment_failure_fails_the_post_script_for_a_safe_retry(self):
        self.commit_change()

        completed = self.run_script(
            TEST_PR_URL="https://github.com/example/repo/pull/42",
            TEST_COMMENT_FAILURE="1",
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(len(self.published()), 1)


if __name__ == "__main__":
    unittest.main()
