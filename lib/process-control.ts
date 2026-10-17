import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export function spawnCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], options);
  }
  return spawn(command, args, options);
}

/** Send a signal to a dedicated POSIX process group when one exists. */
export function killUnixProcessGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Stop a child with a graceful signal, then kill its process tree if needed. */
export async function stopChild(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  graceMs = 1_000,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  try {
    const signaledGroup = child.pid !== undefined && killUnixProcessGroup(child.pid, signal);
    if (!signaledGroup) {
      child.kill(signal);
    }
  } catch {
    return;
  }

  if (await waitForExit(child, graceMs)) {
    return;
  }

  if (process.platform === "win32" && child.pid !== undefined) {
    await killWindowsProcessTree(child.pid);
  } else {
    const killedGroup = child.pid !== undefined && killUnixProcessGroup(child.pid, "SIGKILL");
    if (!killedGroup) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort; the close listener still reconciles the next state poll.
      }
    }
  }
  await waitForExit(child, graceMs);
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", () => finish(true));
  });
}

export async function killWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(finish, 2_000);
    killer.once("close", finish);
    killer.once("error", finish);
  });
}

function quoteWindowsArg(value: string): string {
  if (/^[A-Za-z0-9_./\\:#-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
