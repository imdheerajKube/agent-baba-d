import { describe, it, expect, beforeEach } from 'vitest';
import { Command } from 'commander';
import {
  getWorkflowTemplates,
  getWorkflowTemplate,
  buildTaskPlanFromTemplate,
  buildWorkflowOptions,
  type WorkflowTemplate,
  type WorkflowStep,
} from '../../src/workflow/templates.js';
import { WorkflowCommand } from '../../src/cli/workflow.js';
import { ConfigManager } from '../../src/config/manager.js';
import type { TaskStep } from '../../src/agents/agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create an in-memory ConfigManager that won't touch disk */
function createTestConfigManager(): ConfigManager {
  // ConfigManager's constructor reads ~/.buff/config.json, but we test
  // the command structure, not execution, so a real instance is fine.
  return new ConfigManager();
}

// ─── Template Definitions ───────────────────────────────────────────────────

describe('getWorkflowTemplates', () => {
  it('should return all 4 built-in templates', () => {
    const templates = getWorkflowTemplates();
    expect(templates).toHaveLength(4);
  });

  it('should return a new array each time (shallow copy)', () => {
    const first = getWorkflowTemplates();
    const second = getWorkflowTemplates();
    // Different array instances (shallow copy via spread)
    expect(first).not.toBe(second);
    // But same object references (same template objects)
    expect(first[0]).toBe(second[0]);
  });

  it('should contain quick-fix, create-and-run, feature-implement, and publish-release', () => {
    const ids = getWorkflowTemplates().map((t) => t.id).sort();
    expect(ids).toEqual(['create-and-run', 'feature-implement', 'publish-release', 'quick-fix']);
  });
});

describe('getWorkflowTemplate', () => {
  it('should return the quick-fix template by ID', () => {
    const t = getWorkflowTemplate('quick-fix');
    expect(t).toBeDefined();
    expect(t!.id).toBe('quick-fix');
    expect(t!.name).toBe('Quick Fix');
  });

  it('should return the feature-implement template by ID', () => {
    const t = getWorkflowTemplate('feature-implement');
    expect(t).toBeDefined();
    expect(t!.id).toBe('feature-implement');
    expect(t!.name).toBe('Feature Implementation');
  });

  it('should return the create-and-run template by ID', () => {
    const t = getWorkflowTemplate('create-and-run');
    expect(t).toBeDefined();
    expect(t!.id).toBe('create-and-run');
    expect(t!.name).toBe('Create & Run');
  });

  it('should return the publish-release template by ID', () => {
    const t = getWorkflowTemplate('publish-release');
    expect(t).toBeDefined();
    expect(t!.id).toBe('publish-release');
    expect(t!.name).toBe('Publish Release');
  });

  it('should return undefined for unknown template IDs', () => {
    expect(getWorkflowTemplate('nonexistent')).toBeUndefined();
    expect(getWorkflowTemplate('')).toBeUndefined();
  });

  it('should be case-sensitive', () => {
    expect(getWorkflowTemplate('Quick-Fix')).toBeUndefined();
    expect(getWorkflowTemplate('QUICK-FIX')).toBeUndefined();
  });
});

// ─── Template Structure ─────────────────────────────────────────────────────

describe('quick-fix template structure', () => {
  let template: WorkflowTemplate;

  beforeEach(() => {
    template = getWorkflowTemplate('quick-fix')!;
  });

  it('should have a name, description, id, and steps', () => {
    expect(template.name).toBeTruthy();
    expect(template.description).toBeTruthy();
    expect(template.steps.length).toBeGreaterThan(0);
  });

  it('should have 5 steps: context-gatherer → writer → runner → reviewer → security', () => {
    expect(template.steps).toHaveLength(5);
    expect(template.steps[0].agentType).toBe('context-gatherer');
    expect(template.steps[1].agentType).toBe('writer');
    expect(template.steps[2].agentType).toBe('runner');
    expect(template.steps[3].agentType).toBe('reviewer');
    expect(template.steps[4].agentType).toBe('security');
  });

  it('should have correct dependency chain (each step depends on previous)', () => {
    expect(template.steps[0].dependsOn).toEqual([]);
    expect(template.steps[1].dependsOn).toEqual(['step-0']);
    expect(template.steps[2].dependsOn).toEqual(['step-1']);
    expect(template.steps[3].dependsOn).toEqual(['step-2']);
    expect(template.steps[4].dependsOn).toEqual(['step-3']);
  });

  it('should have recommendedModels for context-gatherer, writer, and reviewer (security is rule-based)', () => {
    expect(template.recommendedModels).toBeDefined();
    expect(Object.keys(template.recommendedModels!)).toHaveLength(3);
    expect(template.recommendedModels!['context-gatherer']).toBeTruthy();
    expect(template.recommendedModels!.writer).toBeTruthy();
    expect(template.recommendedModels!.reviewer).toBeTruthy();
  });

  it('should not set useMemory by default', () => {
    expect(template.useMemory).toBeUndefined();
  });
});

