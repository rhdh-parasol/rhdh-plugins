/* Copyright Red Hat, Inc. */
import { isLifecycleEntity } from './isLifecycleEntity';

describe('isLifecycleEntity', () => {
  it('accepts mapped sources without relying on an overlay name prefix', () => {
    expect(
      isLifecycleEntity({
        kind: 'Component',
        relations: [
          {
            type: 'dependencyOf',
            targetRef: 'component:default/adoption-insights-export',
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects unrelated components and non-components', () => {
    expect(
      isLifecycleEntity({ kind: 'Component', spec: { type: 'service' } }),
    ).toBe(false);
    expect(
      isLifecycleEntity({
        kind: 'Plugin',
        spec: { type: 'rhdh-overlay-workspace' },
      }),
    ).toBe(false);
  });
});
