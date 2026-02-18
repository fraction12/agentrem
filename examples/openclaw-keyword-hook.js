import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AGENTREM_PATH = "/opt/homebrew/bin/agentrem";

/**
 * Check keyword-triggered reminders on every inbound message.
 * If matches are found, inject them into the agent's context.
 */
const handler = async (event) => {
  // Only handle inbound messages
  if (event.type !== "message" || event.action !== "received") return;

  const content = event.context?.content;
  if (!content || typeof content !== "string") return;

  // Skip very short messages (reactions, "ok", "thanks", single emojis)
  const trimmed = content.trim();
  if (trimmed.length < 4) return;

  try {
    const { stdout, stderr } = await execFileAsync(
      AGENTREM_PATH,
      ["check", "--type", "keyword", "--text", trimmed, "--format", "inline"],
      { timeout: 5000, env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } }
    );

    // Exit code 0 means reminders matched
    if (stdout && stdout.trim()) {
      event.messages.push(
        `[System Message] Agent reminder triggered:\n${stdout.trim()}`
      );
    }
  } catch (err) {
    // execFile throws on non-zero exit codes
    // Exit code 1 = no keyword matches (normal, expected most of the time)
    const exitCode = err?.code;
    if (exitCode === 1) return; // No matches — silent, expected

    // Real errors (exit code 2, timeout, crash)
    console.error(
      "[agentrem-keyword-check] Error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
