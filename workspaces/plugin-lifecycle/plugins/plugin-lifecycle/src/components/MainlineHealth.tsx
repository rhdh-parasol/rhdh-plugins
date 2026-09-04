/* Copyright Red Hat, Inc. */
import { Box, Text } from '@backstage/ui';
import type { Delivery } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { BuildSummary } from './BuildSummary';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import deliveryStyles from './Delivery.module.css';

export function MainlineHealth({
  mainline,
  wide = false,
}: {
  mainline: Delivery['mainline'];
  wide?: boolean;
}) {
  if (!mainline.latestBuild && !mainline.latestSuccessfulBuild) return null;
  return (
    <Box
      className={deliveryStyles.deliveryLane}
      data-lane="mainline"
      data-wide={wide || undefined}
    >
      <Text as="h3" variant="body-large" weight="bold">
        Mainline health
      </Text>
      <BuildSummary label="Latest build" build={mainline.latestBuild} />
      <BuildSummary
        label="Latest successful build"
        build={mainline.latestSuccessfulBuild}
      />
    </Box>
  );
}
