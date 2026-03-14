import { execFile, spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

export function runPassthrough(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: env ?? process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(127));
  });
}
