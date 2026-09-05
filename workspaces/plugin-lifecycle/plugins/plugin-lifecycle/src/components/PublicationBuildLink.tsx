/* Copyright Red Hat, Inc. */
import { Link, Text } from '@backstage/ui';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { RiExternalLinkLine } from '@remixicon/react';

export function PublicationBuildLink({
  run,
}: {
  run?: NonNullable<LifecycleContext['lastSuccessfulPublication']>['run'];
}) {
  if (!run) return null;
  if (!run.url) return <Text variant="body-small">Build {run.runId}</Text>;
  return (
    <Link
      href={run.url}
      target="_blank"
      rel="noopener noreferrer"
      variant="body-small"
    >
      Build {run.runId} <RiExternalLinkLine size={13} aria-hidden="true" />
    </Link>
  );
}