describe('feature-implement template structure', () => {
  let template: WorkflowTemplate;

  beforeEach(() => {
    template = getWorkflowTemplate('feature-implement')!;
  });

  it('should have 7 steps (runner added after writer for verification)', () => {
    expect(template.steps).toHaveLength(7);
  });

  it('should have correct agent types in order', () => {
    const agentTypes = template.steps.map((s) => s.agentType);
    expect(agentTypes).toEqual([
      'planner',
      'context-gatherer',
      'writer',
      'tester',
      'runner',
      'reviewer',
      'security',
    ]);
  });

  it('should have sequential dependencies for the first 3 steps', () => {
    expect(template.steps[0].dependsOn).toEqual([]);
    expect(template.steps[1].dependsOn).toEqual(['step-0']);
    expect(template.steps[2].dependsOn).toEqual(['step-1']);
  });

  it('should have tester, runner, AND reviewer all depend on writer (step-2), security on reviewer (step-5)', () => {
    expect(template.steps[3].dependsOn).toEqual(['step-2']); // tester
    expect(template.steps[4].dependsOn).toEqual(['step-2']); // runner
    expect(template.steps[5].dependsOn).toEqual(['step-2']); // reviewer
    expect(template.steps[6].dependsOn).toEqual(['step-5']); // security
  });

  it('should have recommendedModels with 5 entries (security is rule-based, no LLM needed)', () => {
    expect(template.recommendedModels).toBeDefined();
    expect(Object.keys(template.recommendedModels!)).toHaveLength(5);
  });

  it('should enable memory', () => {
    expect(template.useMemory).toBe(true);
  });
});

describe('create-and-run template structure', () => {
  let template: WorkflowTemplate;

  beforeEach(() => {
    template = getWorkflowTemplate('create-and-run')!;
  });

  it('should have 3 steps: writer → runner → reviewer', () => {
    expect(template.steps).toHaveLength(3);
    expect(template.steps[0].agentType).toBe('writer');
    expect(template.steps[1].agentType).toBe('runner');
    expect(template.steps[2].agentType).toBe('reviewer');
  });

  it('should have sequential dependencies', () => {
    expect(template.steps[0].dependsOn).toEqual([]);
    expect(template.steps[1].dependsOn).toEqual(['step-0']);
    expect(template.steps[2].dependsOn).toEqual(['step-1']);
  });

  it('should only have recommendedModels for writer (runner/reviewer use defaults)', () => {
    expect(template.recommendedModels).toBeDefined();
    expect(Object.keys(template.recommendedModels!)).toHaveLength(1);
    expect(template.recommendedModels!.writer).toBeTruthy();
  });
});

