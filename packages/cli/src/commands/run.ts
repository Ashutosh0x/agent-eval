import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AgentEvalClient } from '@agent-eval/sdk';

const client = new AgentEvalClient('http://localhost:3000', 'mock-api-key');
export const runCommand = new Command('run')
  .description('Manage evaluation runs');

runCommand
  .command('start')
  .description('Start evaluation run')
  .option('--env <env>', 'Environment ID')
  .option('--task-set <taskSet>', 'Task set ID')
  .option('--model <model>', 'Model name')
  .option('--budget <budget>', 'Budget limit')
  .action(async (options) => {
    const spinner = ora('Starting run...').start();
    try {
      const run = await client.runs.start(options);
      spinner.succeed(chalk.green(`Started run ${run.id}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to start run: ${error}`));
    }
  });

runCommand
  .command('status')
  .description('Show run status')
  .argument('<id>', 'Run ID')
  .action(async (id) => {
    try {
      const run = await client.runs.get(id);
      console.log(chalk.blue(`Status for run ${id}: ${run.status}`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });

runCommand
  .command('stop')
  .description('Stop a run')
  .argument('<id>', 'Run ID')
  .action(async (id) => {
    const spinner = ora('Stopping run...').start();
    try {
      await client.runs.stop(id);
      spinner.succeed(chalk.green(`Stopped run ${id}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to stop run: ${error}`));
    }
  });

runCommand
  .command('list')
  .description('List runs')
  .action(async () => {
    try {
      const list = await client.runs.list();
      console.log(chalk.blue('Runs:'));
      list.forEach(run => console.log(`- ${run.id} (${run.status})`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });
