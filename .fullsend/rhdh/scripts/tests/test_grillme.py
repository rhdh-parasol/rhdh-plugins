"""Exercise the grillme publisher with mocked GitHub API responses."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1]
SCHEMA = SCRIPTS.parent / "schemas/grillme-result.schema.json"
SHA = "a" * 40


class GrillmeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.output = self.root / "output"
        self.output.mkdir()
        self.context = self.root / "context.json"
        self.context.write_text(json.dumps({"repo": "example/repo", "pr_number": 21, "head_sha": SHA}))
        self.calls = self.root / "calls.jsonl"
        self.metadata = self.root / "metadata.json"
        self.metadata.write_text(json.dumps({"state": "OPEN", "headRefOid": SHA}))
        self.threads = self.root / "threads.json"
        self.threads.write_text(json.dumps({
            "data": {"repository": {"pullRequest": {"reviewThreads": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [
                    {
                        "id": "PRRT_ours", "isResolved": False,
                        "comments": {"nodes": [{
                            "databaseId": 101, "body": "Why? <!-- grillme -->",
                            # GitHub GraphQL omits the REST API's [bot] suffix.
                            "author": {"login": "fullsend-ai-review", "__typename": "Bot"},
                        }]},
                    },
                    {
                        "id": "PRRT_theirs", "isResolved": False,
                        "comments": {"nodes": [{
                            "databaseId": 202, "body": "Why? <!-- grillme -->",
                            "author": {"login": "human", "__typename": "User"},
                        }]},
                    },
                    {
                        "id": "PRRT_lookalike", "isResolved": False,
                        "comments": {"nodes": [{
                            "databaseId": 303, "body": "Why? <!-- grillme -->",
                            "author": {"login": "fullsend-impostor[bot]", "__typename": "Bot"},
                        }]},
                    },
                ],
            }}}},
        }))
        self.result = {
            "action": "comment", "repo": "example/repo", "pr_number": 21,
            "head_sha": SHA, "body": "### 🔥 Grillme — Turn 1\n\nTwo questions.",
            "new_comments": [{
                "path": "README.md", "line": 3,
                "body": "Why choose this scope? <!-- grillme -->",
            }],
        }
        self.env = dict(
            os.environ,
            PATH=f"{self.bin}:{os.environ['PATH']}",
            REVIEW_TOKEN="test-token",
            REPO_FULL_NAME="example/repo",
            PR_NUMBER="21",
            GRILLME_CONTEXT_FILE=str(self.context),
            FULLSEND_VALIDATED_ITERATION_DIR=str(self.output),
            FULLSEND_OUTPUT_SCHEMA=str(SCHEMA),
            GRILLME_TEST_CALLS=str(self.calls),
            GRILLME_TEST_METADATA=str(self.metadata),
            GRILLME_TEST_THREADS=str(self.threads),
        )
        gh = self.bin / "gh"
        gh.write_text(f"#!{sys.executable}\n" + """
import json, os, sys
args = sys.argv[1:]
with open(os.environ['GRILLME_TEST_CALLS'], 'a') as log:
    log.write(json.dumps({'args': args, 'payload': json.load(sys.stdin) if '--input' in args else None}) + '\\n')
if args[:2] == ['pr', 'view']:
    print(open(os.environ['GRILLME_TEST_METADATA']).read())
elif args[:2] == ['api', 'graphql'] and any('reviewThreads(' in x for x in args):
    if os.environ.get('GRILLME_TEST_GRAPHQL_ERROR'):
        print(json.dumps({'errors': ['bad\\n::warning::injected%0Aline']}))
    else:
        print(open(os.environ['GRILLME_TEST_THREADS']).read())
else:
    print('{}')
