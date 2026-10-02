/**
 * Execution model.
 *
 * One internal representation - the Execution Request - and a resolver that
 * decides HOW it runs (local process, or SSH to a remote host). The UI never
 * chooses a transport; it names a target and the resolver maps that to a
 * transport from config.
 *
 * Discovered constraint this encodes: PowerShell mangles multi-line commands
 * into CRLF when piping to a remote bash, so remote scripts are shipped as a
 * base64 payload decoded on the far side. That is not a stylistic choice - it
 * is the only reliable way to run a multi-line script over SSH from Windows.
 */
import { spawn, spawnSync } from "node:child_process";

import type { HarnessConfig, HostTarget } from "../config.ts";
import type { EventSink } from "../events.ts";
import { sessionEmitter } from "../events.ts";
import { redactString } from "../security/redact.ts";

/**
 * Which PowerShell this machine actually has.
 *
 * Discovered the hard way: `pwsh` (PowerShell 7) is NOT installed on this
 * host - only Windows PowerShell 5.1, as `powershell.exe`. Hard-coding `pwsh`
 * made every local execution fail with `spawn pwsh ENOENT`. Probe, never
 * assume, and cache the answer.
 */
let cachedWindowsShell: { file: string; psStyle: boolean } | null = null;

function whichWindows(exe: string): boolean {
  try {
    const r = spawnSync("where", [exe], { windowsHide: true, encoding: "utf8" });
    return r.status === 0 && (r.stdout ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

export function resolveWindowsShell(): { file: string; psStyle: boolean } {
  if (cachedWindowsShell) return cachedWindowsShell;
  if (process.platform !== "win32") {
    cachedWindowsShell = { file: "bash", psStyle: false };
    return cachedWindowsShell;
  }
  if (whichWindows("pwsh.exe") || whichWindows("pwsh")) {
    cachedWindowsShell = { file: "pwsh", psStyle: true };
  } else if (whichWindows("powershell.exe") || whichWindows("powershell")) {
    cachedWindowsShell = { file: "powershell.exe", psStyle: true };
  } else {
    cachedWindowsShell = { file: "cmd.exe", psStyle: false };
  }
  return cachedWindowsShell;
}

/** The single internal execution representation. */
export interface ExecutionRequest {
  /** Host id from config.hosts. */
  target: string;
  /** Environment within that host: "host" | "debian" | "termux". */
  environment?: string;
  /** The shell command to run. */
  command: string;
  /** Permission class - recorded now, enforced when the policy layer lands. */
  permission?: "read" | "write" | "execute" | "network";
  /** Working directory on the target. */
  cwd?: string;
  /** Hard timeout. */
  timeoutMs?: number;
  /** Caller correlation id. */
  requestId?: string;
}

export interface ExecutionResult {
  target: string;
  transport: "local" | "ssh";
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class ExecutionError extends Error {
  constructor(message: string) {
    super(redactString(message).text);
    this.name = "ExecutionError";
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    return `${home}${process.platform === "win32" ? "\\" : "/"}${p.slice(2)}`;
  }
  return p;
}

export class Executor {
  private readonly cfg: HarnessConfig;
  private readonly events: EventSink;

  constructor(cfg: HarnessConfig, events: EventSink) {
    this.cfg = cfg;
    this.events = events;
  }

  host(id: string): HostTarget {
    const h = this.cfg.hosts.find((x) => x.id === id);
    if (!h) {
      throw new ExecutionError(
        `unknown target '${id}'. Known targets: ${this.cfg.hosts.map((x) => x.id).join(", ")}`,
      );
    }
    return h;
  }

  /**
   * Build the local argv. Uses a login-free, non-interactive shell so no rc
   * files run and no shell state leaks between calls. The PowerShell binary is
   * resolved, not assumed.
   */
  private localArgv(host: HostTarget, command: string): { file: string; args: string[] } {
    if (process.platform === "win32") {
      const shell = resolveWindowsShell();
      if (shell.psStyle) {
        return {
          file: shell.file,
          args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        };
      }
      return { file: shell.file, args: ["/d", "/s", "/c", command] };
    }
    return { file: "bash", args: ["-c", command] };
  }

  /**
   * Build the SSH argv. The remote side receives a base64 payload to defeat
   * Windows CRLF mangling of heredocs and multi-line scripts.
   *
   * Every flag here is deliberate:
   *   BatchMode=yes           fail fast instead of hanging on a password prompt
   *   StrictHostKeyChecking   accept-new keeps first contact non-interactive
   */
  private sshArgv(host: HostTarget, command: string): { file: string; args: string[] } {
    const encoded = Buffer.from(command, "utf8").toString("base64");
    const remoteShell = host.shell ?? "bash";
    const remote = `echo ${encoded} | base64 -d | ${remoteShell} -s`;

    const args: string[] = [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "StrictHostKeyChecking=accept-new",
    ];
    if (host.sshPort && host.sshPort !== 22) args.push("-p", String(host.sshPort));
    if (host.sshIdentity) args.push("-i", expandHome(host.sshIdentity));

    const dest = host.sshUser ? `${host.sshUser}@${host.sshTarget}` : String(host.sshTarget);
    args.push(dest, remote);
    return { file: "ssh", args };
  }

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    const host = this.host(req.target);
    const timeoutMs = req.timeoutMs ?? 60_000;

    // Working directory is handled per transport, NOT by prefixing the command
    // with `cd "<path>" && ...`. That prefix is bash-only: Windows PowerShell
    // 5.1 rejects `&&` outright ("The token '&&' is not a valid statement
    // separator"), which silently broke the git overlay.
    //
    //   local -> spawn's own `cwd` option (no shell involved)
    //   ssh   -> `cd` inside the remote bash, where `&&` is valid
    const command =
      req.cwd && host.transport === "ssh"
        ? `cd ${JSON.stringify(req.cwd)} && ${req.command}`
        : req.command;
    const spawnCwd = req.cwd && host.transport === "local" ? req.cwd : undefined;

    const log = sessionEmitter(this.events, "execution", {
      host: host.id,
      requestId: req.requestId,
    });
    log.emit("execution.started", {
      data: {
        environment: req.environment ?? "host",
        permission: req.permission ?? "execute",
        cwd: req.cwd,
        // preview only; the full command stays in the API response
        command: redactString(command.slice(0, 200)).text,
      },
    });

    const { file, args } = host.transport === "ssh" ? this.sshArgv(host, command) : this.localArgv(host, command);
    const started = Date.now();

    const result = await new Promise<ExecutionResult>((resolve, reject) => {
      let child;
      try {
        child = spawn(file, args, { windowsHide: true, cwd: spawnCwd });
      } catch (err) {
        reject(new ExecutionError(err instanceof Error ? err.message : String(err)));
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, timeoutMs);

      child.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ExecutionError(err.message));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          target: host.id,
          transport: host.transport,
          command,
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
        });
      });
    });

    if (result.timedOut || result.exitCode !== 0) {
      log.emit("execution.failed", {
        severity: result.timedOut ? "warn" : "info",
        data: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          // stderr can carry credentials; preview it redacted
          stderr: redactString(result.stderr.slice(0, 300)).text,
        },
      });
    } else {
      log.emit("execution.completed", {
        data: { exitCode: result.exitCode, durationMs: result.durationMs, bytes: result.stdout.length },
      });
    }

    return result;
  }

  /**
   * Run a multi-line script safely. Same transports, but the intent is
   * explicit so callers do not hand-roll quoting.
   */
  async runScript(target: string, script: string, opts: Partial<ExecutionRequest> = {}): Promise<ExecutionResult> {
    return this.run({ target, command: script, ...opts });
  }
}
