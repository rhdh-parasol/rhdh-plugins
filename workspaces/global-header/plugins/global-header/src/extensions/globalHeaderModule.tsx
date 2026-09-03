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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';

import {
  createExtensionInput,
  createFrontendModule,
} from '@backstage/frontend-plugin-api';
import { AppRootWrapperBlueprint } from '@backstage/plugin-app-react';
import { configApiRef, useApi } from '@backstage/core-plugin-api';

import Box from '@mui/material/Box';
import GlobalStyles from '@mui/material/GlobalStyles';

import { GlobalHeaderProvider } from './GlobalHeaderContext';
import { GlobalHeader } from '../components/GlobalHeader';
import {
  globalHeaderComponentDataRef,
  globalHeaderMenuItemDataRef,
} from './dataRefs';
import type {
  GlobalHeaderComponentData,
  GlobalHeaderMenuItemData,
} from '../types';
import { readConfigMenuItems } from '../utils/readConfigMenuItems';
import { readConfigComponents } from '../utils/readConfigComponents';

/**
 * Fallback height in px used before the header is measured at runtime.
 * Matches the MUI Toolbar default `minHeight` at `@media (min-width: 600px)`.
 * The wrapper dynamically measures the actual rendered height so the sidebar
 * offset stays correct regardless of theme or viewport.
 * @internal
 */
export const HEADER_HEIGHT = 64;

/**
 * CSS custom property name set on `document.documentElement` so that global
 * style overrides can reference the measured header height reactively.
 */
const HEADER_HEIGHT_VAR = '--global-header-height';

/**
 * Global CSS override that pushes the Backstage sidebar drawer below the
 * header. Uses a global selector (not a descendant selector) with
 * `!important` so the rule wins regardless of CSS specificity, cascade
 * ordering, or whether the sidebar drawer is rendered via a React portal
 * outside the wrapper's DOM subtree.
 *
 * Defined as a module-level constant to avoid re-creating the object on
 * every render.
 */
const sidebarDrawerStyles = {
  'div[class*="BackstageSidebar-drawer"]': {
    top: `var(${HEADER_HEIGHT_VAR}, ${HEADER_HEIGHT}px) !important`,
  },
} as const;

/**
 * Wrapper component that renders the global header above the app content
 * and applies layout offsets so the sidebar is not obscured.
 * @internal Exported for testing only.
 */
export function GlobalHeaderWrapper({
  extensionComponents,
  extensionMenuItems,
  children,
}: PropsWithChildren<{
  extensionComponents: GlobalHeaderComponentData[];
  extensionMenuItems: GlobalHeaderMenuItemData[];
}>) {
  const configApi = useApi(configApiRef);
  const configComponents = useMemo(
    () => readConfigComponents(configApi),
    [configApi],
  );
  const allComponents = useMemo(
    () =>
      [...extensionComponents, ...configComponents].sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
      ),
    [extensionComponents, configComponents],
  );
  const configMenuItems = useMemo(
    () => readConfigMenuItems(configApi),
    [configApi],
  );
  const allMenuItems = useMemo(
    () =>
      [...extensionMenuItems, ...configMenuItems].sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
      ),
    [extensionMenuItems, configMenuItems],
  );
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(HEADER_HEIGHT);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return undefined;

    const setVar = (h: number) =>
      document.documentElement.style.setProperty(HEADER_HEIGHT_VAR, `${h}px`);

    const update = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) {
        setHeaderHeight(h);
        setVar(h);
      }
    };

    // Publish the fallback immediately so the sidebar is offset even
    // before the first measurement resolves.
    setVar(HEADER_HEIGHT);

    // Measure immediately, then track resize changes.
    update();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update);
      observer.observe(el);
      return () => {
        observer.disconnect();
        document.documentElement.style.removeProperty(HEADER_HEIGHT_VAR);
      };
    }

    return () => {
      document.documentElement.style.removeProperty(HEADER_HEIGHT_VAR);
    };
  }, []);

  return (
    <GlobalHeaderProvider components={allComponents} menuItems={allMenuItems}>
      <GlobalStyles styles={sidebarDrawerStyles} />
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          '.techdocs-reader-page > main': {
            height: 'unset',
          },
        }}
      >
        <Box ref={headerRef} sx={{ flexShrink: 0 }}>
          <GlobalHeader />
        </Box>
        <Box
          sx={{
            display: 'flex',
            flexGrow: 1,
            maxHeight: `calc(100vh - ${headerHeight}px)`,
          }}
        >
          {children}
        </Box>
      </Box>
    </GlobalHeaderProvider>
  );
}

/**
 * Wrapper extension that collects header component and menu item extensions,
 * merges config-driven items from `globalHeader.components` and
 * `globalHeader.menuItems`, and renders them in a global header bar at the
 * top of the app.
 */
const globalHeaderExtension = AppRootWrapperBlueprint.makeWithOverrides({
  name: 'global-header',
  inputs: {
    components: createExtensionInput([globalHeaderComponentDataRef]),
    menuItems: createExtensionInput([globalHeaderMenuItemDataRef]),
  },
  factory(originalFactory, { inputs }) {
    const extensionComponents = inputs.components
      .map(c => c.get(globalHeaderComponentDataRef))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    const extensionMenuItems = inputs.menuItems.map(m =>
      m.get(globalHeaderMenuItemDataRef),
    );

    return originalFactory({
      component: ({ children }) => (
        <GlobalHeaderWrapper
          extensionComponents={extensionComponents}
          extensionMenuItems={extensionMenuItems}
        >
          {children}
        </GlobalHeaderWrapper>
      ),
    });
  },
});

/**
 * Frontend module that provides the global header system.
 * Registers a wrapper extension with input slots for toolbar components
 * and dropdown menu items.
 *
 * Uses `pluginId: 'app'` because the `wrappers` input on `app/root` is
 * marked `internal: true`, restricting attachments to extensions from the
 * `app` plugin.
 *
 * @public
 */
export const globalHeaderModule = createFrontendModule({
  pluginId: 'app',
  extensions: [globalHeaderExtension],
});
