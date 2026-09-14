/* Copyright Red Hat, Inc. */
import { Badge } from '@backstage/ui';
import type { LifecycleState } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { stateLabels } from '../utils/lifecyclePresentation';
import { lifecycleStateIcon } from '../utils/lifecycleStatus';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './LifecycleEvidence.module.css';

export function StateBadge({ state }: { state: LifecycleState }) {
  return (
    <Badge
      className={styles.stateBadge}
      data-state={state}
      icon={lifecycleStateIcon(state)}
    >
      {stateLabels[state]}
    </Badge>
  );
}
