// Model-facing timed `ask_user_question`, copied field-by-field from the shipped
// timed tool (dsh-tool-ask-user/lib/index.js registerTimedAskUser) so the model
// sees exactly the same contract as DSH's own timed mode.
//
// Why a copy: the shipped tool row lives inside an agent preset, which a profile
// patch cannot reach and which an already-mounted agent never rebuilds (see
// AGENTS.md §3.2). This plugin registers this definition into each agent's own
// tools layer, where scoped tools shadow the inherited preset row.
//
// Only node: builtins may be imported here (no node_modules in this package).

/** The tool name this definition shadows. */
export const TIMED_TOOL_NAME = 'ask_user_question'

/** Pending-result notice, copied from the shipped tool. */
const PENDING_NOTICE = 'No answer batch arrived before the timeout. This is pending, not a skipped answer. Continue useful independent work. The user can still answer; their reply will be a user message identified as answer_to_pending_question with this callId and the original questions. Do not treat this as permission.'

/** Model-facing description, copied from the shipped timed tool. */
const TIMED_DESCRIPTION = 'Ask brief, direct, self-contained questions about missing information, preferences, or decisions. Use user-facing terms; assume no knowledge of background work or internal names. Use distinct stable question IDs. An answer item with empty selected and no custom means the user skipped that question: continue without it, do not ask it again, and do not treat the skip as permission. A pending result instead means no answer batch arrived before the timeout and the user can still answer.'

/**
 * Validate the `timeout` argument exactly like the shipped tool.
 * @param {unknown} timeout - model-supplied wait in seconds, or -1.
 * @returns {number} the accepted timeout.
 * @throws {Error} when the value is not -1 and not a positive integer in range.
 */
export function validateTimeout(timeout) {
  if (timeout !== -1 && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483)) {
    throw new Error('timeout must be -1 or a positive integer up to 2147483 seconds')
  }
  return timeout
}

/**
 * Normalize model-supplied questions into the service vocabulary.
 * Mirrors the shipped `questionRequest`: only the documented fields survive.
 * @param {unknown} questions - model-supplied question list.
 * @returns {Array<Record<string, unknown>>} service-shaped questions.
 * @throws {Error} when the list is malformed.
 */
export function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('invalid arguments: questions must be a non-empty array')
  }
  const ids = new Set()
  return questions.map((question) => {
    if (question === null || typeof question !== 'object' || Array.isArray(question)) {
      throw new Error('invalid arguments: each question must be an object')
    }
    if (typeof question.id !== 'string' || question.id.length === 0) {
      throw new Error('invalid arguments: each question needs a string id')
    }
    if (typeof question.question !== 'string' || question.question.length === 0) {
      throw new Error('invalid arguments: each question needs a string question')
    }
    if (ids.has(question.id)) throw new Error(`question id ${JSON.stringify(question.id)} must be unique within this call`)
    ids.add(question.id)
    const normalized = { id: question.id, question: question.question }
    if (question.header !== undefined) {
      if (typeof question.header !== 'string') throw new Error('invalid arguments: header must be a string')
      normalized.header = question.header
    }
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) throw new Error('invalid arguments: options must be an array')
      normalized.options = question.options.map((option) => {
        if (option === null || typeof option !== 'object' || Array.isArray(option)) {
          throw new Error('invalid arguments: each option must be an object')
        }
        if (typeof option.label !== 'string' || option.label.length === 0) {
          throw new Error('invalid arguments: each option needs a string label')
        }
        const copy = { label: option.label }
        if (option.description !== undefined) {
          if (typeof option.description !== 'string') throw new Error('invalid arguments: option description must be a string')
          copy.description = option.description
        }
        return copy
      })
    }
    if (question.multi_select !== undefined) {
      if (typeof question.multi_select !== 'boolean') throw new Error('invalid arguments: multi_select must be a boolean')
      normalized.multiSelect = question.multi_select
    }
    return normalized
  })
}

/**
 * Copy service answers into the model-facing result (shipped `answerResult`).
 * @param {{ answers: Array<{ id: string, selected: string[], custom?: string }> }} result - service answer.
 * @returns {{ answers: Array<{ id: string, selected: string[], custom?: string }> }} detached result.
 */
export function answerResult(result) {
  return {
    answers: result.answers.map((answer) => ({
      id: answer.id,
      selected: [...answer.selected],
      ...answer.custom !== undefined ? { custom: answer.custom } : {}
    }))
  }
}

