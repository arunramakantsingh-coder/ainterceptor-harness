/**
 * Host inventory and self-diagnostics.
 *
 * Two rules from the discovery report:
 *   - Probes must be lightweight and cached; never run expensive commands on a
 *     timer (section 11 requirement).
 *   - Diagnostics report PASS / WARN / FAIL with EVIDENCE, not just a verdict
 *     (section 23 of the brief).
 *
 * The remote probe runs one small shell script over the existing SSH channel,
 * so a real capability model is derived from the machine rather than assumed.
 */
import type { HarnessConfig, HostTarget } from "../config.ts";
import type { EventSink } from "../events.ts";
import { sessionEmitter } from "../events.ts";
import { Executor } from "../exec/executor.ts";
import { buildLocalProbeCommand } from "./local-probe-cmd.ts";

export type Verdict = "PASS" | "WARN" | "FAIL";

export interface Capability {
  /** What was probed, e.g. "git". */
  name: string;
  /** Whether the capability was found. */
  present: boolean;
  /** Version or path evidence. */
  evidence: string;
}

export interface HostCapabilities {
  id: string;
  label: string;
  transport: "local" | "ssh";
  reachable: boolean;
  /** Raw probe facts. */
  identity: {
    hostname?: string;
    os?: string;
    kernel?: string;
    arch?: string;
    uptime?: string;
  };
  resources: {
    cpuCores?: number;
    cpuModel?: string;
    memTotalMb?: number;
    memAvailableMb?: number;
    swapTotalMb?: number;
    diskTotal?: string;
    diskFree?: string;
  };
  network: { addresses: string[]; tailscaleIp?: string };
  capabilities: Capability[];
  /** Non-fatal problems worth surfacing. */
  notes: string[];
  probedAt: string;
  /** Set when the probe could not run at all. */
  error?: string;
}

/** The remote probe. Deliberately small and read-only. */
export const PROBE_SCRIPT = `
set -u
echo "hostname=$(hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=\${PRETTY_NAME:-unknown}"; fi
echo "kernel=$(uname -r 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "uptime=$(uptime -p 2>/dev/null || uptime 2>/dev/null)"
echo "cpu_cores=$(nproc 2>/dev/null || echo 0)"
echo "cpu_model=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
awk '/^MemTotal:/{printf "mem_total_mb=%d\\n", $2/1024}' /proc/meminfo 2>/dev/null
awk '/^MemAvailable:/{printf "mem_avail_mb=%d\\n", $2/1024}' /proc/meminfo 2>/dev/null
awk '/^SwapTotal:/{printf "swap_total_mb=%d\\n", $2/1024}' /proc/meminfo 2>/dev/null
echo "disk=$(df -h / 2>/dev/null | awk 'NR==2{print $2\" total, \"$4\" free\"}')"
echo "addr4=$(ip -4 -o addr show 2>/dev/null | awk '{print $2\"=\"$4}' | paste -sd, -)"
echo "ts_ip=$( (command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1) || true)"
for t in git python3 node npm pnpm docker podman psql sqlite3 curl jq google-chrome xvfb-run ssh; do
  p=$(command -v "$t" 2>/dev/null || true)
  if [ -n "$p" ]; then v=$("$t" --version 2>/dev/null | head -1); echo "cap_$t=$p|$v"; else echo "cap_$t="; fi
done
echo "PROBE_END"
`.trim();

