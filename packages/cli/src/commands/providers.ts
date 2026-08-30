/**
 * Provider and credential commands.
 *
 * `providers test` performs a real request and reports what came back. It has
 * no success path that does not involve the provider answering — which is the
 * whole reason it is slower than it looks like it should be.
 *
 * `models list` asks the provider. When a provider has no listing API the
 * command says so and tells you to pass the id directly, because a model id
 * this CLI has never heard of is still a valid model id.
 */

import chalk from 'chalk';
import { Command } from 'commander';
import { createClient } from '../client';

export const providersCommand = new Command('providers').description(
  'Inspect model providers and their credentials',
);

providersCommand
  .command('list')
  .description('List registered providers and whether each has a credential')
  .action(async () => {
    const { encryptionConfigured, items } = await createClient().providers.list();

    if (!encryptionConfigured) {
      console.log(
        chalk.yellow(
          'Credential encryption is not configured; new credentials cannot be stored.\n' +
            'Set AGENT_EVAL_ENCRYPTION_KEY on the server to 64 hex characters.\n',
        ),
      );
    }

    for (const p of items) {
      const credential = !p.requiresApiKey
        ? 'no credential required'
        : p.credentialConfigured
          ? `${p.credentials.length} credential(s)`
          : chalk.dim('no credential');
      console.log(`  ${p.id.padEnd(20)} ${p.displayName.padEnd(22)} ${credential}`);
      for (const c of p.credentials) {
        console.log(chalk.dim(`      ${c.id}  ${c.name}  ${c.masked}`));
      }
    }
    // Stated because "configured" is routinely misread as "working".
    console.log(
      chalk.dim('\n  A stored credential is not a working one. Use `providers test` for that.'),
    );
  });

providersCommand
  .command('test')
  .description('Make a real request to a provider and report the outcome')
  .argument('<providerId>')
  .option('--credential <id>', 'Use a stored credential rather than the server environment')
  .action(async (providerId: string, options: { credential?: string }) => {
    const status = await createClient().providers.test(providerId, options.credential);
    const colour = status.status === 'connected' ? chalk.green : chalk.red;
    console.log(`  ${colour(status.status)}  ${status.detail ?? ''}`);
    if (status.status === 'connected' && status.modelCount !== undefined) {
      console.log(chalk.dim(`  ${status.modelCount} models reported`));
    }
    // A failed connection is a real result, and the exit code should say so.
    if (status.status !== 'connected') process.exitCode = 1;
  });

export const modelsCommand = new Command('models').description('Discover models from a provider');

modelsCommand
  .command('list')
  .description('Ask a provider what models it has')
  .requiredOption('--provider <id>')
  .option('--credential <id>')
  .action(async (options: { provider: string; credential?: string }) => {
    const listing = await createClient().providers.models(options.provider, options.credential);

    if (!listing.listingSupported) {
      console.log(
        `  ${options.provider} exposes no model-listing API.\n` +
          '  Pass any model id the provider accepts to `runs start --model`.',
      );
      if (listing.note) console.log(chalk.dim(`  ${listing.note}`));
      return;
    }

    for (const m of listing.items) {
      const ctx = m.contextLength ? chalk.dim(`  ${m.contextLength.toLocaleString()} ctx`) : '';
      console.log(`  ${m.id}${ctx}`);
    }
    console.log(
      chalk.dim(
        `\n  ${listing.items.length} models, read from the provider` +
          (listing.fetchedAt ? ` at ${new Date(listing.fetchedAt).toLocaleTimeString()}` : '') +
          '.\n  This list is what the provider returned, not a list this CLI carries:' +
          '\n  a model id missing from it may still be valid.',
      ),
    );
  });

export const credentialsCommand = new Command('credentials').description(
  'Manage stored provider credentials',
);

credentialsCommand
  .command('list')
  .description('List stored credentials (masked)')
  .action(async () => {
    const { items } = await createClient().credentials.list();
    if (items.length === 0) {
      console.log('  No credentials stored.');
      return;
    }
    for (const c of items) {
      const state = c.revokedAt ? chalk.dim(' revoked') : '';
      console.log(`  ${c.id}  ${c.providerId.padEnd(18)} ${c.name.padEnd(20)} ${c.masked}${state}`);
    }
  });

credentialsCommand
  .command('add')
  .description('Store a provider credential; it is encrypted on the server')
  .requiredOption('--provider <id>')
  .requiredOption('--name <name>', 'How you will recognise this credential')
  .option('--base-url <url>', 'For self-hosted and OpenAI-compatible endpoints')
  .action(async (options: { provider: string; name: string; baseUrl?: string }) => {
    // Read from the environment rather than a flag: a --api-key argument would
    // be written into the caller's shell history and into `ps` output.
    const apiKey = process.env.AGENT_EVAL_PROVIDER_KEY;
    if (!apiKey && options.provider !== 'ollama') {
      throw new Error(
        'Set AGENT_EVAL_PROVIDER_KEY to the provider secret.\n' +
          '  It is deliberately not a command-line flag: arguments appear in shell\n' +
          '  history and in the process list, where a credential must not be.',
      );
    }

    const created = await createClient().credentials.create({
      providerId: options.provider,
      name: options.name,
      ...(apiKey ? { apiKey } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
    console.log(`  stored ${created.id}  ${created.masked}`);
    console.log(chalk.dim('  The secret cannot be read back through any endpoint.'));
  });

credentialsCommand
  .command('revoke')
  .description('Revoke a stored credential')
  .argument('<id>')
  .action(async (id: string) => {
    const revoked = await createClient().credentials.revoke(id);
    console.log(`  revoked ${revoked.id} (${revoked.name})`);
  });
