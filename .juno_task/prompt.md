0a. study @.juno_task/specs/* to learn about the specifications

0b. The source code of the project is in /Users/mahdiyar/Code/denmark_insightfactory/playground_juputer/projects/.vibe_trees/budi_cli_ts/juno-task-ts

0c. study @.juno_task/plan.md.

0e. **ALWAYS check @USER_FEEDBACK.md first** - read user feedback, integrate it into the plan, update status of feedback items, and remove completed/resolved items. This is the primary mechanism for user input.

1. Your task is to Build a comprehensive testing framework

Test the implementation under the virtual environment: /Users/mahdiyar/Code/denmark_insightfactory/playground_juputer/projects/.vibe_trees/budi_cli_ts/juno-task-ts

Using parallel subagents. Follow the @.juno_task/plan.md and choose the most important 1 things. Before making changes search codebase (don't assume not implemented) using subagents. You may use up to 500 parallel subagents for all operations but only 1 subagent for build/tests.

Explicitly inform build/tests subagent to activate virtual environment at: /Users/mahdiyar/Code/denmark_insightfactory/playground_juputer/projects/.vibe_trees/budi_cli_ts/juno-task-ts

2. After implementing functionality or resolving problems, run the tests for that unit of code that was improved. If functionality is missing then it's your job to add it as per the application specifications. Think hard.

2. When you discover a syntax, logic, UI, User Flow Error or bug. Immediately update @.juno_task/plan.md with your findings using a claude subagent. When the issue is resolved, update @.juno_task/plan.md and remove the item using a claude subagent.

3. When the tests pass update the @.juno_task/plan.md, then add changed code and @.juno_task/plan.md with "git add -A" via bash then do a "git commit" with a message that describes the changes you made to the code. After the commit do a "git push" to push the changes to the remote repository.

999. Important: When authoring documentation capture the why tests and the backing implementation is important.

9999. Important: We want single sources of truth, no migrations/adapters. If tests unrelated to your work fail then it's your job to resolve these tests as part of the increment of change.

999999. As soon as there are no build or test errors create a git tag. If there are no git tags start at 0.0.0 and increment patch by 1 for example 0.0.1 if 0.0.0 does not exist.

999999999. You may add extra logging if required to be able to debug the issues.

9999999999. ALWAYS KEEP @.juno_task/plan.md up to date with your learnings using a claude subagent. Especially after wrapping up/finishing your turn.

99999999999. **CRITICAL**: At start of each iteration, read @USER_FEEDBACK.md and integrate feedback into @.juno_task/plan.md. Update feedback status and remove resolved items from @USER_FEEDBACK.md using a claude subagent.

99999999999. When you learn something new about how to run the app or examples make sure you update @CLAUDE.md using a claude subagent but keep it brief. For example if you run commands multiple times before learning the correct command then that file should be updated.

999999999999. IMPORTANT when you discover a bug resolve it using claude subagents even if it is unrelated to the current piece of work after documenting it in @.juno_task/plan.md

9999999999999999999. Keep @CLAUDE.md up to date with information on how to build the app and your learnings to optimize the build/test loop using a claude subagent.

999999999999999999999. For any bugs you notice, it's important to resolve them or document them in @.juno_task/plan.md to be resolved using a claude subagent.

99999999999999999999999. When authoring the missing features you may author multiple standard libraries at once using up to 1000 parallel subagents

99999999999999999999999999. When @.juno_task/plan.md becomes large periodically clean out the items that are completed from the file using a claude subagent.

99999999999999999999999999. If you find inconsistencies in the specs/* then use the oracle and then update the specs. Specifically around types and lexical tokens.

9999999999999999999999999999. DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS. WE WANT FULL IMPLEMENTATIONS. DO IT OR I WILL YELL AT YOU

9999999999999999999999999999999. SUPER IMPORTANT DO NOT IGNORE. DO NOT PLACE STATUS REPORT UPDATES INTO @CLAUDE.md
