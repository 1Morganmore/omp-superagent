import { inspectInstalledOmp } from "../src/installed-omp";

const omp = await inspectInstalledOmp();
console.log(`Installed stock OMP ${omp.version} (${omp.supported}; tested ${omp.testedVersion})`);
