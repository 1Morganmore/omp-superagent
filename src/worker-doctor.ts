import { listWorkers, matchWorkerDescription, WorkerRegistrationError } from "./worker-registration";
import { workerRepositoryHead } from "./worker-repository";
import { workerDescribe, type WorkerDescription, type WorkerLaneRef, type WorkerRegistration } from "./worker-wire";

type Workspace = Pick<WorkerLaneRef, "repoId" | "revision" | "subdir">;

function verifiedWorker({ destination, description, defaultRepository }: WorkerRegistration) {
  const { active: _enrollmentSnapshot, ...verified } = description;
  return { destination, ...verified, default: defaultRepository !== undefined, ...(defaultRepository && { defaultRepository }) };
}

/** Local inventory only: never expose a private key path or stale activity as live. */
export function workerInventory(stateDir: string) {
  return { source: "verified-inventory", workers: listWorkers(stateDir).map(verifiedWorker) };
}

async function describeEnrollment(registration: WorkerRegistration, workspace?: Workspace) {
  let reply: WorkerDescription;
  try { reply = await workerDescribe(registration, workspace); }
  catch (error) {
    if (error instanceof WorkerRegistrationError)
      return { reason: "identity-unavailable", detail: "The dedicated SSH identity is missing or unsafe." } as const;
    if (error instanceof Error) {
      // Do not surface peer-supplied refusal messages or raw SSH output.
      return { reason: "describe-unverified", detail: workspace
        ? "The worker did not verify the requested checkout revision through the enrolled connection."
        : "No verified describe receipt. Check the enrolled OpenSSH endpoint, independently verified host key and target policy." } as const;
    }
    throw error;
  }
  try {
    const description = matchWorkerDescription(registration.description, reply);
    if (!description)
      return { reason: "enrollment-mismatch", detail: "The live description differs from the verified enrollment." } as const;
    return { live: { active: description.active, available: description.capacity - description.active } } as const;
  } catch (error) {
    if (error instanceof WorkerRegistrationError)
      return { reason: "invalid-description", detail: "The worker returned an invalid description." } as const;
    throw error;
  }
}

/** Observes the verified endpoint but never refreshes enrollment, allocates capacity or starts a Host. */
export async function workerDoctor(stateDir: string, destination: string) {
  const registration = listWorkers(stateDir).find(worker => worker.destination === destination);
  if (!registration) return { status: "blocked", destination, reason: "unregistered",
    detail: "No verified registration for this destination. Complete worker add, target worker init and worker add again." } as const;

  const worker = verifiedWorker(registration);
  const observed = await describeEnrollment(registration);
  if (!observed.live) return { status: "blocked", worker, check: "worker", ...observed } as const;

  const { defaultRepository } = registration;
  if (!defaultRepository) return { status: "ok", worker, live: observed.live } as const;

  const source = await workerRepositoryHead(defaultRepository.root);
  if (!source || source.root !== defaultRepository.root || source.repoId !== defaultRepository.repoId || source.subdir !== "")
    return { status: "blocked", worker, live: observed.live, check: "default-workspace", reason: "local-checkout-unverified",
      detail: "The enrolled default requires the same clean local checkout root and Git repository identity." } as const;

  // Send only the authorized repository binding, never the head-side path.
  const { root: _root, ...workspace } = source;
  const scoped = await describeEnrollment(registration, workspace);
  if (!scoped.live) return { status: "blocked", worker, live: observed.live, check: "default-workspace", workspace, ...scoped } as const;
  return { status: "ok", worker, live: scoped.live, workspace } as const;
}
