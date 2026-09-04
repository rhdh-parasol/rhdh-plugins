/* Copyright Red Hat, Inc. */
import { Badge, Box, Flex, Link, Text } from '@backstage/ui';
import type { Delivery } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  RiCheckboxCircleLine,
  RiExternalLinkLine,
  RiGitBranchLine,
} from '@remixicon/react';
import { formattedTime, shortRevision } from '../utils/lifecyclePresentation';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import deliveryStyles from './Delivery.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

export function BuildSummary({
  label,
  build,
}: {
  label: string;
  build?: Delivery['mainline']['latestBuild'];
}) {
  if (!build) {
    return (
      <Box className={deliveryStyles.compactEvidenceRow}>
        <Text variant="body-small" weight="bold">
          {label}
        </Text>
        <Text variant="body-small" color="secondary">
          Not observed
        </Text>
      </Box>
    );
  }
  const successful =
    build.status === 'completed' && build.conclusion === 'success';
  const revision = shortRevision(build.commitSha);
  let buildLinkLabel = 'Open running workspace job';
  if (successful) buildLinkLabel = 'Open successful workspace job';
  else if (build.status === 'completed')
    buildLinkLabel = 'Inspect failed workspace job';
  return (
    <Box className={deliveryStyles.deliveryItem}>
      <Flex gap="2" align="center">
        <Badge
          icon={
            successful ? <RiCheckboxCircleLine aria-hidden="true" /> : undefined
          }
        >
          {build.status === 'completed'
            ? build.conclusion ?? 'completed'
            : build.status}
        </Badge>
        <Text variant="body-small" weight="bold">
          {label}
        </Text>
      </Flex>
      <Text
        variant="body-x-small"
        color="secondary"
        className={sharedStyles.breakable}
      >
        {build.jobName ?? 'Workspace job'} · run{' '}
        {build.runNumber ?? build.runId}
        {build.runAttempt ? ` · attempt ${build.runAttempt}` : ''}
      </Text>
      <Flex gap="2" className={sharedStyles.actionRow} align="center">
        {build.branch && (
          <Badge icon={<RiGitBranchLine aria-hidden="true" />}>
            {build.branch}
          </Badge>
        )}
        {revision &&
          (build.commitUrl ? (
            <Link
              href={build.commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="body-small"
            >
              Commit {revision}{' '}
              <RiExternalLinkLine size={13} aria-hidden="true" />
            </Link>
          ) : (
            <Text variant="body-x-small" color="secondary">
              Commit {revision}
            </Text>
          ))}
      </Flex>
      {build.updatedAt && (
        <Text variant="body-x-small" color="secondary">
          Observed {formattedTime(build.updatedAt)}
        </Text>
      )}
      {build.url && (
        <Link
          href={build.url}
          target="_blank"
          rel="noopener noreferrer"
          variant="body-small"
        >
          {buildLinkLabel} <RiExternalLinkLine size={13} aria-hidden="true" />
        </Link>
      )}
    </Box>
  );
}
