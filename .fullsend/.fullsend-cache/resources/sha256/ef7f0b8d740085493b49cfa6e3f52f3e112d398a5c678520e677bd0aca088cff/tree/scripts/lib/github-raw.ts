// Fetch file contents from raw.githubusercontent.com, honoring GITHUB_TOKEN /
// GH_TOKEN for private repos. Some environments provide a token scoped to
// specific repos which yields 404 elsewhere, so a 404 with a token is retried
// anonymously before concluding the file is absent. The token's validity is
// learned once per repo and cached, so real 404s (absent files) don't pay a
// second request forever after.

import { fetchText } from './http.ts';

export interface RawFetchResult {
  /** File content, or null when the file does not exist at that ref. */
  content: string | null;
  /** True when the provided token was rejected and the anonymous retry succeeded. */
  anonymousFallback: boolean;
}

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

/** Per-repo knowledge about whether the provided token works there. */
const tokenState = new Map<string, 'valid' | 'rejected'>();

/** repo is "owner/name". Throws on network/auth errors, returns content null on 404. */
export async function fetchGithubRaw(repo: string, ref: string, filePath: string): Promise<RawFetchResult> {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`;
  const token = githubToken();
  const useToken = Boolean(token) && tokenState.get(repo) !== 'rejected';
  const headers: Record<string, string> = useToken ? { authorization: `token ${token}` } : {};
  let res = await fetchText(url, { headers, okStatuses: [404], timeoutMs: 30_000 });
  let anonymousFallback = false;
  if (res.ok && useToken) {
    if (res.status !== 404) {
      tokenState.set(repo, 'valid');
    } else if (tokenState.get(repo) !== 'valid') {
      // First 404 with an unproven token: probe anonymously to distinguish
      // "file absent" from "token rejected for this repo".
      const anon = await fetchText(url, { okStatuses: [404], timeoutMs: 30_000 });
      if (anon.ok && anon.status !== 404) {
        tokenState.set(repo, 'rejected');
        res = anon;
        anonymousFallback = true;
      }
    }
  }
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.error}`);
  return { content: res.status === 404 ? null : res.data, anonymousFallback };
}
