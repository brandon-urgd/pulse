// Unit tests for AcceptConfidentiality and CreateSelfSession — PreGenerate removal
// Validates: Requirements 7.1, 7.2
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const acceptConfidentialitySource = readFileSync(
  resolve(import.meta.dirname, '../../lambdas/urgd-pulse-acceptConfidentiality/index.mjs'),
  'utf-8'
)

const createSelfSessionSource = readFileSync(
  resolve(import.meta.dirname, '../../lambdas/urgd-pulse-createSelfSession/index.mjs'),
  'utf-8'
)

describe('PreGenerate removal — AcceptConfidentiality Lambda (R7.1)', () => {
  it('does not import LambdaClient', () => {
    // LambdaClient was used solely for PreGenerate invocation
    expect(acceptConfidentialitySource).not.toContain('LambdaClient')
  })

  it('does not import InvokeCommand', () => {
    expect(acceptConfidentialitySource).not.toContain('InvokeCommand')
  })

  it('does not reference PRE_GENERATE_FUNCTION_ARN', () => {
    expect(acceptConfidentialitySource).not.toContain('PRE_GENERATE_FUNCTION_ARN')
  })

  it('does not contain any Lambda invocation pattern', () => {
    expect(acceptConfidentialitySource).not.toContain('InvocationType')
    expect(acceptConfidentialitySource).not.toMatch(/lambda\s*\.\s*send/)
    expect(acceptConfidentialitySource).not.toMatch(/lambdaClient\s*\.\s*send/)
  })
})

describe('PreGenerate removal — CreateSelfSession Lambda (R7.2)', () => {
  it('does not import LambdaClient', () => {
    expect(createSelfSessionSource).not.toContain('LambdaClient')
  })

  it('does not import InvokeCommand', () => {
    expect(createSelfSessionSource).not.toContain('InvokeCommand')
  })

  it('does not reference PRE_GENERATE_FUNCTION_ARN', () => {
    expect(createSelfSessionSource).not.toContain('PRE_GENERATE_FUNCTION_ARN')
  })

  it('does not contain any Lambda invocation pattern', () => {
    expect(createSelfSessionSource).not.toContain('InvocationType')
  })
})

describe('Neither Lambda references PreGenerate (R7.1, R7.2)', () => {
  it('neither source file mentions preGenerate or PreGenerate', () => {
    // Case-insensitive check for any pregenerate reference
    expect(acceptConfidentialitySource.toLowerCase()).not.toContain('pregenerate')
    expect(createSelfSessionSource.toLowerCase()).not.toContain('pregenerate')
  })
})
