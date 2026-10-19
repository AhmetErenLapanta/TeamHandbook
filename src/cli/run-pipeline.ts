import { drainHarvestJobs, keepClaimsFresh, releaseHarvestJob, runHarvestJob } from "../lib/pipeline.js";

async function main(): Promise<void> {
  const claims = drainHarvestJobs();
  // every claim this runner still holds stays fresh until its turn has come and gone
  const stop = keepClaimsFresh(claims.map((claim) => claim.claimedFile));
  try {
    for (const { job, claimedFile } of claims) {
      try {
        await runHarvestJob(job);
      } finally {
        // release only after the job has been processed (or has queued its own retry):
        // a runner killed mid-harvest leaves the claim for reclaimStaleClaims
        releaseHarvestJob(claimedFile);
      }
    }
  } finally {
    stop();
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
