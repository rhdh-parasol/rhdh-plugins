/* Copyright Red Hat, Inc. */
import { Flex, Skeleton } from '@backstage/ui';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './EntityPluginLifecycleContent.module.css';

export function LoadingPanel() {
  return (
    <Flex
      direction="column"
      gap="4"
      role="status"
      aria-label="Loading lifecycle context"
      aria-busy="true"
    >
      <Skeleton height={160} rounded />
      <Flex gap="4" direction={{ initial: 'column', lg: 'row' }}>
        <Skeleton height={360} rounded className={styles.loadingWide} />
        <Skeleton height={360} rounded className={styles.loadingNarrow} />
      </Flex>
    </Flex>
  );
}
