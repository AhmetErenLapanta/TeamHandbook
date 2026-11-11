import type { JiraBoard, JiraIssue } from "./jira.js";
import type { OrgSpec, TeamSpec } from "./orgs.js";

/**
 * An organization whose one change reaches three code repositories: a customer API gateway that
 * keeps a JSON file per route, a backend-for-frontend with a controller per resource, and the
 * service behind it with an endpoint per call. Its team's skill says how one endpoint goes
 * through all three, and its issue asks for one. Each repository's tests are `scripts/check.sh`,
 * which fail on a file that breaks the repository's own shape or carries the marker a stand-in
 * agent writes when a task asks it to break them.
 */

export const MULTI_REPO_ISSUE: JiraIssue = {
  key: "HOO-412",
  summary: "Expose the shipment-tracking endpoint to customers",
  description:
    "Customers ask where a shipment is; the service knows, but nothing outside it can ask.\n\n" +
    "Acceptance criteria:\n" +
    "- customer-gateway routes GET /v1/shipments/{id}/tracking to customer-bff;\n" +
    "- customer-bff has a controller that calls shipment-service;\n" +
    "- shipment-service answers the tracking of one shipment;\n" +
    "- each repository's checks pass, and the three requests carry this issue's key.",
  status: "Ready for Dev",
  subtasks: [],
  comments: [{ author: "Cara Customers", body: "One request per repository, all three under HOO-412.", created: "2026-10-26T09:00:00.000+0000" }],
  type: "Story",
  assignee: "Cara Customers",
  storyPoints: 5,
  labels: ["customer-api"],
};

/** An issue that asks for one endpoint through the three repositories, the shape the stand-in agent reads. */
const endpointIssue = (key: string, name: string, why: string, points: number, assignee: string | null): JiraIssue => ({
  key,
  summary: `Expose the ${name} endpoint to customers`,
  description: `${why}\n\nAcceptance criteria: customer-gateway routes it, customer-bff calls it, shipment-service answers it, and each repository's checks pass.`,
  status: "Ready for Dev",
  subtasks: [],
  comments: [],
  type: "Story",
  assignee,
  storyPoints: points,
  labels: ["customer-api"],
});

/** The team's sprint: three issues in it, two waiting in the backlog, one of them a bug the stand-in agent leaves alone. */
export const SPRINT_ISSUES: JiraIssue[] = [
  endpointIssue("HOO-413", "delivery-window", "Customers ask when a delivery will arrive; the service knows the window.", 3, "Cara Customers"),
  endpointIssue("HOO-414", "return-label", "Customers print a label to send a shipment back; the service makes one.", 2, null),
];

export const BACKLOG_ISSUES: JiraIssue[] = [
  endpointIssue("HOO-415", "carrier-list", "Customers pick a carrier; the service lists the ones it ships with.", 1, null),
  { key: "HOO-416", summary: "The shipment list skips its last page", description: "With an exact multiple of the page size, the last page is never shown.", status: "Ready for Dev", subtasks: [], comments: [], type: "Bug", assignee: null, storyPoints: 1, priority: "High", labels: [] },
];

/** The Customers team's scrum board: its active sprint holds HOO-412 to HOO-414, the next one nothing yet. */
export const CUSTOMERS_BOARD: JiraBoard = {
  id: 7,
  name: "Customers board",
  projectKey: "HOO",
  projectName: "Hooli Customers",
  // The team's own workflow, not the orchestrator's stages: an agent's stage is a badge on the card.
  columns: [
    { name: "Ready for Dev", statuses: ["Ready for Dev"] },
    { name: "In Dev", statuses: ["In Dev"] },
    { name: "Code Review", statuses: ["Code Review"] },
    { name: "Ready for Test", statuses: ["Ready for Test"] },
    { name: "In Test", statuses: ["In Test"] },
    { name: "Test Passed", statuses: ["Test Passed"] },
    { name: "Done", statuses: ["Done"] },
  ],
  sprints: [
    { id: 41, name: "Customers Sprint 14", state: "active", goal: "Customers can follow, time and return a shipment", startDate: "2026-10-27T08:00:00.000Z", endDate: "2026-11-10T17:00:00.000Z", issues: ["HOO-412", "HOO-413", "HOO-414"] },
    { id: 42, name: "Customers Sprint 15", state: "future", goal: "", startDate: null, endDate: null, issues: [] },
    { id: 40, name: "Customers Sprint 13", state: "closed", goal: "Shipments are listed", startDate: "2026-10-13T08:00:00.000Z", endDate: "2026-10-24T17:00:00.000Z", issues: [] },
  ],
  backlog: ["HOO-415", "HOO-416"],
};

