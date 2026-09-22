#!/usr/bin/env bash
# Ensure a successful spec commit is publishable, delegate to the stock code
# post-script, then announce the generated spec on its pull request.

set -euo pipefail

RUN_DIR="$(pwd)"
REPO_DIR="${REPO_DIR:-repo}"
TARGET_BRANCH="main"

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "::error::Extracted repo not found at ${REPO_DIR}"
  exit 1
fi

CURRENT_BRANCH="$(git -C "${REPO_DIR}" branch --show-current)"
case "${CURRENT_BRANCH}" in
  ""|main|master)
    if ! git -C "${REPO_DIR}" rev-parse --verify --quiet \
      "refs/remotes/origin/${TARGET_BRANCH}" >/dev/null; then
      echo "::error::Cannot verify origin/${TARGET_BRANCH} before publishing the spec"
      exit 1
    fi

    AHEAD_COUNT="$(git -C "${REPO_DIR}" rev-list --count \
      "origin/${TARGET_BRANCH}..HEAD")"
    if [[ "${AHEAD_COUNT}" -gt 0 ]]; then
      WORK_ITEM_KEY="${FULLSEND_WORK_ITEM_KEY:-}"
      if [[ -z "${WORK_ITEM_KEY}" ]]; then
        WORK_ITEM_URL="${FULLSEND_WORK_ITEM_URL:-${ISSUE_URL:-}}"
        WORK_ITEM_KEY="${WORK_ITEM_URL%/}"
        WORK_ITEM_KEY="${WORK_ITEM_KEY##*/}"
      fi
      if [[ -z "${WORK_ITEM_KEY}" ]]; then
        WORK_ITEM_KEY="${ISSUE_NUMBER:-}"
      fi
      if [[ ! "${WORK_ITEM_KEY}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
        echo "::error::Cannot derive a safe work-item key for the spec branch"
        exit 1
      fi

      SPEC_BRANCH="agent/${WORK_ITEM_KEY}-spec"
      echo "::notice::Moving ${AHEAD_COUNT} spec commit(s) from ${CURRENT_BRANCH:-detached HEAD} to ${SPEC_BRANCH}"
      git -C "${REPO_DIR}" switch -c "${SPEC_BRANCH}"
    fi
    ;;
esac

SCRIPTS_SHA="${SPEC_GENERATE_BASE_SCRIPTS_SHA256:-}"
if [[ ! "${SCRIPTS_SHA}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::SPEC_GENERATE_BASE_SCRIPTS_SHA256 is missing or invalid"
  exit 1
fi

WORKSPACE_DIR="${GITHUB_WORKSPACE:-${RUN_DIR}}"
BASE_POST_SCRIPT="${WORKSPACE_DIR}/.fullsend/.fullsend-cache/resources/sha256/${SCRIPTS_SHA}/scripts/post-code.sh"
if [[ ! -f "${BASE_POST_SCRIPT}" ]]; then
  echo "::error::Pinned stock post-code.sh not found at ${BASE_POST_SCRIPT}"
  exit 1
fi

PUBLISH_OUTPUT="$(mktemp)"
COMMENT_BODY=""
cleanup() {
  rm -f "${PUBLISH_OUTPUT}"
  if [[ -n "${COMMENT_BODY}" ]]; then
    rm -f "${COMMENT_BODY}"
  fi
}
trap cleanup EXIT

# Capture the publisher's outputs so the generated PR can be announced while
# still forwarding every output to the workflow step that invoked this script.
CALLER_GITHUB_OUTPUT="${GITHUB_OUTPUT:-}"
GITHUB_OUTPUT="${PUBLISH_OUTPUT}" bash "${BASE_POST_SCRIPT}"
if [[ -n "${CALLER_GITHUB_OUTPUT}" ]]; then
  cat "${PUBLISH_OUTPUT}" >> "${CALLER_GITHUB_OUTPUT}"
fi

PR_URL="$(sed -n 's/^pr_url=//p' "${PUBLISH_OUTPUT}" | tail -n 1)"
if [[ -z "${PR_URL}" ]]; then
  echo "::notice::Publisher did not create or find a spec PR; skipping the PR comment"
  exit 0
fi

: "${PUSH_TOKEN:?PUSH_TOKEN is required to comment on the generated spec PR}"
if [[ ! "${REPO_FULL_NAME:-}" =~ ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$ ]]; then
  echo "::error::Invalid repository for generated spec PR comment" >&2
  exit 1
fi

PR_BASE_URL="${PR_URL%%[?#]*}"
PR_BASE_URL="${PR_BASE_URL%/}"
PR_NUMBER="${PR_BASE_URL##*/}"
PR_HOST_AND_PATH="${PR_BASE_URL#https://}"
PR_HOST="${PR_HOST_AND_PATH%%/*}"
PR_PATH="/${PR_HOST_AND_PATH#*/}"
if [[ ! "${PR_NUMBER}" =~ ^[1-9][0-9]*$ ]] \
  || [[ ! "${PR_HOST}" =~ ^[a-zA-Z0-9.-]+(:[1-9][0-9]*)?$ ]] \
  || [[ "${PR_PATH}" != "/${REPO_FULL_NAME}/pull/${PR_NUMBER}" ]]; then
  echo "::error::Publisher returned an invalid spec PR URL" >&2
  exit 1
fi

SPEC_PATH="$(git -C "${REPO_DIR}" diff --name-only \
  "origin/${TARGET_BRANCH}...HEAD" \
  | awk -F/ '{
      for (i = 1; i + 3 <= NF; i++) {
        if ($i == "openspec" && $(i + 1) == "changes") {
          path = $1
          for (j = 2; j <= i + 2; j++) path = path "/" $j
          print path
          exit
        }
      }
    }')"
if [[ -z "${SPEC_PATH}" ]]; then
  echo "::error::Could not identify the generated OpenSpec change path" >&2
  exit 1
fi

WORK_ITEM_KEY="${FULLSEND_WORK_ITEM_KEY:-${ISSUE_NUMBER:-work item}}"
WORK_ITEM_URL="${FULLSEND_WORK_ITEM_URL:-${ISSUE_URL:-}}"
if [[ -z "${WORK_ITEM_URL}" && "${ISSUE_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
  WORK_ITEM_URL="https://github.com/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}"
fi

COMMENT_BODY="$(mktemp)"
{
  printf '## Spec ready\n\n'
  printf 'Pull request: [#%s](%s)\n\n' "${PR_NUMBER}" "${PR_URL}"
  printf "OpenSpec change: \`%s\`\n\n" "${SPEC_PATH}"
  if [[ "${WORK_ITEM_URL}" =~ ^https?://[^[:space:]]+$ ]]; then
    printf 'Source work item: [%s](%s)\n\n' "${WORK_ITEM_KEY}" "${WORK_ITEM_URL}"
  else
    printf "Source work item: \`%s\`\n\n" "${WORK_ITEM_KEY}"
  fi
  printf "This PR contains the specification only. After it is reviewed and merged, run \`/fs-code\` on the source work item to request implementation.\n"
} > "${COMMENT_BODY}"

# The marker makes retries update this comment instead of creating duplicates.
fullsend post-comment --repo "${REPO_FULL_NAME}" --token "${PUSH_TOKEN}" \
  --number "${PR_NUMBER}" --marker '<!-- fullsend:spec-generate -->' \
  --result "${COMMENT_BODY}"
