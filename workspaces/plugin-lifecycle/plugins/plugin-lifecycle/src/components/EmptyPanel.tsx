/* Copyright Red Hat, Inc. */
import { Card, CardBody, Flex, Text } from '@backstage/ui';
import type { ReactElement } from 'react';
import { RiArchiveLine } from '@remixicon/react';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './EntityPluginLifecycleContent.module.css';

export function EmptyPanel({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactElement;
}) {
  return (
    <Card>
      <CardBody>
        <Flex
          direction="column"
          align="center"
          gap="3"
          className={styles.emptyPanel}
        >
          <RiArchiveLine size={28} aria-hidden="true" />
          <Text as="h2" variant="title-small">
            {title}
          </Text>
          <Text color="secondary" className={styles.emptyDescription}>
            {description}
          </Text>
          {action}
        </Flex>
      </CardBody>
    </Card>
  );
}
