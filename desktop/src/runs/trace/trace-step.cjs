'use strict'

const { z } = require('zod')

const STEP_KINDS = Object.freeze([
  'thinking',
  'message',
  'tool',
  'plan',
  'stderr',
  'raw',
  'lifecycle',
])

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const pathText = z.string().max(4096)
const blobRef = z.strictObject({
  blobId: z.string().regex(ID),
  bytes: z.number().int().nonnegative(),
})

const traceStepDraftSchema = z.strictObject({
  kind: z.enum(STEP_KINDS),
  toolCallId: z.string().regex(ID).optional(),
  title: z.string().max(2000).optional(),
  status: z.string().max(80).optional(),
  command: z.string().optional(),
  input: z.unknown().optional(),
  output: z.string().optional(),
  paths: z.array(pathText).max(256).optional(),
  exitCode: z.number().int().optional(),
  raw: z.unknown().optional(),
  blobs: z.record(z.string().max(80), blobRef).optional(),
})

const traceStepSchema = traceStepDraftSchema.extend({
  seq: z.number().int().positive(),
  at: z.string().min(1).max(80),
})

function parseTraceStepDraft(value) {
  return traceStepDraftSchema.parse(value)
}

function parseTraceStep(value) {
  return traceStepSchema.parse(value)
}

module.exports = {
  STEP_KINDS,
  parseTraceStep,
  parseTraceStepDraft,
  traceStepDraftSchema,
  traceStepSchema,
}
