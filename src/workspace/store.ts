/**
 * Workspace core.
 *
 * A workspace is a durable project record: one canonical directory plus the
 * facts the harness needs about it. Two rules taken from the discovery report:
 *
 *   1. Identity is the CANONICAL path (fs.realpath), so a symlink to the same
 *      directory collides rather than creating a second workspace.
 *   2. The tree must reflect the REAL filesystem. Nothing here is mocked.
 *
 * Git data is an overlay: read-only commands only (rev-parse, status, log).
 * The harness never mutates a repository from this module.
 */
import { readdir, realpath, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { EventSink } from "../events.ts";
import { sessionEmitter } from "../events.ts";
import { Executor } from "../exec/executor.ts";

export interface Workspace {
  id: string;
  /** Canonical absolute path - the identity. */
  root: string;
  name: string;
  /** Which host this workspace's files physically live on. */
  host: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface TreeNode {
  name: string;
  /** Path relative to the workspace root, using forward slashes. */
  rel: string;
  type: "file" | "dir";
  size?: number;
  /** Populated for directories when depth remains. */
  children?: TreeNode[];
  /** True when traversal stopped early here. */
  truncated?: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  /** Short hash of HEAD. */
  head?: string;
  ahead?: number;
  behind?: number;
  /** Porcelain lines, verbatim (already short). */
  changes: string[];
  clean?: boolean;
  error?: string;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  git: GitStatus;
  tree: TreeNode[];
  treeStats: { files: number; dirs: number; truncated: boolean };
}

/** Directories that are never worth walking for a UI tree. */
const ALWAYS_SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "build",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  ".gradle",
  ".idea",
  ".turbo",
  ".cache",
]);

interface Registry {
  version: number;
  workspaces: Workspace[];
}

const REGISTRY_VERSION = 1;

export class WorkspaceStore {
  private registry: Registry = { version: REGISTRY_VERSION, workspaces: [] };
  private loaded = false;
  private readonly dataDir: string;
  private readonly executor: Executor;
  private readonly events: EventSink;

  constructor(dataDir: string, executor: Executor, events: EventSink) {
    this.dataDir = dataDir;
    this.executor = executor;
    this.events = events;
  }

  private get registryFile(): string {
    return path.join(this.dataDir, "workspaces.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.registryFile, "utf8");
      const parsed = JSON.parse(raw) as Registry;
      if (parsed && Array.isArray(parsed.workspaces)) this.registry = parsed;
    } catch {
      // first run, or an unreadable registry - start empty rather than fail
      this.registry = { version: REGISTRY_VERSION, workspaces: [] };
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.registryFile, JSON.stringify(this.registry, null, 2), "utf8");
  }

  async list(): Promise<Workspace[]> {
    await this.load();
    return [...this.registry.workspaces];
  }

  async get(id: string): Promise<Workspace | undefined> {
    await this.load();
    return this.registry.workspaces.find((w) => w.id === id);
  }