const BRANCH_EXAMPLE = "HOO-123-short-description";

const check = (shape: string, test: string) =>
  `#!/bin/sh
# The repository's own checks: ${shape}, and no file carrying the marker a broken change leaves.
set -eu
${test}
# The marker is spelled in two halves, so this script never carries it and finds only a broken file.
marker="LAB""-BROKEN"
if grep -rl "$marker" --exclude-dir=.git . >/dev/null 2>&1; then
  echo "a check fails: a file carries the $marker marker"
  exit 1
fi
echo "checks pass"
`;

const code = (id: string, files: Record<string, string>): TeamSpec => ({
  id,
  team: "Customers",
  branchExample: BRANCH_EXAMPLE,
  reviewers: [],
  labels: [],
  skills: [],
  testCommand: "sh scripts/check.sh",
  code: { skillsFrom: "customer-skills", files },
});

const ADD_ENDPOINT = `1. Read the issue: its key names every branch and every request, and its acceptance criteria name the route.
2. In customer-gateway, add one file under endpoints/ for the route: its endpoint, method and the backend it reaches in customer-bff.
3. In customer-bff, add a controller under src/controllers/ that answers the gateway's path and calls shipment-service.
4. In shipment-service, add the endpoint under src/endpoints/ that answers the call.
5. Run scripts/check.sh in each repository; a change whose checks fail is not proposed.
6. Open one request per repository, each titled and branched with the issue's key, and say in each which other two belong with it.

## Which repositories

- shipment-service: the endpoint that answers the call, under src/endpoints/.
- customer-bff: the controller the customers' apps call, under src/controllers/.
- customer-gateway: the route customers reach, one JSON file under endpoints/.
`;

export const MULTI_REPO_ORG: OrgSpec = {
  name: "hooli",
  store: "sqlite",
  forge: "gitlab",
  fixture: "multi-repo",
  teams: [
    {
      id: "customer-skills",
      team: "Customers",
      version: "0.1.0",
      branchExample: BRANCH_EXAMPLE,
      reviewers: [],
      labels: [],
      skills: [{ slug: "add-endpoint", description: "Use when an issue exposes a new API to customers: the route in customer-gateway, the controller in customer-bff and the endpoint in shipment-service, one request each under the issue's key.", body: ADD_ENDPOINT }],
    },
    code("customer-gateway", {
      "README.md": "# customer-gateway\n\nThe customers' API: one JSON file per route under endpoints/.\n",
      "endpoints/shipments-list.json": JSON.stringify({ endpoint: "/v1/shipments", method: "GET", backend: { service: "customer-bff", path: "/shipments" } }, null, 2) + "\n",
      "scripts/check.sh": check(
        "every route names an endpoint, a method and a backend",
        `for f in endpoints/*.json; do
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!r.endpoint || !r.method || !r.backend) process.exit(1)' "$f" || { echo "$f is not a route"; exit 1; }
done`,
      ),
    }),
    code("customer-bff", {
      "README.md": "# customer-bff\n\nThe backend for the customers' apps: one controller per resource under src/controllers/.\n",
      "src/controllers/ShipmentsController.ts": 'export class ShipmentsController {\n  readonly path = "/shipments";\n\n  async list(): Promise<unknown[]> {\n    return [];\n  }\n}\n',
      "scripts/check.sh": check(
        "every controller exports a class with a path",
        `for f in src/controllers/*.ts; do
  grep -q "export class" "$f" && grep -q "readonly path" "$f" || { echo "$f is not a controller"; exit 1; }
done`,
      ),
    }),
    code("shipment-service", {
      "README.md": "# shipment-service\n\nWhere shipments are kept: one endpoint per call under src/endpoints/.\n",
      "src/endpoints/list-shipments.ts": 'export const listShipments = { method: "GET", path: "/shipments" };\n',
      "scripts/check.sh": check(
        "every endpoint exports a method and a path",
        `for f in src/endpoints/*.ts; do
  grep -q "method:" "$f" && grep -q "path:" "$f" || { echo "$f is not an endpoint"; exit 1; }
done`,
      ),
    }),
  ],
  people: [
    { key: "admin", name: "Hal Hooli-Owner", role: "owner", teams: [] },
    { key: "org-admin", name: "Ida Hooli-Admin", role: "admin", teams: [] },
    { key: "owner:Customers", name: "Cara Customers", role: "member", teams: ["Customers"] },
    { key: "member", name: "Max Member", role: "member", teams: [] },
  ],
  developers: [],
  forgeUsers: ["hal", "ida"],
  agents: "fake,claude-code",
  // A sprint's three issues run side by side.
  taskConcurrency: 3,
};