/** Model-facing parameter schema, the JSON-Schema projection of the shipped timed tool. */
function parametersSchema(defaultTimeout) {
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask the user.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: {
              type: 'string',
              description: 'Stable id for this question; echoed in the answer.'
            },
            question: {
              type: 'string',
              description: 'The specific question to ask the user.'
            },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".'
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: {
                    type: 'string',
                    description: 'Short user-facing option label.'
                  },
                  description: {
                    type: 'string',
                    description: 'One sentence explaining the tradeoff or impact.'
                  }
                },
                required: ['label']
              }
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.'
            }
          },
          required: ['id', 'question']
        }
      },
      timeout: {
        type: 'integer',
        description: `Wait seconds for the entire batch (default ${String(defaultTimeout)}); omit unless the user specifies a duration. Use -1 only when an answer is required before proceeding.`
      }
    },
    required: ['questions']
  }
}

/** Model-facing output schema, the JSON-Schema projection of the shipped timed tool. */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        pending: {
          type: 'boolean',
          enum: [true],
          description: 'True when the foreground wait expired before the user submitted an answer batch. The questions remain answerable; this is not a skipped answer.'
        },
        callId: {
          type: 'string',
          description: 'Tool call whose unanswered questions remain pending.'
        },
        message: {
          type: 'string',
          description: 'How to continue while the questions stay answerable.'
        }
      },
      required: ['pending', 'callId', 'message']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        answers: {
          type: 'array',
          description: 'Submitted answer batch with one item per question. A skipped question has empty selected and no custom; unlike pending, the user has completed the batch.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                description: 'Stable question id echoed from the request.'
              },
              selected: {
                type: 'array',
                items: { type: 'string' },
                description: 'Selected option labels. Empty with no custom means the user explicitly skipped this question.'
              },
              custom: {
                type: 'string',
                description: 'Optional free-form answer; omitted for a skipped question.'
              }
            },
            required: ['id', 'selected']
          }
        }
      },
      required: ['answers']
    }
  ]
}

/**
 * Build the shadowed timed `ask_user_question` tool definition.
 *
 * Execution semantics (AGENTS.md §3.3):
 * - `timeout >= 1`: `ctx.userQuestions.askTimed(...)` — the desktop popup races
 *   the DSH UI, and the Client card is removed through its `attachWait` claim.
 * - `timeout === -1`: the shipped blocking path `ask({ wait: { callId } })`, with
 *   no popup (a request without `wait.timed` has no claim stream to end the card).
 *
 * @param {{ ctx: any, timeout?: number, log?: (line: string) => void }} options - owner context, default wait, diagnostics.
 * @returns {Record<string, any>} a tools-registry definition.
 */
export function createTimedAskUserTool({ ctx, timeout = 120, log = () => {} }) {
  const defaultTimeout = validateTimeout(timeout)
  return {
    name: TIMED_TOOL_NAME,
    description: TIMED_DESCRIPTION,
    parameters: parametersSchema(defaultTimeout),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    async execute(args, exec) {
      const timeoutSeconds = validateTimeout(args?.timeout ?? defaultTimeout)
      // One-line diagnostic: the resolved wait is the only way to tell a caller's
      // misplaced `timeout` (e.g. nested inside a question) from a plugin bug.
      log(`ask_user_question execute: callId=${String(exec?.callId)} timeoutArg=${JSON.stringify(args?.timeout ?? null)} resolvedTimeout=${String(timeoutSeconds)}`)
      const questions = normalizeQuestions(args?.questions)
      if (timeoutSeconds === -1) {
        // Blocking request: the DSH Client card must stay the only answerer.
        const blocking = await ctx.userQuestions.ask({
          questions,
          ...exec.agent !== undefined ? { agent: exec.agent } : {},
          signal: exec.signal,
          wait: { callId: exec.callId }
        })
        return answerResult(blocking)
      }
      if (exec.agent === undefined) throw new Error('timed questions require a live agent')
      const result = await ctx.userQuestions.askTimed({
        questions,
        agent: exec.agent,
        signal: exec.signal
      }, exec.callId, timeoutSeconds * 1000)
      if ('pending' in result) return { ...result, message: PENDING_NOTICE }
      return answerResult(result)
    }
  }
}
