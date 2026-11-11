# Sourced by the lab's scripts: the lab directory, LAB_DIR or one under the system's temp directory,
# worked out by node so it is the same path the lab itself and the test suite use.
lab_dir() {
  node -e 'const { tmpdir } = require("node:os"); const { join } = require("node:path"); process.stdout.write(process.env.LAB_DIR ?? join(tmpdir(), "teamhandbook-orchestrator-lab"))'
}
