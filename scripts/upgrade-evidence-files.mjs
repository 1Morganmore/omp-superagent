import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireEvidence, Unconfirmed } from "./upgrade-host-wire.mjs";

const fileLimit = 16 * 1024;
export const machine = { hostname: hostname(), platform: process.platform, uid: process.getuid() };

export function absolute(path) {
  return typeof path === "string" && isAbsolute(path) && !path.includes("\0");
}

export function readJson(data) {
  try {
    return JSON.parse(data.toString());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Unconfirmed("Invalid JSON evidence");
    throw error;
  }
}

export function entry(path) {
  requireEvidence(absolute(path), "Evidence paths must be absolute");
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

export function inode(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function privateDirectory(stat) {
  return stat?.isDirectory() && stat.uid === BigInt(machine.uid) && (stat.mode & 0o777n) === 0o700n;
}

export function socket(path) {
  requireEvidence(absolute(path) && Buffer.byteLength(path) <= 100, "Invalid private Unix socket path");
  const stat = entry(path);
  requireEvidence(privateDirectory(entry(dirname(path))) && stat?.isSocket() &&
    stat.uid === BigInt(machine.uid) && (stat.mode & 0o777n) === 0o600n,
    `Not a private owned socket: ${path}`);
  return inode(stat);
}

export function ownedFile(stat, path, mode) {
  requireEvidence(stat?.isFile() && stat.uid === BigInt(machine.uid) && (stat.mode & mode) === 0n,
    `Not an owned regular file with the required permissions: ${path}`);
}

function enclosedByPrivateDirectory(path) {
  for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
    if (privateDirectory(entry(directory))) return true;
  }
  return false;
}

export function journal(path, worker) {
  const leaf = entry(path);
  const link = leaf?.isSymbolicLink();
  requireEvidence(leaf?.isFile() || (link && !worker && leaf.uid === BigInt(machine.uid)),
    "Managed journal is not an owned local link or regular file");
  const resolvedPath = realpathSync(path);
  const resolved = entry(resolvedPath);
  ownedFile(resolved, path, 0o022n);
  // Stock OMP can create regular journals with mode 0644 under private session directories.
  requireEvidence((resolved.mode & 0o077n) === 0n || enclosedByPrivateDirectory(resolvedPath),
    "Managed journal is not private");
  const current = entry(path);
  const target = link ? statSync(path, { bigint: true }) : current;
  requireEvidence(current && current.uid === leaf.uid && isDeepStrictEqual(inode(current), inode(leaf)) &&
    target.mode === resolved.mode && target.uid === resolved.uid && isDeepStrictEqual(inode(target), inode(resolved)),
    "Managed journal changed during inspection");
  return { resolvedPath, ...inode(resolved), ...(link ? { link: inode(leaf) } : {}) };
}

export function privateJson(path, stat, limit = fileLimit) {
  ownedFile(stat, path, 0o077n);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    ownedFile(opened, path, 0o077n);
    requireEvidence(isDeepStrictEqual(inode(opened), inode(stat)), `Evidence was replaced: ${path}`);
    requireEvidence(opened.size <= BigInt(limit), "Evidence exceeded size limit");
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = entry(path);
    requireEvidence(length === buffer.length - 1 && after && after.mode === opened.mode && after.uid === opened.uid &&
      isDeepStrictEqual(inode(after), inode(opened)) && after.size === opened.size &&
      after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs,
      `Evidence exceeded size limit or changed during read: ${path}`);
    return readJson(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
