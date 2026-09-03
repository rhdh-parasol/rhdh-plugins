/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  Alert,
  Accordion,
  AccordionPanel,
  AccordionTrigger,
  Badge,
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Cell,
  CellText,
  Flex,
  Link,
  Select,
  SelectItemText,
  Skeleton,
  Table,
  Text,
  type ColumnConfig,
} from '@backstage/ui';
import type {
  LifecycleContext,
  Delivery,
  LifecycleEvent,
  LifecyclePhase,
  LifecycleProjection,
  LifecycleState,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  RiArchiveLine,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiGitBranchLine,
  RiHistoryLine,
  RiLoader4Line,
  RiProhibitedLine,
  RiRefreshLine,
} from '@remixicon/react';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  useLifecycleContext,
  type LifecycleRefreshResult,
} from './useLifecycleContext';
import { isLifecycleEntity } from '../lifecycleEntity';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './EntityPluginLifecycleContent.module.css';

const phases: Array<{ id: LifecyclePhase; label: string }> = [
  { id: 'intent', label: 'Intent' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'build', label: 'Build' },
  { id: 'verification', label: 'Verification' },
  { id: 'publication', label: 'Publication' },
];

const stateLabels: Record<LifecycleState, string> = {
  pending: 'Pending',
  running: 'Running',
  blocked: 'Blocked',
  ready_for_human: 'Ready for human',
  failed: 'Failed',
  succeeded: 'Succeeded',
  superseded: 'Superseded',
};

function catalogEntityHref(entityRef: string): string {
  const parsed = parseEntityRef(entityRef);
  return `/catalog/${parsed.namespace}/${parsed.kind}/${parsed.name}`;
}

function shortRevision(revision?: string): string | undefined {
  return revision ? revision.slice(0, 12) : undefined;
}

function publishStatusLabel(
  status: Delivery['activeCandidates'][number]['publishStatus'],
): string {
  switch (status) {
    case 'unknown':
      return 'Publish unknown';
    case 'success':
      return 'Publish succeeded';
    case 'failure':
      return 'Publish failed';
    case 'running':
      return 'Publish running';
    default:
      return 'Publish pending';
  }
}

function statusIcon(state: LifecycleState): ReactElement {
  const props = { size: 16, 'aria-hidden': true } as const;
  switch (state) {
    case 'succeeded':
      return <RiCheckboxCircleLine {...props} />;
    case 'blocked':
    case 'superseded':
      return <RiProhibitedLine {...props} />;
    case 'failed':
      return <RiErrorWarningLine {...props} />;
    case 'running':
    case 'ready_for_human':
      return <RiLoader4Line {...props} />;
    default:
      return <RiCheckboxBlankCircleLine {...props} />;
  }
}

function StateBadge({ state }: { state: LifecycleState }) {
  return (
    <Badge
      className={styles.stateBadge}
      data-state={state}
      icon={statusIcon(state)}
    >
      {stateLabels[state]}
    </Badge>
  );
}

function phaseState(
  phase: LifecyclePhase,
  projection: LifecycleProjection,
): LifecycleState | undefined {
  const recorded = projection.phaseStates?.find(entry => entry.phase === phase);
  if (recorded) return recorded.state;
  if (phase !== projection.phase) return undefined;
  return projection.state;
}

function eventSummary(event: LifecycleEvent): string {
  const payload = event.payload;
  switch (payload.kind) {
    case 'change.created':
      return payload.summary ?? payload.title;
    case 'phase.updated':
      return payload.summary;
    case 'reference.linked':
      return payload.reference.title;
    case 'ci.run.recorded':
      return `${payload.run.workflow} · ${
        payload.run.fixture ? 'fixture run' : 'run'
      } ${payload.run.runId} · attempt ${
        payload.run.runAttempt ?? payload.run.runNumber ?? payload.run.attempt
      }`;
    case 'verification.recorded':
      return payload.verification.summary;
    case 'artifact.recorded':
      return payload.artifact.name ?? payload.artifact.reference;
    case 'agent.attempt.recorded':
      return payload.attempt.summary;
    case 'change.superseded':
      return payload.reason;
    default: {
      const exhaustive: never = payload;
      throw new Error(`Unsupported lifecycle event: ${exhaustive}`);
    }
  }
}

function eventState(event: LifecycleEvent): LifecycleState | undefined {
  switch (event.payload.kind) {
    case 'phase.updated':
      return event.payload.state;
    case 'verification.recorded':
      return event.payload.verification.state;
    case 'agent.attempt.recorded':
      return event.payload.attempt.state;
    case 'change.superseded':
      return 'superseded';
    case 'ci.run.recorded':
      if (event.payload.run.status !== 'completed') return 'running';
      return event.payload.run.conclusion === 'success'
        ? 'succeeded'
        : 'failed';
    default:
      return undefined;
  }
}

function eventLink(event: LifecycleEvent): string | undefined {
  switch (event.payload.kind) {
    case 'reference.linked':
      return event.payload.reference.url;
    case 'ci.run.recorded':
      return event.payload.run.url;
    case 'verification.recorded':
      return event.payload.verification.url;
    case 'artifact.recorded':
      return event.payload.artifact.url;
    case 'agent.attempt.recorded':
      return (
        event.payload.attempt.evidenceUrl ?? event.payload.attempt.sessionUrl
      );
    default:
      return undefined;
  }
}

