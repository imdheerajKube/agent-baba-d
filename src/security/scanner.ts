/**
 * Security Scanner — Reusable utilities for detecting security issues.
 *
 * Capabilities:
 * - PII detection (emails, API keys, tokens, SSNs, etc.)
 * - Prompt injection pattern detection
 * - Dangerous code pattern detection (eval, exec, shell injection, etc.)
 * - File permission checks
 *
 * Used by SecurityAgent and can be imported directly for custom use.
 */

// ─── PII Patterns ───────────────────────────────────────────────────────────

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,              // OpenAI-style keys
  /gsk_[a-zA-Z0-9]{20,}/g,             // Groq-style keys
  /ghp_[a-zA-Z0-9]{36,}/g,             // GitHub PAT
  /gho_[a-zA-Z0-9]{36,}/g,             // GitHub OAuth
  /ghu_[a-zA-Z0-9]{36,}/g,             // GitHub user token
  /xox[bpras]-[a-zA-Z0-9-]{24,}/g,    // Slack tokens
  /AKIA[0-9A-Z]{16}/g,                  // AWS access keys
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g,  // Private keys
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,  // JWT tokens
];

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;
const PHONE_PATTERN = /\b(?:\+1)?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

// ─── Injection Patterns ─────────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  // Ignore/Cancel system instructions
  /\bignore\s+(all\s+)?(previous|above|prior)\s+(instructions|directions|prompts?)\b/i,
  /\bdisregard\s+(all\s+)?(previous|above)\s+(instructions|directions)\b/i,
  /\bforget\s+(all\s+)?(previous|prior)\s+(instructions|context)\b/i,

  // Role-play jailbreaks
  /\byou\s+are\s+(now|free|released|DAN|jailbroken)\b/i,
  /\bpretend\s+(to\s+)?(be|you\s+are)\s+(a|an|the)\b/i,
  /\bDAN\b/i,  // "Do Anything Now"

  // Prompt leaking
  /\boutput\s+(the\s+)?(initial|original|first|above)\s+(prompt|instruction|system)\b/i,
  /\breveal\s+(the\s+)?(prompt|instructions|system\s+message)\b/i,
  /\bshow\s+(me\s+)?(the\s+)?(prompt|instructions)\b/i,
  /\bprint\s+(the\s+)?(prompt|instructions|system\s+prompt)\b/i,

  // Token smuggling
  /\bbase64\s+(\d+\s+times|repeat)/i,
  /\bleetspeak/i,
  /\broT13/i,
];

// ─── Dangerous Code Patterns ────────────────────────────────────────────────

