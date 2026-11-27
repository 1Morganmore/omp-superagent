import { hostPaths, type Config } from "../config/config";
import type { Lane } from "../contracts";
import { HostConnection } from "../omp/host";
import { lookupWorker, remoteLanePaths, workerConnect, workerRef } from "../worker/worker-wire";

/** The saved lane and selected instance must agree before contact. Send the
 * stop only over the connection on which its native identity was established. */
export async function stopManagedLane(config: Config, lane: Lane): Promise<void> {
  const remote = lane.remote;
  const paths = remote ? remoteLanePaths(remote, lane.id) : hostPaths(config, lane.id);
  if (!lane.pid || !lane.sessionId || lane.socketPath !== paths.socketPath || (remote && lane.sessionFile !== paths.sessionFile))
    throw new Error("Lane has no recorded Host identity eligible for shutdown");

  const endpoint = remote ? {
    connection: await workerConnect(await lookupWorker(config.stateDir, remote), workerRef(lane)),
  } : await HostConnection.open(paths.socketPath);
  try {
    const state = "state" in endpoint ? endpoint.state : await endpoint.connection.client.getState();
    if (state.hostPid !== lane.pid || state.sessionId !== lane.sessionId || state.sessionFile !== lane.sessionFile ||
        (!remote && "workerAttempt" in state))
      throw new Error("Host identity no longer matches the recorded lane; shutdown was not sent");
    const response = await endpoint.connection.request({ type: "shutdown_host" });
    if (!response.success) throw new Error(response.error ?? "Host refused shutdown");
  } finally { await endpoint.connection.close(); }
}
