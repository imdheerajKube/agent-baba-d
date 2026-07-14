# Agent-Baba-D: Multi-Agent Orchestrator — Project Scope Document

> **Vision:** Transform agent-baba-d from a single-agent chatbot into an autonomous multi-agent coding system that plans, writes, debugs, tests, compiles, and publishes projects — all running locally with your own API keys and models.

---

## 📊 Current State vs. Target

| Capability | Current (v1.4.1) | Target (v3.0) |
|---|---|---|
| Architecture | Single-agent | Multi-agent orchestration |
| Agent roles | None (direct LLM call) | Planner, Gatherer, Writer, Reviewer, Tester, Publisher |
| Memory | JSON response cache | Vector store + trajectory learning |
| Parallel execution | No | Yes (independent tasks run concurrently) |
| Code execution | No | Sandboxed test runner |
| Git integration | No | Branch, commit, PR generation |
| Publishing | No | npm publish + GitHub releases |
| Self-learning | No | Trajectory scoring + pattern extraction |
| Model routing | Manual per-command | Automatic (small models for simple tasks) |

---

## 🧱 Phase 1: Agent Orchestration Layer — "The Brain"

**Goal:** Build the core orchestration infrastructure: agent interface, shared context bus, orchestrator, and 4 foundational agents.

### Deliverables

| Module | File | Purpose |
|---|---|---|
| **Agent Interface** | `src/agents/agent.ts` | Abstract `Agent` class + `AgentResult`, `TaskStep`, `Artifact` types |
| **Context Vault** | `src/agents/context-vault.ts` | In-memory shared context bus for inter-agent communication |
| **Orchestrator** | `src/agents/orchestrator.ts` | Decomposes goals, schedules agents, synthesizes results |
| **PlannerAgent** | `src/agents/agents/planner.ts` | Analyzes goal, produces ordered task plan |
| **ContextGathererAgent** | `src/agents/agents/context-gatherer.ts` | Scans codebase, finds relevant files |
| **WriterAgent** | `src/agents/agents/writer.ts` | Implements code changes from plan |
| **ReviewerAgent** | `src/agents/agents/reviewer.ts` | Validates code for bugs, style, correctness |
| **Execute CLI** | `src/cli/execute.ts` | `agent-baba-d execute "goal"` command |

### Architecture

```
User: agent-baba-d execute "add JWT auth to Express app"
                              │
                              ▼
                        Orchestrator
                     (decomposes goal)
                   ┌────────┴────────┐
                   │                 │
            PlannerAgent      ContextVault
          (task plan →           (shared
            ordered steps)      context bus)
                   │                 │
                   ▼                 │
            ContextGatherer ◄────────┤
          (relevant files)           │
                   │                 │
                   ▼                 │
             WriterAgent ◄───────────┤
          (implements edits)         │
                   │                 │
                   ▼                 │
            ReviewerAgent ◄──────────┤
          (validates output)         │
                   │                 │
                   ▼                 │
         Result synthesized ─────────┘
                   │
                   ▼
          User sees: summary + diffs
```

### Data Flow

1. **User inputs goal** → Orchestrator stores in ContextVault
2. **PlannerAgent** reads goal, produces `TaskStep[]` with dependencies
3. **ContextGathererAgent** reads goal + plan, finds relevant files, stores artifacts
4. **WriterAgent** reads plan + artifacts, implements changes, stores file diffs
5. **ReviewerAgent** reads changes, validates, stores feedback
6. **Orchestrator** synthesizes all results into final output for user

### Key Design Decisions

- **No external dependencies** — pure Node.js + existing packages
- **Each agent gets its own `callLLM` function** — orchestrator controls provider/model per agent
- **ContextVault is in-memory only** — persistence comes in Phase 2
- **Sequential execution in Phase 1** — parallelism comes in Phase 3

---

## 🧠 Phase 2: Persistent Agent Memory

**Goal:** Add cross-session memory so agents learn from past tasks and retrieve relevant context.

### Deliverables

| Module | Purpose |
|---|---|
| `src/memory/vector-store.ts` | JSON-based vector store with cosine similarity search |
| `src/memory/embedder.ts` | Embedding generation via any configured LLM |
| `src/memory/trajectory-store.ts` | Stores successful agent trajectories as few-shot examples |
| ContextVault integration | Agents query memory before planning |

