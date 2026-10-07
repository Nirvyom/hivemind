import chalk from 'chalk';
import { getDaemonPid, clearDaemonPid } from '../../config/index.js';

export async function stopCommand(): Promise<void> {
  const pid = getDaemonPid();

  if (!pid) {
    console.log(chalk.yellow('Daemon is not running.'));
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    clearDaemonPid();
    console.log(chalk.green(`Hivemind daemon stopped (PID: ${pid})`));
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      clearDaemonPid();
      console.log(chalk.yellow('Daemon process not found. Cleaned up PID file.'));
    } else {
      console.log(chalk.red(`Failed to stop daemon: ${err.message}`));
    }
  }
}