function eventLinkLabel(event: LifecycleEvent): string {
  switch (event.payload.kind) {
    case 'reference.linked':
      switch (event.payload.reference.type) {
        case 'pull_request':
          return 'Open pull request';
        case 'source':
          return 'Open source revision';
        case 'workflow':
          return 'Open workflow run';
        default:
          return 'Open referenced evidence';
      }
    case 'ci.run.recorded':
      return event.payload.run.provider === 'github-commit-status'
        ? `Open ${event.payload.run.jobName ?? 'GitHub'} check`
        : 'Open workspace job';
    case 'verification.recorded':
      return 'Open verification result';
    case 'artifact.recorded':
      return 'Open artifact';
    case 'agent.attempt.recorded':
      return 'Open agent attempt';
    default:
      return 'Open evidence';
  }
}

function eventLabel(event: LifecycleEvent): string {
  if (
    event.payload.kind === 'change.created' &&
    event.actorRef === 'system:plugin-lifecycle'
  ) {
    return 'Lifecycle record imported into RHDH';
  }
  const labels: Record<LifecycleEvent['payload']['kind'], string> = {
    'change.created': 'Change created',
    'phase.updated': 'Phase updated',
    'reference.linked': 'Reference linked',
    'ci.run.recorded': 'CI run recorded',
    'verification.recorded': 'Verification recorded',
    'artifact.recorded': 'Artifact recorded',
    'agent.attempt.recorded': 'Agent attempt recorded',
    'change.superseded': 'Change superseded',
  };
  return labels[event.payload.kind];
}

function formattedTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function PhaseRail({ projection }: { projection: LifecycleProjection }) {
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
              {state ? (
                statusIcon(state)
              ) : (
                <RiCheckboxBlankCircleLine size={16} aria-hidden="true" />
              )}
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

interface ProvenanceNode {
  label: string;
  value?: string;
  detail?: string;
  href?: string;
  fixture?: boolean;
}

function ProvenanceRail({ context }: { context: LifecycleContext }) {
  const projection = context.projection!;
  const source = [...projection.references]
    .reverse()
    .find(reference => reference.type === 'source');
  const pullRequest = [...projection.references]
    .reverse()
    .find(reference => reference.type === 'pull_request');
  const ociArtifact = [...projection.artifacts]
    .reverse()
    .find(artifact => artifact.artifactType === 'oci');
  const packageArtifact =
    [...projection.artifacts]
      .reverse()
      .find(artifact => artifact.artifactType === 'npm') ?? ociArtifact;
  const nodes: ProvenanceNode[] = [
    {
      label: 'Source',
      value:
        projection.winningRun?.commitSha?.slice(0, 12) ??
        source?.externalId?.slice(0, 12),
      detail: source?.title,
      href: source?.url,
    },
    {
      label: 'Pull request',
      value: pullRequest?.externalId,
      detail: pullRequest?.title,
      href: pullRequest?.url,
    },
    {
      label: 'Winning run',
      value: projection.winningRun?.runId,
      detail: projection.winningRun
        ? `${projection.winningRun.workflow} · attempt ${
            projection.winningRun.runAttempt ??
            projection.winningRun.runNumber ??
            projection.winningRun.attempt
          }`
        : undefined,
      href: projection.winningRun?.url,
      fixture: projection.winningRun?.fixture,
    },
    {
      label: 'Package',
      value: packageArtifact?.version,
      detail: packageArtifact?.name,
      href: packageArtifact?.url,
    },
    {
      label: 'OCI artifact',
      value: ociArtifact?.digest?.slice(0, 20),
      detail: ociArtifact?.reference,
      href: ociArtifact?.url,
    },
  ];

  return (
    <Card className={styles.provenanceCard}>
      <CardHeader>
        <Flex direction="column" gap="1">
          <Text as="h2" variant="title-small">
            Provenance
          </Text>
          <Text variant="body-small" color="secondary">
            {context.asOf
              ? 'The evidence chain recorded by this time'
              : 'Source, workflow, and Catalog package evidence recorded by RHDH'}
          </Text>
        </Flex>
      </CardHeader>
      <CardBody>
        <Box as="ol" className={styles.provenanceRail}>
          {nodes.map((node, index) => (
            <Box
              as="li"
              key={node.label}
              className={styles.provenanceNode}
              data-present={Boolean(node.value || node.detail) || undefined}
              data-last={index === nodes.length - 1 || undefined}
            >
              <Box
                as="span"
                className={styles.provenanceGlyph}
                aria-hidden="true"
              >
                {node.value || node.detail ? (
                  <RiCheckboxCircleLine size={17} />
                ) : (
                  <RiCheckboxBlankCircleLine size={17} />
                )}
              </Box>
              <Flex
                direction="column"
                gap="0.5"
                className={styles.minWidthZero}
              >
                <Text
                  as="span"
                  variant="body-x-small"
                  color="secondary"
                  weight="bold"
                  className={styles.eyebrow}
                >
                  {node.label}
                </Text>
                {node.value || node.detail ? (
                  <>
                    {node.href ? (
                      <Link
                        href={node.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body-small"
                        weight="bold"
                        className={styles.breakable}
                      >
                        {node.value ?? node.detail}{' '}
                        <RiExternalLinkLine size={13} aria-hidden="true" />
                      </Link>
                    ) : (
                      <Text
                        variant="body-small"
                        weight="bold"
                        className={styles.breakable}
                      >
                        {node.value ?? node.detail}
                      </Text>
                    )}
                    {node.value && node.detail && (
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className={styles.breakable}
                      >
                        {node.detail}
                      </Text>
                    )}
                    {node.fixture && <Badge>Fixture data</Badge>}
                  </>
                ) : (
                  <Text variant="body-small" color="secondary">
                    Evidence not recorded
                  </Text>
                )}
              </Flex>
            </Box>
          ))}
        </Box>

        {context.relatedEntities
          .filter(entity => entity.role === 'package')
          .map(pkg => (
            <Box key={pkg.entityRef} className={styles.packageSummary}>
              <Text
                as="span"
                variant="body-x-small"
                color="secondary"
                weight="bold"
                className={styles.eyebrow}
              >
                Current Catalog package
              </Text>
              <Text variant="body-small" weight="bold">
                {pkg.packageName ?? pkg.title ?? pkg.name}
              </Text>
              <Flex gap="1" className={styles.badgeRow}>
                {pkg.version && <Badge>{`v${pkg.version}`}</Badge>}
                {pkg.support && <Badge>{pkg.support}</Badge>}
                {pkg.supportedVersions.map(version => (
                  <Badge key={version}>{`Backstage ${version}`}</Badge>
                ))}
              </Flex>
            </Box>
          ))}
      </CardBody>
    </Card>
  );
}

function LastSuccessfulPublication({
  publication,
}: {
  publication: NonNullable<LifecycleContext['lastSuccessfulPublication']>;
}) {
  const ociArtifacts = publication.artifacts.filter(
    artifact => artifact.artifactType === 'oci',
  );
  return (
    <Card>
      <CardHeader>
        <Flex direction="column" gap="1">
          <Text as="h2" variant="title-small">
            Last attested publication
          </Text>
          <Text variant="body-small" color="secondary">
            Persisted publication evidence from a lifecycle change. This is
            separate from the current Extensions Catalog baseline.
          </Text>
        </Flex>
      </CardHeader>
      <CardBody>
        <Flex direction="column" gap="3">
          <Flex gap="2" align="center">
            <Badge icon={<RiCheckboxCircleLine aria-hidden="true" />}>
              Succeeded
            </Badge>
            {publication.run?.fixture && (
              <Badge>Fixture data — not a real CI run</Badge>
            )}
            <Text variant="body-small" weight="bold">
              {publication.change.title}
            </Text>
            <PublicationBuildLink run={publication.run} />
          </Flex>
          {ociArtifacts.length > 0 ? (
            <Flex direction="column" gap="2">
              <Text variant="body-small" weight="bold">
                Published OCI images
              </Text>
              {ociArtifacts.map(artifact => (
                <Flex
                  key={`${artifact.reference}:${artifact.digest ?? ''}`}
                  direction="column"
                  gap="0.5"
                  className={styles.minWidthZero}
                >
                  {artifact.url ? (
                    <Link
                      href={artifact.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="body-small"
                      className={styles.breakable}
                    >
                      {artifact.name ?? artifact.reference}{' '}
                      <RiExternalLinkLine size={13} aria-hidden="true" />
                    </Link>
                  ) : (
                    <Text
                      variant="body-small"
                      weight="bold"
                      className={styles.breakable}
                    >
                      {artifact.name ?? artifact.reference}
                    </Text>
                  )}
                  {artifact.version && (
                    <Text variant="body-x-small" color="secondary">
                      Version {artifact.version}
                    </Text>
                  )}
                  {artifact.digest && (
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className={styles.breakable}
                    >
                      Digest {artifact.digest}
                    </Text>
                  )}
                </Flex>
              ))}
            </Flex>
          ) : (
            <Text variant="body-small" color="secondary">
              No digest-pinned OCI image was recorded for this successful
              change.
            </Text>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}

function Timeline(props: {
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
        {props.events.length === 0 ? (
          <Alert
            status="info"
            icon
            title="No evidence in this view"
            description="No events were recorded by the selected historical time."
          />
        ) : (
          <Box as="ol" className={styles.timeline}>
            {props.events.map((event, index) => {
              const state = eventState(event);
              const href = eventLink(event);
              return (
                <Box
                  as="li"
                  key={event.eventId}
                  className={styles.timelineItem}
                  data-last={index === props.events.length - 1 || undefined}
                >
                  <Box
                    as="span"
                    className={styles.timelineGlyph}
                    data-state={state}
                    aria-hidden="true"
                  >
                    {state ? statusIcon(state) : <RiGitBranchLine size={17} />}
                  </Box>
                  <Flex
                    direction="column"
                    gap="2"
                    className={styles.minWidthZero}
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
                    <Flex gap="3" align="center" className={styles.actionRow}>
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
                        onPress={() => props.onViewAt(event)}
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

function EmptyPanel(props: {
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
            {props.title}
          </Text>
          <Text color="secondary" className={styles.emptyDescription}>
            {props.description}
          </Text>
          {props.action}
        </Flex>
      </CardBody>
    </Card>
  );
}

function LoadingPanel() {
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

function MappingWarnings({
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

function deliveryStatusLabel(status: Delivery['status']): string {
  switch (status) {
    case 'attention_required':
      return 'Attention required';
    case 'in_progress':
      return 'In progress';
    case 'ready_to_test':
      return 'Ready to test';
    case 'ready_to_merge':
      return 'Ready to merge';
    case 'stable':
      return 'Stable';
    default:
      return 'Unknown';
  }
}

function deliveryStatusIcon(status: Delivery['status']): ReactElement {
  const props = { size: 18, 'aria-hidden': true } as const;
  switch (status) {
    case 'stable':
    case 'ready_to_merge':
      return <RiCheckboxCircleLine {...props} />;
    case 'attention_required':
      return <RiErrorWarningLine {...props} />;
    case 'in_progress':
    case 'ready_to_test':
      return <RiLoader4Line {...props} />;
    default:
      return <RiCheckboxBlankCircleLine {...props} />;
  }
}

function refreshResultSummary(result: LifecycleRefreshResult): string {
  if (result.eventsAdded > 0) {
    return `${result.eventsAdded} new event${
      result.eventsAdded === 1 ? '' : 's'
    }`;
  }
  if (result.changesAdded > 0) {
    return `${result.changesAdded} new change${
      result.changesAdded === 1 ? '' : 's'
    }`;
  }
  return 'no new evidence';
}

function refreshResultMessage(result: LifecycleRefreshResult): string {
  if (result.eventsAdded > 0) {
    return `Stored ${result.eventsAdded} new lifecycle event${
      result.eventsAdded === 1 ? '' : 's'
    } from GitHub.`;
  }
  if (result.changesAdded > 0) {
    return `Found ${result.changesAdded} new lifecycle change${
      result.changesAdded === 1 ? '' : 's'
    } on GitHub.`;
  }
  return 'GitHub was checked successfully; no new matching evidence was found.';
}

function CopyReferenceButton({ reference }: { reference: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="small"
      variant="tertiary"
      onPress={async () => {
        if (!window.navigator.clipboard) return;
        try {
          await window.navigator.clipboard.writeText(reference);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function OciReference({
  reference,
  label,
}: {
  reference: string;
  label: string;
}) {
  return (
    <Box className={styles.ociReference}>
      <Flex justify="between" align="center" gap="2">
        <Text
          variant="body-x-small"
          color="secondary"
          weight="bold"
          className={styles.eyebrow}
        >
          {label}
        </Text>
        <CopyReferenceButton reference={reference} />
      </Flex>
      <Box as="code" className={styles.ociValue} title={reference}>
        {shortImageReference(reference)}
      </Box>
    </Box>
  );
}

function shortImageReference(reference: string): string {
  const normalized = reference.replace(/^oci:\/\//, '');
  return `…/${normalized.slice(normalized.lastIndexOf('/') + 1)}`;
}

function imageReferenceParts(reference: string): {
  name: string;
  version?: string;
} {
  const normalized = reference.replace(/^oci:\/\//, '');
  const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
  const digestIndex = leaf.indexOf('@');
  const tagIndex = leaf.lastIndexOf(':');
  const separator = digestIndex >= 0 ? digestIndex : tagIndex;
  const rawName = separator >= 0 ? leaf.slice(0, separator) : leaf;
  return {
    name: rawName
      .replace(/^red-hat-developer-hub-backstage-plugin-/, '')
      .replace(/^backstage-community-plugin-/, ''),
    version: separator >= 0 ? leaf.slice(separator + 1) : undefined,
  };
}

function shortPackageName(packageName: string): string {
  return packageName
    .replace(/^@[^/]+\//, '')
    .replace(/^(backstage-plugin-|rhdh-bsp-)/, '')
    .replace(/^(catalog-backend-module-|catalog-frontend-module-)/, '');
}

type ReleasedPackageRow = Delivery['releasedPackages'][number] & {
  id: string;
};

function ReleasedPackagesTable({
  packages,
}: {
  packages: Delivery['releasedPackages'];
}) {
  const rows: ReleasedPackageRow[] = packages.map(pkg => ({
    ...pkg,
    id: pkg.entityRef,
  }));
  const columns: ColumnConfig<ReleasedPackageRow>[] = [
    {
      id: 'package',
      label: 'Package',
      isRowHeader: true,
      cell: pkg => (
        <Cell>
          <Link
            href={catalogEntityHref(pkg.entityRef)}
            variant="body-small"
            weight="bold"
            title={pkg.packageName ?? pkg.entityRef}
            aria-label={pkg.packageName ?? pkg.entityRef}
          >
            {shortPackageName(pkg.packageName ?? pkg.entityRef)}
          </Link>
        </Cell>
      ),
    },
    {
      id: 'version',
      label: 'Version',
      cell: pkg => <CellText title={pkg.version ?? 'Not listed'} />,
    },
    {
      id: 'support',
      label: 'Support',
      cell: pkg => <CellText title={pkg.support ?? 'Not listed'} />,
    },
    {
      id: 'backstage',
      label: 'Backstage',
      cell: pkg => (
        <CellText title={pkg.supportedVersions.join(', ') || 'Not listed'} />
      ),
    },
    {
      id: 'image',
      label: 'Image',
      minWidth: 260,
      defaultWidth: '2fr',
      cell: pkg => {
        const image = pkg.ociReference
          ? imageReferenceParts(pkg.ociReference)
          : undefined;
        return (
          <Cell>
            {pkg.ociReference && image ? (
              <Flex align="center" justify="between" gap="1">
                <Flex
                  direction="column"
                  gap="0.5"
                  className={styles.minWidthZero}
                >
                  <Text
                    variant="body-small"
                    weight="bold"
                    className={styles.tableImage}
                    title={pkg.ociReference}
                  >
                    {image.name}
                  </Text>
                  {image.version && (
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className={styles.tableImageVersion}
                    >
                      {image.version}
                    </Text>
                  )}
                </Flex>
                <CopyReferenceButton reference={pkg.ociReference} />
              </Flex>
            ) : (
              <Text variant="body-small" color="secondary">
                Not listed
              </Text>
            )}
          </Cell>
        );
      },
    },
  ];
  return (
    <Table
      data={rows}
      columnConfig={columns}
      pagination={{ type: 'none' }}
      className={styles.packageTable}
    />
  );
}

function PublicationBuildLink({
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

function BuildSummary({
  label,
  build,
}: {
  label: string;
  build?: Delivery['mainline']['latestBuild'];
}) {
  if (!build) {
    return (
      <Box className={styles.compactEvidenceRow}>
        <Text variant="body-small" weight="bold">
          {label}
        </Text>
        <Text variant="body-small" color="secondary">
          Not observed
        </Text>
      </Box>
    );
  }
  const successful =
    build.status === 'completed' && build.conclusion === 'success';
  const revision = shortRevision(build.commitSha);
  let buildLinkLabel = 'Open running workspace job';
  if (successful) buildLinkLabel = 'Open successful workspace job';
  else if (build.status === 'completed') {
    buildLinkLabel = 'Inspect failed workspace job';
  }
  return (
    <Box className={styles.deliveryItem}>
      <Flex gap="2" align="center">
        <Badge
          icon={
            successful ? <RiCheckboxCircleLine aria-hidden="true" /> : undefined
          }
        >
          {build.status === 'completed'
            ? build.conclusion ?? 'completed'
            : build.status}
        </Badge>
        <Text variant="body-small" weight="bold">
          {label}
        </Text>
      </Flex>
      <Text
        variant="body-x-small"
        color="secondary"
        className={styles.breakable}
      >
        {build.jobName ?? 'Workspace job'} · run{' '}
        {build.runNumber ?? build.runId}
        {build.runAttempt ? ` · attempt ${build.runAttempt}` : ''}
      </Text>
      <Flex gap="2" className={styles.actionRow} align="center">
        {build.branch && (
          <Badge icon={<RiGitBranchLine aria-hidden="true" />}>
            {build.branch}
          </Badge>
        )}
        {revision &&
          (build.commitUrl ? (
            <Link
              href={build.commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="body-small"
            >
              Commit {revision}{' '}
              <RiExternalLinkLine size={13} aria-hidden="true" />
            </Link>
          ) : (
            <Text variant="body-x-small" color="secondary">
              Commit {revision}
            </Text>
          ))}
      </Flex>
      {build.updatedAt && (
        <Text variant="body-x-small" color="secondary">
          Observed {formattedTime(build.updatedAt)}
        </Text>
      )}
      {build.url && (
        <Link
          href={build.url}
          target="_blank"
          rel="noopener noreferrer"
          variant="body-small"
        >
          {buildLinkLabel} <RiExternalLinkLine size={13} aria-hidden="true" />
        </Link>
      )}
    </Box>
  );
}

function DeliveryOverview({
  delivery,
  action,
  refreshResult,
}: {
  delivery: Delivery;
  action?: ReactElement;
  refreshResult?: LifecycleRefreshResult;
}) {
  const hasMainlineEvidence = Boolean(
    delivery.mainline.latestBuild || delivery.mainline.latestSuccessfulBuild,
  );
  return (
    <Card className={styles.deliveryCard}>
      <CardHeader className={styles.compactCardHeader}>
        <Flex
          direction={{ initial: 'column', md: 'row' }}
          justify="between"
          align={{ initial: 'start', md: 'center' }}
          gap="2"
        >
          <Flex direction="column" gap="1">
            <Text as="h2" variant="body-large" weight="bold">
              Current delivery
            </Text>
            <Flex gap="2" align="center" className={styles.actionRow}>
              <Badge
                className={styles.deliveryStatus}
                data-status={delivery.status}
                icon={deliveryStatusIcon(delivery.status)}
              >
                {deliveryStatusLabel(delivery.status)}
              </Badge>
              {delivery.freshness.lastSuccessAt && (
                <Text variant="body-x-small" color="secondary">
                  Updated {formattedTime(delivery.freshness.lastSuccessAt)}
                </Text>
              )}
              {refreshResult && (
                <Text
                  variant="body-x-small"
                  color="secondary"
                  aria-live="polite"
                >
                  GitHub refresh complete ·{' '}
                  {refreshResultSummary(refreshResult)}
                </Text>
              )}
            </Flex>
          </Flex>
          {action}
        </Flex>
      </CardHeader>
      <CardBody className={styles.compactCardBody}>
        <Flex direction="column" gap="3">
          {delivery.status !== 'stable' &&
            (delivery.status !== 'unknown' || delivery.nextAction) && (
              <Box
                className={styles.decisionPanel}
                data-status={delivery.status}
                role="status"
              >
                <Flex direction="column" gap="1">
                  <Text variant="body-small" weight="bold">
                    {delivery.statusReason}
                  </Text>
                  {delivery.nextAction && (
                    <Text variant="body-small">
                      Next: {delivery.nextAction}
                    </Text>
                  )}
                  {delivery.nextActionUrl && (
                    <Link
                      href={delivery.nextActionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="body-small"
                    >
                      {delivery.nextActionLabel ?? 'Open supporting evidence'}{' '}
                      <RiExternalLinkLine size={13} aria-hidden="true" />
                    </Link>
                  )}
                </Flex>
              </Box>
            )}
          <Box className={styles.deliveryLanes}>
            <Box className={styles.deliveryLane} data-lane="released">
              <Text as="h3" variant="body-large" weight="bold">
                Available in Extensions Catalog (
                {delivery.releasedPackages.length})
              </Text>
              {delivery.releasedPackages.length === 0 ? (
                <Text variant="body-small" color="secondary">
                  No available Package entity is currently mapped to this
                  workspace.
                </Text>
              ) : (
                <ReleasedPackagesTable packages={delivery.releasedPackages} />
              )}
            </Box>
            {delivery.activeCandidates.length > 0 && (
              <Box
                className={styles.deliveryLane}
                data-lane="candidate"
                data-wide={!hasMainlineEvidence || undefined}
              >
                <Text as="h3" variant="body-large" weight="bold">
                  Open candidates
                </Text>
                <Flex direction="column" gap="3">
                  {delivery.activeCandidates.map(candidate => (
                    <Box
                      key={candidate.changeId}
                      className={styles.deliveryItem}
                    >
                      <Flex justify="between" gap="2" align="start">
                        {candidate.pullRequestUrl ? (
                          <Link
                            href={candidate.pullRequestUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="body-small"
                          >
                            {candidate.title}{' '}
                            <RiExternalLinkLine size={13} aria-hidden="true" />
                          </Link>
                        ) : (
                          <Text variant="body-small" weight="bold">
                            {candidate.title}
                          </Text>
                        )}
                      </Flex>
                      {(candidate.author || candidate.pullRequestNumber) && (
                        <Text variant="body-x-small" color="secondary">
                          {candidate.author
                            ? `By ${candidate.author}`
                            : 'Pull request'}
                          {candidate.pullRequestNumber
                            ? ` · #${candidate.pullRequestNumber}`
                            : ''}
                        </Text>
                      )}
                      <Box className={styles.checkGrid}>
                        <Box className={styles.checkSummary}>
                          <Text
                            variant="body-x-small"
                            color="secondary"
                            weight="bold"
                          >
                            Publish
                          </Text>
                          <Badge>
                            {publishStatusLabel(candidate.publishStatus)}
                          </Badge>
                          {candidate.publishUrl && (
                            <Link
                              href={candidate.publishUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              variant="body-small"
                            >
                              View publish check{' '}
                              <RiExternalLinkLine
                                size={13}
                                aria-hidden="true"
                              />
                            </Link>
                          )}
                        </Box>
                        <Box className={styles.checkSummary}>
                          <Text
                            variant="body-x-small"
                            color="secondary"
                            weight="bold"
                          >
                            Smoke test
                          </Text>
                          <Badge>{candidate.smokeTestStatus}</Badge>
                          {candidate.smokeTestUrl && (
                            <Link
                              href={candidate.smokeTestUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              variant="body-small"
                            >
                              View smoke test{' '}
                              <RiExternalLinkLine
                                size={13}
                                aria-hidden="true"
                              />
                            </Link>
                          )}
                        </Box>
                      </Box>
                      {candidate.sourceRevision &&
                        (candidate.sourceUrl ? (
                          <Link
                            href={candidate.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="body-small"
                          >
                            Source {shortRevision(candidate.sourceRevision)}{' '}
                            <RiExternalLinkLine size={13} aria-hidden="true" />
                          </Link>
                        ) : (
                          <Text variant="body-x-small" color="secondary">
                            Source {shortRevision(candidate.sourceRevision)}
                          </Text>
                        ))}
                      {candidate.blocker && (
                        <Text variant="body-small" color="secondary">
                          {candidate.blocker}
                        </Text>
                      )}
                      {candidate.nextAction && (
                        <Flex direction="column" gap="0.5">
                          <Text variant="body-small" color="secondary">
                            Next: {candidate.nextAction}
                          </Text>
                          {candidate.nextActionUrl && (
                            <Link
                              href={candidate.nextActionUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              variant="body-small"
                            >
                              {candidate.nextActionLabel ?? 'Open evidence'}{' '}
                              <RiExternalLinkLine
                                size={13}
                                aria-hidden="true"
                              />
                            </Link>
                          )}
                        </Flex>
                      )}
                      {candidate.candidateImages.length > 0 && (
                        <Flex direction="column" gap="1">
                          <Text variant="body-x-small" weight="bold">
                            Candidate images to test
                          </Text>
                          {candidate.candidateImages.map(image => (
                            <OciReference
                              key={image.reference}
                              label="Candidate OCI image"
                              reference={image.reference}
                            />
                          ))}
                        </Flex>
                      )}
                    </Box>
                  ))}
                </Flex>
              </Box>
            )}
            {hasMainlineEvidence && (
              <Box
                className={styles.deliveryLane}
                data-lane="mainline"
                data-wide={delivery.activeCandidates.length === 0 || undefined}
              >
                <Text as="h3" variant="body-large" weight="bold">
                  Mainline health
                </Text>
                <BuildSummary
                  label="Latest build"
                  build={delivery.mainline.latestBuild}
                />
                <BuildSummary
                  label="Latest successful build"
                  build={delivery.mainline.latestSuccessfulBuild}
                />
              </Box>
            )}
            {(delivery.activeCandidates.length === 0 ||
              !hasMainlineEvidence) && (
              <Flex
                className={styles.deliveryEmptySummary}
                align="center"
                gap="4"
              >
                {delivery.activeCandidates.length === 0 && (
                  <Text variant="body-small">
                    <strong>Open candidates:</strong> None
                  </Text>
                )}
                {!hasMainlineEvidence && (
                  <Text variant="body-small" color="secondary">
                    <strong>Mainline:</strong> No build evidence collected
                  </Text>
                )}
              </Flex>
            )}
          </Box>
        </Flex>
      </CardBody>
    </Card>
  );
}

function EmptyLifecycleEvidence({
  sync,
  refreshing,
  refreshResult,
  onRefresh,
}: {
  sync: LifecycleContext['sync'];
  refreshing: boolean;
  refreshResult?: LifecycleRefreshResult;
  onRefresh?: () => void;
}) {
  let label = 'Not loaded';
  let message = 'Lifecycle data has not been loaded from GitHub yet.';
  let active = false;
  if (refreshing) {
    label = 'Fetching GitHub';
    message =
      'Checking workflow jobs, pull requests, and candidate image evidence.';
    active = true;
  } else if (refreshResult) {
    label = 'Refresh complete';
    message = refreshResultMessage(refreshResult);
  } else if (sync?.status === 'pending') {
    label = 'Queued';
    message = 'Waiting in the initial GitHub collection queue.';
    active = true;
  } else if (sync?.status === 'prioritized') {
    label = 'Next';
    message = 'This plugin has been prioritized and will be collected next.';
    active = true;
  } else if (sync?.status === 'running') {
    label = 'Fetching GitHub';
    message =
      'Checking workflow jobs, pull requests, and candidate image evidence.';
    active = true;
  } else if (sync?.status === 'empty') {
    label = 'Refresh complete';
    message = 'The last GitHub refresh found no matching lifecycle evidence.';
  } else if (sync?.status === 'succeeded') {
    label = 'Refresh complete';
    message =
      'GitHub was checked successfully; no lifecycle events were added.';
  } else if (sync?.status === 'failed') {
    label = 'Refresh failed';
    message =
      sync.errorSummary ?? 'GitHub lifecycle evidence could not be refreshed.';
  } else if (sync?.status === 'rate_limited') {
    label = 'Rate limited';
    message = 'GitHub temporarily limited lifecycle collection.';
  } else if (sync?.bootstrapStatus === 'running') {
    label = 'Queued';
    message = 'Waiting in the initial GitHub collection queue.';
    active = true;
  }
  let refreshLabel = 'Refresh from GitHub';
  if (refreshing) refreshLabel = 'Refreshing…';
  else if (active) refreshLabel = 'Load this plugin now';
  return (
    <Card>
      <CardBody className={styles.compactEvidenceEmpty} aria-live="polite">
        <Flex
          direction={{ initial: 'column', sm: 'row' }}
          align={{ initial: 'start', sm: 'center' }}
          justify="between"
          gap="1"
        >
          <Text as="h2" variant="body-large" weight="bold">
            Lifecycle evidence
          </Text>
          <Flex align="center" gap="2" className={styles.actionRow}>
            <Badge
              icon={active ? <RiLoader4Line aria-hidden="true" /> : undefined}
            >
              {label}
            </Badge>
            <Text variant="body-small" color="secondary">
              {message}
            </Text>
            {onRefresh && sync?.canRefresh !== false && (
              <Button
                variant="secondary"
                size="small"
                iconStart={<RiRefreshLine aria-hidden="true" />}
                isDisabled={refreshing}
                onPress={onRefresh}
              >
                {refreshLabel}
              </Button>
            )}
          </Flex>
        </Flex>
      </CardBody>
    </Card>
  );
}

export function LifecycleDashboard(props: {
  context: LifecycleContext;
  selectedChangeId?: string;
  onChangeSelected: (changeId: string) => void;
  onViewAt: (event: LifecycleEvent) => void;
  onReturnToCurrent: () => void;
  refreshError?: Error;
  refreshResult?: LifecycleRefreshResult;
  loading?: boolean;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  const { context } = props;
  const syncStatus = context.sync?.status;
  const bootstrapRunning = context.sync?.bootstrapStatus === 'running';
  const subjectCollectionActive =
    syncStatus === 'pending' ||
    syncStatus === 'prioritized' ||
    syncStatus === 'running' ||
    (syncStatus === 'never' && bootstrapRunning);
  const refreshLabel = subjectCollectionActive
    ? 'Load this plugin now'
    : 'Refresh from GitHub';
  const refreshAction =
    props.onRefresh &&
    !context.asOf &&
    !context.asOfEventId &&
    context.sync?.canRefresh !== false ? (
      <Button
        variant="primary"
        iconStart={<RiRefreshLine aria-hidden="true" />}
        isDisabled={props.loading}
        onPress={props.onRefresh}
      >
        {props.loading ? 'Refreshing…' : refreshLabel}
      </Button>
    ) : undefined;
  let emptyDescription =
    'Refresh this plugin to collect the latest lifecycle evidence.';
  if (subjectCollectionActive) {
    emptyDescription = 'Initial lifecycle data is being collected.';
  } else if (context.sync?.canRefresh === false) {
    emptyDescription =
      'Synchronization is not configured for this instance, or your permissions are read-only.';
  }
  if (
    context.delivery &&
    (context.changes.length === 0 ||
      !context.selectedChange ||
      !context.projection)
  ) {
    return (
      <Flex direction="column" gap="5">
        <MappingWarnings warnings={context.warnings} />
        <DeliveryOverview
          delivery={context.delivery}
          action={refreshAction}
          refreshResult={props.refreshResult}
        />
        <EmptyLifecycleEvidence
          sync={context.sync}
          refreshing={Boolean(props.loading)}
          refreshResult={props.refreshResult}
          onRefresh={props.onRefresh}
        />
      </Flex>
    );
  }
  if (context.changes.length === 0 || !context.selectedChange) {
    return (
      <EmptyPanel
        title={
          syncStatus === 'never' || subjectCollectionActive
            ? 'Lifecycle data has not been loaded yet.'
            : 'No matching lifecycle evidence was found.'
        }
        description={emptyDescription}
        action={refreshAction}
      />
    );
  }
  if (!context.projection) {
    return (
      <EmptyPanel
        title="No lifecycle state existed at this time"
        description="Choose a later point in the evidence timeline or return to the current state."
        action={
          context.asOf || context.asOfEventId ? (
            <Button
              variant="primary"
              iconStart={<RiRefreshLine aria-hidden="true" />}
              onPress={props.onReturnToCurrent}
            >
              Return to current
            </Button>
          ) : undefined
        }
      />
    );
  }
  const projection = context.projection;
  const selectedChange = context.selectedChange;

  return (
    <Flex direction="column" gap="5">
      <MappingWarnings warnings={context.warnings} />
      {context.delivery && (
        <DeliveryOverview
          delivery={context.delivery}
          action={refreshAction}
          refreshResult={props.refreshResult}
        />
      )}
      {props.loading && context.changes.length > 0 && (
        <Alert
          status="info"
          icon
          title="Fetching fresh evidence from GitHub"
          description="Checking workflow jobs, pull requests, and candidate images. The stored lifecycle remains visible."
          aria-live="polite"
        />
      )}
      {props.refreshError && (
        <Alert
          status="danger"
          icon
          title="Live refresh failed"
          description={`${props.refreshError.message} Showing the last known lifecycle state.`}
          customActions={
            props.onRefresh ?? props.onRetry ? (
              <Button
                variant="secondary"
                size="small"
                onPress={props.onRefresh ?? props.onRetry}
              >
                Retry
              </Button>
            ) : undefined
          }
        />
      )}
      {context.sync?.canRefresh === false && context.sync.stale && (
        <Alert
          status="info"
          icon
          title="Read-only lifecycle context"
          description="You can view stored lifecycle evidence, but synchronization is unavailable or your permissions do not allow a live refresh."
        />
      )}
      {(context.sync?.status === 'failed' ||
        context.sync?.status === 'rate_limited') &&
        context.sync.errorSummary && (
          <Alert
            status="warning"
            icon
            title={
              context.sync.status === 'rate_limited'
                ? 'GitHub refresh is rate limited'
                : 'The last lifecycle refresh failed'
            }
            description="Showing the last known lifecycle state."
          />
        )}
      {context.subject.catalogStatus === 'missing' && (
        <Alert
          status="warning"
          icon
          title="Catalog entity missing"
          description="This plugin is no longer available in the Catalog. Its retained lifecycle history remains readable."
        />
      )}
      {(context.asOf || context.asOfEventId) && (
        <Alert
          status="info"
          icon={<RiHistoryLine aria-hidden="true" />}
          title={
            context.asOf
              ? `Showing state at ${formattedTime(context.asOf)}`
              : `Showing state at event cursor ${context.asOfEventId}`
          }
          description="Live updates are paused."
          customActions={
            <Button
              variant="secondary"
              size="small"
              iconStart={<RiRefreshLine aria-hidden="true" />}
              onPress={props.onReturnToCurrent}
            >
              Return to current
            </Button>
          }
        />
      )}
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
                    className={styles.changeCopy}
                  >
                    <Text
                      as="span"
                      variant="body-x-small"
                      color="secondary"
                      weight="bold"
                      className={styles.eyebrow}
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
                    items={context.changes.map(change => ({
                      id: change.changeId,
                      title: change.title,
                      description: `${
                        stateLabels[
                          context.asOf &&
                          change.changeId === selectedChange.changeId
                            ? projection.state
                            : change.currentState
                        ]
                      }${
                        context.asOf &&
                        change.changeId === selectedChange.changeId
                          ? ' at this time'
                          : ''
                      }`,
                    }))}
                    selectedKey={
                      props.selectedChangeId ?? selectedChange.changeId
                    }
                    onSelectionChange={key => {
                      if (key) props.onChangeSelected(String(key));
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
              <LastSuccessfulPublication
                publication={context.lastSuccessfulPublication}
              />
            )}
            {projection.blocker && (
              <Alert
                status="warning"
                icon={<RiProhibitedLine aria-hidden="true" />}
                title={
                  context.asOf ? 'Blocker at this time' : 'Current blocker'
                }
                description={projection.blocker}
              />
            )}
            <Box className={styles.dashboardGrid}>
              <ProvenanceRail context={context} />
              <Timeline events={context.events} onViewAt={props.onViewAt} />
            </Box>
          </Flex>
        </AccordionPanel>
      </Accordion>
    </Flex>
  );
}

export function EntityPluginLifecycleContent() {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  const [selectedChangeId, setSelectedChangeId] = useState<string>();
  const [asOf, setAsOf] = useState<string>();
  const [asOfEventId, setAsOfEventId] = useState<string>();
  const { data, loading, error, reload, refresh, refreshResult } =
    useLifecycleContext({
      entityRef,
      changeId: selectedChangeId,
      asOf,
      asOfEventId,
    });

  useEffect(() => {
    if (!data) return;

    // A refresh can replace the set of changes (for example, when the page
    // starts with fixture data and the first live GitHub refresh creates a
    // different change). Do not keep sending a removed changeId on later
    // historical requests.
    const selectedChangeStillExists = selectedChangeId
      ? data.changes.some(change => change.changeId === selectedChangeId)
      : false;
    if (selectedChangeId && !selectedChangeStillExists) {
      setSelectedChangeId(data.selectedChange?.changeId);
      setAsOf(undefined);
      setAsOfEventId(undefined);
      return;
    }
    if (!selectedChangeId && data.selectedChange) {
      setSelectedChangeId(data.selectedChange.changeId);
    }
  }, [data, selectedChangeId]);

  if (!isLifecycleEntity(entity)) {
    return (
      <EmptyPanel
        title="Plugin lifecycle is unavailable"
        description="This view is available for mapped source and overlay Components."
      />
    );
  }
  if (loading && !data) return <LoadingPanel />;
  if (error && !data) {
    return (
      <Alert
        status="danger"
        icon
        title="Plugin lifecycle could not be loaded"
        description={error.message}
        customActions={
          <Button variant="secondary" size="small" onPress={reload}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!data) return <LoadingPanel />;

  return (
    <LifecycleDashboard
      context={data}
      selectedChangeId={selectedChangeId}
      onChangeSelected={changeId => {
        setSelectedChangeId(changeId);
        setAsOf(undefined);
        setAsOfEventId(undefined);
      }}
      onViewAt={event => {
        if (event.eventCursor) {
          setAsOf(undefined);
          setAsOfEventId(event.eventCursor);
        } else {
          setAsOf(event.occurredAt);
          setAsOfEventId(undefined);
        }
      }}
      onReturnToCurrent={() => {
        setAsOf(undefined);
        setAsOfEventId(undefined);
      }}
      refreshError={error}
      refreshResult={refreshResult}
      loading={loading}
      onRetry={reload}
      onRefresh={() => void refresh()}
    />
  );
}
