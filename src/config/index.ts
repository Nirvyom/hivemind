import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HivemindConfigSchema, type HivemindConfig } from './schema.js';

const HIVEMIND_DIR = path.join(os.homedir(), '.hivemind');
const CONFIG_FILE = path.join(HIVEMIND_DIR, 'config.json');
const DB_FILE = path.join(HIVEMIND_DIR, 'hivemind.db');
const LOG_DIR = path.join(HIVEMIND_DIR, 'logs');
const PID_FILE = path.join(HIVEMIND_DIR, 'hivemind.pid');
const SOCKET_PATH = path.join(HIVEMIND_DIR, 'hivemind.sock');

export const paths = {
  dir: HIVEMIND_DIR,
  config: CONFIG_FILE,
  db: DB_FILE,
  logs: LOG_DIR,
  pid: PID_FILE,
  socket: SOCKET_PATH,
};

export function ensureDir(): void {
  if (!fs.existsSync(HIVEMIND_DIR)) {
    fs.mkdirSync(HIVEMIND_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

// Shared mutable config reference for hot reload
let _currentConfig: HivemindConfig | null = null;

export function loadConfig(): HivemindConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('Hivemind not initialized. Run `hivemind init` first.');
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  _currentConfig = HivemindConfigSchema.parse(raw);
  return _currentConfig;
}

export function reloadConfig(): HivemindConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const newConfig = HivemindConfigSchema.parse(raw);
    if (_currentConfig) {
      // Update the existing config object in-place so all references stay valid
      Object.assign(_currentConfig, newConfig);
    } else {
      _currentConfig = newConfig;
    }
    return _currentConfig;
  } catch {
    return null;
  }
}

export function getCurrentConfig(): HivemindConfig | null {
  return _currentConfig;
}

export function saveConfig(config: HivemindConfig): void {
  ensureDir();
  const validated = HivemindConfigSchema.parse({
    ...config,
    updatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(validated, null, 2));
}

export function getDaemonPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    // Check if process is running
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function saveDaemonPid(pid: number): void {
  fs.writeFileSync(PID_FILE, String(pid));
}

export function clearDaemonPid(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}
