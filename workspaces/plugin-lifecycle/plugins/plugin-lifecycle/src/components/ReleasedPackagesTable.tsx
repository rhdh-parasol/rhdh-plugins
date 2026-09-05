/* Copyright Red Hat, Inc. */
import {
  Cell,
  CellText,
  Flex,
  Link,
  Table,
  Text,
  type ColumnConfig,
} from '@backstage/ui';
import type { Delivery } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  catalogEntityHref,
  imageReferenceParts,
  shortPackageName,
} from '../utils/lifecyclePresentation';
import { CopyReferenceButton } from './CopyReferenceButton';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import deliveryStyles from './Delivery.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

type ReleasedPackageRow = Delivery['releasedPackages'][number] & { id: string };

export function ReleasedPackagesTable({
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
                  className={sharedStyles.minWidthZero}
                >
                  <Text
                    variant="body-small"
                    weight="bold"
                    className={deliveryStyles.tableImage}
                    title={pkg.ociReference}
                  >
                    {image.name}
                  </Text>
                  {image.version && (
                    <Text
                      variant="body-x-small"
                      color="secondary"
                      className={deliveryStyles.tableImageVersion}
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
      className={deliveryStyles.packageTable}
    />
  );
}
