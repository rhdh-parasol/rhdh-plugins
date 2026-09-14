/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import type { GithubCredentialsProvider } from '@backstage/integration';

/** HTTP failures retain the headers needed to classify GitHub throttling. */
export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string,
    readonly rateLimitReset?: string,
    readonly rateLimitRemaining?: string,
  ) {
    super(message);
  }
}

export function isGitHubRateLimited(error: unknown): boolean {
  if (!(error instanceof GitHubRequestError)) return false;
  if (error.status === 429) return true;
  return (
    error.status === 403 &&
    (error.rateLimitRemaining === '0' || Boolean(error.retryAfter))
  );
}

/** Shared authenticated transport for all GitHub reads. */
export class GitHubRequestClient {
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

  constructor(
    private readonly credentials: string | GithubCredentialsProvider,
    private readonly apiBase = 'https://api.github.com',
    private readonly requestTimeoutMs = GitHubRequestClient.DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async get(url: string, repository: string): Promise<Response> {
    const token =
      typeof this.credentials === 'string'
        ? this.credentials
        : (
            await this.credentials.getCredentials({
              url: `https://github.com/${repository}`,
            })
          ).token;
    if (!token)
      throw new GitHubRequestError('GitHub credentials are missing', 401);

    const controller = new AbortController();
    const timeoutMs = Number.isFinite(this.requestTimeoutMs)
      ? Math.max(1_000, Math.min(120_000, this.requestTimeoutMs))
      : GitHubRequestClient.DEFAULT_REQUEST_TIMEOUT_MS;
    let timeoutError: GitHubRequestError | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => {
        timeoutError = new GitHubRequestError(
          `GitHub request timed out after ${timeoutMs}ms for ${url}`,
          408,
        );
        // Abort the underlying request, but race it as well: a non-compliant
        // transport may ignore AbortSignal and otherwise leave callers stuck.
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });

    let response: Response;
    try {
      response = await Promise.race([
        globalThis.fetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timeoutError) throw timeoutError;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new GitHubRequestError(
        `GitHub request failed (${response.status}) for ${url}`,
        response.status,
        response.headers.get('retry-after') ?? undefined,
        response.headers.get('x-ratelimit-reset') ?? undefined,
        response.headers.get('x-ratelimit-remaining') ?? undefined,
      );
    }
    return response;
  }

  url(path: string): string {
    return `${this.apiBase}${path}`;
  }
}
