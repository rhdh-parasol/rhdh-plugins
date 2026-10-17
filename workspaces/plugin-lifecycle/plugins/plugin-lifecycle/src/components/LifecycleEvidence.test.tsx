/* Copyright Red Hat, Inc. */
import { renderInTestApp } from '@backstage/frontend-test-utils';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { LifecycleEvidence } from './LifecycleEvidence';
import { context } from '../testUtils/lifecycleFixtures';

describe('LifecycleEvidence', () => {
  it('renders the phase rail and uses the event cursor for history', async () => {
    const onViewAt = jest.fn();
    await renderInTestApp(
      <LifecycleEvidence
        context={context}
        onChangeSelected={jest.fn()}
        onViewAt={onViewAt}
      />,
    );
    expect(
      screen.getByText('Lifecycle evidence and history'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Lifecycle phases' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'View state here' }),
    );
    expect(onViewAt).toHaveBeenCalledWith(context.events[0]);
  });
});
