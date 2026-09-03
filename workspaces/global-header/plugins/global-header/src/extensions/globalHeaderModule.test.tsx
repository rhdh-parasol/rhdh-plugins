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

import { render, screen } from '@testing-library/react';
import { configApiRef } from '@backstage/core-plugin-api';
import { TestApiProvider, mockApis } from '@backstage/test-utils';
import { GlobalHeaderWrapper, HEADER_HEIGHT } from './globalHeaderModule';

jest.mock('@backstage/core-components', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

const mockConfig = mockApis.config({ data: {} });

function renderWrapper(children?: React.ReactNode) {
  return render(
    <TestApiProvider apis={[[configApiRef, mockConfig]]}>
      <GlobalHeaderWrapper extensionComponents={[]} extensionMenuItems={[]}>
        {children}
      </GlobalHeaderWrapper>
    </TestApiProvider>,
  );
}

describe('GlobalHeaderWrapper', () => {
  it('renders the global header and children', () => {
    renderWrapper(<div data-testid="app-content">App content</div>);

    expect(document.getElementById('global-header')).toBeInTheDocument();
    expect(screen.getByTestId('app-content')).toBeInTheDocument();
  });

  it('renders the header before children in DOM order', () => {
    renderWrapper(<div data-testid="app-content">App content</div>);

    const header = document.getElementById('global-header')!;
    const content = screen.getByTestId('app-content');

    // eslint-disable-next-line no-bitwise
    expect(
      header.compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('wraps children in a layout container separate from the header', () => {
    renderWrapper(<div data-testid="app-content">App content</div>);

    const header = document.getElementById('global-header')!;
    const content = screen.getByTestId('app-content');

    // The header (nav) sits directly in the outer Box.
    // Children sit inside an inner Box which is also a child of the outer Box.
    // So: header.parentElement (outer Box) === content.parentElement.parentElement (inner Box's parent).
    const outerBox = header.parentElement!;
    const innerBox = content.parentElement!;
    expect(innerBox).not.toBe(outerBox);
    expect(innerBox.parentElement).toBe(outerBox);
  });

  it('exports HEADER_HEIGHT matching the MUI Toolbar default', () => {
    expect(HEADER_HEIGHT).toBe(64);
  });
});