  /**
   * Register (or return the existing) workspace for a directory.
   *
   * Identity is the CANONICAL path. For a local target we canonicalise with
   * Node's realpath, so `C:\a\link` and `C:\a\real` resolve to one workspace.
   * For a REMOTE target the path must be canonicalised on that machine instead
   * - validating it against the host filesystem is wrong and made every remote
   * workspace fail with "path does not exist or is not readable".
   *
   * A non-existent path is always an error: we never invent a workspace for a
   * directory that is not there.
   */
  async open(inputPath: string, host = "local"): Promise<Workspace> {
    await this.load();
    const target = this.executor.host(host);
    const isLocal = target.transport === "local";

    let canonical: string;
    if (isLocal) {
      const expanded = inputPath.startsWith("~")
        ? path.join(os.homedir(), inputPath.slice(1).replace(/^[/\\]/, ""))
        : inputPath;
      try {
        canonical = await realpath(path.resolve(expanded));
      } catch {
        throw new Error(`path does not exist or is not readable: ${expanded}`);
      }
      const st = await stat(canonical).catch(() => undefined);
      if (!st?.isDirectory()) {
        throw new Error(`not a directory: ${canonical}`);
      }
    } else {
      // Ask the remote host to canonicalise and confirm it is a directory.
      // `cd -P` resolves symlinks; `pwd -P` then prints the physical path.
      // The remote shell is bash, and the path is passed as a single-quoted
      // literal so nothing is expanded.
      const quoted = `'${inputPath.replace(/'/g, `'\\''`)}'`;
      const res = await this.executor.run({
        target: host,
        command: `if [ ! -d ${quoted} ]; then echo "__MISSING__"; else cd -P ${quoted} && pwd -P; fi`,
        permission: "read",
        timeoutMs: 30_000,
      });
      const out = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      if (res.exitCode !== 0 || !out || out === "__MISSING__") {
        throw new Error(`path does not exist or is not a directory on ${host}: ${inputPath}`);
      }
      canonical = out;
    }

    const existing = this.registry.workspaces.find((w) => w.root === canonical);
    const now = new Date().toISOString();
    if (existing) {
      existing.lastOpenedAt = now;
      await this.save();
      sessionEmitter(this.events, "workspace").emit("workspace.opened", {
        workspace: existing.id,
        data: { root: canonical, reused: true },
      });
      return existing;
    }

    const ws: Workspace = {
      id: `ws-${Buffer.from(canonical).toString("base64url").slice(0, 16)}`,
      root: canonical,
      name: path.basename(canonical) || canonical,
      host,
      createdAt: now,
      lastOpenedAt: now,
    };
    this.registry.workspaces.push(ws);
    await this.save();
    sessionEmitter(this.events, "workspace").emit("workspace.created", {
      workspace: ws.id,
      data: { root: canonical, host },
    });
    return ws;
  }

  /** Removing a workspace NEVER deletes folders, files or sessions. */
  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.registry.workspaces.length;
    this.registry.workspaces = this.registry.workspaces.filter((w) => w.id !== id);
    if (this.registry.workspaces.length === before) return false;
    await this.save();
    sessionEmitter(this.events, "workspace").emit("workspace.removed", {
      workspace: id,
      data: { note: "files on disk were left untouched" },
    });
    return true;
  }

  /**
   * Walk the real directory. Depth- and count-limited so a huge repo cannot
   * hang the UI; `truncated` tells the caller where we stopped.
   */
  async tree(
    root: string,
    opts: { depth?: number; maxEntries?: number; host?: string } = {},
  ): Promise<{ tree: TreeNode[]; stats: { files: number; dirs: number; truncated: boolean } }> {
    const maxDepth = opts.depth ?? 3;
    const maxEntries = opts.maxEntries ?? 4000;
    const hostId = opts.host ?? "local";

    // A remote workspace's files live on that machine, so a local readdir
    // would be meaningless. Ask the remote host to enumerate instead.
    if (this.executor.host(hostId).transport !== "local") {
      return this.remoteTree(root, hostId, maxDepth, maxEntries);
    }

    const stats = { files: 0, dirs: 0, truncated: false };

    const walk = async (abs: string, rel: string, depth: number): Promise<TreeNode[]> => {
      if (depth > maxDepth) {
        stats.truncated = true;
        return [];
      }
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return [];
      }

      const nodes: TreeNode[] = [];
      // deterministic order: directories first, then alphabetical
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });

      for (const e of entries) {
        if (stats.files + stats.dirs >= maxEntries) {
          stats.truncated = true;
          break;
        }
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(abs, e.name);

        if (e.isDirectory()) {
          if (ALWAYS_SKIP.has(e.name)) {
            nodes.push({ name: e.name, rel: childRel, type: "dir", truncated: true });
            continue;
          }
          stats.dirs++;
          const children = await walk(childAbs, childRel, depth + 1);
          nodes.push({ name: e.name, rel: childRel, type: "dir", children });
        } else if (e.isFile()) {
          stats.files++;
          let size: number | undefined;
          try {
            size = (await stat(childAbs)).size;
          } catch {
            /* size is best-effort */
          }
          nodes.push({ name: e.name, rel: childRel, type: "file", size });
        }
        // symlinks and sockets are skipped deliberately
      }
      return nodes;
    };

    const tree = await walk(root, "", 1);
    return { tree, stats };
  }

  /**
   * Read-only git facts.
   *
   * Shell-agnostic on purpose. The first version used a bash script with
   * `if/then/fi` and `$( )`, which silently produced `isRepo:false` on Windows
   * because the local transport is PowerShell 5.1 - it has no `&&` and no bash
   * conditionals. Instead we run each git command separately and use `git -C`
   * so no `cd`/`&&` chaining is required on any platform.
   *
   * Every command here is non-mutating.
   */
  async git(root: string, host = "local"): Promise<GitStatus> {
    const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

    const run = async (gitArgs: string[]): Promise<{ code: number | null; out: string }> => {
      try {
        const res = await this.executor.run({
          target: host,
          command: `git -C ${q(root)} ${gitArgs.join(" ")}`,
          permission: "read",
          timeoutMs: 30_000,
        });
        return { code: res.exitCode, out: `${res.stdout}${res.stderr ? "\n" + res.stderr : ""}` };
      } catch (err) {
        return { code: 1, out: err instanceof Error ? err.message : String(err) };
      }
    };

    try {
      const inside = await run(["rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0 || !/true/i.test(inside.out)) {
        return {
          isRepo: false,
          changes: [],
          error: inside.code === 0 ? undefined : inside.out.trim().slice(0, 200),
        };
      }

      const [branch, head, counts, status] = await Promise.all([
        run(["branch", "--show-current"]),
        run(["rev-parse", "--short", "HEAD"]),
        run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
        run(["status", "--porcelain=v1"]),
      ]);

      const changes = status.out
        .split(/\r?\n/)
        .map((s) => s.trimEnd())
        .filter((s) => s.length > 0)
        .slice(0, 200);

      let ahead: number | undefined;
      let behind: number | undefined;
      const cm = /^(\d+)\s+(\d+)/m.exec(counts.out.trim());
      if (cm) {
        behind = Number(cm[1]);
        ahead = Number(cm[2]);
      }

      return {
        isRepo: true,
        branch: branch.out.trim() || undefined,
        head: head.out.trim() || undefined,
        ahead,
        behind,
        changes,
        clean: changes.length === 0,
      };
    } catch (err) {
      return {
        isRepo: false,
        changes: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Enumerate a remote workspace with `find`, which is present on the Debian
   * target and needs no Node on the far side. Output is one line per entry:
   *   <type> <depth> <size> <relpath>
   * and we rebuild the nested TreeNode shape from the depth field.
   */
  private async remoteTree(
    root: string,
    host: string,
    maxDepth: number,
    maxEntries: number,
  ): Promise<{ tree: TreeNode[]; stats: { files: number; dirs: number; truncated: boolean } }> {
    const stats = { files: 0, dirs: 0, truncated: false };
    const quoted = `'${root.replace(/'/g, `'\\''`)}'`;

