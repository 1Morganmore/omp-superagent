#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--publish"))
  throw new Error("Usage: bun run release [--publish]");

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
  return text.trim();
}

if (await run(["git", "status", "--porcelain"]))
  throw new Error("Release packaging requires a clean checkout; commit the intended release changes first");
const { name, version } = JSON.parse(await run(["git", "show", "HEAD:package.json"])) as { name: string; version: string };
const tag = `v${version}`;
const revision = await run(["git", "rev-parse", "HEAD"]);
const publish = args[0] === "--publish";
if (publish) {
  if (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== tag)
    throw new Error(`Publishing requires the ${tag} tag workflow`);
  if (await run(["git", "rev-parse", `${tag}^{commit}`]) !== revision)
    throw new Error("Release tag does not identify the checked-out commit");
}
const notes = join(root, "docs/releases", `${version}.md`);
if (!await Bun.file(notes).exists()) throw new Error(`Missing release notes: ${notes}`);
const directory = join(root, "dist");
await mkdir(directory, { recursive: true });
const filename = `${name}-${version}.tar.gz`;
const archive = join(directory, filename);
await run(["git", "archive", "--format=tar.gz", `--prefix=${name}-${version}/`, `--output=${archive}`, revision]);
const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
const checksum = `${archive}.sha256`;
await Bun.write(checksum, `${digest}  ${filename}\n`);
console.log(`Packaged ${revision}\n${archive}\n${checksum}`);
if (publish) {
  console.log(await run(["gh", "release", "create", tag, archive, checksum,
    "--verify-tag", "--title", `${name} ${version}`, "--notes-file", notes]));
}
