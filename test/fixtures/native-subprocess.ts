import { join } from "node:path";

/** Allowlist shared by the native subprocess proofs; do not inherit the caller's account environment. */
export function isolatedNativeEnvironment(root: string) {
  const home = join(root, "home");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_NO_TITLE: "1", CI: "true", NO_COLOR: "1",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), COPILOT_HOME: join(root, "copilot"),
    TMPDIR: root, TMP: root, TEMP: root,
  };
}

/** Failure bound for real subprocess and RPC work, not a synchronization delay. */
export async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(label)), ms);
  try { return await Promise.race([work, expired.promise]); }
  finally { clearTimeout(timer); }
}
