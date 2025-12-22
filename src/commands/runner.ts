import { mkdir } from "node:fs/promises";
import { getBasePrompt } from "../prompts/base-prompt.ts";
import { prettyPrintLine, prettyPrintStderr } from "../utils/pretty-print.ts";

/** Save PM2 process list for persistence across container restarts */
async function savePm2State(role: string): Promise<void> {
  try {
    console.log(`[${role}] Saving PM2 process list...`);
    await Bun.$`pm2 save`.quiet();
    console.log(`[${role}] PM2 state saved`);
  } catch {
    // PM2 not available or no processes - silently ignore
  }
}

/** Setup signal handlers for graceful shutdown */
function setupShutdownHandlers(role: string): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[${role}] Received ${signal}, shutting down...`);
    await savePm2State(role);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Configuration for a runner role (worker or lead) */
export interface RunnerConfig {
  /** Role name for logging, e.g., "worker" or "lead" */
  role: string;
  /** Default prompt if none provided */
  defaultPrompt: string;
  /** Metadata type for log files, e.g., "worker_metadata" */
  metadataType: string;
  /** Optional capabilities of the agent */
  capabilities?: string[];
}

export interface RunnerOptions {
  prompt?: string;
  yolo?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  logsDir?: string;
  additionalArgs?: string[];
}

interface RunClaudeIterationOptions {
  prompt: string;
  logFile: string;
  systemPrompt?: string;
  additionalArgs?: string[];
  role: string;
}

async function runClaudeIteration(opts: RunClaudeIterationOptions): Promise<number> {
  const { role } = opts;
  const CMD = [
    "claude",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "-p",
    opts.prompt,
  ];

  if (opts.additionalArgs && opts.additionalArgs.length > 0) {
    CMD.push(...opts.additionalArgs);
  }

  if (opts.systemPrompt) {
    CMD.push("--append-system-prompt", opts.systemPrompt);
  }

  console.log(`\x1b[2m[${role}]\x1b[0m \x1b[36m▸\x1b[0m Starting Claude (PID will follow)`);

  const logFileHandle = Bun.file(opts.logFile).writer();
  let stderrOutput = "";

  const proc = Bun.spawn(CMD, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutChunks = 0;
  let stderrChunks = 0;

  const stdoutPromise = (async () => {
    if (proc.stdout) {
      for await (const chunk of proc.stdout) {
        stdoutChunks++;
        const text = new TextDecoder().decode(chunk);
        logFileHandle.write(text);

        const lines = text.split("\n");
        for (const line of lines) {
          prettyPrintLine(line, role);
        }
      }
    }
  })();

  const stderrPromise = (async () => {
    if (proc.stderr) {
      for await (const chunk of proc.stderr) {
        stderrChunks++;
        const text = new TextDecoder().decode(chunk);
        stderrOutput += text;
        prettyPrintStderr(text, role);
        logFileHandle.write(
          `${JSON.stringify({ type: "stderr", content: text, timestamp: new Date().toISOString() })}\n`,
        );
      }
    }
  })();

  await Promise.all([stdoutPromise, stderrPromise]);
  await logFileHandle.end();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && stderrOutput) {
    console.error(`\x1b[31m[${role}] Full stderr:\x1b[0m\n${stderrOutput}`);
  }

  if (stdoutChunks === 0 && stderrChunks === 0) {
    console.warn(`\x1b[33m[${role}] WARNING: No output from Claude - check auth/startup\x1b[0m`);
  }

  return exitCode ?? 1;
}

export async function runAgent(config: RunnerConfig, opts: RunnerOptions) {
  const { role, defaultPrompt, metadataType } = config;

  // Setup graceful shutdown handlers (saves PM2 state on Ctrl+C)
  setupShutdownHandlers(role);

  const sessionId = process.env.SESSION_ID || crypto.randomUUID().slice(0, 8);
  const baseLogDir = opts.logsDir || process.env.LOG_DIR || "/logs";
  const logDir = `${baseLogDir}/${sessionId}`;

  await mkdir(logDir, { recursive: true });

  const prompt = opts.prompt || defaultPrompt;
  const isYolo = opts.yolo || process.env.YOLO === "true";

  // Get agent identity and swarm URL for base prompt
  const agentId = process.env.AGENT_ID || "unknown";
  const swarmUrl = process.env.SWARM_URL || "localhost";

  // Generate base prompt that's always included
  const basePrompt = getBasePrompt({ role, agentId, swarmUrl, capabilities: config.capabilities });

  // Resolve additional system prompt: CLI flag > env var
  let additionalSystemPrompt: string | undefined;
  const systemPromptText = opts.systemPrompt || process.env.SYSTEM_PROMPT;
  const systemPromptFilePath = opts.systemPromptFile || process.env.SYSTEM_PROMPT_FILE;

  if (systemPromptText) {
    additionalSystemPrompt = systemPromptText;
    console.log(
      `[${role}] Using additional system prompt from ${opts.systemPrompt ? "CLI flag" : "env var"}`,
    );
  } else if (systemPromptFilePath) {
    try {
      const file = Bun.file(systemPromptFilePath);
      if (!(await file.exists())) {
        console.error(`[${role}] ERROR: System prompt file not found: ${systemPromptFilePath}`);
        process.exit(1);
      }
      additionalSystemPrompt = await file.text();
      console.log(`[${role}] Loaded additional system prompt from file: ${systemPromptFilePath}`);
      console.log(
        `[${role}] Additional system prompt length: ${additionalSystemPrompt.length} characters`,
      );
    } catch (error) {
      console.error(`[${role}] ERROR: Failed to read system prompt file: ${systemPromptFilePath}`);
      console.error(error);
      process.exit(1);
    }
  }

  // Combine base prompt with any additional system prompt
  const resolvedSystemPrompt = additionalSystemPrompt
    ? `${basePrompt}\n\n${additionalSystemPrompt}`
    : basePrompt;

  console.log(`[${role}] Starting ${role}`);
  console.log(`[${role}] Session ID: ${sessionId}`);
  console.log(`[${role}] Log directory: ${logDir}`);
  console.log(`[${role}] YOLO mode: ${isYolo ? "enabled" : "disabled"}`);
  console.log(`[${role}] Prompt: ${prompt}`);
  console.log(`[${role}] Swarm URL: ${swarmUrl}`);
  console.log(`[${role}] Base prompt: included (${basePrompt.length} chars)`);
  console.log(
    `[${role}] Additional system prompt: ${additionalSystemPrompt ? "provided" : "none"}`,
  );
  console.log(`[${role}] Total system prompt length: ${resolvedSystemPrompt.length} chars`);

  let iteration = 0;

  while (true) {
    iteration++;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = `${logDir}/${timestamp}.jsonl`;

    console.log(`\n[${role}] === Iteration ${iteration} ===`);
    console.log(`[${role}] Logging to: ${logFile}`);

    const metadata = {
      type: metadataType,
      sessionId,
      iteration,
      timestamp: new Date().toISOString(),
      prompt,
      yolo: isYolo,
    };
    await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

    const exitCode = await runClaudeIteration({
      prompt,
      logFile,
      systemPrompt: resolvedSystemPrompt,
      additionalArgs: opts.additionalArgs,
      role,
    });

    if (exitCode !== 0) {
      const errorLog = {
        timestamp: new Date().toISOString(),
        iteration,
        exitCode,
        error: true,
      };

      const errorsFile = `${logDir}/errors.jsonl`;
      const errorsFileRef = Bun.file(errorsFile);
      const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
      await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

      if (!isYolo) {
        console.error(`[${role}] Claude exited with code ${exitCode}. Stopping.`);
        console.error(`[${role}] Error logged to: ${errorsFile}`);
        process.exit(exitCode);
      }

      console.warn(`[${role}] Claude exited with code ${exitCode}. YOLO mode - continuing...`);
    }

    console.log(`[${role}] Iteration ${iteration} complete. Starting next iteration...`);
  }
}
