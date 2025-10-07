# Available Coding Agents

## Currently Selected Agent: claude

## Agent Comparison

### Claude (Anthropic)
- **Strengths:** Excellent code quality, strong reasoning, comprehensive documentation
- **Best For:** Complex problem solving, refactoring, architectural decisions
- **Model Options:** Claude-3-sonnet, Claude-3-opus
- **Selection Status:** ✅ SELECTED

### Cursor (Cursor.sh)
- **Strengths:** IDE integration, real-time collaboration, fast iterations
- **Best For:** Interactive development, rapid prototyping, code completion
- **Model Options:** GPT-4, Claude integration
- **Selection Status:** ⭕ Available

### Codex (GitHub Copilot)
- **Strengths:** Code generation, pattern recognition, language versatility
- **Best For:** Boilerplate code, common patterns, multi-language projects
- **Model Options:** Codex, GPT-4 variants
- **Selection Status:** ⭕ Available

### Gemini (Google)
- **Strengths:** Multimodal capabilities, large context windows, research integration
- **Best For:** Data analysis, ML projects, research-oriented tasks
- **Model Options:** Gemini-pro, Gemini-ultra
- **Selection Status:** ⭕ Available

## Agent Selection Guidelines

### Task-Based Recommendations:

**Complex Architecture & Design:**
- Primary: Claude (excellent reasoning)
- Secondary: Gemini (large context)

**Rapid Development & Prototyping:**
- Primary: Cursor (real-time feedback)
- Secondary: Codex (fast generation)

**Data Science & ML:**
- Primary: Gemini (multimodal, research focus)
- Secondary: Claude (analytical depth)

**Legacy Code & Refactoring:**
- Primary: Claude (comprehensive analysis)
- Secondary: Cursor (IDE integration)

## Switching Agents

To change the selected coding agent, run:
```bash
juno-task init --subagent <agent_name>
```

Available agent names: `claude`, `cursor`, `codex`, `gemini`

## Agent Performance Tracking

### claude Performance Metrics:
- **Tasks Completed:** 0
- **Success Rate:** N/A
- **Average Completion Time:** N/A
- **Code Quality Score:** N/A

*Note: Metrics will be updated as tasks are completed*

## Configuration History

| Date | Previous Agent | New Agent | Reason |
|------|---------------|-----------|---------|
| 2025-10-07 | None | claude | Initial project setup |

---
*Last updated: 2025-10-07*
*Current configuration: claude agent selected*