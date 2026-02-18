import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AGENTREM_PATH = "/opt/homebrew/bin/agentrem";

/**
 * Inject due reminders into the agent's bootstrap context.
 * Runs on every session bootstrap so the agent wakes up aware of pending items.
 */
const handler = async (event) => {
  // Only handle bootstrap events
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  try {
    const { stdout } = await execFileAsync(
      AGENTREM_PATH,
      ["check", "--type", "session,time,heartbeat", "--format", "compact"],
      { timeout: 5000, env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } }
    );

    if (stdout && stdout.trim()) {
      // Inject as a bootstrap file in the agent's Project Context
      const bootstrapFiles = event.context?.bootstrapFiles;
      if (Array.isArray(bootstrapFiles)) {
        bootstrapFiles.push({
          basename: "REMINDERS.md",
          path: "agentrem://active-reminders",
          content: `# Active Reminders\n\n${stdout.trim()}`,
        });
      }
    }
  } catch (err) {
    // execFile throws on non-zero exit codes
    // Exit code 1 = no reminders due (normal, expected)
    const exitCode = err?.code;
    if (exitCode === 1) return; // No reminders — silent, expected

    // Real errors (exit code 2, timeout, crash)
    console.error(
      "[agentrem-bootstrap] Error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
