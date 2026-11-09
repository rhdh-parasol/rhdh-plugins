#!/usr/bin/env bash
# Post-script: comment the classification on the issue or PR.
#
# Runs on the trusted runner AFTER the sandbox exits. Agent output is
# untrusted: validate JSON, allowlist status, cap length, strip @mentions.
set -euo pipefail

_TOKEN="${REVIEW_TOKEN:-${GH_TOKEN:-}}"
: "${_TOKEN:?REVIEW_TOKEN or GH_TOKEN is required}"
echo "::add-mask::${_TOKEN}"
export GH_TOKEN="${_TOKEN}"

REPO_FULL_NAME="${REPO_FULL_NAME:-}"
ISSUE_NUMBER="${ISSUE_NUMBER:-${PR_NUMBER:-}}"
ISSUE_URL="${ISSUE_URL:-${GITHUB_PR_URL:-${GITHUB_ISSUE_URL:-}}}"

if [[ -z "${ISSUE_NUMBER}" && "${ISSUE_URL}" =~ /(issues|pull)/([0-9]+) ]]; then
  ISSUE_NUMBER="${BASH_REMATCH[2]}"
fi
if [[ -z "${REPO_FULL_NAME}" && "${ISSUE_URL}" =~ github\.com/([^/]+/[^/]+)/ ]]; then
  REPO_FULL_NAME="${BASH_REMATCH[1]}"
fi

: "${REPO_FULL_NAME:?REPO_FULL_NAME is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
if ! [[ "${ISSUE_NUMBER}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::ISSUE_NUMBER must be a positive integer, got: '${ISSUE_NUMBER}'" >&2
  exit 1
fi

CLEANUP_FILES=()
trap 'rm -f "${CLEANUP_FILES[@]}"' EXIT

OUTPUT_FILE="${FULLSEND_OUTPUT_FILE:-agent-result.json}"

if [[ -n "${FULLSEND_VALIDATED_ITERATION_DIR:-}" ]]; then
  RESULT_FILE="${FULLSEND_VALIDATED_ITERATION_DIR}/${OUTPUT_FILE}"
else
  RESULT_FILE=""
  for dir in iteration-*/output; do
    if [[ -f "${dir}/${OUTPUT_FILE}" ]]; then
      RESULT_FILE="${dir}/${OUTPUT_FILE}"
    fi
  done
fi

if [[ -z "${RESULT_FILE}" || ! -f "${RESULT_FILE}" ]]; then
  RESULT_FILE="$(find . -name "${OUTPUT_FILE}" -type f 2>/dev/null | head -1)"
fi

if [[ -z "${RESULT_FILE}" || ! -f "${RESULT_FILE}" ]]; then
  echo "::error::${OUTPUT_FILE} not found"
  echo "--- diagnostic: iteration output contents ---"
  for dir in iteration-*/output; do
    [[ -d "${dir}" ]] && ls -laR "${dir}" 2>/dev/null
  done
  echo "--- diagnostic: all iteration dirs ---"
  ls -la iteration-*/ 2>/dev/null || echo "(no iteration-* dirs)"
  echo "--- end diagnostic ---"
  exit 1
fi

if ! jq empty "${RESULT_FILE}" 2>/dev/null; then
  echo "::error::${OUTPUT_FILE} is not valid JSON"
  exit 1
fi

STATUS="$(jq -r '.status // empty' "${RESULT_FILE}")"
case "${STATUS}" in
  complete|needs_input|error) ;;
  *)
    echo "::error::Unknown or missing status '${STATUS}'"
    exit 1
    ;;
esac

COMMENT="$(jq -r '.comment // empty' "${RESULT_FILE}")"
if [[ -z "${COMMENT}" ]]; then
  echo "::error::comment is empty"
  exit 1
fi

COMMENT="${COMMENT//@/at-}"

MAX_LEN=60000
if [[ "${#COMMENT}" -gt "${MAX_LEN}" ]]; then
  COMMENT="${COMMENT:0:$((MAX_LEN - 40))}

…truncated by post-script…"
fi

BODY_FILE="$(mktemp)"
CLEANUP_FILES+=("${BODY_FILE}")
printf '%s\n' "${COMMENT}" > "${BODY_FILE}"

echo "Posting ${STATUS} package-impact comment on ${REPO_FULL_NAME}#${ISSUE_NUMBER}"
gh issue comment "${ISSUE_NUMBER}" --repo "${REPO_FULL_NAME}" --body-file "${BODY_FILE}"
echo "Posted comment on ${REPO_FULL_NAME}#${ISSUE_NUMBER}"
