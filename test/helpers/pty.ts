import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./pty-run.py", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

export interface PtyStep {
  /** Text to wait for in the output (after the previous step's match). */
  expect: string;
  /** Keystrokes to send once it has appeared. */
  send: string;
  /** Seconds to let the program start reading before the keys go in. */
  after?: number;
}

export interface PtyRun {
  /** Everything the program wrote, escape sequences included. */
  output: string;
  code: number;
  /** The first `expect` that never appeared, or null. */
  missing: string | null;
}

/** Runs the built CLI on a pseudo-terminal with scripted keystrokes. */
export function runOnTerminal(
  args: string[],
  steps: PtyStep[],
  options: { cwd: string; env: Record<string, string | undefined>; cols?: number; rows?: number },
): Promise<PtyRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(options.env)) {
    if (value === undefined) delete env[key];
  }
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const script = JSON.stringify({ cols: options.cols ?? 100, rows: options.rows ?? 40, steps });
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [RUNNER, script, "--", process.execPath, BUNDLE, ...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as PtyRun);
      } catch {
        reject(new Error(`pty runner failed: ${stderr || stdout}`));
      }
    });
  });
}

/** The program's output as the terminal would show it for the text: escape sequences taken out. */
export const plain = (output: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control bytes are the target
  output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
