/* Copyright Red Hat, Inc. */
import { Box, Flex, Link, Text } from '@backstage/ui';
import { RiExternalLinkLine } from '@remixicon/react';
import { shortImageReference } from '../utils/lifecyclePresentation';
import { CopyReferenceButton } from './CopyReferenceButton';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import deliveryStyles from './Delivery.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

export function OciReference({
  reference,
  label,
  href,
}: {
  reference: string;
  label: string;
  href?: string;
}) {
  return (
    <Box className={deliveryStyles.ociReference}>
      <Flex justify="between" align="center" gap="2">
        <Text
          variant="body-x-small"
          color="secondary"
          weight="bold"
          className={sharedStyles.eyebrow}
        >
          {label}
        </Text>
        <CopyReferenceButton reference={reference} />
      </Flex>
      <Box as="code" className={deliveryStyles.ociValue} title={reference}>
        {href ? (
          <Link
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            variant="body-small"
          >
            {shortImageReference(reference)}{' '}
            <RiExternalLinkLine size={13} aria-hidden="true" />
          </Link>
        ) : (
          shortImageReference(reference)
        )}
      </Box>
    </Box>
  );
}