### Memory Types

- **Episodic:** "When I tried to add auth, I modified these 3 files"
- **Procedural:** "For TypeScript API projects: routes → controllers → services"
- **Semantic:** "The project uses Express with MongoDB"

### Storage

```json
{
  "id": "traj_001",
  "goal": "add JWT authentication",
  "projectFingerprint": "express-typescript-mongoose",
  "taskPlan": [...],
  "artifacts": [...],
  "fileChanges": [...],
  "score": 0.95,
  "timestamp": 1712345678
}
```

Retrieval: when a new goal arrives, find top-3 similar past trajectories by cosine similarity of embeddings → inject as few-shot examples into agent prompts.

---

## ⚡ Phase 3: Advanced Agent Systems

**Goal:** Expand agent capabilities with parallel execution, sandboxed testing, and git integration.

### New Agents

| Agent | Role | Parallelizable? |
|---|---|---|
| **TesterAgent** | Runs tests in isolated sandbox, reports pass/fail | ✅ With Reviewer |
| **DebuggerAgent** | Iteratively fixes test failures | ❌ After Tester |
| **GitAgent** | Creates branch, commits, generates PR description | ❌ After all changes |
| **SandboxExecutor** | Runs shell commands in temp directory | ✅ Standalone |

### Parallel Execution Engine

- **Dependency graph resolution** — tasks with no interdependencies run concurrently
- **Merge strategy** — concurrent file changes merged with conflict detection
- **Orchestrator spawns sub-agents** via Promise.all for parallel tasks

### Sandbox Architecture

```
WriterAgent → outputs file changes
       │
       ▼
SandboxExecutor (creates /tmp/buff-sandbox-xxx)
       │
       ├── writes changed files
       ├── npm install
       ├── npm test
       └── reports result
       │
       ▼
DebuggerAgent (iterates if tests fail)
```

---

## 🚀 Phase 4: Self-Learning & Optimization

**Goal:** Make the system smarter over time by scoring outcomes, extracting patterns, and routing tasks intelligently.

### Components

| Module | Purpose |
|---|---|
| `src/learning/scorer.ts` | Scores trajectory outcomes (tests passed? user accepted?) |
| `src/learning/pattern-extractor.ts` | LLM extracts reusable "recipes" from top trajectories |
| `src/learning/model-router.ts` | Recommends best model for each task type |

### Adaptive Model Routing

| Task Type | Recommended Model |
|---|---|
| Code formatting, linting | Local (Ollama, small model) |
| Simple edits, refactors | Groq / NIM (fast API models) |
| Architecture planning | Gemini / OpenRouter (large context models) |
| Security audit, complex review | OpenRouter (GPT-4, Claude) |
| Test generation | Any capable model |

### Scoring Heuristics

- Tests pass → +0.3
- User accepts without changes → +0.4
- Fewer agent iterations → +0.2
- No reviewer issues found → +0.1

---

## 📦 Phase 5: Plugin Ecosystem & Publishing Pipeline

**Goal:** Enable third-party agents, custom workflows, and end-to-end project publishing.

### Publishing Pipeline

```
User: "publish this package"
         │
         ▼
  TesterAgent (npm test)
         │
         ▼
  PackageAgent (bump version, npm build)
         │
         ▼
  GitHubReleaseAgent (create tag + release)
         │
         ▼
  PublishAgent (npm publish)
         │
         ▼
  ChangelogAgent (generate changelog)
```

### Plugin System Extensions

| Feature | Description |
|---|---|
| `~/.buff/agents/` auto-discovery | Scan directory for `.js` agent files |
| Agent plugins | Third-party agents that register with orchestrator |
| Workflow YAML | User-defined pipelines: `buff workflow run my-pipeline.yml` |
| Tool plugins | MCP-like tool registration (filesystem, shell, git, etc.) |

### Workflow Template Example

```yaml
# quick-fix.yml
name: Quick Fix
agents:
  - context-gatherer
  - writer
  - reviewer
options:
  parallel: [context-gatherer]
  model:
    planner: gemini-2.0-flash-exp
    writer: groq/llama-3.3-70b
    reviewer: local/llama2
```

