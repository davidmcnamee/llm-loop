import _, { result } from "lodash";
import { PrismaClient } from "@prisma/client";
import { query } from "@anthropic-ai/claude-code";

const prisma = new PrismaClient();

const DEFAULT_CWD = process.env.DEFAULT_CWD as string;
if (typeof DEFAULT_CWD !== "string") throw new Error("DEFAULT_CWD must be a string");

const SELF_DM_CHANNEL = process.env.SELF_DM_CHANNEL as string;
if (typeof SELF_DM_CHANNEL !== "string") throw new Error("SELF_DM_CHANNEL must be a string");

async function startLoop() {
  await runEvery(1000 * 60 * 10, async () => {
    const { response: allMessages } = await askLlm<{ threadId: string; messageId: string }[]>(`Are there any new slack messages in DM ${SELF_DM_CHANNEL}`);
    for (const [threadId, threadMessages] of _.entries(_.groupBy(allMessages, (m) => m.threadId))) {
      const existingSession = await prisma.task.findUnique({ where: { threadId } });

      let branchName = existingSession?.branchName;
      if (!existingSession) {
        let {
          response: { branchName },
        } = await askLlm<{ branchName: string }>(`generate a branch name from the input prompt ${threadMessages}`);
        await askLlm<void>(`create a git worktree at ~/dev/worktrees/${branchName} and create a branch ${branchName} on that worktree`);
      }
      assertNotNull(branchName);

      const {
        response: { responseTs },
        sessionId,
      } = await askLlm<{ responseTs: string }>(`Read these slack messages ${threadMessages}, and send a response to ${threadId}`, {
        sessionId: existingSession?.sessionId ?? null,
        cwd: `~/dev/worktrees/${branchName}`,
      });
      const {
        response: { status },
      } = await askLlm<{ status: "awaiting user" | "done" | "cancelled" }>(`How would you describe the status of this task?`, {
        sessionId: existingSession?.sessionId ?? sessionId,
        cwd: `~/dev/worktrees/${branchName}`,
      });

      if (!existingSession) {
        await prisma.task.create({ data: { threadId, sessionId, branchName, status } });
      }
      await prisma.seenSlackMessages.createMany({ data: threadMessages.map((m) => ({ id: m.messageId })).concat([{ id: responseTs }]) });
    }
  });
}

async function askLlm<T>(
  prompt: string,
  { sessionId = null, cwd = DEFAULT_CWD }: { sessionId: string | null; cwd: string } = { sessionId: null, cwd: DEFAULT_CWD }
): Promise<{ response: T; sessionId: string }> {
  for await (const message of query({
    prompt,
    options: {
      maxTurns: 5,
    },
  })) {
    if (message.type === "result" && message.subtype === 'success') {
        const result = message.result;
        try {
           return { response: JSON.parse(result), sessionId: message.session_id };
        } catch(error) {
            throw new Error('Failed to parse result ' + result);
        }
    } else if(message.type === 'result') {
        let errMsg: string;
        if(message.subtype === 'error_max_turns') {
            errMsg = 'Max turns exceeded';
        } else {
            errMsg = 'Unknown error';
        }
        throw new Error(errMsg + ' ' + JSON.stringify(message));
    }
  }
}

async function runEvery(intervalMs: number, callback: () => Promise<void>) {
  let lastTime = 0;
  while (true) {
    await sleepUntil(lastTime + intervalMs);
    await callback();
    lastTime = new Date().getTime();
  }
}

function assertNotNull<T>(value: T | null | undefined): asserts value is T {
  if (value === null || value === undefined) throw new Error("value should not be null");
}

function sleepUntil(time: number) {
  const now = new Date().getTime();
  const timeToSleep = Math.max(0, time - now);
  return new Promise((resolve) => setTimeout(resolve, timeToSleep));
}

startLoop();