function parseProbe(text: string): Partial<HostCapabilities> & { caps: Capability[]; notes: string[] } {
  const caps: Capability[] = [];
  const notes: string[] = [];
  const kv = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9_]+)=(.*)$/i.exec(line.trim());
    if (!m) continue;
    kv.set(m[1], m[2]);
  }

  for (const [k, v] of kv.entries()) {
    if (!k.startsWith("cap_")) continue;
    const name = k.slice(4);
    if (!v) {
      caps.push({ name, present: false, evidence: "" });
      continue;
    }
    const [p, version] = v.split("|");
    caps.push({ name, present: true, evidence: version ? `${p} (${version})` : p });
  }

  const num = (k: string): number | undefined => {
    const v = kv.get(k);
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const addresses = (kv.get("addr4") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (kv.has("swap_total_mb") && num("swap_total_mb") === 0) {
    notes.push("no swap configured");
  }
  const avail = num("mem_avail_mb");
  const total = num("mem_total_mb");
  if (avail !== undefined && total !== undefined && total > 0 && avail / total < 0.15) {
    notes.push(`memory pressure: only ${avail} MB of ${total} MB available`);
  }

  return {
    identity: {
      hostname: kv.get("hostname"),
      os: kv.get("os"),
      kernel: kv.get("kernel"),
      arch: kv.get("arch"),
      uptime: kv.get("uptime"),
    },
    resources: {
      cpuCores: num("cpu_cores"),
      cpuModel: kv.get("cpu_model"),
      memTotalMb: total,
      memAvailableMb: avail,
      swapTotalMb: num("swap_total_mb"),
      diskFree: kv.get("disk"),
    },
    network: { addresses, tailscaleIp: kv.get("ts_ip") || undefined },
    caps,
    notes,
  };
}

export interface DiagnosticCheck {
  name: string;
  verdict: Verdict;
  detail: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  overall: Verdict;
  checks: DiagnosticCheck[];
  hosts: HostCapabilities[];
  aiBackend: {
    baseUrl: string;
    /** The reference, never the value. */
    apiKeyRef: string;
    keyPresent: boolean;
    reachable: boolean;
    detail: string;
    activeProviders?: string[];
  };
}

export class HostInventory {
  private cache = new Map<string, HostCapabilities>();
  private readonly cfg: HarnessConfig;
  private readonly executor: Executor;
  private readonly events: EventSink;

  constructor(cfg: HarnessConfig, executor: Executor, events: EventSink) {
    this.cfg = cfg;
    this.executor = executor;
    this.events = events;
  }

  /** Cached read; pass refresh to re-probe. */
  async get(hostId: string, refresh = false): Promise<HostCapabilities> {
    if (!refresh) {
      const hit = this.cache.get(hostId);
      if (hit) return hit;
    }
    const probed = await this.probe(hostId);
    this.cache.set(hostId, probed);
    return probed;
  }

  async all(refresh = false): Promise<HostCapabilities[]> {
    const out: HostCapabilities[] = [];
    for (const h of this.cfg.hosts) out.push(await this.get(h.id, refresh));
    return out;
  }

  private async probe(hostId: string): Promise<HostCapabilities> {
    const host: HostTarget = this.executor.host(hostId);
    const base: HostCapabilities = {
      id: host.id,
      label: host.label,
      transport: host.transport,
      reachable: false,
      identity: {},
      resources: {},
      network: { addresses: [] },
      capabilities: [],
      notes: [],
      probedAt: new Date().toISOString(),
    };

    const log = sessionEmitter(this.events, "harness", { host: host.id });
    try {
      // Local probes use the platform's own shell; remote probes use bash.
      const command =
        host.transport === "local" && process.platform === "win32"
          ? LOCAL_WINDOWS_PROBE
          : PROBE_SCRIPT;

      const res = await this.executor.run({
        target: host.id,
        command,
        permission: "read",
        timeoutMs: 45_000,
      });

      if (res.exitCode !== 0 && res.stdout.trim().length === 0) {
        return {
          ...base,
          error: `probe exited ${res.exitCode}: ${res.stderr.slice(0, 200)}`,
        };
      }

      const parsed =
        host.transport === "local" && process.platform === "win32"
          ? parseWindowsProbe(res.stdout)
          : parseProbe(res.stdout);

      const result: HostCapabilities = {
        ...base,
        reachable: true,
        identity: parsed.identity ?? {},
        resources: parsed.resources ?? {},
        network: parsed.network ?? { addresses: [] },
        capabilities: parsed.caps,
        notes: parsed.notes,
      };
      log.emit("harness.started", {
        severity: "debug",
        data: { probe: "host-inventory", host: host.id, reachable: true, caps: parsed.caps.length },
      });
      return result;
    } catch (err) {
      return {
        ...base,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Windows local probe.
 *
 * Delegates to the Node binary that is already running the harness, so the
 * report describes the real machine regardless of which shell exists. This is
 * deliberately not a PowerShell script: `pwsh` (PowerShell 7) is absent on this
 * host (only Windows PowerShell 5.1), and quoting an absolute Windows path
 * through PowerShell's `-Command` broke the probe with `Unexpected token`.
 */
const LOCAL_WINDOWS_PROBE = buildLocalProbeCommand();

function parseWindowsProbe(text: string): {
  identity: HostCapabilities["identity"];
  resources: HostCapabilities["resources"];
  network: HostCapabilities["network"];
  caps: Capability[];
  notes: string[];
} {
  const notes: string[] = [];

  // The local probe emits one JSON object (see hosts/local-probe.ts).
  try {
    const j = JSON.parse(text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}") as {
      hostname?: string;
      os?: string;
      kernel?: string;
      arch?: string;
      uptime?: string;
      cpuCores?: number;
      cpuModel?: string;
      memTotalMb?: number;
      memAvailMb?: number;
      addr4?: string[];
      caps?: Record<string, string>;
    };

    const caps: Capability[] = Object.entries(j.caps ?? {}).map(([name, evidence]) => ({
      name,
      present: Boolean(evidence),
      evidence: evidence || "",
    }));

    if (!caps.find((c) => c.name === "pnpm")?.present) notes.push("pnpm not installed");
    if (j.memAvailMb !== undefined && j.memTotalMb !== undefined && j.memTotalMb > 0) {
      const ratio = j.memAvailMb / j.memTotalMb;
      if (ratio < 0.15) {
        notes.push(`memory pressure: only ${j.memAvailMb} MB of ${j.memTotalMb} MB available`);
      }
    }

    return {
      identity: {
        hostname: j.hostname,
        os: j.os,
        kernel: j.kernel,
        arch: j.arch,
        uptime: j.uptime,
      },
      resources: {
        cpuCores: j.cpuCores,
        cpuModel: j.cpuModel,
        memTotalMb: j.memTotalMb,
        memAvailableMb: j.memAvailMb,
      },
      network: { addresses: j.addr4 ?? [] },
      caps,
      notes,
    };
  } catch {
    // Fall back to the key=value shape so an older probe still parses.
    const kv = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const m = /^([a-z0-9_]+)=(.*)$/i.exec(line.trim());
      if (m) kv.set(m[1], m[2]);
    }
    const caps: Capability[] = [];
    for (const [k, v] of kv.entries()) {
      if (k.startsWith("cap_")) caps.push({ name: k.slice(4), present: Boolean(v), evidence: v });
    }
    return {
      identity: {
        hostname: kv.get("hostname"),
        os: kv.get("os"),
        kernel: kv.get("kernel"),
        arch: kv.get("arch"),
      },
      resources: {
        cpuCores: Number(kv.get("cpu_cores")) || undefined,
        cpuModel: kv.get("cpu_model"),
        diskFree: kv.get("disk"),
      },
      network: {
        addresses: (kv.get("addr4") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      },
      caps,
      notes,
    };
  }
}

/** Aggregate verdict from a set of checks. FAIL dominates, then WARN. */
export function overallVerdict(checks: DiagnosticCheck[]): Verdict {
  if (checks.some((c) => c.verdict === "FAIL")) return "FAIL";
  if (checks.some((c) => c.verdict === "WARN")) return "WARN";
  return "PASS";
}