""")
        gh.chmod(0o755)

    def run_publisher(self):
        (self.output / "agent-result.json").write_text(json.dumps(self.result))
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "post-grillme.py")],
            cwd=self.root, env=self.env, text=True, capture_output=True,
        )

    def calls_made(self):
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_posts_comment_only_review_with_inline_question(self):
        run = self.run_publisher()
        self.assertEqual(run.returncode, 0, run.stderr)
        calls = self.calls_made()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["args"][:2], ["api", "repos/example/repo/pulls/21/reviews"])
        payload = calls[1]["payload"]
        self.assertEqual(payload["event"], "COMMENT")
        self.assertEqual(payload["commit_id"], SHA)
        self.assertIn("<!-- fullsend:grillme -->", payload["body"])
        self.assertEqual(payload["comments"][0]["side"], "RIGHT")
        self.assertNotIn("label_actions", payload)

    def test_replies_and_resolves_only_owned_threads(self):
        self.result["new_comments"] = []
        self.result["thread_replies"] = [{"comment_id": 101, "body": "And retries? <!-- grillme -->"}]
        run = self.run_publisher()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(self.calls_made()[-1]["args"][1],
                         "repos/example/repo/pulls/21/comments/101/replies")

        self.calls.unlink()
        self.result.pop("thread_replies")
        self.result["resolve_threads"] = ["PRRT_ours"]
        run = self.run_publisher()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(any("resolveReviewThread" in " ".join(call["args"])
                            for call in self.calls_made()))

    def test_rejects_unowned_thread_before_any_write(self):
        for comment_id in (202, 303):
            with self.subTest(comment_id=comment_id):
                self.result["thread_replies"] = [{"comment_id": comment_id, "body": "Why? <!-- grillme -->"}]
                run = self.run_publisher()
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse(any(call["payload"] is not None for call in self.calls_made()))
                self.calls.unlink()

    def test_failure_result_posts_only_an_explanatory_pr_comment(self):
        self.result = {
            "action": "failure", "repo": "example/repo", "pr_number": 21,
            "head_sha": SHA, "reason": "tool-failure",
            "body": "Could not read the PR diff. Run `/fs-grillme` again.",
        }
        run = self.run_publisher()
        self.assertEqual(run.returncode, 0, run.stderr)
        calls = self.calls_made()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[-1]["args"][1], "repos/example/repo/issues/21/comments")
        self.assertIn("Could not read the PR diff", calls[-1]["payload"]["body"])
        self.assertFalse(any("/reviews" in call["args"][1] for call in calls if len(call["args"]) > 1))

    def test_api_error_cannot_inject_a_workflow_command(self):
        self.env["GRILLME_TEST_GRAPHQL_ERROR"] = "1"
        self.result["thread_replies"] = [{"comment_id": 101, "body": "And retries? <!-- grillme -->"}]
        run = self.run_publisher()
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(len(run.stderr.splitlines()), 1)
        self.assertIn("%250A", run.stderr)
        self.assertNotIn("\n::warning::", run.stderr)
        self.assertFalse(any(call["payload"] is not None for call in self.calls_made()))

    def test_stale_head_publishes_notice_without_review(self):
        self.metadata.write_text(json.dumps({"state": "OPEN", "headRefOid": "b" * 40}))
        run = self.run_publisher()
        self.assertEqual(run.returncode, 0, run.stderr)
        calls = self.calls_made()
        self.assertEqual(calls[-1]["args"][1], "repos/example/repo/issues/21/comments")
        self.assertIn("Run `/fs-grillme` again", calls[-1]["payload"]["body"])

    def test_schema_rejects_review_mutations_and_invalid_thread_actions(self):
        for patch in (
            {"action": "approve"}, {"label_actions": {}},
            {"new_comments": [{"path": "README.md", "line": 3, "body": "No marker"}]},
            {"resolve_threads": ["PRRT_theirs"]},
        ):
            with self.subTest(patch=patch):
                self.result = self.result | patch
                run = self.run_publisher()
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse(any(call["payload"] is not None for call in self.calls_made()))
                self.result = {
                    "action": "comment", "repo": "example/repo", "pr_number": 21,
                    "head_sha": SHA, "body": "A question", "new_comments": [],
                }
                if self.calls.exists():
                    self.calls.unlink()

    def test_validation_loop_accepts_structured_output(self):
        (self.output / "agent-result.json").write_text(json.dumps(self.result))
        run = subprocess.run(
            [sys.executable, str(SCRIPTS / "validate-grillme.py")],
            cwd=self.root, env=self.env, text=True, capture_output=True,
        )
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)


if __name__ == "__main__":
    unittest.main()
