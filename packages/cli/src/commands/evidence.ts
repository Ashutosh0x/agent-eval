import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AgentEvalClient } from '@agent-eval/sdk';

const client = new AgentEvalClient('http://localhost:3000', 'mock-api-key');
export const evidenceCommand = new Command('evidence')
  .description('Manage evidence bundles');

evidenceCommand
  .command('generate')
  .description('Generate evidence bundle')
  .argument('<runId>', 'Run ID')
  .action(async (runId) => {
    const spinner = ora('Generating bundle...').start();
    try {
      const bundle = await client.evidence.generate(runId);
      spinner.succeed(chalk.green(`Generated bundle ${bundle.id}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to generate bundle: ${error}`));
    }
  });

evidenceCommand
  .command('verify')
  .description('Verify bundle integrity')
  .argument('<id>', 'Bundle ID')
  .action(async (id) => {
    const spinner = ora('Verifying bundle...').start();
    try {
      const isValid = await client.evidence.verify(id);
      if (isValid) {
        spinner.succeed(chalk.green(`Bundle ${id} is valid`));
      } else {
        spinner.fail(chalk.red(`Bundle ${id} is invalid`));
      }
    } catch (error) {
      spinner.fail(chalk.red(`Failed to verify bundle: ${error}`));
    }
  });

evidenceCommand
  .command('export')
  .description('Export bundle')
  .argument('<id>', 'Bundle ID')
  .option('--format <format>', 'Export format (json|pdf)', 'json')
  .action(async (id, options) => {
    const spinner = ora(`Exporting bundle to ${options.format}...`).start();
    try {
      // Mock export
      spinner.succeed(chalk.green(`Exported bundle ${id} to ${options.format}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to export bundle: ${error}`));
    }
  });
