/* Copyright Red Hat, Inc. */
import type {
  Delivery,
  LifecycleState,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiProhibitedLine,
} from '@remixicon/react';
import type { ReactElement } from 'react';

export function lifecycleStateIcon(
  state: LifecycleState,
  size = 16,
): ReactElement {
  const props = { size, 'aria-hidden': true } as const;
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

export function deliveryStatusIcon(status: Delivery['status']): ReactElement {
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
