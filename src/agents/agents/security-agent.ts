/**
 * SecurityAgent — Detects security issues in agent prompts and generated code.
 *
 * Capabilities:
 * - Scan LLM prompts for injection/jailbreak attempts before sending
 * - Scan generated code changes for PII, dangerous patterns, vulnerabilities
 * - Validate file paths for directory traversal attempts
 * - Integrated with the orchestrator pipeline to block unsafe content
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-security", "description": "Scan code for security issues", "agentType": "security", "dependsOn": ["step-write"] }
 * ```
 */

import { homedir } from 'node:os';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';
import {
  runAllScans,
  scanForInjections,
  formatScanReport,
  type SecurityFinding,
  type ScanResult,
} from '../../security/scanner.js';

/** Default scan severity threshold: block on critical or high findings */
const DEFAULT_SEVERITY_THRESHOLD: SecurityFinding['severity'][] = ['critical', 'high'];

/** Paths that should never be modified (system files) */
const PROTECTED_PATHS = [
  // Linux/Unix
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/ssh/',
  // Windows
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'C:\\Windows\\System32\\config\\',
  'C:\\Windows\\System32\\drivers\\etc\\',
  'C:\\Program Files\\',
  // Cross-platform
  '~/.ssh/',
  '~/.aws/',
  '~/.config/gcloud/',
  '~/.npmrc',
];

/**
 * SecurityAgent — Scans prompts and generated content for security issues.
 */
export class SecurityAgent extends Agent {
  readonly name = 'Security';
  readonly description = 'Scans for PII, prompt injection, and dangerous code patterns';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      const taskDesc = context.taskPlan.find(
        (s) => s.agentType === 'security' && s.status === 'running',
      )?.description || context.goal;

      const allFindings: SecurityFinding[] = [];
      const details: string[] = [];

      // Parse which scans to run from the task description
      const scanTypes = this.parseScanTypes(taskDesc);

      // ── 1. Scan all fileChanges for PII and dangerous code ────────────
      if (scanTypes.code) {
        for (const change of context.fileChanges) {
          const content = change.newContent || change.originalContent;
          if (!content) continue;

          const result = runAllScans(content, {
            isGenerated: change.status === 'created' || change.status === 'modified',
            filename: change.path,
          });

          allFindings.push(...result.findings);

          if (result.findings.length > 0) {
            details.push(`File: ${change.path}`);
            details.push(formatScanReport(result));
          }
        }
      }

      // ── 2. Scan artifacts for injected secrets ───────────────────────
      if (scanTypes.secrets) {
        for (const artifact of context.artifacts) {
          const piiResult = runAllScans(artifact.content, { isGenerated: true });
          const piiFindings = piiResult.findings.filter((f) => f.type === 'pii');
          allFindings.push(...piiFindings);

          if (piiFindings.length > 0) {
            details.push(`Artifact: ${artifact.path}`);
            details.push(formatScanReport({ passed: false, findings: piiFindings, summary: piiResult.summary }));
          }
        }
      }

      // ── 3. Scan file paths for directory traversal ────────────────────
      if (scanTypes.paths) {
        for (const change of context.fileChanges) {
          const pathIssue = this.checkPathSafety(change.path);
          if (pathIssue) {
            allFindings.push(pathIssue);
            details.push(`  🔴 [critical] Path traversal: ${change.path}`);
          }
        }
      }

      // ── 4. Scan the goal/prompt for injection attempts ────────────────
      if (scanTypes.prompt) {
        const injectionFindings = scanForInjections(context.goal);
        allFindings.push(...injectionFindings);

        if (injectionFindings.length > 0) {
          details.push('Prompt injection detected in user goal:');
          details.push(formatScanReport({ passed: false, findings: injectionFindings, summary: 'Injection detected' }));
        }
      }

      // ── Assess results ───────────────────────────────────────────────
      const blockedSeverities = DEFAULT_SEVERITY_THRESHOLD;
      const blockedFindings = allFindings.filter(
        (f) => blockedSeverities.includes(f.severity),
      );

      const result: ScanResult = {
        passed: blockedFindings.length === 0,
        findings: allFindings,
        summary: allFindings.length === 0
          ? 'Security scan passed — no issues found'
          : `Security scan found ${allFindings.length} issue(s) (${blockedFindings.length} blocking)`,
      };

      // Log results for visibility
      if (details.length > 0) {
        logger.info(details.join('\n'));
      }
      if (blockedFindings.length > 0) {
        logger.warn(`Security: ${blockedFindings.length} blocking issue(s) found`);
      }

      // Store scan results in context metadata for downstream agents
      context.metadata['securityScanResult'] = result;

      return {
        success: result.passed,
        summary: result.summary,
        details: details.length > 0 ? details.join('\n') : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'Security scan failed', error: msg };
    }
  }

  /**
   * Parse which scan types to run based on the task description.
   */
  private parseScanTypes(description: string): {
    code: boolean;
    secrets: boolean;
    paths: boolean;
    prompt: boolean;
  } {
    const lower = description.toLowerCase();

    // Check if the description mentions specific scan types
    const hasCode = lower.includes('code') || lower.includes('dangerous') || lower.includes('vulnerability');
    const hasSecrets = lower.includes('secret') || lower.includes('pii') || lower.includes('credential');
    const hasPaths = lower.includes('path') || lower.includes('traversal');
    const hasPrompt = lower.includes('injection') || lower.includes('prompt');

    // If no specific scan type is mentioned, run all scans (default)
    if (!hasCode && !hasSecrets && !hasPaths && !hasPrompt) {
      return { code: true, secrets: true, paths: true, prompt: true };
    }

    // Otherwise, only run the requested scans
    return {
      code: hasCode,
      secrets: hasSecrets,
      paths: hasPaths,
      prompt: hasPrompt,
    };
  }

  /**
   * Check if a file path is safe (no directory traversal, no protected paths).
   */
  private checkPathSafety(filePath: string): SecurityFinding | null {
    // Check for path traversal
    if (filePath.includes('..')) {
      return {
        type: 'dangerous-code',
        severity: 'critical',
        category: 'path-traversal',
        match: filePath,
        recommendation: 'Prevent directory traversal — use path.resolve() with safe base',
      };
    }

    // Check for absolute paths to protected locations
    const homeDir = homedir();
    const normalized = filePath.replace(/^~/, homeDir);
    for (const protectedPath of PROTECTED_PATHS) {
      const expandedProtected = protectedPath.replace(/^~/, homeDir);
      if (normalized.startsWith(expandedProtected)) {
        return {
          type: 'dangerous-code',
          severity: 'critical',
          category: 'protected-path',
          match: filePath,
          recommendation: `Do not modify protected system files: ${protectedPath}`,
        };
      }
    }

    return null;
  }
}
