import { drainHarvestJobs, releaseHarvestJob, runHarvestJob } from "../lib/pipeline.js";

async function main(): Promise<void> {
  for (const { job, claimedFile } of drainHarvestJobs()) {
    try {
      await runHarvestJob(job);
    } finally {
      // release only after the job has been processed (or has queued its own retry):
      // a runner killed mid-harvest leaves the claim for reclaimStaleClaims
      releaseHarvestJob(claimedFile);
    }
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