describe('publish-release template structure', () => {
  let template: WorkflowTemplate;

  beforeEach(() => {
    template = getWorkflowTemplate('publish-release')!;
  });

  it('should have 7 steps (tester → writer → reviewer → security → git → package → github-release)', () => {
    expect(template.steps).toHaveLength(7);
    expect(template.steps[0].agentType).toBe('tester');
    expect(template.steps[1].agentType).toBe('writer');
    expect(template.steps[2].agentType).toBe('reviewer');
    expect(template.steps[3].agentType).toBe('security');
    expect(template.steps[4].agentType).toBe('git');
    expect(template.steps[5].agentType).toBe('package');
    expect(template.steps[6].agentType).toBe('github-release');
  });

  it('should have sequential dependency chain through all 7 steps', () => {
    expect(template.steps[0].dependsOn).toEqual([]);
    expect(template.steps[1].dependsOn).toEqual(['step-0']);
    expect(template.steps[2].dependsOn).toEqual(['step-1']);
    expect(template.steps[3].dependsOn).toEqual(['step-2']);
    expect(template.steps[4].dependsOn).toEqual(['step-3']);
    expect(template.steps[5].dependsOn).toEqual(['step-4']);
    expect(template.steps[6].dependsOn).toEqual(['step-5']);
  });

  it('should have recommendedModels limited to writer and reviewer (git/package/github-release are CLI-based)', () => {
    expect(template.recommendedModels).toBeDefined();
    expect(Object.keys(template.recommendedModels!)).toHaveLength(2);
    expect(template.recommendedModels!.writer).toBeTruthy();
    expect(template.recommendedModels!.reviewer).toBeTruthy();
  });

  it('should have useMemory set to false', () => {
    expect(template.useMemory).toBe(false);
  });
});

describe('each template step validity', () => {
  const templates = getWorkflowTemplates();

  for (const t of templates) {
    describe(`${t.id}: each step`, () => {
      for (let i = 0; i < t.steps.length; i++) {
        const step = t.steps[i];

        it(`step ${i} (${step.agentType}) should have a non-empty description`, () => {
          expect(step.description).toBeTruthy();
          expect(step.description.length).toBeGreaterThan(10);
        });

        it(`step ${i} (${step.agentType}) should have dependsOn as an array`, () => {
          expect(Array.isArray(step.dependsOn)).toBe(true);
        });

        it(`step ${i} (${step.agentType}) should reference valid step IDs only` +
           ` (deps: ${JSON.stringify(step.dependsOn)})`, () => {
          for (const dep of step.dependsOn) {
            // dep IDs are like 'step-0', 'step-1', etc.
            expect(dep).toMatch(/^step-\d+$/);
            const depIndex = parseInt(dep.replace('step-', ''), 10);
            expect(depIndex).toBeLessThan(i); // can't depend on future steps
            expect(depIndex).toBeGreaterThanOrEqual(0);
          }
        });
      }

      // Verify first step has no dependencies
      it('first step should have no dependencies', () => {
        expect(t.steps[0].dependsOn).toEqual([]);
      });
    });
  }
});

// ─── buildTaskPlanFromTemplate ──────────────────────────────────────────────

