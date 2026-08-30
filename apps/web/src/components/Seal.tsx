/**
 * The seal.
 *
 * Not a badge. A badge shows a conclusion; this shows its working — the
 * reconstructed root next to the expected one, the signing key, and for a
 * broken chain the specific entry where the break occurs. That distinction is
 * the product: an auditor who is told "verified" has learned nothing, and one
 * who can see the arithmetic has.
 *
 * Four states, and each carries colour + icon + word + shape. Colour alone
 * fails WCAG 1.4.1, and fails harder on the monochrome printout this ends up
 * as. The ring style is what survives greyscale.
 */

import { CircleDashed, HelpCircle, Stamp, Unlink } from 'lucide-react';
import { useState } from 'react';

export type SealState = 'sealed' | 'pending' | 'broken' | 'unverifiable';

export interface SealProps {
  state: SealState;
  /** The checks behind the verdict, shown when expanded. */
  detail?: {
    signature?: boolean;
    chain?: boolean;
    inclusion?: boolean;
    keyId?: string;
    expectedRoot?: string;
    computedRoot?: string;
    brokenAt?: number;
    failures?: string[];
  };
  onVerify?: () => void;
}

const PRESENTATION: Record<
  SealState,
  { label: string; Icon: typeof Stamp; ring: string; text: string }
> = {
  sealed: {
    label: 'Verified',
    Icon: Stamp,
    ring: 'ring-2 ring-[var(--sealed)]',
    text: 'text-[var(--sealed)]',
  },
  pending: {
    label: 'Unverified',
    Icon: CircleDashed,
    ring: 'ring-2 ring-dashed ring-[var(--pending)]',
    text: 'text-[var(--pending)]',
  },
  broken: {
    label: 'Chain broken',
    Icon: Unlink,
    // A visible gap in the ring, so the state survives greyscale printing.
    ring: 'ring-2 ring-[var(--broken)] ring-offset-2 ring-offset-[var(--surface)]',
    text: 'text-[var(--broken)]',
  },
  unverifiable: {
    label: 'Cannot verify',
    Icon: HelpCircle,
    ring: 'ring-1 ring-[var(--border)]',
    text: 'text-[var(--text-muted)]',
  },
};

export function Seal({ state, detail, onVerify }: SealProps) {
  const [open, setOpen] = useState(false);
  const { label, Icon, ring, text } = PRESENTATION[state];

  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) onVerify?.();
        }}
        aria-expanded={open}
        className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${ring} ${text} bg-[var(--surface-raised)] text-sm font-medium`}
      >
        <Icon className="size-4" aria-hidden="true" />
        <span>{label}</span>
        <span className="text-xs opacity-60 no-print">{open ? 'hide' : 'show working'}</span>
      </button>

      {open && detail ? (
        <dl className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-sm space-y-2 min-w-[22rem]">
          <Check label="Ed25519 signature" ok={detail.signature} />
          <Check label="Hash chain" ok={detail.chain} />
          <Check label="Merkle inclusion (RFC 6962)" ok={detail.inclusion} />

          {detail.keyId ? (
            <Row label="Signed by">
              <span className="font-mono text-xs">{detail.keyId}</span>
            </Row>
          ) : null}

          {detail.expectedRoot ? (
            <Row label="Expected root">
              <span className="font-mono text-xs break-all">{detail.expectedRoot}</span>
            </Row>
          ) : null}

          {detail.computedRoot && detail.computedRoot !== detail.expectedRoot ? (
            <Row label="Computed root">
              <span className="font-mono text-xs break-all text-[var(--broken)]">
                {detail.computedRoot}
              </span>
            </Row>
          ) : null}

          {detail.brokenAt !== undefined ? (
            <p className="text-[var(--broken)] pt-1">
              The chain breaks at entry <span className="font-mono">{detail.brokenAt}</span>. Every
              entry before it still verifies.
            </p>
          ) : null}

          {detail.failures?.length ? (
            <ul className="pt-1 space-y-1">
              {detail.failures.map((f) => (
                <li key={f} className="text-[var(--broken)] text-xs">
                  {f}
                </li>
              ))}
            </ul>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function Check({ label, ok }: { label: string; ok?: boolean }) {
  if (ok === undefined) return null;
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className={ok ? 'text-[var(--sealed)]' : 'text-[var(--broken)]'}>
        {/* Word, not just colour. */}
        {ok ? 'pass' : 'fail'}
      </dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1">
      <dt className="text-[var(--text-muted)] text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
