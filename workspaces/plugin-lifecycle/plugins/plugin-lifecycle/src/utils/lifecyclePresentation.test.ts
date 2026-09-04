/* Copyright Red Hat, Inc. */
import {
  catalogEntityHref,
  imageReferenceParts,
  phaseState,
  shortImageReference,
} from './lifecyclePresentation';
import type { LifecycleProjection } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

describe('lifecycle presentation helpers', () => {
  it('creates links for catalog and extension entities', () => {
    expect(catalogEntityHref('component:default/example')).toBe(
      '/catalog/default/component/example',
    );
    expect(catalogEntityHref('package:rhdh/example')).toBe(
      '/extensions/packages/rhdh/example',
    );
  });

  it('keeps OCI references readable while preserving tags', () => {
    expect(shortImageReference('quay.io/example/plugin:1.2.3')).toBe(
      '…/plugin:1.2.3',
    );
    expect(imageReferenceParts('quay.io/example/plugin:1.2.3')).toEqual({
      name: 'plugin',
      version: '1.2.3',
    });
  });

  it('does not fabricate phase state when a phase was not observed', () => {
    const projection = {
      phase: 'build',
      state: 'running',
      phaseStates: [],
      references: [],
      ciRuns: [],
      verifications: [],
      artifacts: [],
      agentAttempts: [],
      summary: 'Build',
      updatedAt: '2026-09-01T10:00:00.000Z',
    } as LifecycleProjection;
    expect(phaseState('intent', projection)).toBeUndefined();
    expect(phaseState('build', projection)).toBe('running');
  });
});
