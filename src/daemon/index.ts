import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { paths, loadConfig, saveDaemonPid, clearDaemonPid, getDaemonPid } from '../config/index.js';
import { initializeDatabase, getSqlite, closeDb } from '../db/index.js';
import { createAgents } from '../agents/index.js';
import { getLogger } from '../utils/logger.js';
import cron from 'node-cron';

const log = getLogger('daemon');

export function startDaemon(): { pid: number } | { error: string } {
  const existingPid = getDaemonPid();
  if (existingPid) {
    return { error: `Daemon already running (PID: ${existingPid})` };
  }

  // Fork a detached child process
  const daemonScript = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'worker.js'
  );

  // We'll run the daemon in the current process for simplicity
  // In production, this would fork a detached process
  const child = fork(daemonScript, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HIVEMIND_DAEMON: '1' },
  });

  child.unref();

  if (child.pid) {
    saveDaemonPid(child.pid);
    return { pid: child.pid };
  }

  return { error: 'Failed to start daemon' };
}

export function stopDaemon(): boolean {
  const pid = getDaemonPid();
  if (!pid) return false;

  try {
    process.kill(pid, 'SIGTERM');
    clearDaemonPid();
    return true;
  } catch {
    clearDaemonPid();
    return false;
  }
}

export function isDaemonRunning(): boolean {
  return getDaemonPid() !== null;
}

// This runs inside the daemon process
export async function runDaemon(): Promise<void> {
  log.info('Hivemind daemon starting...');

  const config = loadConfig();
  initializeDatabase();

  const agentSchedules = createAgents(config);
  const cronJobs: cron.ScheduledTask[] = [];

  // Schedule each agent
  for (const schedule of agentSchedules) {
    const job = cron.schedule(schedule.cronExpression, async () => {
      try {
        log.info({ agent: schedule.agent.name }, `Ticking agent`);
        await schedule.agent.tick();
      } catch (err: any) {
        log.error({ err, agent: schedule.agent.name }, 'Agent tick failed');
      }
    });
    cronJobs.push(job);
    log.info({ agent: schedule.agent.name, interval: schedule.interval }, 'Agent scheduled');
  }

  // IPC socket for CLI communication
  const socketServer = net.createServer((socket) => {
    socket.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const response = handleIPCMessage(msg, config);
        socket.write(JSON.stringify(response));
      } catch (err) {
        socket.write(JSON.stringify({ error: 'Invalid message' }));
      }
      socket.end();
    });
  });

  // Clean up old socket
  try { fs.unlinkSync(paths.socket); } catch {}

  socketServer.listen(paths.socket, () => {
    log.info({ socket: paths.socket }, 'IPC socket listening');
  });

  // Run initial ticks for ops and CEO
  setTimeout(async () => {
    const opsSchedule = agentSchedules.find(s => s.agent.name === 'ops');
    if (opsSchedule) {
      log.info('Running initial Ops tick');
      await opsSchedule.agent.tick().catch(err => log.error({ err }, 'Initial ops tick failed'));
    }
  }, 5000);

  setTimeout(async () => {
    const ceoSchedule = agentSchedules.find(s => s.agent.name === 'ceo');
    if (ceoSchedule) {
      log.info('Running initial CEO tick');
      await ceoSchedule.agent.tick().catch(err => log.error({ err }, 'Initial CEO tick failed'));
    }
  }, 10000);

  // Graceful shutdown
  const shutdown = () => {
    log.info('Daemon shutting down...');
    for (const job of cronJobs) {
      job.stop();
    }
    socketServer.close();
    closeDb();
    clearDaemonPid();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    log.error({ err }, 'Uncaught exception in daemon');
  });
  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'Unhandled rejection in daemon');
  });

  log.info('Hivemind daemon running. All agents scheduled.');
}

function handleIPCMessage(msg: any, config: any): any {
  switch (msg.command) {
    case 'status':
      return getStatus();
    case 'financials':
      return getFinancials();
    case 'health':
      return { status: 'ok', uptime: process.uptime() };
    default:
      return { error: `Unknown command: ${msg.command}` };
  }
}

function getStatus(): any {
  const db = getSqlite();
  const agents = ['ceo', 'content', 'social', 'sales', 'client', 'ops'];

  return {
    uptime: process.uptime(),
    agents: agents.map(agent => {
      const lastRun = db.prepare(`
        SELECT status, completed_at, summary FROM agent_runs
        WHERE agent = ? ORDER BY id DESC LIMIT 1
      `).get(agent) as any;

      return {
        name: agent,
        status: lastRun?.status || 'pending',
        lastRun: lastRun?.completed_at || 'never',
      };
    }),
  };
}

function getFinancials(): any {
  const db = getSqlite();
  const revenue = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'revenue'"
  ).get() as any).total;
  const expenses = (db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense'"
  ).get() as any).total;

  return { revenue, expenses, net: revenue - expenses };
}
