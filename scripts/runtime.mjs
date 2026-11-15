import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function runChild(command, args, options = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options, shell: false });
    const stop = (signal) => child.kill(signal);
    const onInterrupt = () => stop('SIGINT');
    const onTerminate = () => stop('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const clean = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.once('error', (error) => {
      clean();
      reject(new Error(`Could not start ${command}: ${error.code ?? 'unknown error'}. Check your PATH.`));
    });
    child.once('close', (code, signal) => {
      clean();
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}
