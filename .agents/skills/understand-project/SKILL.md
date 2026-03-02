---
name: understand-project
description: Understand current project and create/update specs under @.juno_task/specs/* , it allows you understand dependencies. and prepare for implementation. Use when user explicitly ask you, or when asking for understand the project, first see how it works and then do [main task] with respect to [constraints]
argument-hint: "[Main Task] [Constraints] [Ultimate Goal]"
enable-shell-directives: true
---

## Main Task

!`jq -r '.mainTask' ./.juno_task/config.json`

$1

### Task 1

Ultrathink !
First task is to study @.juno_task/plan.md (it may be incorrect) and is to use up to 500 subagents to study existing project
and study what is needed to achieve the main task.
From that create/update a @.juno_task/plan.md which is a bullet point list sorted in priority of the items which have yet to be implemeneted. Think extra hard.
Study @.juno_task/plan.md to determine starting point for research and keep it up to date with items considered complete/incomplete using subagents.

### Task 2

Second Task is to understand the task, create a spec for process to follow, plan to execute, scripts to create, virtual enviroment that we need, things that we need to be aware of, how to test the scripts and follow progress.
Think hard and plan/create spec for every step of this task
and for each part create a seperate .md file under @.juno_task/specs/\*

## ULTIMATE Goal

We want to achieve the main Task with respect to the Constraints section
Consider missing steps and plan. If the step is missing then author the specification at @.juno_task/specs/FILENAME.md (do NOT assume that it does not exist, search before creating). The naming of the module should be GenZ named and not conflict with another module name. If you create a new step then document the plan to implement in @.juno_task/plan.md

### @.juno_task/specs/ file format.

- github flavored markdown
- GenZ module names and without conflict to another module name.
- Start with Priority in Codebase, Example: P0-core-module.md
- the goal is when we run `ls` command in the specs folder we could understand what are the cornerstone of the project with one glance.

### Constraints

$1

---

$ARGUMENTS
