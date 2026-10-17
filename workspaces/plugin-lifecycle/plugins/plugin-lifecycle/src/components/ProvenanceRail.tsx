/* Copyright Red Hat, Inc. */
import {
  Badge,
  Box,
  Card,
  CardBody,
  CardHeader,
  Flex,
  Link,
  Text,
} from '@backstage/ui';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiExternalLinkLine,
} from '@remixicon/react';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './LifecycleEvidence.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

interface ProvenanceNode {
  label: string;
  value?: string;
  detail?: string;
  href?: string;
  fixture?: boolean;
}

export function ProvenanceRail({ context }: { context: LifecycleContext }) {
  const projection = context.projection!;
  const source = [...projection.references]
    .reverse()
    .find(reference => reference.type === 'source');
  const pullRequest = [...projection.references]
    .reverse()
    .find(reference => reference.type === 'pull_request');
  const ociArtifact = [...projection.artifacts]
    .reverse()
    .find(artifact => artifact.artifactType === 'oci');
  const packageArtifact =
    [...projection.artifacts]
      .reverse()
      .find(artifact => artifact.artifactType === 'npm') ?? ociArtifact;
  const nodes: ProvenanceNode[] = [
    {
      label: 'Source',
      value:
        projection.winningRun?.commitSha?.slice(0, 12) ??
        source?.externalId?.slice(0, 12),
      detail: source?.title,
      href: source?.url,
    },
    {
      label: 'Pull request',
      value: pullRequest?.externalId,
      detail: pullRequest?.title,
      href: pullRequest?.url,
    },
    {
      label: 'Winning run',
      value: projection.winningRun?.runId,
      detail: projection.winningRun
        ? `${projection.winningRun.workflow} · attempt ${
            projection.winningRun.runAttempt ??
            projection.winningRun.runNumber ??
            projection.winningRun.attempt
          }`
        : undefined,
      href: projection.winningRun?.url,
      fixture: projection.winningRun?.fixture,
    },
    {
      label: 'Package',
      value: packageArtifact?.version,
      detail: packageArtifact?.name,
      href: packageArtifact?.url,
    },
    {
      label: 'OCI artifact',
      value: ociArtifact?.digest?.slice(0, 20),
      detail: ociArtifact?.reference,
      href: ociArtifact?.url,
    },
  ];
  return (
    <Card className={styles.provenanceCard}>
      <CardHeader>
        <Flex direction="column" gap="1">
          <Text as="h2" variant="title-small">
            Provenance
          </Text>
          <Text variant="body-small" color="secondary">
            {context.asOf
              ? 'The evidence chain recorded by this time'
              : 'Source, workflow, and Catalog package evidence recorded by RHDH'}
          </Text>
        </Flex>
      </CardHeader>
      <CardBody>
        <Box as="ol" className={styles.provenanceRail}>
          {nodes.map((node, index) => (
            <Box
              as="li"
              key={node.label}
              className={styles.provenanceNode}
              data-present={Boolean(node.value || node.detail) || undefined}
              data-last={index === nodes.length - 1 || undefined}
            >
              <Box
                as="span"
                className={styles.provenanceGlyph}
                aria-hidden="true"
              >
                {node.value || node.detail ? (
                  <RiCheckboxCircleLine size={17} />
                ) : (
                  <RiCheckboxBlankCircleLine size={17} />
                )}
              </Box>
              <Flex
                direction="column"
                gap="0.5"
                className={sharedStyles.minWidthZero}
              >
                <Text
                  as="span"
                  variant="body-x-small"
                  color="secondary"
                  weight="bold"
                  className={sharedStyles.eyebrow}
                >
                  {node.label}
                </Text>
                {node.value || node.detail ? (
                  <>
                    {node.href ? (
                      <Link
                        href={node.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body-small"
                        weight="bold"
                        className={sharedStyles.breakable}
                      >
                        {node.value ?? node.detail}{' '}
                        <RiExternalLinkLine size={13} aria-hidden="true" />
                      </Link>
                    ) : (
                      <Text
                        variant="body-small"
                        weight="bold"
                        className={sharedStyles.breakable}
                      >
                        {node.value ?? node.detail}
                      </Text>
                    )}
                    {node.value && node.detail && (
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className={sharedStyles.breakable}
                      >
                        {node.detail}
                      </Text>
                    )}
                    {node.fixture && <Badge>Fixture data</Badge>}
                  </>
                ) : (
                  <Text variant="body-small" color="secondary">
                    Evidence not recorded
                  </Text>
                )}
              </Flex>
            </Box>
          ))}
        </Box>
        {context.relatedEntities
          .filter(entity => entity.role === 'package')
          .map(pkg => (
            <Box key={pkg.entityRef} className={styles.packageSummary}>
              <Text
                as="span"
                variant="body-x-small"
                color="secondary"
                weight="bold"
                className={sharedStyles.eyebrow}
              >
                Current Catalog package
              </Text>
              <Text variant="body-small" weight="bold">
                {pkg.packageName ?? pkg.title ?? pkg.name}
              </Text>
              <Flex gap="1" className={sharedStyles.badgeRow}>
                {pkg.version && <Badge>{`v${pkg.version}`}</Badge>}
                {pkg.support && <Badge>{pkg.support}</Badge>}
                {pkg.supportedVersions.map(version => (
                  <Badge key={version}>{`Backstage ${version}`}</Badge>
                ))}
              </Flex>
            </Box>
          ))}
      </CardBody>
    </Card>
  );
}
