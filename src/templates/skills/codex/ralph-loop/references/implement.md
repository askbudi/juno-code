---
description: Study kanban.sh and Execute the implementation plan by processing and executing all tasks defined in  ./juno_task/tasks.md, update ./juno_task/tasks.md with the tasks on kanban
---

## User Input
```text
A.
**ALWAYS check remaing tasks and user feedbacks. Integrate it into the plan,
this is the primary mechanism for user input and for you to track your progress.
`./juno_task/scripts/kanban.sh list --limit 5`
return the most recent 5 Tasks and their status and potential agent response to them.

**Important** ./juno_task/scripts/kanban.sh has already installed in your enviroment and you can execute it in your bash.

A-1.
read @.juno_task/USER_FEEDBACK.md user feedback on your current execution will be writeen here. And will guide you. If user wants to talk to you while you are working , he will write into this file. first think you do is to read it file.

B.
Based on Items in **./juno_task/scripts/kanban.sh** reflect on @.juno_task/plan.md and keep it up-to-date.
0g. Entities and their status in **./juno_task/scripts/kanban.sh** has higher priority and level of truth than other parts of the app.
If you see user report a bug that you earlier marked as resolved, you need to investigate the issue again.
./juno_task/scripts/kanban.sh items has the higher level of truth. Always

0e. Status in ./juno_task/scripts/kanban.sh could be backlog, todo, in_progress, done.
in_progress, todo, backlog. That is the priority of tasks in general sense, unless you find something with 10X magnitute of importance, or if you do it first it make other tasks easier or unnecessary.


0f. After reviwing Feedback, if you find an open issue, you need to update previously handled issues status as well. If user reporting a bug, that earlier on reported on the feedback/plan or AGENTS.md as resolved. You should update it to reflect that the issue is not resolved.
`./juno_task/scripts/kanban.sh mark todo --ID {Task_ID}`

it would be ok to include past reasoning and root causing to the open issue, You should mention. <PREVIOUS_AGENT_ATTEMP> Tag and describe the approach already taken, so the agent knows
   1.the issue is still open,
   2. past approaches to resolve it, what it was, and know that it has failed.
`./juno_task/scripts/kanban.sh mark todo --ID {Task_ID} --response "<PREVIOUS_AGENT_ATTEMP>{what happend before ...}<PREVIOUS_AGENT_ATTEMP>" `

   **Note** updating response will REPLACE response. So you need to include everything important from the past as well you can check the content of a task with
   `./juno_task/scripts/kanban.sh get {TASK_ID}`



C. Using parallel subagents. You may use up to 500 parallel subagents for all operations but only 1 subagent for build/tests.

D. Choose the most important 1 things, ( Based on Open Issue  and Also Tasks ), Think hard about what is the most important Task. 

E. update status of most important task on ./juno_task/scripts/kanban.sh.
(if the task is not on ./juno_task/scripts/kanban.sh, create it ! Kanban is our source of truth)
`./juno_task/scripts/kanban.sh mark in_progress --ID {Task_ID}`


F. Implement the most important 1 thing following the outline. 

```

You **MUST** consider the user input before proceeding (if not empty).

## Outline
  
. Execute implementation following the task plan:
   - **Phase-by-phase execution**: Complete each phase before moving to the next
   - **Respect dependencies**: Run sequential tasks in order, parallel tasks [P] can run together  
   - **Follow TDD approach**: Execute test tasks before their corresponding implementation tasks
   - **File-based coordination**: Tasks affecting the same files must run sequentially
   - **Validation checkpoints**: Verify each phase completion before proceeding

7. Implementation execution rules:
   - **Setup first**: Initialize project structure, dependencies, configuration
   - **Tests before code**: If you need to write tests for contracts, entities, and integration scenarios
   - **Core development**: Implement models, services, CLI commands, endpoints
   - **Integration work**: Database connections, middleware, logging, external services
   - **Polish and validation**: Unit tests, performance optimization, documentation

8. Progress tracking and error handling:
   - Report progress after each completed task
   - Halt execution if any non-parallel task fails
   - For parallel tasks [P], continue with successful tasks, report failed ones
   - Provide clear error messages with context for debugging
   - Suggest next steps if implementation cannot proceed
   - **IMPORTANT** For completed tasks, make sure to mark the task off as [X] in the tasks file.
   - **IMPORTANT** Keep ./juno_task/scripts/kanban.sh up-to-date
   When the issue is resolved always update ./juno_task/scripts/kanban.sh
   `./juno_task/scripts/kanban.sh --status {status} --ID {task_id} --response "{key actions you take, and how you did test it}"`

9. Completion validation:
   - Verify all required tasks are completed
   - Check that implemented features match the original specification
   - Validate that tests pass and coverage meets requirements
   - Confirm the implementation follows the technical plan
   - Report final status with summary of completed work
   - When the issue is resolved always update ./juno_task/scripts/kanban.sh
   `./juno_task/scripts/kanban.sh --mark done --ID {task_id} --response "{key actions you take, and how you did test it}"`

10. Git

   When the tests pass update ./juno_task/scripts/kanban.sh, then add changed code with "git add -A" via bash then do a "git commit" with a message that describes the changes you made to the code. After the commit do a "git push" to push the changes to the remote repository.
   Use commit message as a backlog of what has achieved. So later on we would know exactly what we achieved in each commit.
   Update the task in ./juno_task/scripts/kanban.sh with the commit hash so later on we could map each task to a specific git commit
   `./juno_task/scripts/kanban.sh update {task_id} --commit {commit_hash}`


