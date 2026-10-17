/* Copyright Red Hat, Inc. */
import { Badge, Box, Flex, Link, Text } from '@backstage/ui';
import type { Delivery } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { RiExternalLinkLine } from '@remixicon/react';
import {
  publishStatusLabel,
  shortRevision,
} from '../utils/lifecyclePresentation';
import { OciReference } from './OciReference';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import deliveryStyles from './Delivery.module.css';

export function CandidateCard({
  candidate,
}: {
  candidate: Delivery['activeCandidates'][number];
}) {
  return (
    <Box className={deliveryStyles.deliveryItem}>
      <Flex justify="between" gap="2" align="start">
        {candidate.pullRequestUrl ? (
          <Link
            href={candidate.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="body-small"
          >
            {candidate.title}{' '}
            <RiExternalLinkLine size={13} aria-hidden="true" />
          </Link>
        ) : (
          <Text variant="body-small" weight="bold">
            {candidate.title}
          </Text>
        )}
      </Flex>
      {(candidate.author || candidate.pullRequestNumber) && (
        <Text variant="body-x-small" color="secondary">
          {candidate.author ? `By ${candidate.author}` : 'Pull request'}
          {candidate.pullRequestNumber
            ? ` · #${candidate.pullRequestNumber}`
            : ''}
        </Text>
      )}
      <Box className={deliveryStyles.checkGrid}>
        <Box className={deliveryStyles.checkSummary}>
          <Text variant="body-x-small" color="secondary" weight="bold">
            Publish
          </Text>
          <Badge>{publishStatusLabel(candidate.publishStatus)}</Badge>
          {candidate.publishUrl && (
            <Link
              href={candidate.publishUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="body-small"
            >
              View publish check{' '}
              <RiExternalLinkLine size={13} aria-hidden="true" />
            </Link>
          )}
        </Box>
        <Box className={deliveryStyles.checkSummary}>
          <Text variant="body-x-small" color="secondary" weight="bold">
            Smoke test
          </Text>
          <Badge>{candidate.smokeTestStatus}</Badge>
          {candidate.smokeTestUrl && (
            <Link
              href={candidate.smokeTestUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="body-small"
            >
              View smoke test{' '}
              <RiExternalLinkLine size={13} aria-hidden="true" />
            </Link>
          )}
        </Box>
      </Box>
      {candidate.sourceRevision &&
        (candidate.sourceUrl ? (
          <Link
            href={candidate.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="body-small"
          >
            Source {shortRevision(candidate.sourceRevision)}{' '}
            <RiExternalLinkLine size={13} aria-hidden="true" />
          </Link>
        ) : (
          <Text variant="body-x-small" color="secondary">
            Source {shortRevision(candidate.sourceRevision)}
          </Text>
        ))}
      {candidate.blocker && (
        <Text variant="body-small" color="secondary">
          {candidate.blocker}
        </Text>
      )}
      {candidate.nextAction && (
        <Flex direction="column" gap="0.5">
          <Text variant="body-small" color="secondary">
            Next: {candidate.nextAction}
          </Text>
          {candidate.nextActionUrl && (
            <Link
              href={candidate.nextActionUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="body-small"
            >
              {candidate.nextActionLabel ?? 'Open evidence'}{' '}
              <RiExternalLinkLine size={13} aria-hidden="true" />
            </Link>
          )}
        </Flex>
      )}
      {candidate.candidateImages.length > 0 && (
        <Flex direction="column" gap="1">
          <Text variant="body-x-small" weight="bold">
            Candidate images to test
          </Text>
          {candidate.candidateImages.map(image => (
            <OciReference
              key={image.reference}
              label="Candidate OCI image"
              reference={image.reference}
            />
          ))}
        </Flex>
      )}
    </Box>
  );
}
