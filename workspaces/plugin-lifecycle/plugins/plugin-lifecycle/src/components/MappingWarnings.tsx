/* Copyright Red Hat, Inc. */
import { Alert } from '@backstage/ui';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

export function MappingWarnings({
  warnings,
}: {
  warnings: LifecycleContext['warnings'];
}) {
  if (warnings.length === 0) return null;
  return (
    <Alert
      status="warning"
      icon
      title="Catalog mapping is incomplete"
      description={warnings.map(warning => warning.message).join(' ')}
    />
  );
}
