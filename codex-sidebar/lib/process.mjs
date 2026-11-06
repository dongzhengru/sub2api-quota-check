import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Finder-launched apps may have the C locale. macOS ps then escapes Chinese
// paths, so matching them against the actual CLI path incorrectly fails.
export const processOptions = () => ({
  timeout: 3000,
  env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
});

export async function matchesDaemonProcess(state, cli, run = exec) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 1 ||
      typeof state.instance !== 'string' || !state.instance) return false;
  try {
    const { stdout } = await run('/bin/ps', ['-ww', '-p', String(state.pid), '-o', 'command='], processOptions());
    return stdout.includes(`${cli} run `) && stdout.trim().endsWith(`--instance ${state.instance}`) ||
      stdout.includes(`${cli} run `) && stdout.includes(`--instance ${state.instance} --selector `);
  } catch { return false; }
}
