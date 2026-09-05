/* Copyright Red Hat, Inc. */
import { Button } from '@backstage/ui';
import { useEffect, useRef, useState } from 'react';

export function CopyReferenceButton({ reference }: { reference: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <Button
      size="small"
      variant="tertiary"
      onPress={async () => {
        if (!window.navigator.clipboard) return;
        try {
          await window.navigator.clipboard.writeText(reference);
          setCopied(true);
          if (resetTimer.current) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={`Copy ${reference}`}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
