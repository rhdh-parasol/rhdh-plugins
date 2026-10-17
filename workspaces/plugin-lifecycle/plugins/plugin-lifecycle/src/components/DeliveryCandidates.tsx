/* Copyright Red Hat, Inc. */
import { Box, Flex, Text } from '@backstage/ui';
import type { Delivery } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { CandidateCard } from './CandidateCard';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import deliveryStyles from './Delivery.module.css';

export function DeliveryCandidates({
  candidates,
  wide = false,
}: {
  candidates: Delivery['activeCandidates'];
  wide?: boolean;
}) {
  if (candidates.length === 0) return null;
  return (
    <Box
      className={deliveryStyles.deliveryLane}
      data-lane="candidate"
      data-wide={wide || undefined}
    >
      <Text as="h3" variant="body-large" weight="bold">
        Open candidates
      </Text>
      <Flex direction="column" gap="3">
        {candidates.map(candidate => (
          <CandidateCard key={candidate.changeId} candidate={candidate} />
        ))}
      </Flex>
    </Box>
  );
}
