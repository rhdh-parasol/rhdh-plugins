/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { createHash } from 'crypto';
import JSZip from 'jszip';
import { z } from 'zod/v3';

export const MAX_ARCHIVE_BYTES = 1_048_576;
const MAX_ARCHIVE_ENTRIES = 32;

export interface PublishedExports {
  repository: string;
  workspace: string;
  overlayCommit: string;
  pullRequestNumber: number;
  targetBranch?: string;
  images: string[];
}

const publishedExportsArtifactName = (pullRequestNumber: number) =>
  `published-exports-pr-${pullRequestNumber}`;

const publishedExportsMetaSchema = z.object({
  workspace: z.string().min(1),
  overlayBranch: z.string().min(1),
  overlayRepo: z.string().min(1),
  overlayCommit: z.string().min(7),
  pr: z.number().int().positive(),
  targetBranch: z.string().min(1).optional(),
});

const lifecycleManifestPackageSchema = z.object({
  workspace: z.string().min(1),
  sourceRepository: z.string().url().optional(),
  sourceRevision: z.string().min(1).optional(),
  packageEntityRef: z.string().min(1),
  packageName: z.string().min(1),
  version: z.string().min(1),
  ociReference: z.string().min(1),
  ociDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const lifecycleManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().min(1),
  workflow: z.string().min(1),
  runId: z.string().min(1),
  runNumber: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
  event: z.string().min(1),
  ref: z.string().min(1),
  pullRequestNumber: z.number().int().positive().optional(),
  headSha: z.string().min(7),
  runUrl: z.string().url(),
  packages: z.array(lifecycleManifestPackageSchema).min(1),
});

export type LifecycleManifest = z.infer<typeof lifecycleManifestSchema>;

function validateArchiveEntries(
  entries: Array<{
    name: string;
    dir?: boolean;
    _data?: { uncompressedSize?: number };
  }>,
): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Lifecycle artifact contains too many archive entries');
  }

  let totalUncompressedBytes = 0;
  for (const file of entries) {
    if (
      file.name.startsWith('/') ||
      file.name.split(/[\\/]+/).some(segment => segment === '..')
    ) {
      throw new Error('Lifecycle artifact contains an unsafe archive path');
    }
    const uncompressedSize = file._data?.uncompressedSize ?? 0;
    totalUncompressedBytes += uncompressedSize;
    if (uncompressedSize > MAX_ARCHIVE_BYTES) {
      throw new Error('Lifecycle artifact entry exceeds the 1 MiB limit');
    }
  }
  if (totalUncompressedBytes > MAX_ARCHIVE_BYTES) {
    throw new Error('Lifecycle artifact contents exceed the 1 MiB limit');
  }
}

function isImageReference(value: string): boolean {
  const reference = value.replace(/^oci:\/\//, '');
  return (
    !/\s/.test(value) &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?\/[^\s:@]+(?:[/:][^\s]+)*(?::[^\s]+|@sha256:[a-f0-9]{64})$/.test(
      reference,
    )
  );
}

function assertArchiveDigest(archive: Uint8Array, expected?: string): void {
  if (!expected) return;
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (digest !== expected) {
    throw new Error('Lifecycle artifact archive digest did not match GitHub');
  }
}

export async function parsePublishedExportsArchive(
  archive: Uint8Array,
  repository: string,
  pullRequestNumber: number,
  expectedDigest?: string,
): Promise<PublishedExports | undefined> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Published exports artifact exceeds the 1 MiB limit');
  }
  assertArchiveDigest(archive, expectedDigest);
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files);
  validateArchiveEntries(entries);
  const metaEntry = entries.find(
    file => file.name.endsWith('meta.json') && !file.dir,
  );
  const imagesEntry = entries.find(
    file => file.name.endsWith('published-exports.txt') && !file.dir,
  );
  if (!metaEntry || !imagesEntry) return undefined;

  const metadata = publishedExportsMetaSchema.parse(
    JSON.parse(await metaEntry.async('string')),
  );
  if (
    metadata.overlayRepo !== repository ||
    metadata.pr !== pullRequestNumber
  ) {
    throw new Error('Published exports metadata does not match the PR');
  }

  const images = (await imagesEntry.async('string'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (images.some(image => !isImageReference(image))) {
    throw new Error(
      'Published exports artifact contains an invalid image reference',
    );
  }
  return {
    repository,
    workspace: metadata.workspace.replace(/^workspaces\//, ''),
    overlayCommit: metadata.overlayCommit,
    pullRequestNumber: metadata.pr,
    targetBranch: metadata.targetBranch,
    images,
  };
}

export async function parseLifecycleManifestArchive(
  archive: Uint8Array,
  repository: string,
  runId: number,
  runAttempt: number,
  expectedDigest?: string,
): Promise<LifecycleManifest | undefined> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Lifecycle manifest archive exceeds the 1 MiB limit');
  }
  assertArchiveDigest(archive, expectedDigest);
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files);
  validateArchiveEntries(entries);
  const entry = entries.find(
    file => file.name.endsWith('plugin-lifecycle-manifest.json') && !file.dir,
  );
  if (!entry) return undefined;
  const content = await entry.async('string');
  if (Buffer.byteLength(content, 'utf8') > MAX_ARCHIVE_BYTES) {
    throw new Error('Lifecycle manifest exceeds the 1 MiB limit');
  }
  const manifest = lifecycleManifestSchema.parse(JSON.parse(content));
  if (manifest.repository !== repository || manifest.runId !== String(runId)) {
    throw new Error('Lifecycle manifest does not identify the requested run');
  }
  if (manifest.runAttempt !== runAttempt) {
    throw new Error('Lifecycle manifest run attempt does not match GitHub');
  }
  return manifest;
}

export { publishedExportsArtifactName };