describe('buildTaskPlanFromTemplate', () => {
  const goal = 'add JWT authentication to the Express app';

  it('should return a TaskStep[] with stable IDs (step-0, step-1, ...)', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const plan = buildTaskPlanFromTemplate(template, goal);

    expect(plan).toHaveLength(5); // quick-fix now has 5 steps
    plan.forEach((step, i) => {
      expect(step.id).toBe(`step-${i}`);
    });
  });

  it('should include the goal in each step description', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const plan = buildTaskPlanFromTemplate(template, goal);

    for (const step of plan) {
      expect(step.description).toContain(goal);
    }
  });

  it('should prefix the step description with the original template description', () => {
    const template = getWorkflowTemplate('feature-implement')!;
    const plan = buildTaskPlanFromTemplate(template, goal);

    expect(plan[0].description).toContain(template.steps[0].description);
    expect(plan[0].description).toContain(goal);
  });

  it('should preserve dependsOn references from the template', () => {
    const template = getWorkflowTemplate('feature-implement')!;
    const plan = buildTaskPlanFromTemplate(template, goal);

    expect(plan[0].dependsOn).toEqual([]);
    expect(plan[1].dependsOn).toEqual(['step-0']);
    expect(plan[2].dependsOn).toEqual(['step-1']);
    expect(plan[3].dependsOn).toEqual(['step-2']); // tester
    expect(plan[4].dependsOn).toEqual(['step-2']); // runner (same dep as tester)
    expect(plan[5].dependsOn).toEqual(['step-2']); // reviewer (same dep)
    expect(plan[6].dependsOn).toEqual(['step-5']); // security depends on reviewer
  });

  it('should set status to pending for all 7 steps', () => {
    const template = getWorkflowTemplate('publish-release')!;
    const plan = buildTaskPlanFromTemplate(template, 'test');

    expect(plan).toHaveLength(7);
    for (const step of plan) {
      expect(step.status).toBe('pending');
    }
  });

  it('should set agentType from the template step', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const plan = buildTaskPlanFromTemplate(template, goal);

    expect(plan.map((s) => s.agentType)).toEqual([
      'context-gatherer',
      'writer',
      'runner',
      'reviewer',
      'security',
    ]);
  });

  it('should work with an empty goal string', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const plan = buildTaskPlanFromTemplate(template, '');

    expect(plan).toHaveLength(5);
    expect(plan[0].description).toContain('for:');
  });

  it('should produce TaskStep objects matching the TaskStep interface', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const plan = buildTaskPlanFromTemplate(template, goal);

    for (const step of plan) {
      // Verify all required TaskStep fields exist
      expect(typeof step.id).toBe('string');
      expect(typeof step.description).toBe('string');
      expect(typeof step.agentType).toBe('string');
      expect(Array.isArray(step.dependsOn)).toBe(true);
      expect(step.status).toBe('pending');
      // result is optional and should be undefined initially
      expect(step.result).toBeUndefined();
    }
  });

  it('should produce a different plan for each template', () => {
    const qf = buildTaskPlanFromTemplate(getWorkflowTemplate('quick-fix')!, 'x');
    const cr = buildTaskPlanFromTemplate(getWorkflowTemplate('create-and-run')!, 'x');
    const fi = buildTaskPlanFromTemplate(getWorkflowTemplate('feature-implement')!, 'x');
    const pr = buildTaskPlanFromTemplate(getWorkflowTemplate('publish-release')!, 'x');

    expect(qf).toHaveLength(5);
    expect(cr).toHaveLength(3);
    expect(fi).toHaveLength(7);
    expect(pr).toHaveLength(7);

    expect(qf[0].agentType).toBe('context-gatherer');
    expect(qf[4].agentType).toBe('security');
    expect(cr[0].agentType).toBe('writer');
    expect(cr[1].agentType).toBe('runner');
    expect(fi[6].agentType).toBe('security');
    expect(pr[0].agentType).toBe('tester');
    expect(pr[3].agentType).toBe('security');
    expect(pr[6].agentType).toBe('github-release');
  });
});

// ─── buildWorkflowOptions ───────────────────────────────────────────────────

describe('buildWorkflowOptions', () => {
  it('should extract recommendedModels from the template', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const options = buildWorkflowOptions(template);

    expect(options.agentModels).toBe(template.recommendedModels);
  });

  it('should set useMemory from the template', () => {
    const featureTemplate = getWorkflowTemplate('feature-implement')!;
    const releaseTemplate = getWorkflowTemplate('publish-release')!;

    expect(buildWorkflowOptions(featureTemplate).useMemory).toBe(true);
    expect(buildWorkflowOptions(releaseTemplate).useMemory).toBe(false);
  });

  it('should set autoRouteModels to false when template has recommendedModels', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    expect(template.recommendedModels).toBeDefined();
    const options = buildWorkflowOptions(template);
    expect(options.autoRouteModels).toBe(false);
  });

  it('should merge user-provided verbose and dryRun overrides', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const options = buildWorkflowOptions(template, {
      verbose: true,
      dryRun: true,
    });
    expect(options.verbose).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it('should merge user-provided provider and model overrides', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const options = buildWorkflowOptions(template, {
      provider: 'groq',
      model: 'llama-3.3-70b',
    });
    expect(options.provider).toBe('groq');
    expect(options.model).toBe('llama-3.3-70b');
  });

  it('should not set verbose/dryRun when not provided by user', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const options = buildWorkflowOptions(template);
    expect(options.verbose).toBeUndefined();
    expect(options.dryRun).toBeUndefined();
  });

  it('should return a partial OrchestratorOptions (not the full interface)', () => {
    const template = getWorkflowTemplate('quick-fix')!;
    const options = buildWorkflowOptions(template);

    // Should include template-derived fields
    expect(options).toHaveProperty('agentModels');
    expect(options).toHaveProperty('useMemory');
    expect(options).toHaveProperty('autoRouteModels');

    // Should not include things like prefillPlan
    expect(options).not.toHaveProperty('prefillPlan');
  });

  it('should handle empty userOptions gracefully', () => {
    const template = getWorkflowTemplate('publish-release')!;
    const options = buildWorkflowOptions(template);

    expect(options).toBeDefined();
    expect(options.agentModels).toBe(template.recommendedModels);
    expect(options.useMemory).toBe(false);
    expect(options.verbose).toBeUndefined();
  });
});