    // -printf is a GNU find extension; the VM is Debian, so it is available.
    const res = await this.executor.run({
      target: host,
      command:
        `find ${quoted} -mindepth 1 -maxdepth ${maxDepth + 1} ` +
        `\\( -name .git -o -name node_modules -o -name .venv -o -name __pycache__ -o -name .next \\) -prune -o ` +
        `-printf '%y %d %s %P\\n' 2>/dev/null | head -${maxEntries}`,
      permission: "read",
      timeoutMs: 45_000,
    });

    type Row = { type: "f" | "d"; depth: number; size: number; rel: string };
    const rows: Row[] = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = /^([fd]) (\d+) (\d+) (.*)$/.exec(line.trim());
      if (!m) continue;
      rows.push({ type: m[1] as "f" | "d", depth: Number(m[2]), size: Number(m[3]), rel: m[4] });
    }
    if (rows.length >= maxEntries) stats.truncated = true;

    // rows are in find's pre-order; depth tells us where to attach each node
    const rootNodes: TreeNode[] = [];
    const stack: Array<{ depth: number; node: TreeNode }> = [];

    for (const r of rows) {
      const name = r.rel.split("/").pop() ?? r.rel;
      const node: TreeNode =
        r.type === "d"
          ? { name, rel: r.rel, type: "dir", children: [] }
          : { name, rel: r.rel, type: "file", size: r.size };

      if (r.type === "d") stats.dirs++;
      else stats.files++;

      while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop();
      if (stack.length === 0) {
        rootNodes.push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        (parent.children ??= []).push(node);
      }
      if (r.type === "d") stack.push({ depth: r.depth, node });
    }

    return { tree: rootNodes, stats };
  }

  async detail(id: string): Promise<WorkspaceDetail | undefined> {
    const ws = await this.get(id);
    if (!ws) return undefined;
    const [treeRes, git] = await Promise.all([
      this.tree(ws.root, { host: ws.host }),
      this.git(ws.root, ws.host),
    ]);
    return { workspace: ws, git, tree: treeRes.tree, treeStats: treeRes.stats };
  }
}
