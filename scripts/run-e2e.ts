// E2E gate: runs `bun test ./test/e2e` with FUTURE_E2E=1 (e2e tests skip without it).
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const proc = Bun.spawn([process.execPath, "test", "./test/e2e"], {
  cwd: REPO_ROOT,
  env: { ...process.env, FUTURE_E2E: "1" },
  stdio: ["inherit", "inherit", "inherit"],
});
const code = await proc.exited;
if (code === 0) console.log("COMPLETE");
process.exit(code);