---

## 📐 Architecture Diagram (Full Vision)

```
┌─────────────────────────────────────────────────────────┐
│                      User CLI                            │
│  agent-baba-d chat | edit | plan | execute | publish     │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                   Orchestrator                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Goal        │  │ Task         │  │ Result         │  │
│  │ Decomposer  │──│ Scheduler    │──│ Synthesizer    │  │
│  └─────────────┘  └──────┬───────┘  └────────────────┘  │
│                          │                                │
└──────────────────────────┼────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
┌─────────────────────┐ ┌─────┐ ┌──────────┐
│   Agent Pool         │ │Memory│ │  Plugin  │
│ ┌─────────────────┐ │ │Store │ │ Registry │
│ │ PlannerAgent     │ │ │      │ │          │
│ │ ContextGatherer  │ │ │Traj. │ │ Auto-    │
│ │ WriterAgent      │ │ │Store │ │ discovery│
│ │ ReviewerAgent    │ │ │      │ │          │
│ │ TesterAgent      │ │ │Vector│ │ Workflow │
│ │ DebuggerAgent    │ │ │Store │ │ YAML     │
│ │ GitAgent         │ │ │      │ │          │
│ │ PackageAgent     │ │ │      │ │          │
│ └─────────────────┘ │ └──────┘ └──────────┘
└─────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
┌──────────────────┐ ┌──────────┐ ┌──────────┐
│  Inference Layer  │ │Sandbox   │ │ Git/CLI  │
│  (5 providers)    │ │Executor  │ │ Tools    │
└──────────────────┘ └──────────┘ └──────────┘
```

---

## 🎯 Success Criteria

| Phase | Criteria |
|---|---|
| **Phase 1** | `agent-baba-d execute "goal"` runs a multi-agent pipeline end-to-end |
| **Phase 2** | Second run of similar goal retrieves past trajectory and improves quality |
| **Phase 3** | Agents run in parallel; tests execute in sandbox; git commits created |
| **Phase 4** | System automatically routes models; quality improves over time |
| **Phase 5** | Third-party agents load from `~/.buff/agents/`; `publish` npm + GitHub |

---

## 🔒 Design Principles

1. **Zero server dependency** — everything works with BYO API keys and local models
2. **No new npm dependencies** — use Node.js built-ins + existing packages
3. **Backward compatibility** — existing `chat`, `edit`, `plan`, `models` commands continue working
4. **Progressive enhancement** — each phase builds on the previous, all optional
5. **Observability** — verbose/debug mode shows exactly what each agent does

---

## 📋 File Map (Post-Phase 1)

```
src/
├── index.ts                    # Entry point + exports
├── agents/
│   ├── agent.ts                # Abstract Agent + types
│   ├── orchestrator.ts         # Orchestrator
│   ├── context-vault.ts        # Shared context bus
│   └── agents/
│       ├── planner.ts          # PlannerAgent
│       ├── context-gatherer.ts # ContextGathererAgent
│       ├── writer.ts           # WriterAgent
│       └── reviewer.ts         # ReviewerAgent
├── cli/
│   ├── router.ts               # Command registration
│   ├── commands.ts             # BaseCommand
│   ├── chat.ts                 # Chat command
│   ├── edit.ts                 # Edit command
│   ├── plan.ts                 # Plan command
│   ├── models.ts               # Models command
│   ├── config.ts               # Config command
│   ├── cache.ts                # Cache command
│   └── execute.ts              # Execute command (NEW)
├── config/
│   ├── types.ts                # TypeScript types
│   └── manager.ts              # Config management
├── inference/
│   ├── interface.ts            # InferenceProvider
│   ├── factory.ts              # Provider factory
│   ├── sse.ts                  # SSE streaming
│   ├── nim-adapter.ts
│   ├── gemini-adapter.ts
│   ├── openrouter-adapter.ts
│   ├── groq-adapter.ts
│   └── local-adapter.ts
├── context/
│   ├── parser.ts               # Context parsing
│   └── cache.ts                # Response cache
├── plugins/
│   └── registry.ts             # Plugin registry
└── utils/
    ├── logger.ts               # Logging
    └── env.ts                  # Environment
```
