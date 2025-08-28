import { query } from '@anthropic-ai/claude-code'
import { PrismaClient } from '@prisma/client'
import _ from 'lodash'
import { z } from 'zod'

const prisma = new PrismaClient()

const LAST_IGNORED_MESSAGE = process.env.LAST_IGNORED_MESSAGE as string | undefined
if(LAST_IGNORED_MESSAGE && typeof LAST_IGNORED_MESSAGE !== 'string') throw new Error('LAST_IGNORED_MESSAGE must be a string')

const DEFAULT_CWD = process.env.DEFAULT_CWD as string
if (typeof DEFAULT_CWD !== 'string') throw new Error('DEFAULT_CWD must be a string')

const SELF_DM_CHANNEL = process.env.SELF_DM_CHANNEL as string
if (typeof SELF_DM_CHANNEL !== 'string') throw new Error('SELF_DM_CHANNEL must be a string')

const DEBUG = process.env.DEBUG === 'true'

async function startLoop() {
    await runEvery(1000 * 60 * 2, async () => {
        let { response: allMessages } = await askLlm(
            `Are there any new slack messages in DM ${SELF_DM_CHANNEL} ${LAST_IGNORED_MESSAGE ? 'after ' + LAST_IGNORED_MESSAGE : ''}. Show me the lastest 10 messages in that DM`,
            z.array(z.object({ threadId: z.string().describe('thread id (or message id if it is the root of a thread)'), messageId: z.string() }))
        )

        const found = await prisma.seenSlackMessages.findMany({ where: { id: { in: allMessages.map(m => m.messageId) } } });
        const alreadySeenIds = new Set(found.map(f => f.id))
        allMessages = allMessages.filter(m => !alreadySeenIds.has(m.messageId))

        await maybeParallelize(_.entries(_.groupBy(allMessages, (m) => m.threadId)), async ([threadId, threadMessages]) => {
            const existingSession = await prisma.task.findUnique({ where: { threadId } })

            let branchName = existingSession?.branchName
            if (!existingSession) {
                let { response } = await askLlm(
                    `generate a branch name from the input prompt(s) (which you can pull via slack) ${JSON.stringify(threadMessages.map((x) => x.messageId))}`,
                    z.object({ branchName: z.string() })
                )
                branchName = response.branchName
                await askLlm(`create a git worktree at ~/dev/worktrees/${branchName} and create a branch ${branchName} on that worktree`, z.void())
            }
            assertNotNull(branchName)

            const {
                response: { responseTs },
                sessionId
            } = await askLlm(`Read these slack messages ${JSON.stringify(threadMessages.map((x) => x.messageId))}, and send a response to ${threadId} using slack mcp in channel ${SELF_DM_CHANNEL}. If the user asked you to take any actions, you must perform those actions before replying.`, z.object({ responseTs: z.string() }), {
                sessionId: existingSession?.sessionId ?? null,
                cwd: process.env.HOME + `/dev/worktrees/${branchName}`
            })
            const {
                response: { status }
            } = await askLlm(`How would you describe the status of this task?`, z.object({ status: z.enum(['awaiting user', 'done', 'cancelled']) }), {
                sessionId,
                cwd: process.env.HOME + `/dev/worktrees/${branchName}`
            })

            if (!existingSession) {
                await prisma.task.create({ data: { threadId, sessionId, branchName, status } })
            }
            for (const threadMsg of threadMessages) {
                await prisma.seenSlackMessages.upsert({ where: { id: threadMsg.messageId }, create: { id: threadMsg.messageId }, update: { id: threadMsg.messageId } })
            }
            await prisma.seenSlackMessages.upsert({ where: { id: responseTs }, create: { id: responseTs }, update: { id: responseTs } })
        })
    })
}

async function askLlm<TSchema extends z.ZodType>(
    prompt: string,
    schema: TSchema,
    { sessionId = null, cwd = DEFAULT_CWD }: { sessionId: string | null; cwd: string } = { sessionId: null, cwd: DEFAULT_CWD }
): Promise<{ response: z.infer<TSchema>; sessionId: string }> {
    const isVoid = schema instanceof z.ZodVoid
    const isString = schema instanceof z.ZodString

    let promptToUse: string
    if (isVoid) {
        promptToUse = prompt
    } else if (isString) {
        promptToUse = `${prompt}\n\nRespond with only the requested string value, no JSON formatting.`
    } else {
        const schemaDescription = JSON.stringify(z.toJSONSchema(schema))
        promptToUse = `${prompt}\n\nRespond *only* with valid JSON that matches this structure:\n${schemaDescription}`
    }

    console.info('spawning claude in:', cwd)
    console.info('claude prompt:', promptToUse)
    for await (const message of query({
        prompt: promptToUse,
        options: {
            maxTurns: 500,
            cwd,
            resume: sessionId ?? undefined,
            permissionMode: 'bypassPermissions'
        }
    })) {
        if (message.type === 'result' && message.subtype === 'success') {
            let result = message.result

            if (isVoid) {
                return { response: undefined as z.infer<TSchema>, sessionId: message.session_id }
            } else if (isString) {
                return { response: result as z.infer<TSchema>, sessionId: message.session_id }
            } else {
                result = result.replace('```json', '').replace('```', '')
                try {
                    const parsed = findAndParseJson(result)
                    const validated = schema.parse(parsed)
                    console.log('validated response', validated)
                    return { response: validated, sessionId: message.session_id }
                } catch (error) {
                    throw new Error('Failed to parse or validate result ' + result + ': ' + error)
                }
            }
        } else if (message.type === 'result') {
            throw new Error('LLM failed to generate response ' + JSON.stringify(message))
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

function findMatchingBrackets(text: string): { startIdx: number; endIdx: number }[] {
    const results: { startIdx: number; endIdx: number }[] = []
    const stack: { char: string; index: number }[] = []
    const openBrackets = ['{', '[']
    const closeBrackets = ['}', ']']
    const matchingPairs: Record<string, string> = { '{': '}', '[': ']' }

    for (let i = 0; i < text.length; i++) {
        const char = text[i]

        if (openBrackets.includes(char)) {
            stack.push({ char, index: i })
        } else if (closeBrackets.includes(char)) {
            // Find the matching opening bracket in the stack
            for (let j = stack.length - 1; j >= 0; j--) {
                if (matchingPairs[stack[j].char] === char) {
                    // Found matching pair
                    const opening = stack[j]
                    results.push({ startIdx: opening.index, endIdx: i })
                    stack.splice(j, 1) // Remove the matched opening bracket
                    break
                }
            }
        }
    }

    return results
}

function findAndParseJson(text: string) {
    const bracketPairs = findMatchingBrackets(text)
    for (const { startIdx, endIdx } of _.sortBy(bracketPairs, (p) => p.startIdx - p.endIdx)) {
        try {
            const json = JSON.parse(text.slice(startIdx, endIdx + 1))
            return json
        } catch (error) {}
    }
    throw new Error('No JSON found in text')
}

startLoop()
    .then(() => console.log('done'))
    .catch((e) => console.error(e))
