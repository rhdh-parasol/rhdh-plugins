/* Copyright Red Hat, Inc. */
import { Box, Text } from '@backstage/ui';
import type { LifecycleProjection } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  phaseState,
  phases,
  stateLabels,
} from '../utils/lifecyclePresentation';
import { lifecycleStateIcon } from '../utils/lifecycleStatus';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './LifecycleEvidence.module.css';

export function PhaseRail({ projection }: { projection: LifecycleProjection }) {
  return (
    <Box as="ol" aria-label="Lifecycle phases" className={styles.phaseRail}>
      {phases.map((phase, index) => {
        const state = phaseState(phase.id, projection);
        return (
          <Box
            as="li"
            key={phase.id}
            className={styles.phaseItem}
            data-complete={state === 'succeeded' || undefined}
            data-last={index === phases.length - 1 || undefined}
          >
            <Box
              as="span"
              className={styles.phaseGlyph}
              data-state={state}
              aria-hidden="true"
            >
              {state
                ? lifecycleStateIcon(state)
                : lifecycleStateIcon('pending')}
            </Box>
            <Box as="span" className={styles.phaseCopy}>
              <Text as="span" variant="body-small" weight="bold">
                {phase.label}
              </Text>
              <Text as="span" variant="body-x-small" color="secondary">
                {state ? stateLabels[state] : 'Not observed'}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
