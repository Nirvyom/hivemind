import chalk from 'chalk';
import ora from 'ora';
import { configExists, loadConfig, getDaemonPid, saveDaemonPid, paths } from '../../config/index.js';
import { initializeDatabase } from '../../db/index.js';
import { runDaemon } from '../../daemon/index.js';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startCommand(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red('Hivemind not initialized. Run `hivemind init` first.'));
    process.exit(1);
  }

  const existingPid = getDaemonPid();
  if (existingPid) {
    console.log(chalk.yellow(`Daemon already running (PID: ${existingPid})`));
    return;
  }

  const spinner = ora('Starting Hivemind daemon...').start();

  try {
    // Initialize database
    initializeDatabase();

    // Fork the daemon worker
    const workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../daemon/worker.js'
    );

    const child = fork(workerPath, [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, HIVEMIND_DAEMON: '1' },
    });

    if (child.pid) {
      saveDaemonPid(child.pid);
      child.unref();
      child.disconnect();

      spinner.succeed(`Hivemind daemon started (PID: ${child.pid})`);
      console.log(chalk.dim(`  Logs: ${paths.logs}`));
      console.log(chalk.cyan('\n  Run `hivemind status` to check agent health.'));
      console.log(chalk.cyan('  Run `hivemind dashboard` for live monitoring.\n'));
    } else {
      spinner.fail('Failed to start daemon');
    }
  } catch (err: any) {
    spinner.fail(`Failed to start daemon: ${err.message}`);
    process.exit(1);
  }
}
