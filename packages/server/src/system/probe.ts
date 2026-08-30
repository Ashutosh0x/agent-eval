/**
 * Running system probes.
 *
 * Every fact this module produces is either measured or explicitly absent.
 * There is no default value anywhere, and that is the whole design: a
 * capability report that guesses is worse than one that says "unknown",
 * because an operator acts on it. If nvidia-smi is missing, the answer is
 * "nvidia-smi is not installed" — not "0 GPUs", which reads like a working
 * probe that found nothing.
 *
 * Commands are executed with a fixed argument vector and never through a
 * shell. Nothing here interpolates caller input into a command line: these
 * probes are reachable from an authenticated HTTP route, and a shell string
 * built from a request parameter is how that becomes remote code execution.
 */

import { execFile } from 'node:child_process';

/**
 * The result of trying to learn one fact.
 *
 * `unavailable` means the probe ran and the thing is not there. `unknown`
 * means the probe could not run, or answered in a shape this code does not
 * understand — a distinction that matters when someone is debugging why their
 * GPU is not detected.
 */
export type Probe<T> =
  | { status: 'ok'; value: T }
  | { status: 'unavailable'; reason: string }
  | { status: 'unknown'; reason: string };

export const ok = <T>(value: T): Probe<T> => ({ status: 'ok', value });
export const unavailable = <T>(reason: string): Probe<T> => ({ status: 'unavailable', reason });
export const unknown = <T>(reason: string): Probe<T> => ({ status: 'unknown', reason });

/** The value if the probe succeeded, otherwise undefined. */
export function valueOf<T>(probe: Probe<T>): T | undefined {
  return probe.status === 'ok' ? probe.value : undefined;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a command and capture its output.
 *
 * Resolves rather than throws on a non-zero exit, because for a probe a
 * failure is data. A missing binary is reported as ENOENT so the caller can
 * distinguish "not installed" from "installed and unhappy".
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult | { error: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        // Probes must not be able to hang a request. Ten seconds is generous
        // for nvidia-smi and short enough that a wedged binary is noticed.
        timeout: options.timeoutMs ?? 10_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolve({ error: `${command} is not installed or not on PATH` });
            return;
          }
          if (code === 'ETIMEDOUT') {
            resolve({ error: `${command} did not respond within the probe timeout` });
            return;
          }
          // A non-zero exit still carries output worth keeping.
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : 1,
          });
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
      },
    );
  });
}

export function isError(
  result: CommandResult | { error: string },
): result is { error: string } {
  return 'error' in result;
}

/**
 * Run a command and map its first line of output.
 *
 * The common shape: a probe that either produces one useful line or tells you
 * why it could not.
 */
export async function probeCommand<T>(
  command: string,
  args: readonly string[],
  parse: (stdout: string) => T | undefined,
  options: RunOptions = {},
): Promise<Probe<T>> {
  const result = await run(command, args, options);
  if (isError(result)) return unavailable(result.error);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    return unavailable(`${command} exited ${result.code}${detail ? `: ${detail}` : ''}`);
  }
  const parsed = parse(result.stdout);
  if (parsed === undefined) {
    return unknown(`${command} produced output this build does not recognise`);
  }
  return ok(parsed);
}

/** First non-empty trimmed line, the usual shape of a version probe. */
export function firstLine(stdout: string): string | undefined {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line || undefined;
}