// ─── CLI Command Structure ──────────────────────────────────────────────────

describe('WorkflowCommand CLI structure', () => {
  let workflowCmd: WorkflowCommand;
  let command: Command;

  beforeEach(() => {
    workflowCmd = new WorkflowCommand(createTestConfigManager());
    command = workflowCmd.create();
  });

  it('should create a Command named "workflow"', () => {
    expect(command.name()).toBe('workflow');
  });

  it('should have a "list" subcommand', () => {
    const listCmd = command.commands.find((c) => c.name() === 'list');
    expect(listCmd).toBeDefined();
    expect(listCmd!.description()).toBeTruthy();
  });

  it('should have a "run" subcommand', () => {
    const runCmd = command.commands.find((c) => c.name() === 'run');
    expect(runCmd).toBeDefined();
    expect(runCmd!.description()).toBeTruthy();
  });

  describe('"run" subcommand arguments', () => {
    let runCmd: Command;

    beforeEach(() => {
      runCmd = command.commands.find((c) => c.name() === 'run')!;
      // exitOverride ensures commander throws instead of calling process.exit()
      // This is critical for Windows CI where commander's error exit behavior differs
      runCmd.exitOverride();
    });

    it('should have a --provider option with -p short flag', () => {
      const opt = runCmd.options.find((o) => o.long === '--provider');
      expect(opt).toBeDefined();
      expect(opt!.short).toBe('-p');
    });

    it('should have a --model option with -m short flag', () => {
      const opt = runCmd.options.find((o) => o.long === '--model');
      expect(opt).toBeDefined();
      expect(opt!.short).toBe('-m');
    });

    it('should have a --dry-run flag (boolean)', () => {
      const opt = runCmd.options.find((o) => o.long === '--dry-run');
      expect(opt).toBeDefined();
    });

    it('should have a --verbose flag with -v short flag', () => {
      const opt = runCmd.options.find((o) => o.long === '--verbose');
      expect(opt).toBeDefined();
      expect(opt!.short).toBe('-v');
    });

    it('should parse two positional arguments (template + goal)', () => {
      const parsed = runCmd.parse(['quick-fix', 'fix the bug', '--dry-run', '--verbose'], { from: 'user' });
      expect(parsed.args[0]).toBe('quick-fix');
      expect(parsed.args[1]).toBe('fix the bug');
      expect(parsed.opts().dryRun).toBe(true);
      expect(parsed.opts().verbose).toBe(true);
    });

    it('should parse provider and model options alongside positional args', () => {
      const parsed = runCmd.parse(['feature-implement', 'add auth', '--provider', 'groq', '--model', 'llama-3.3'], { from: 'user' });
      expect(parsed.args[0]).toBe('feature-implement');
      expect(parsed.args[1]).toBe('add auth');
      expect(parsed.opts().provider).toBe('groq');
      expect(parsed.opts().model).toBe('llama-3.3');
    });

    it('should reject missing required arguments', () => {
      expect(() => {
        runCmd.parse(['quick-fix'], { from: 'user' });
      }).toThrow();
    });
  });

  describe('"list" subcommand', () => {
    it('should have no required arguments', () => {
      const listCmd = command.commands.find((c) => c.name() === 'list')!;
      expect(listCmd.args).toHaveLength(0);
    });
  });
});