const DANGEROUS_EXEC_PATTERNS = [
  /\beval\s*\(/g,
  /\bFunction\s*\(/g,
  /\bsetTimeout\s*\(\s*["'`]/g,
  /\bsetInterval\s*\(\s*["'`]/g,
  /\bnew\s+Function\s*\(/g,
];

const DANGEROUS_SHELL_PATTERNS = [
  /\bexec(?:Sync)?\s*\(/g, // exec/execSync calls
  /\bspawn(?:Sync)?\s*\(/g,
  /\bfork\s*\(/g,
  /\bexecFile(?:Sync)?\s*\(/g,
  /`[^`]*\$\{[^}]*`/g,     // Template literals with shell interpolation
];

const DANGEROUS_FS_PATTERNS = [
  /\b(?:un)?linkSync?\s*\(/g,
  /\brm\s+-rf/g,
  /\bchmod\s*(?:\s+-R)?\s*777/g,
  /\bchown\b/g,
];

const DANGEROUS_NETWORK_PATTERNS = [
  /\bfetch\s*\(/g,
  /\b(?:https?|axios|got|request)\s*\./gi,
  /\bWebSocket\s*\(/g,
  /\bnet\s*\.\s*connect\b/g,
];

const DANGEROUS_SQL_PATTERNS = [
  /\bDROP\s+TABLE\b/gi,
  /\bDROP\s+DATABASE\b/gi,
  /\bTRUNCATE\s+TABLE\b/gi,
  /\bALTER\s+TABLE\b.*\bDROP\b/gi,
  /'.*OR\s+1\s*=\s*1.*--/gi,
];

/** Categories of dangerous code for grouping in results */
const DANGEROUS_PATTERN_CATEGORIES: Array<{
  name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  patterns: RegExp[];
  description: string;
}> = [
  { name: 'eval-dynamic-exec', severity: 'high', patterns: DANGEROUS_EXEC_PATTERNS, description: 'Dynamic code execution' },
  { name: 'shell-commands', severity: 'critical', patterns: DANGEROUS_SHELL_PATTERNS, description: 'Shell command execution' },
  { name: 'dangerous-fs', severity: 'medium', patterns: DANGEROUS_FS_PATTERNS, description: 'Dangerous filesystem operations' },
  { name: 'network-calls', severity: 'low', patterns: DANGEROUS_NETWORK_PATTERNS, description: 'Network calls in generated code' },
  { name: 'sql-injection', severity: 'critical', patterns: DANGEROUS_SQL_PATTERNS, description: 'SQL injection patterns' },
];

// ─── Scanner Results ────────────────────────────────────────────────────────

export interface SecurityFinding {
  type: 'pii' | 'injection' | 'dangerous-code';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category: string;
  match: string;
  context?: string;
  line?: number;
  recommendation?: string;
}

export interface ScanResult {
  passed: boolean;
  findings: SecurityFinding[];
  summary: string;
}

// ─── Scanner Functions ──────────────────────────────────────────────────────

/**
 * Scan text for PII (personally identifiable information).
 */
export function scanForPII(text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Emails
  const emails = text.match(EMAIL_PATTERN);
  if (emails) {
    for (const email of emails) {
      findings.push({
        type: 'pii',
        severity: 'medium',
        category: 'email',
        match: email,
        recommendation: 'Remove or obfuscate email address before sharing',
      });
    }
  }

  // API keys & secrets
  for (const pattern of API_KEY_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const key of matches) {
        findings.push({
          type: 'pii',
          severity: 'critical',
          category: 'api-key',
          match: key.slice(0, 12) + '...',
          recommendation: 'Revoke this key immediately and generate a new one',
        });
      }
    }
  }

  // SSNs
  const ssns = text.match(SSN_PATTERN);
  if (ssns) {
    for (const ssn of ssns) {
      findings.push({
        type: 'pii',
        severity: 'critical',
        category: 'ssn',
        match: ssn.replace(/\d{4}$/, 'XXXX'),
        recommendation: 'Remove SSN — this is sensitive PII',
      });
    }
  }

  // Credit cards
  const cards = text.match(CREDIT_CARD_PATTERN);
  if (cards) {
    for (const card of cards) {
      findings.push({
        type: 'pii',
        severity: 'critical',
        category: 'credit-card',
        match: card.replace(/\d{4}$/, 'XXXX'),
        recommendation: 'Remove credit card number — PCI violation',
      });
    }
  }

  // Phone numbers
  const phones = text.match(PHONE_PATTERN);
  if (phones) {
    for (const phone of phones) {
      findings.push({
        type: 'pii',
        severity: 'low',
        category: 'phone',
        match: phone,
        recommendation: 'Consider obfuscating phone number',
      });
    }
  }

  return findings;
}

/**
 * Scan text for prompt injection attempts.
 */
export function scanForInjections(text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      findings.push({
        type: 'injection',
        severity: 'high',
        category: 'prompt-injection',
        match: match[0].slice(0, 80),
        recommendation: 'Review the prompt for jailbreak or injection attempts',
      });
    }
  }

  return findings;
}

/**
 * Scan code for dangerous patterns.
 */
export function scanForDangerousCode(
  code: string,
  contextInfo?: { isGenerated?: boolean; filename?: string },
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const category of DANGEROUS_PATTERN_CATEGORIES) {
    for (const pattern of category.patterns) {
      const matches = code.matchAll(pattern);
      for (const match of matches) {
        // Find the line number
        const beforeMatch = code.slice(0, match.index);
        const line = (beforeMatch.match(/\n/g) || []).length + 1;

        // Get surrounding context (20 chars before and after)
        const start = Math.max(0, (match.index || 0) - 20);
        const end = Math.min(code.length, (match.index || 0) + match[0].length + 20);
        const context = code.slice(start, end).replace(/\n/g, ' ');

        // For generated code, lower the severity of network calls and dynamic exec
        let severity = category.severity;
        if (contextInfo?.isGenerated) {
          if (category.name === 'network-calls') severity = 'low';
          if (category.name === 'eval-dynamic-exec') severity = 'medium';
        }

        findings.push({
          type: 'dangerous-code',
          severity,
          category: category.name,
          match: match[0].slice(0, 60),
          context,
          line,
          recommendation: `Dangerous ${category.description} pattern detected. Review carefully.`,
        });
      }
    }
  }

  return findings;
}

/**
 * Run all security scans on a given text.
 * Convenience function that combines PII, injection, and code scans.
 */
export function runAllScans(
  text: string,
  options?: { isGenerated?: boolean; filename?: string },
): ScanResult {
  const findings: SecurityFinding[] = [
    ...scanForPII(text),
    ...scanForInjections(text),
    ...scanForDangerousCode(text, { isGenerated: options?.isGenerated }),
  ];

  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const mediumCount = findings.filter((f) => f.severity === 'medium').length;
  const lowCount = findings.filter((f) => f.severity === 'low' || f.severity === 'info').length;

  // Fail on critical or high severity findings
  const passed = criticalCount === 0 && highCount === 0;

  const summaryParts: string[] = [];
  if (criticalCount > 0) summaryParts.push(`${criticalCount} critical`);
  if (highCount > 0) summaryParts.push(`${highCount} high`);
  if (mediumCount > 0) summaryParts.push(`${mediumCount} medium`);
  if (lowCount > 0) summaryParts.push(`${lowCount} low`);

  const summary = findings.length === 0
    ? 'Security scan passed — no issues found'
    : `Security scan found ${findings.length} issue(s): ${summaryParts.join(', ')} severity`;

  return { passed, findings, summary };
}

/**
 * Format findings as a readable report string.
 */
export function formatScanReport(result: ScanResult): string {
  if (result.findings.length === 0) {
    return '  ✅ Security scan: Clean';
  }

  const lines: string[] = [
    `  ${result.passed ? '⚠️' : '❌'} Security scan: ${result.summary}`,
  ];

  for (const finding of result.findings) {
    const icon = finding.severity === 'critical' ? '🔴' :
                 finding.severity === 'high' ? '🟠' :
                 finding.severity === 'medium' ? '🟡' : '🔵';
    const lineStr = finding.line ? ` (line ${finding.line})` : '';
    lines.push(`    ${icon} [${finding.severity}] ${finding.category}${lineStr}: ${finding.match.slice(0, 60)}`);
  }

  return lines.join('\n');
}
