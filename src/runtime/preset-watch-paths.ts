import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

export function presetWatchState(paths: readonly string[]): {
  direct: Map<string, Set<string>>;
  ancestors: Map<string, Set<string>>;
  uncovered: boolean;
  snapshot: string;
} {
  const direct = new Map<string, Set<string>>();
  const ancestors = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, dir: string, name: string) => {
    let names = map.get(dir);
    if (!names) { names = new Set(); map.set(dir, names); }
    names.add(name);
  };
  const addAncestor = (missingDir: string): boolean => {
    let child = missingDir;
    let parent = dirname(child);
    while (parent !== child && !existsSync(parent)) {
      child = parent;
      parent = dirname(child);
    }
    if (parent !== child && existsSync(parent)) {
      add(ancestors, parent, basename(child));
      return true;
    }
    return false;
  };
  const statIdentity = (filePath: string, follow: boolean): string => {
    try {
      const info = (follow ? statSync : lstatSync)(filePath, { bigint: true });
      const kind = !follow && info.isSymbolicLink() ? "l" : info.isDirectory() ? "d" : "f";
      return `${info.dev}:${info.ino}:${kind}`;
    } catch {
      return "missing";
    }
  };
  let uncovered = false;
  const entries: string[] = [];
  const watchLinks = (target: string) => {
    const absolute = resolve(target);
    let dir = parse(absolute).root;
    let parts = absolute.slice(dir.length).split(sep);
    let followed = 0;
    for (let name = parts.shift(); name !== undefined; name = parts.shift()) {
      if (!name || name === ".") continue;
      if (name === "..") { dir = dirname(dir); continue; }
      const path = join(dir, name);
      let info;
      try { info = lstatSync(path, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") uncovered = true;
        else add(ancestors, dir, name);
        return;
      }
      if (!info.isSymbolicLink()) {
        if (parts.length && !info.isDirectory()) { uncovered = true; return; }
        dir = path;
        continue;
      }
      // Subscribe to every physical hop, not just the input path and the final realpath.
      add(ancestors, dir, name);
      const parent = dirname(dir);
      if (parent !== dir) add(ancestors, parent, basename(dir));
      try {
        const link = readlinkSync(path);
        entries.push(`link:${path}|${info.dev}:${info.ino}|${link}`);
        // Linux stops resolving paths after this many symlinks, including cycles.
        if (++followed > 40) { uncovered = true; return; }
        const root = parse(link).root;
        if (root) dir = root;
        parts = [...link.slice(root.length).split(sep), ...parts];
      } catch { uncovered = true; return; }
    }
  };
  for (const target of paths) {
    const directory = dirname(target);
    const name = basename(target);
    watchLinks(target);
    if (!existsSync(directory)) {
      uncovered = true;
      const watched = addAncestor(directory);
      entries.push(`${target}|missing|${watched}`);
      continue;
    }
    add(direct, directory, name);
    const parentDir = dirname(directory);
    if (parentDir !== directory && existsSync(parentDir)) add(ancestors, parentDir, basename(directory));
    let realDir = "";
    try {
      realDir = realpathSync(directory);
      if (realDir !== directory) {
        add(direct, realDir, name);
        const realParent = dirname(realDir);
        if (realParent !== realDir && existsSync(realParent)) add(ancestors, realParent, basename(realDir));
      }
    } catch {
      uncovered = true;
    }
    let resolved: string | null = null;
    let covered = true;
    try {
      lstatSync(target);
      try {
        const real = realpathSync(target);
        resolved = real;
        if (real !== target) {
          const realTargetDir = dirname(real);
          if (existsSync(realTargetDir)) {
            add(direct, realTargetDir, basename(real));
            const realTargetParent = dirname(realTargetDir);
            if (realTargetParent !== realTargetDir && existsSync(realTargetParent)) {
              add(ancestors, realTargetParent, basename(realTargetDir));
            }
          } else {
            covered = false;
          }
        }
      } catch {
        // Dangling symlink or unresolvable target: watch link target's parent/ancestor if possible and keep fallback active.
        covered = false;
        try {
          const linkDest = resolve(directory, readlinkSync(target));
          const linkDir = dirname(linkDest);
          if (existsSync(linkDir)) add(direct, linkDir, basename(linkDest));
          else addAncestor(linkDir);
        } catch {}
      }
    } catch {
      // File does not exist yet inside an existing directory: directory watch covers creation.
    }
    if (!covered) uncovered = true;
    entries.push(`${target}|exists|${statIdentity(directory, true)}|${realDir}|${statIdentity(realDir, true)}|${resolved ?? ""}|${statIdentity(target, false)}|${statIdentity(target, true)}|${covered}`);
  }
  return { direct, ancestors, uncovered, snapshot: entries.join("\n") };
}
