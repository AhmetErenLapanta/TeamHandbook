# Browser tests

`npm run e2e` runs the specs here (`*.spec.ts`) against a self-hosted orchestrator that
`playwright.config.ts` builds and starts on SQLite with the demo seed, on `ORCHESTRATOR_E2E_PORT`
(18181 by default). Run only the specs you need with `--workers=1`.

`npm run test:e2e:cloud` runs the cloud specs (`*.cloud.ts`) with `playwright.cloud.config.ts`.
They need a Postgres the run can create databases on, named by `ORCHESTRATOR_TEST_DATABASE_URL`, and
skip without it. Before any spec, `cloud-setup.ts` creates a throwaway database, builds the
orchestrator, starts the lab's stand-in Google, GitHub and Microsoft (`lab/sign-in-providers.ts`) on a
free port with the clients `lab/cloud.ts` registers, migrates the database as a cloud orchestrator
requires (`node dist/server.js migrate`), and starts the orchestrator with `ORCHESTRATOR_MODE=cloud` on
`ORCHESTRATOR_E2E_PORT` (18192 by default). The browser opens it at `https://orchestrator.example.invalid`,
which the specs route to that port, so the orchestrator's secure cookies behave as they do in
production; redirects become pages that move on by themselves, since a browser follows a redirect
without asking the routes again. Nothing reaches a real provider or the network. At the end the
orchestrator and the providers stop and the database is dropped; when the orchestrator does not come up,
the error quotes the last lines of its log.
