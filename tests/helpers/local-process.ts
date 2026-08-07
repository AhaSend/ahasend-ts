import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createServer } from "node:net";

export interface LocalProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export interface CapturedLocalProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<LocalProcessExit>;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReadinessOptions {
  readonly label: string;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
}

export interface StopProcessOptions {
  readonly gracePeriodMs?: number;
}

export async function allocateLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else reject(error);
      });
    });
  });
}

export function spawnCapturedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
): CapturedLocalProcess {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<LocalProcessExit>((resolveExit) => {
    let settled = false;
    const settle = (exit: LocalProcessExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(exit);
    };
    child.once("error", (error) => {
      settle({ exitCode: child.exitCode, signal: child.signalCode, error });
    });
    child.once("close", (exitCode, signal) => {
      settle({ exitCode, signal });
    });
  });

  return {
    child,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(timeoutError());
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function waitForProcessReadiness(
  process: CapturedLocalProcess,
  probe: (signal: AbortSignal) => Promise<boolean>,
  options: ReadinessOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? 250;
  const earlyExit = process.exited.then((exit) => ({ kind: "exit" as const, exit }));

  await withDeadline(
    async (signal) => {
      while (!signal.aborted) {
        const outcome = await Promise.race([
          earlyExit,
          probe(signal).then(
            (ready) => ({ kind: "probe" as const, ready }),
            () => ({ kind: "probe" as const, ready: false }),
          ),
        ]);
        if (outcome.kind === "exit") {
          throw new Error(
            `${options.label} exited before becoming ready (${formatExitStatus(outcome.exit)}).${formatCapturedOutput(process)}`,
            outcome.exit.error === undefined ? undefined : { cause: outcome.exit.error },
          );
        }
        if (outcome.ready) return;

        const waitOutcome = await Promise.race([
          earlyExit,
          wait(intervalMs, signal).then(() => ({ kind: "wait" as const })),
        ]);
        if (waitOutcome.kind === "exit") {
          throw new Error(
            `${options.label} exited before becoming ready (${formatExitStatus(waitOutcome.exit)}).${formatCapturedOutput(process)}`,
            waitOutcome.exit.error === undefined ? undefined : { cause: waitOutcome.exit.error },
          );
        }
      }
    },
    options.timeoutMs,
    () =>
      new Error(
        `${options.label} did not become ready within ${options.timeoutMs}ms.${formatCapturedOutput(process)}`,
      ),
  );
}

export function formatCapturedOutput(process: CapturedLocalProcess): string {
  return `\nstdout:\n${process.stdout}\nstderr:\n${process.stderr}`;
}

export async function stopProcess(
  process: CapturedLocalProcess | undefined,
  options: StopProcessOptions = {},
): Promise<void> {
  if (process === undefined) return;
  if (hasExited(process.child)) {
    await process.exited;
    return;
  }

  process.child.kill("SIGTERM");
  const exitedGracefully = await settlesWithin(process.exited, options.gracePeriodMs ?? 5_000);
  if (exitedGracefully) return;
  if (hasExited(process.child)) {
    await process.exited;
    return;
  }

  process.child.kill("SIGKILL");
  await process.exited;
}

function formatExitStatus(exit: LocalProcessExit): string {
  if (exit.error !== undefined) return `spawn error: ${exit.error.message}`;
  if (exit.exitCode !== null) return `exit code ${exit.exitCode}`;
  if (exit.signal !== null) return `signal ${exit.signal}`;
  return "unknown exit status";
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function wait(timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolveWait();
    };
    timeout = setTimeout(finish, timeoutMs);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}
