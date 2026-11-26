import { readNativeSessionId } from "./native-journal";

try {
  const [, , operation, path] = process.argv;
  if (operation !== "session-id" || !path?.startsWith("/")) throw new Error("Expected an absolute session path");
  const id = await readNativeSessionId(path);
  process.stdout.write(`GATEWAY_HOST ${JSON.stringify(id ?? null)}\n`);
} catch {
  // Do not put private session diagnostics on the Gateway channel.
  console.error("Gateway Host session identity is unavailable");
  process.exitCode = 1;
}
