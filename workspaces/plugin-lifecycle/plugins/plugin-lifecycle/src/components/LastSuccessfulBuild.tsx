/* Copyright Red Hat, Inc. */
import { Badge, Card, CardBody, CardHeader, Flex, Text } from '@backstage/ui';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { RiCheckboxCircleLine } from '@remixicon/react';
import { OciReference } from './OciReference';
import { PublicationBuildLink } from './PublicationBuildLink';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

export function LastSuccessfulBuild({
  publication,
}: {
  publication: NonNullable<LifecycleContext['lastSuccessfulPublication']>;
}) {
  const ociArtifacts = publication.artifacts.filter(
    artifact => artifact.artifactType === 'oci',
  );
  return (
    <Card>
      <CardHeader>
        <Flex direction="column" gap="1">
          <Text as="h2" variant="title-small">
            Latest successful build
          </Text>
          <Text variant="body-small" color="secondary">
            Last attested publication from a lifecycle change. This is separate
            from the current Extensions Catalog baseline.
          </Text>
        </Flex>
      </CardHeader>
      <CardBody>
        <Flex direction="column" gap="3">
          <Flex gap="2" align="center" className={sharedStyles.actionRow}>
            <Badge icon={<RiCheckboxCircleLine aria-hidden="true" />}>
              Succeeded
            </Badge>
            {publication.run?.fixture && (
              <Badge>Fixture data — not a real CI run</Badge>
            )}
            <Text variant="body-small" weight="bold">
              {publication.change.title}
            </Text>
            <PublicationBuildLink run={publication.run} />
          </Flex>
          {ociArtifacts.length > 0 ? (
            <Flex direction="column" gap="2">
              <Text variant="body-small" weight="bold">
                Published OCI images
              </Text>
              {ociArtifacts.map(artifact => (
                <Flex
                  key={`${artifact.reference}:${artifact.digest ?? ''}`}
                  direction="column"
                  gap="1"
                >
                  <OciReference
                    label={artifact.name ?? 'Published OCI image'}
                    reference={artifact.reference}
                    href={artifact.url}
                  />
                  {artifact.digest && (
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className={sharedStyles.breakable}
                    >
                      Digest {artifact.digest}
                    </Text>
                  )}
                </Flex>
              ))}
            </Flex>
          ) : (
            <Text variant="body-small" color="secondary">
              No digest-pinned OCI image was recorded for this successful
              change.
            </Text>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}
