#!/usr/bin/env python3
"""Publish one validated, comment-only grilling turn on the verified PR."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys

from jsonschema import validate


SCHEMA = Path(__file__).resolve().parents[1] / "schemas/grillme-result.schema.json"
REVIEW_BOT_LOGIN = "fullsend-ai-review[bot]"
THREADS_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { databaseId body author { login __typename } }
          }
        }
      }
    }
  }
}
"""
RESOLVE_MUTATION = """
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}
"""


def gh(*args, payload=None):
    command = ["gh", *args]
    if payload is not None:
        command.extend(["--input", "-"])
    result = subprocess.run(
        command,
        input=json.dumps(payload) if payload is not None else None,
        text=True,
        capture_output=True,
        check=True,
    )
    response = json.loads(result.stdout) if result.stdout.strip() else {}
    if isinstance(response, dict) and response.get("errors"):
        raise ValueError(f"GitHub GraphQL returned errors: {response['errors']}")
    return response


def owned_threads(repo, number):
    owner, name = repo.split("/", 1)
    cursor = None
    threads = {}
    while True:
        args = [
            "api", "graphql", "-f", f"query={THREADS_QUERY}",
            "-f", f"owner={owner}", "-f", f"name={name}",
            "-F", f"number={number}",
        ]
        if cursor:
            args.extend(["-f", f"cursor={cursor}"])
        data = gh(*args)["data"]["repository"]["pullRequest"]["reviewThreads"]
        for thread in data["nodes"]:
            first = thread["comments"]["nodes"]
            if not first:
                continue
            first = first[0]
            author = first.get("author") or {}
            login = author.get("login", "").lower()
            if "<!-- grillme -->" in first.get("body", "") and login == REVIEW_BOT_LOGIN:
                threads[thread["id"]] = {
                    "comment_id": first["databaseId"],
                    "resolved": thread["isResolved"],
                }
        page = data["pageInfo"]
        if not page["hasNextPage"]:
            return threads
        cursor = page["endCursor"]
        if not cursor:
            raise ValueError("GitHub review-thread pagination returned no cursor")


def publish():
    token = os.environ["REVIEW_TOKEN"]
    repo = os.environ["REPO_FULL_NAME"]
    number = int(os.environ["PR_NUMBER"])
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo) or number < 1:
        raise ValueError("Invalid repository or PR number")
    os.environ["GH_TOKEN"] = token

    context = json.loads(Path(os.environ["GRILLME_CONTEXT_FILE"]).read_text())
    result_path = Path(os.environ["FULLSEND_VALIDATED_ITERATION_DIR"]) / "agent-result.json"
    result = json.loads(result_path.read_text())
    validate(result, json.loads(SCHEMA.read_text()))
    if (context.get("repo"), context.get("pr_number"), context.get("head_sha")) != (
        repo, number, result["head_sha"]
    ) or (result["repo"], result["pr_number"]) != (repo, number):
        raise ValueError("Grillme result does not match the verified PR snapshot")

    metadata = gh("pr", "view", str(number), "--repo", repo, "--json", "state,headRefOid")
    if metadata["state"] != "OPEN":
        print("PR is no longer open; skipping grillme publication")
        return
    if metadata["headRefOid"] != result["head_sha"]:
        stale = (
            "<!-- fullsend:grillme -->\n"
            "### 🔥 Grillme\n\nThe PR changed while this turn was running. "
            "Run `/fs-grillme` again on the current head. No questions or "
            "thread actions from the stale snapshot were published."
        )
        gh("api", f"repos/{repo}/issues/{number}/comments", "--method", "POST", payload={"body": stale})
        print("PR head moved; published a stale-run notice")
        return

    if result["action"] == "failure":
        body = "<!-- fullsend:grillme -->\n### 🔥 Grillme could not complete\n\n" + result["body"]
        gh("api", f"repos/{repo}/issues/{number}/comments", "--method", "POST", payload={"body": body})
        print("Published grillme failure notice")
        return

    replies = result.get("thread_replies", [])
    resolutions = result.get("resolve_threads", [])
    if replies or resolutions:
        threads = owned_threads(repo, number)
        open_threads = {key: value for key, value in threads.items() if not value["resolved"]}
        valid_comment_ids = {value["comment_id"] for value in open_threads.values()}
        reply_ids = [reply["comment_id"] for reply in replies]
        if len(reply_ids) != len(set(reply_ids)) or not set(reply_ids) <= valid_comment_ids:
            raise ValueError("Reply targets must be distinct, open grillme threads on this PR")
        if not set(resolutions) <= set(open_threads):
            raise ValueError("Resolution targets must be open grillme threads on this PR")
        resolving_comment_ids = {open_threads[key]["comment_id"] for key in resolutions}
        if resolving_comment_ids.intersection(reply_ids):
            raise ValueError("Cannot reply to and resolve the same thread in one turn")

    body = "<!-- fullsend:grillme -->\n" + result["body"]
    comments = [
        {"path": item["path"], "line": item["line"], "side": "RIGHT", "body": item["body"]}
        for item in result.get("new_comments", [])
    ]
    gh(
        "api", f"repos/{repo}/pulls/{number}/reviews", "--method", "POST",
        payload={"event": "COMMENT", "commit_id": result["head_sha"], "body": body, "comments": comments},
    )
    for reply in replies:
        gh(
            "api", f"repos/{repo}/pulls/{number}/comments/{reply['comment_id']}/replies",
            "--method", "POST", payload={"body": reply["body"]},
        )
    for thread_id in resolutions:
        gh(
            "api", "graphql", "-f", f"query={RESOLVE_MUTATION}",
            "-f", f"threadId={thread_id}",
        )
    print(
        f"Published grillme turn on {repo}#{number}: "
        f"{len(comments)} new questions, {len(replies)} replies, "
        f"{len(resolutions)} resolutions"
    )


if __name__ == "__main__":
    try:
        publish()
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        # Keep untrusted API error text on one GHA workflow-command line.
        detail = str(exc).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        detail = "".join(char if char.isprintable() else " " for char in detail)
        print(f"::error::Could not publish grillme turn: {detail}", file=sys.stderr)
        sys.exit(1)
