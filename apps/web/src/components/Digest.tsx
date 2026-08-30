/**
 * A hash, rendered so it can be compared and quoted.
 *
 * Truncation uses a middle ellipsis rather than a tail cut. Hashes are
 * compared by their ends — someone checking a digest against a registry looks
 * at the first and last few characters — and cutting the tail removes exactly
 * the half that does the work.
 *
 * The full value stays in the DOM for screen readers and for select-all, so
 * what a person copies is never the truncated form.
 */

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export interface DigestProps {
  value: string;
  /** Characters to show at each end. */
  chars?: number;
  label?: string;
}

export function Digest({ value, chars = 8, label }: DigestProps) {
  const [copied, setCopied] = useState(false);

  const short =
    value.length > chars * 2 + 3
      ? `${value.slice(0, chars)}…${value.slice(-chars)}`
      : value;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard is blocked in some contexts. The full value is selectable
      // in the DOM regardless, so this is a convenience, not the only route.
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      {label ? <span className="text-[var(--text-muted)]">{label}</span> : null}
      <span title={value}>
        {/* Visible truncation, full value for assistive tech and copy. */}
        <span aria-hidden="true">{short}</span>
        <span className="sr-only">{value}</span>
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label ?? 'value'}`}
        className="no-print opacity-50 hover:opacity-100"
      >
        {copied ? (
          <Check className="size-3.5 text-[var(--sealed)]" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
