/** Enrollment pins the full destination, including a non-default OpenSSH port.
 * SSH config aliases and arbitrary client options are not part of this syntax. */
export function parseWorkerDestination(value: string) {
  if (value.length > 320) return;
  const match = /^([A-Za-z0-9_][\w.-]*@[A-Za-z0-9][\w.-]*)(?::([1-9][0-9]{0,4}))?(?![\s\S])/.exec(value);
  if (!match?.[1]) return;
  const port = match[2];
  if (port && Number(port) > 65535) return;
  return { login: match[1], port };
}
