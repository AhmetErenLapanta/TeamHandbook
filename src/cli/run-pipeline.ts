import { drainHarvestJobs, runHarvestJob } from "../lib/pipeline.js";

async function main(): Promise<void> {
  const jobs = drainHarvestJobs();
  for (const job of jobs) {
    await runHarvestJob(job);
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
