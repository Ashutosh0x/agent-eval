/**
 * API key commands.
 *
 * `keys create` prints the secret once. There is no command to read it back,
 * because there is no endpoint that could: the server stores a hash. If it is
 * lost, the key is rotated, which is the property that makes the store
 * worth having.
 */

import chalk from 'chalk';
import { Command } from 'commander';
import { createClient } from '../client';

export const keysCommand = new Command('keys').description('Manage agent-eval API keys');

keysCommand
  .command('list')
  .description('List API keys (masked)')
  .action(async () => {
    const { items } = await createClient().apiKeys.list();
    if (items.length === 0) {
      console.log('  No API keys.');
      return;
    }
    for (const k of items) {
      const state = k.revokedAt
        ? chalk.dim('revoked')
        : k.expiresAt && Date.parse(k.expiresAt) <= Date.now()
          ? chalk.yellow('expired')
          : chalk.green('active');
      console.log(`  ${k.id.padEnd(18)} ${k.masked.padEnd(26)} ${state.padEnd(18)} ${k.name}`);
      console.log(chalk.dim(`      scopes: ${k.scopes.join(', ')}`));
    }
  });

keysCommand
  .command('create')
  .description('Create an API key; the secret is shown once and never again')
  .requiredOption('--name <name>')
  .requiredOption('--scopes <scopes>', 'Comma-separated')
  .option('--description <text>')
  .option('--expires-in-days <n>')
  .action(async (o: Record<string, string>) => {
    const { key, secret } = await createClient().apiKeys.create({
      name: o.name!,
      scopes: o.scopes!.split(',').map((s) => s.trim()),
      ...(o.description ? { description: o.description } : {}),
      ...(o.expiresInDays ? { expiresInDays: Number(o.expiresInDays) } : {}),
    });

    console.log(`  ${key.id}`);
    console.log(`  scopes  ${key.scopes.join(', ')}`);
    if (key.expiresAt) console.log(`  expires ${key.expiresAt}`);
    console.log(`\n  ${secret}\n`);
    console.log(
      chalk.yellow(
        '  This is the only time this secret exists. The server keeps a hash and\n' +
          '  cannot show it again. Store it now, or create a new key.',
      ),
    );
  });

keysCommand
  .command('revoke')
  .description('Revoke an API key immediately')
  .argument('<id>')
  .action(async (id: string) => {
    const key = await createClient().apiKeys.revoke(id);
    console.log(`  revoked ${key.id} (${key.name})`);
  });
