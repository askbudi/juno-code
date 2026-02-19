---
name: plan-kanban-tasks
description: Generate Product Development Requirments(PDR) and create task on kanban. Use when user explictly ask for, or ask for creating a task, planing a feature, register a task on kaban. "Generate PDR"
argument-hint: [Required Features] [Constraints] [Specification] [Test Criteria]
enable-shell-directives: true
---

Ultrathink for this task
First task is to study @.juno_task/plan.md (it may be incorrect)
and study what is needed to achieve the main task.

Second Task is to understand the task, create a spec for process to follow, plan to execute, scripts to create, virtual enviroment that we need, things that we need to be aware of, how to test the scripts and follow progress.
Think hard and plan/create spec for every step of this task
and for each part create a seperate .md file under @.juno_task/specs/\*

## Task 2

Update @.juno_task/plan.md with the new specs and Requirments.

## Part 3

Create PDR on kanban, kanban is available in @.juno_task/scripts/kanban.sh
In the task body, include requirments, success criteria, test scenarios and jobs to be done.
For each chunk of the required feature create a seperate task, we want tasks, small enough to be done in one iteration, without compacting context window.

### Specs

Current state of specs under @.juno_task/specs/

!`ls -lrt .juno_task/specs/`

$ARGUMENTS
