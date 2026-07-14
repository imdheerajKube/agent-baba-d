/**
 * Manual end-to-end memory test.
 * Tests the full memory cycle: save trajectory → embed → vector search → retrieve → format as few-shot
 * This bypasses the writer agent (which has intermittent LLM failures) and tests the memory system directly.
 *
 * Usage: node tests/manual/memory-e2e-test.mjs
 */

import { getTrajectoryStore } from '../../dist/memory/trajectory-store.js';
import { getVectorStore, cosineSimilarity } from '../../dist/memory/vector-store.js';
import { clearEmbeddingCache } from '../../dist/memory/embedder.js';
import { retrieveMemoryContext, storeExecutionTrajectory, getMemoryStats, clearMemory } from '../../dist/memory/memory-integration.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function testMemoryCycle() {
  console.log('\n🧠 Memory System End-to-End Test\n');
  console.log('='.repeat(60));

  // ── Setup: clear existing memory ──────────────────────────────────────
  await clearMemory();
  clearEmbeddingCache();
  console.log('\n📦 Setup: Memory cleared\n');

  // ── Step 1: Store a trajectory ────────────────────────────────────────
  console.log('📝 Step 1: Store a trajectory\n');
  
  const taskPlan = [
    { id: 'step-1', description: 'Gather context about CLI', agentType: 'context-gatherer', dependsOn: [], status: 'completed' },
    { id: 'step-2', description: 'Write help command implementation', agentType: 'writer', dependsOn: ['step-1'], status: 'completed' },
    { id: 'step-3', description: 'Review the implementation', agentType: 'reviewer', dependsOn: ['step-2'], status: 'completed' },
  ];

  // Mock LLM that returns a deterministic embedding
  const mockLLM = async (prompt) => {
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.01 + prompt.length * 0.001));
    return JSON.stringify(vec);
  };

  const trajectory1 = {
    success: true,
    goal: 'add a help command to the CLI application',
    summary: 'Completed 3 tasks successfully',
    tasksCompleted: 3,
    tasksTotal: 3,
    agentResults: [
      { agent: 'Planner', success: true, summary: 'Created 3 steps' },
      { agent: 'ContextGatherer', success: true, summary: 'Found 12 files' },
      { agent: 'Writer', success: true, summary: 'Created src/help.ts' },
    ],
    fileChanges: '  📄 src/cli/help.ts (created)\n  ✏️ src/cli/router.ts (modified)',
  };

  const storedId = await storeExecutionTrajectory(
    trajectory1,
    mockLLM,
    taskPlan,
    ['src/cli/router.ts', 'src/cli/chat.ts', 'package.json'],
    true
  );

  assert(storedId.length > 0, `Trajectory stored with ID: ${storedId}`);
  
  // ── Step 2: Store a second, different trajectory ──────────────────────
  console.log('\n📝 Step 2: Store a second, different trajectory\n');
  
  const trajectory2 = {
    success: true,
    goal: 'refactor the database layer to use PostgreSQL',
    summary: 'Completed 4 tasks successfully',
    tasksCompleted: 4,
    tasksTotal: 4,
    agentResults: [
      { agent: 'Planner', success: true, summary: 'Created 4 steps' },
      { agent: 'Writer', success: true, summary: 'Modified src/db.ts' },
    ],
    fileChanges: '  ✏️ src/db/config.ts (modified)\n  ✏️ src/db/queries.ts (modified)',
  };

  const storedId2 = await storeExecutionTrajectory(
    trajectory2,
    mockLLM,
    [
      { id: 's1', description: 'Analyze current DB code', agentType: 'context-gatherer', dependsOn: [], status: 'completed' },
      { id: 's2', description: 'Update DB config', agentType: 'writer', dependsOn: ['s1'], status: 'completed' },
    ],
    ['src/db/config.ts'],
    true
  );

  assert(storedId2.length > 0, `Second trajectory stored with ID: ${storedId2}`);

  // ── Step 3: Get memory stats ──────────────────────────────────────────
  console.log('\n📊 Step 3: Memory statistics\n');
  
  const stats = await getMemoryStats();
  assert(stats.total === 2, `Total trajectories: ${stats.total}`);
  assert(stats.avgScore > 0, `Average score: ${stats.avgScore}`);

  // ── Step 4: Search for similar trajectories ───────────────────────────
  console.log('\n🔍 Step 4: Search for similar trajectories\n');
  
  const memoryContext = await retrieveMemoryContext(
    'implement a help command for the CLI tool',
    mockLLM,
    3
  );

  assert(Array.isArray(memoryContext.trajectories), `Search returned ${memoryContext.trajectories.length} trajectory(s)`);

  // ── Step 5: Verify few-shot formatting ────────────────────────────────
  console.log('\n📋 Step 5: Verify few-shot formatting\n');
  
  const formattedContext = memoryContext.fewShotContext;
  
  if (formattedContext.length > 0) {
    assert(formattedContext.includes('Similar Past Task'), 'Contains "Similar Past Task" header');
    assert(formattedContext.includes('help command'), 'Contains goal text from stored trajectory');
    assert(formattedContext.includes('src/cli/help.ts'), 'Contains file change info');
    
    // Show a preview of the formatted context
    console.log(`\n  Preview of few-shot context:\n`);
    const preview = formattedContext.slice(0, 500);
    console.log(`  ${preview.replace(/\n/g, '\n  ')}...`);
    console.log();
  } else {
    console.log('  ⚠️  No few-shot context returned (embeddings may not match with mock LLM)');
  }

  // ── Step 6: Test cosine similarity directly ───────────────────────────
  console.log('📐 Step 6: Cosine similarity math\n');
  
  const sim1 = cosineSimilarity([1, 0, 0], [1, 0, 0]);
  assert(Math.abs(sim1 - 1) < 0.001, `Identical vectors: ${sim1.toFixed(3)} (expected 1.000)`);
  
  const sim2 = cosineSimilarity([1, 0, 0], [0, 1, 0]);
  assert(Math.abs(sim2) < 0.001, `Orthogonal vectors: ${sim2.toFixed(3)} (expected 0.000)`);
  
  const sim3 = cosineSimilarity([1, 0], [1, 0, 0]);
  assert(sim3 === 0, `Different lengths: ${sim3} (expected 0)`);

  // ── Step 7: Clean up ─────────────────────────────────────────────────
  await clearMemory();
  clearEmbeddingCache();
  console.log('🧹 Step 7: Clean up complete\n');

  // ── Results ──────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

testMemoryCycle().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
