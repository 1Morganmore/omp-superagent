#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const [mode, ...extra] = process.argv.slice(2);
if (extra.length || mode !== undefined && mode !== "--publish" && mode !== "--replace")
  throw new Error("Usage: bun run release [--publish|--replace]");

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
if (mode !== undefined) {
  if (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== tag)
    throw new Error(`Publishing requires the ${tag} tag workflow`);
  if (await run(["git", "rev-parse", `${tag}^{commit}`]) !== revision)
    throw new Error("Release tag does not identify the checked-out commit");
}
if (mode === "--replace" && process.env.GITHUB_EVENT_NAME !== "workflow_dispatch")
  throw new Error("Replacing a release requires the manual tag workflow");
const notes = join(root, "docs/releases", `${version}.md`);
if (!await Bun.file(notes).exists()) throw new Error(`Missing release notes: ${notes}`);
const directory = join(root, "dist");
await mkdir(directory, { recursive: true });
const sourceFilename = `${name}-${version}.tar.gz`;
const packageFilename = `${name}-${version}.tgz`;
const archive = join(directory, sourceFilename);
await run(["git", "archive", "--format=tar.gz", `--prefix=${name}-${version}/`, `--output=${archive}`, revision]);
await run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", join(directory, packageFilename)]);
const assets: string[] = [];
for (const filename of [sourceFilename, packageFilename]) {
  const path = join(directory, filename);
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
  const checksum = `${path}.sha256`;
  await Bun.write(checksum, `${digest}  ${filename}\n`);
  assets.push(path, checksum);
}
console.log(`Packaged ${revision}\n${assets.join("\n")}`);
if (mode === "--publish") {
  console.log(await run(["gh", "release", "create", tag, ...assets,
    "--verify-tag", "--title", `${name} ${version}`, "--notes-file", notes]));
} else if (mode === "--replace") {
  // Check the live tag, not just the checkout used by earlier CI jobs.
  const remote = await run(["git", "ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (remote.split("\n").at(-1)?.split("\t")[0] !== revision)
    throw new Error("Remote release tag no longer identifies the verified commit");
  console.log(await run(["gh", "release", "upload", tag, ...assets, "--clobber"]));
  console.log(await run(["gh", "release", "edit", tag, "--verify-tag", "--notes-file", notes]));
}
