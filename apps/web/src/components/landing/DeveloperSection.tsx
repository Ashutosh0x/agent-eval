/**
 * Developer experience.
 *
 * The terminal shows the CLI's real syntax. That mattered enough to check:
 * the obvious invention — `agent-eval run create --provider anthropic` — is
 * not a command this CLI has. The real one is `runs start` with the manifest
 * fields, because a run that cannot describe itself is refused. Printing a
 * command that does not exist on the page that teaches people the command
 * would be a small lie with an immediate cost.
 *
 * The stack list is likewise only what the repository actually uses. Prisma
 * and a Go supervisor appear in no file; four declared dependencies —
 * recharts, zustand, react-query and date-fns — are imported by zero files,
 * so listing them would describe a package.json rather than a product.
 */

import { Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IllustrativeTag, Panel, Reveal, Section, SectionHeading, SectionLabel } from './primitives';

type Line = { text: string; tone: 'command' | 'output' | 'ok' | 'dim' };

const LINES: Line[] = [
  { text: '$ agent-eval runs start \\', tone: 'command' },
  { text: '    --environment local/ollama \\', tone: 'command' },
  { text: '    --digest sha256:3f3f…3f3f \\', tone: 'command' },
  { text: '    --task-set smoke --task-set-version 1 \\', tone: 'command' },
  { text: '    --verifier manual --verifier-version 1 \\', tone: 'command' },
  { text: '    --model ollama/gemma3:4b \\', tone: 'command' },
  { text: '    --retention eu-ai-act-art-19', tone: 'command' },
  { text: '  run_mtfrc4mv6  queued', tone: 'output' },
  { text: '', tone: 'dim' },
  { text: '$ agent-eval evidence generate run_mtfrc4mv6', tone: 'command' },
  { text: '  bundle_mtfrdeep7', tone: 'output' },
  { text: '  entries    25, 26, 27, 28, 29, 30, 31', tone: 'dim' },
  { text: '  signature  ed25519 / dev-key-1', tone: 'dim' },
  { text: '', tone: 'dim' },
  { text: '$ agent-eval evidence verify bundle.json', tone: 'command' },
  { text: '  PASS  signature', tone: 'ok' },
  { text: '  PASS  entryDigests', tone: 'ok' },
  { text: '  PASS  ordering', tone: 'ok' },
  { text: '  PASS  inclusion', tone: 'ok' },
  { text: '  PASS  manifest', tone: 'ok' },
  { text: '  BUNDLE VALID', tone: 'ok' },
];

/** Only what the repository imports and runs. */
const STACK = [
  'TypeScript',
  'Node',
  'Fastify',
  'Zod',
  'React',
  'Vite',
  'Tailwind',
  'Vitest',
  'pnpm',
  'Turborepo',
];

const SURFACES = [
  { name: 'REST API', detail: '34 routes under /v1, problem+json errors, OpenAPI at /docs' },
  { name: 'TypeScript SDK', detail: 'Typed client; no provider calls, no secret ever returned' },
  { name: 'CLI', detail: 'Runs, providers, credentials, evidence, audit, keys' },
];

export function DeveloperSection() {
  return (
    <Section>
      <SectionLabel index="09">Developer experience</SectionLabel>
      <SectionHeading sub="Three surfaces over one API. The CLI exits non-zero when a check fails, so it is usable as a pipeline gate.">
        Built for engineers.
      </SectionHeading>

      <div className="mt-12 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Reveal className="min-w-0">
          <TerminalPanel />
        </Reveal>

        <div className="space-y-5">
          <Reveal delay={100}>
            <ul className="overflow-hidden rounded-xl border border-[var(--border)]">
              {SURFACES.map((s) => (
                <li
                  key={s.name}
                  className="border-b border-[var(--border)] bg-[var(--surface-raised)] p-4 last:border-0"
                >
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{s.detail}</p>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={160}>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4">
              <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                Stack
              </p>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {STACK.map((tech) => (
                  <li
                    key={tech}
                    className="rounded border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]"
                  >
                    {tech}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </Section>
  );
}

function TerminalPanel() {
  const reduced =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Lines appear one at a time. Not a character-by-character typing effect:
  // that is slow to read, impossible to skim, and the content here is the
  // point rather than the performance.
  const [shown, setShown] = useState(reduced ? LINES.length : 0);

  useEffect(() => {
    if (shown >= LINES.length) return;
    const timer = setTimeout(() => setShown((n) => n + 1), shown < 7 ? 90 : 150);
    return () => clearTimeout(timer);
  }, [shown]);

  return (
    <Panel
      title={
        <>
          <Terminal className="size-3.5" aria-hidden="true" />
          <span>agent-eval CLI</span>
        </>
      }
      aside={<IllustrativeTag />}
    >
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-[1.7]">
        <code>
          {LINES.slice(0, shown).map((line, i) => (
            <span
              key={i}
              className="block"
              style={{
                color:
                  line.tone === 'ok'
                    ? 'var(--sealed)'
                    : line.tone === 'command'
                      ? 'var(--text)'
                      : 'var(--text-muted)',
              }}
            >
              {line.text || ' '}
            </span>
          ))}
        </code>
      </pre>
    </Panel>
  );
}
