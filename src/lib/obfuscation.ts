import type { ObfuscationMethod, ObfuscationRule } from '@/types'

export interface ObfuscationMethodDefinition {
  id: ObfuscationMethod
  label: string
  description: string
  category: 'string' | 'number' | 'date'
}

export const OBFUSCATION_METHODS: ObfuscationMethodDefinition[] = [
  // String methods
  {
    id: 'redact',
    label: 'Redact',
    description: 'Replace with [REDACTED]',
    category: 'string',
  },
  {
    id: 'mask',
    label: 'Mask',
    description: 'Show partial value (J***n D*e)',
    category: 'string',
  },
  {
    id: 'hash',
    label: 'Hash (SHA-256)',
    description: 'One-way hash with secret',
    category: 'string',
  },
  {
    id: 'faker',
    label: 'Faker',
    description: 'Replace with fake data',
    category: 'string',
  },
  // Number methods
  {
    id: 'scramble',
    label: 'Scramble',
    description: 'Shuffle digits',
    category: 'number',
  },
  {
    id: 'last4',
    label: 'Last 4',
    description: 'Show only last 4 digits',
    category: 'number',
  },
  {
    id: 'zero',
    label: 'Zero Out',
    description: 'Replace with zeros',
    category: 'number',
  },
  // Date methods
  {
    id: 'year_only',
    label: 'Year Only',
    description: 'Keep only the year',
    category: 'date',
  },
  {
    id: 'jitter',
    label: 'Jitter',
    description: 'Add random +/- days',
    category: 'date',
  },
]

async function hashWithSecret(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(value + secret)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function maskString(value: string): string {
  if (value.length <= 2) return '*'.repeat(value.length)
  const first = value[0]
  const last = value[value.length - 1]
  return first + '*'.repeat(Math.min(value.length - 2, 5)) + last
}

function scrambleDigits(value: string): string {
  const digits = value.replace(/\D/g, '').split('')
  for (let i = digits.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[digits[i], digits[j]] = [digits[j], digits[i]]
  }
  return digits.join('')
}

function last4Digits(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length <= 4) return digits
  return '*'.repeat(digits.length - 4) + digits.slice(-4)
}

function yearOnly(value: string): string {
  // Handle both string dates and numeric timestamps (from DuckDB)
  let date: Date
  const numValue = Number(value)
  if (!isNaN(numValue) && String(numValue) === value) {
    // It's a numeric timestamp
    date = new Date(numValue)
  } else {
    // It's a string date
    date = new Date(value)
  }
  if (isNaN(date.getTime())) return value
  return `${date.getFullYear()}-01-01`
}

function jitterDate(value: string, days: number = 30): string {
  const date = new Date(value)
  if (isNaN(date.getTime())) return value
  const jitter = Math.floor(Math.random() * (days * 2 + 1)) - days
  date.setDate(date.getDate() + jitter)
  return date.toISOString().split('T')[0]
}

// Simple faker data
const FAKE_NAMES = [
  'John Smith', 'Jane Doe', 'Bob Johnson', 'Alice Williams',
  'Charlie Brown', 'Diana Prince', 'Edward Norton', 'Fiona Green',
]
const FAKE_EMAILS = [
  'user1@example.com', 'user2@example.com', 'contact@example.com',
  'info@example.com', 'hello@example.com', 'test@example.com',
]

function fakerValue(value: string): string {
  // Simple heuristic based on content
  if (value.includes('@')) {
    return FAKE_EMAILS[Math.floor(Math.random() * FAKE_EMAILS.length)]
  }
  if (/^[\d-]+$/.test(value)) {
    return Math.random().toString().slice(2, 12)
  }
  return FAKE_NAMES[Math.floor(Math.random() * FAKE_NAMES.length)]
}

export async function obfuscateValue(
  value: unknown,
  method: ObfuscationMethod,
  secret: string
): Promise<string> {
  if (value === null || value === undefined) return ''

  const strValue = String(value)

  switch (method) {
    case 'redact':
      return '[REDACTED]'

    case 'mask':
      return maskString(strValue)

    case 'hash': {
      const hash = await hashWithSecret(strValue, secret)
      return hash.substring(0, 16) // Return first 16 chars of hash
    }

    case 'faker':
      return fakerValue(strValue)

    case 'scramble':
      return scrambleDigits(strValue)

    case 'last4':
      return last4Digits(strValue)

    case 'zero':
      return strValue.replace(/\d/g, '0')

    case 'year_only':
      return yearOnly(strValue)

    case 'jitter':
      return jitterDate(strValue)

    default:
      return strValue
  }
}

export async function applyObfuscationRules(
  data: Record<string, unknown>[],
  rules: ObfuscationRule[],
  secret: string,
  keyMap?: Map<string, string>
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = []

  for (const row of data) {
    const newRow: Record<string, unknown> = { ...row }

    for (const rule of rules) {
      const originalValue = row[rule.column]
      if (originalValue === null || originalValue === undefined) continue

      const strValue = String(originalValue)

      // Check keyMap for existing mapping
      if (keyMap?.has(strValue)) {
        newRow[rule.column] = keyMap.get(strValue)
        continue
      }

      const obfuscated = await obfuscateValue(originalValue, rule.method, secret)
      newRow[rule.column] = obfuscated

      // Add to keyMap if provided
      if (keyMap && rule.method === 'hash') {
        keyMap.set(strValue, obfuscated)
      }
    }

    result.push(newRow)
  }

  return result
}
