/**
 * Model providers.
 *
 * The list mirrors the server's provider registry exactly. It is static rather
 * than fetched, and the reason is worth stating: GET /v1/providers requires
 * the runs:read scope, so a public page cannot read it without either
 * weakening that route or shipping a credential to every visitor. Neither is
 * worth a list that changes about once a quarter.
 *
 * What the page must not do — and does not — is imply that these nine are the
 * extent of what can run. There is no model list anywhere in this product;
 * any model id a provider accepts is valid, and the ninth entry exists
 * precisely so that endpoints nobody has named yet are reachable.
 */

import { Boxes, Server } from 'lucide-react';
import { Reveal, Section, SectionHeading, SectionLabel } from './primitives';

interface Provider {
  id: string;
  name: string;
  /** How the platform talks to it, which is the fact an engineer wants. */
  transport: string;
  credential: 'API key' | 'None';
}

const PROVIDERS: Provider[] = [
  { id: 'openai', name: 'OpenAI', transport: 'OpenAI', credential: 'API key' },
  { id: 'anthropic', name: 'Anthropic', transport: 'Anthropic Messages', credential: 'API key' },
  { id: 'xai', name: 'xAI', transport: 'OpenAI-compatible', credential: 'API key' },
  { id: 'google', name: 'Google Gemini', transport: 'generateContent', credential: 'API key' },
  { id: 'deepseek', name: 'DeepSeek', transport: 'OpenAI-compatible', credential: 'API key' },
  { id: 'mistral', name: 'Mistral', transport: 'OpenAI-compatible', credential: 'API key' },
  { id: 'minimax', name: 'MiniMax', transport: 'OpenAI-compatible', credential: 'API key' },
  { id: 'ollama', name: 'Ollama', transport: 'Ollama', credential: 'None' },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible',
    transport: 'Any compatible endpoint',
    credential: 'API key',
  },
];

export function ProvidersSection() {
  return (
    <Section>
      <SectionLabel index="07">Providers</SectionLabel>
      <SectionHeading sub="Nine adapters across four wire formats. Six of them share one transport because they genuinely speak the same protocol, so adding another is a configuration object rather than an implementation.">
        Use the models you already run.
      </SectionHeading>

      <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3">
        {PROVIDERS.map((provider, i) => (
          <Reveal key={provider.id} delay={(i % 3) * 60}>
            <div className="group h-full bg-[var(--surface-raised)] p-5 transition-colors duration-200 hover:bg-[var(--surface)]">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">{provider.name}</p>
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {provider.credential === 'None' ? 'no key' : 'key'}
                </span>
              </div>
              <p className="mt-1 font-mono text-xs text-[var(--text-muted)]">{provider.id}</p>
              <p className="mt-3 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">
                {provider.transport}
              </p>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={120}>
        <div className="mt-6 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5 sm:flex-row sm:items-start">
          <Boxes className="size-5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">No model list, anywhere</p>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-muted)]">
              Not in the server, the SDK, the CLI or this dashboard. Models are discovered from the
              provider at runtime, so a model released this morning is usable this morning. Ask for
              one that does not exist and the error comes back in the provider&rsquo;s own words,
              which is how you can tell nothing local is being consulted.
            </p>
          </div>
        </div>
      </Reveal>

      <Reveal delay={160}>
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5 sm:flex-row sm:items-start">
          <Server className="size-5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">Self-hosted and compatible endpoints</p>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-muted)]">
              Anything speaking the OpenAI dialect works with a base URL — vLLM, LM Studio, Azure
              OpenAI deployments, internal gateways. Ollama needs no credential at all.
            </p>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

/**
 * Local compute.
 *
 * Deliberately short, and deliberately not an NVIDIA advertisement. DGX Spark
 * is a supported place to put compute, not what this product is. Every figure
 * quoted is attributed to NVIDIA documentation and the theoretical one stays
 * labelled theoretical — a page arguing that evidence beats claims cannot
 * quote a peak number as achieved throughput.
 */
export function LocalComputeSection() {
  return (
    <Section>
      <SectionLabel index="08">Local compute</SectionLabel>
      <SectionHeading sub="Serve models on your own hardware and keep the evidence trail. The control plane detects what the machine is, records it into the bundle, and says so plainly when it cannot.">
        Run agent evaluations locally.
      </SectionHeading>

      <div className="mt-12 grid gap-5 lg:grid-cols-[1fr_minmax(0,380px)]">
        <Reveal>
          <div className="h-full rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6">
            <p className="text-sm font-medium">NVIDIA DGX Spark as an evaluation node</p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
              An Arm workstation with an integrated Grace Blackwell GPU, serving models through
              vLLM, TensorRT-LLM, NIM or Ollama while agent-eval records the run. Hardware,
              driver and CUDA versions are probed from the machine and written into the evidence
              bundle, so a reviewer can later establish which system produced a result.
            </p>
            <dl className="mt-5 grid gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3">
              {[
                ['SoC', 'Grace Blackwell GB10'],
                ['Memory', '128 GB LPDDR5x unified'],
                ['Bandwidth', '273 GB/s'],
              ].map(([k, v]) => (
                <div key={k} className="bg-[var(--surface-raised)] p-4">
                  <dt className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                    {k}
                  </dt>
                  <dd className="mt-1.5 text-sm">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
              Specifications published by NVIDIA, not measured by this project. NVIDIA also states
              up to 1 PFLOP at FP4 with sparsity — a peak theoretical figure, which is why it is
              not presented here as performance you will observe.
            </p>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="h-full rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6">
            <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              What the platform detects
            </p>
            <ul className="mt-4 space-y-0">
              {[
                'Architecture and kernel',
                'GPU, compute capability, driver',
                'CUDA toolkit or driver maximum',
                'NVIDIA container runtime',
                'Runtime endpoints that answered',
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2.5 border-b border-[var(--border)] py-2 text-sm last:border-0"
                >
                  <span
                    className="inline-block size-1.5 shrink-0 rounded-full"
                    style={{ background: 'var(--sealed)' }}
                    aria-hidden="true"
                  />
                  <span className="text-[var(--text-muted)]">{item}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-[var(--border)] pt-3 text-xs leading-relaxed text-[var(--text-muted)]">
              A host that is not a DGX Spark reports that, with the reason, and keeps working
              against remote providers.
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
