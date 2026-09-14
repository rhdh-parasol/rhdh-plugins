/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import {
  Accordion,
  AccordionPanel,
  AccordionTrigger,
  Alert,
  Box,
  Card,
  CardBody,
  CardHeader,
  Flex,
  Select,
  SelectItemText,
  Text,
} from '@backstage/ui';
import type {
  LifecycleContext,
  LifecycleEvent,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { RiProhibitedLine } from '@remixicon/react';
import {
  externalStatusLabel,
  stateLabels,
} from '../utils/lifecyclePresentation';
import { EmptyLifecycleEvidence } from './EmptyLifecycleEvidence';
import { LastSuccessfulBuild } from './LastSuccessfulBuild';
import { PhaseRail } from './PhaseRail';
import { ProvenanceRail } from './ProvenanceRail';
import { Timeline } from './Timeline';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './EntityPluginLifecycleContent.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

export function LifecycleEvidence({
  context,
  selectedChangeId,
  onChangeSelected,
  onViewAt,
}: {
  context: LifecycleContext;
  selectedChangeId?: string;
  onChangeSelected: (changeId: string) => void;
  onViewAt: (event: LifecycleEvent) => void;
}) {
  const selectableChanges = context.changes.filter(
    change => change.scope !== 'branch',
  );
  const selectedChange =
    context.selectedChange?.scope === 'branch'
      ? undefined
      : context.selectedChange;
  if (!selectedChange || !context.projection)
    return <EmptyLifecycleEvidence sync={context.sync} refreshing={false} />;
  const projection = context.projection;
  return (
    <Accordion defaultExpanded className={styles.evidenceAccordion}>
      <AccordionTrigger
        title="Lifecycle evidence and history"
        subtitle="Inspect raw lifecycle events, provenance, and historical state"
      />
      <AccordionPanel>
        <Flex direction="column" gap="3">
          <Card>
            <CardHeader>
              <Flex
                direction={{ initial: 'column', md: 'row' }}
                justify="between"
                align={{ initial: 'stretch', md: 'start' }}
                gap="2"
              >
                <Flex
                  direction="column"
                  gap="1"
                  className={sharedStyles.changeCopy}
                >
                  <Text
                    as="span"
                    variant="body-x-small"
                    color="secondary"
                    weight="bold"
                    className={sharedStyles.eyebrow}
                  >
                    Overlay workspace change
                  </Text>
                  <Text as="h2" variant="title-small">
                    {selectedChange.title}
                  </Text>
                  <Text variant="body-small" color="secondary">
                    {projection.summary}
                  </Text>
                </Flex>
                <Select
                  label="Change"
                  items={selectableChanges.map(change => ({
                    id: change.changeId,
                    title: change.title,
                    description: [
                      externalStatusLabel(change.externalStatus),
                      stateLabels[
                        context.asOf &&
                        change.changeId === selectedChange.changeId
                          ? projection.state
                          : change.currentState
                      ],
                      context.asOf &&
                      change.changeId === selectedChange.changeId
                        ? 'at this time'
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                  selectedKey={selectedChangeId ?? selectedChange.changeId}
                  onSelectionChange={key => {
                    if (key) onChangeSelected(String(key));
                  }}
                  className={styles.changeSelect}
                >
                  {item => (
                    <SelectItemText
                      id={item.id}
                      title={item.title}
                      description={item.description}
                    />
                  )}
                </Select>
              </Flex>
            </CardHeader>
            <CardBody className={styles.phaseBody}>
              <Flex direction="column" gap="2">
                <Text variant="body-x-small" color="secondary">
                  Only stages backed by collected evidence are marked.
                </Text>
                <PhaseRail projection={projection} />
              </Flex>
            </CardBody>
          </Card>
          {!context.asOf && context.lastSuccessfulPublication && (
            <LastSuccessfulBuild
              publication={context.lastSuccessfulPublication}
            />
          )}
          {projection.blocker && (
            <Alert
              status="warning"
              icon={<RiProhibitedLine aria-hidden="true" />}
              title={context.asOf ? 'Blocker at this time' : 'Current blocker'}
              description={projection.blocker}
            />
          )}
          <Box className={styles.dashboardGrid}>
            <ProvenanceRail context={context} />
            <Timeline events={context.events} onViewAt={onViewAt} />
          </Box>
        </Flex>
      </AccordionPanel>
    </Accordion>
  );
}
