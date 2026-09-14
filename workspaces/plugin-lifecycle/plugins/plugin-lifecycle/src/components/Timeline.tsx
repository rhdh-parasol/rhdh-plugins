/* Copyright Red Hat, Inc. */
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Flex,
  Link,
  Text,
} from '@backstage/ui';
import type { LifecycleEvent } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  RiExternalLinkLine,
  RiGitBranchLine,
  RiHistoryLine,
} from '@remixicon/react';
import {
  eventLabel,
  eventLink,
  eventLinkLabel,
  eventState,
  eventSummary,
  formattedTime,
} from '../utils/lifecyclePresentation';
import { lifecycleStateIcon } from '../utils/lifecycleStatus';
import { StateBadge } from './StateBadge';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './LifecycleEvidence.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

export function Timeline({
  events,
  onViewAt,
}: {
  events: LifecycleEvent[];
  onViewAt: (event: LifecycleEvent) => void;
}) {
  return (
    <Card className={styles.timelineCard}>
      <CardHeader>
        <Flex direction="column" gap="1">
          <Text as="h2" variant="title-small">
            Evidence timeline
          </Text>
          <Text variant="body-small" color="secondary">
            Events are stored once in RHDH
          </Text>
        </Flex>
      </CardHeader>
      <CardBody>
        {events.length === 0 ? (
          <Alert
            status="info"
            icon
            title="No evidence in this view"
            description="No events were recorded by the selected historical time."
          />
        ) : (
          <Box as="ol" className={styles.timeline}>
            {events.map((event, index) => {
              const state = eventState(event);
              const href = eventLink(event);
              return (
                <Box
                  as="li"
                  key={event.eventId}
                  className={styles.timelineItem}
                  data-last={index === events.length - 1 || undefined}
                >
                  <Box
                    as="span"
                    className={styles.timelineGlyph}
                    data-state={state}
                    aria-hidden="true"
                  >
                    {state ? (
                      lifecycleStateIcon(state, 17)
                    ) : (
                      <RiGitBranchLine size={17} />
                    )}
                  </Box>
                  <Flex
                    direction="column"
                    gap="2"
                    className={sharedStyles.minWidthZero}
                  >
                    <Flex
                      direction={{ initial: 'column', sm: 'row' }}
                      align={{ initial: 'start', sm: 'center' }}
                      justify="between"
                      gap="2"
                    >
                      <Flex direction="column" gap="0.5">
                        <Text variant="body-small" weight="bold">
                          {eventLabel(event)}
                        </Text>
                        <time dateTime={event.occurredAt}>
                          <Text
                            as="span"
                            variant="body-x-small"
                            color="secondary"
                          >
                            {formattedTime(event.occurredAt)} · {event.producer}
                          </Text>
                        </time>
                      </Flex>
                      {state && <StateBadge state={state} />}
                    </Flex>
                    <Text variant="body-small">{eventSummary(event)}</Text>
                    {event.payload.kind === 'ci.run.recorded' &&
                      event.payload.run.fixture && (
                        <Badge>Fixture data — not a real CI run</Badge>
                      )}
                    {event.payload.kind === 'phase.updated' &&
                      event.payload.blocker && (
                        <Alert
                          status="warning"
                          icon
                          title="Blocked"
                          description={event.payload.blocker}
                        />
                      )}
                    <Flex
                      gap="3"
                      align="center"
                      className={sharedStyles.actionRow}
                    >
                      {href && (
                        <Link
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="body-small"
                        >
                          {eventLinkLabel(event)}{' '}
                          <RiExternalLinkLine size={13} aria-hidden="true" />
                        </Link>
                      )}
                      <Button
                        size="small"
                        variant="tertiary"
                        iconStart={<RiHistoryLine aria-hidden="true" />}
                        onPress={() => onViewAt(event)}
                      >
                        View state here
                      </Button>
                    </Flex>
                  </Flex>
                </Box>
              );
            })}
          </Box>
        )}
      </CardBody>
    </Card>
  );
}
