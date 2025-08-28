import { query } from '@anthropic-ai/claude-code'
import { PrismaClient } from '@prisma/client'
import _ from 'lodash'
import { z } from 'zod'

const prisma = new PrismaClient()

const DEFAULT_CWD = process.env.DEFAULT_CWD as string
if (typeof DEFAULT_CWD !== 'string') throw new Error('DEFAULT_CWD must be a string')

const SELF_DM_CHANNEL = process.env.SELF_DM_CHANNEL as string
if (typeof SELF_DM_CHANNEL !== 'string') throw new Error('SELF_DM_CHANNEL must be a string')

const DEBUG = process.env.DEBUG === 'true'

async function startLoop() {
    await runEvery(1000 * 60 * 10, async () => {
        const { response: allMessages } = await askLlm(`Are there any new slack messages in DM ${SELF_DM_CHANNEL}`, z.array(z.object({ threadId: z.string(), messageId: z.string() })))
        
        await maybeParallelize(_.entries(_.groupBy(allMessages, (m) => m.threadId)), async ([threadId, threadMessages]) => {
            const existingSession = await prisma.task.findUnique({ where: { threadId } })

            let branchName = existingSession?.branchName
            if (!existingSession) {
                let {
                    response: { branchName }
                } = await askLlm(`generate a branch name from the input prompt ${threadMessages}`, z.object({ branchName: z.string() }))
                await askLlm(`create a git worktree at ~/dev/worktrees/${branchName} and create a branch ${branchName} on that worktree`, z.void())
            }
            assertNotNull(branchName)

            const {
                response: { responseTs },
                sessionId
            } = await askLlm(`Read these slack messages ${threadMessages}, and send a response to ${threadId}`, z.object({ responseTs: z.string() }), {
                sessionId: existingSession?.sessionId ?? null,
                cwd: `~/dev/worktrees/${branchName}`
            })
            const {
                response: { status }
            } = await askLlm(`How would you describe the status of this task?`, z.object({ status: z.enum(['awaiting user', 'done', 'cancelled']) }), {
                sessionId: existingSession?.sessionId ?? sessionId,
                cwd: `~/dev/worktrees/${branchName}`
            })

            if (!existingSession) {
                await prisma.task.create({ data: { threadId, sessionId, branchName, status } })
            }
            await prisma.seenSlackMessages.createMany({ data: threadMessages.map((m) => ({ id: m.messageId })).concat([{ id: responseTs }]) })
        })
    })
}

async function askLlm<TSchema extends z.ZodType>(
    prompt: string,
    schema: TSchema,
    { sessionId = null, cwd = DEFAULT_CWD }: { sessionId: string | null; cwd: string } = { sessionId: null, cwd: DEFAULT_CWD }
): Promise<{ response: z.infer<TSchema>; sessionId: string }> {
    const schemaDescription = JSON.stringify(z.toJSONSchema(schema))
    const promptWithSchema = `${prompt}\n\nRespond with valid JSON that matches this structure:\n${schemaDescription}`
    for await (const message of query({
        prompt: promptWithSchema,
        options: {
            maxTurns: 20,
            cwd,
            resume: sessionId ?? undefined
        }
    })) {
        if (message.type === 'result' && message.subtype === 'success') {
            const result = message.result
            try {
                const parsed = JSON.parse(result)
                const validated = schema.parse(parsed)
                return { response: validated, sessionId: message.session_id }
            } catch (error) {
                throw new Error('Failed to parse or validate result ' + result + ': ' + error)
            }
        } else if (message.type === 'result') {
            let errMsg: string
            if (message.subtype === 'error_max_turns') {
                errMsg = 'Max turns exceeded'
            } else {
                errMsg = 'Unknown error'
            }
            throw new Error(errMsg + ' ' + JSON.stringify(message))
        }
    }
    throw new Error('never')
}

async function maybeParallelize<T>(iter: AsyncIterable<T> | Iterable<T>, fn: (arg: T) => Promise<void>) {
    const promises = []
    for await (const arg of iter) {
        promises.push(fn(arg))
    }
    if (DEBUG) {
        for await (const __ of promises) {
        }
    } else {
        await Promise.all(promises)
    }
}

async function runEvery(intervalMs: number, callback: () => Promise<void>) {
    let lastTime = 0
    while (true) {
        await sleepUntil(lastTime + intervalMs)
        await callback()
        lastTime = new Date().getTime()
    }
}

function assertNotNull<T>(value: T | null | undefined): asserts value is T {
    if (value === null || value === undefined) throw new Error('value should not be null')
}

function sleepUntil(time: number) {
    const now = new Date().getTime()
    const timeToSleep = Math.max(0, time - now)
    return new Promise((resolve) => setTimeout(resolve, timeToSleep))
}

startLoop()
