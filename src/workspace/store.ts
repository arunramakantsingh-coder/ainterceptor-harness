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
   * The path is canonicalised with realpath, so `C:\a\link` and `C:\a\real`
   * resolve to one workspace. A non-existent path is an error - we never
   * invent a workspace for a directory that is not there.
   */
  async open(inputPath: string, host = "local"): Promise<Workspace> {
    await this.load();
    const expanded = inputPath.startsWith("~")
      ? path.join(os.homedir(), inputPath.slice(1).replace(/^[/\\]/, ""))
      : inputPath;

    let canonical: string;
    try {
      canonical = await realpath(path.resolve(expanded));
    } catch {
      throw new Error(`path does not exist or is not readable: ${expanded}`);
    }

    const st = await stat(canonical).catch(() => undefined);
    if (!st?.isDirectory()) {
      throw new Error(`not a directory: ${canonical}`);
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
    opts: { depth?: number; maxEntries?: number } = {},
  ): Promise<{ tree: TreeNode[]; stats: { files: number; dirs: number; truncated: boolean } }> {
    const maxDepth = opts.depth ?? 3;
    const maxEntries = opts.maxEntries ?? 4000;
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
   * Read-only git facts. Runs in the workspace root so relative paths behave.
   * Every command here is non-mutating.
   */
  async git(root: string, host = "local"): Promise<GitStatus> {
    const script = [
      "set -u",
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "ISREPO=0"; exit 0; fi',
      'echo "ISREPO=1"',
      'echo "BRANCH=$(git branch --show-current 2>/dev/null)"',
      'echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null)"',
      'echo "COUNTS=$(git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null || echo "")"',
      'echo "CHANGES_BEGIN"',
      "git status --porcelain=v1 2>/dev/null | head -100",
      'echo "CHANGES_END"',
    ].join("\n");

    try {
      const res = await this.executor.run({
        target: host,
        command: script,
        cwd: root,
        permission: "read",
        timeoutMs: 30_000,
      });
      if (res.exitCode !== 0) {
        return { isRepo: false, changes: [], error: res.stderr.slice(0, 200) };
      }
      const out = res.stdout;
      if (/^ISREPO=0$/m.test(out)) return { isRepo: false, changes: [] };

      const grab = (k: string): string | undefined => {
        const m = new RegExp(`^${k}=(.*)$`, "m").exec(out);
        return m?.[1]?.trim() || undefined;
      };
      const changes = (/CHANGES_BEGIN\n([\s\S]*?)\nCHANGES_END/.exec(out)?.[1] ?? "")
        .split(/\r?\n/)
        .map((s) => s.trimEnd())
        .filter(Boolean);

      const counts = grab("COUNTS");
      let ahead: number | undefined;
      let behind: number | undefined;
      if (counts) {
        const [b, a] = counts.split(/\s+/).map((n) => Number(n));
        if (Number.isFinite(b)) behind = b;
        if (Number.isFinite(a)) ahead = a;
      }

      return {
        isRepo: true,
        branch: grab("BRANCH"),
        head: grab("HEAD"),
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

  async detail(id: string): Promise<WorkspaceDetail | undefined> {
    const ws = await this.get(id);
    if (!ws) return undefined;
    const [treeRes, git] = await Promise.all([this.tree(ws.root), this.git(ws.root, ws.host)]);
    return { workspace: ws, git, tree: treeRes.tree, treeStats: treeRes.stats };
  }
}
