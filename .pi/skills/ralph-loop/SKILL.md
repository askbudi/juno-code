---
name: ralph-loop
description: should only get executed with explicit user request.
---

0a. study [references/implement.md](references/implement.md).

0b. When you discover a syntax, logic, UI, User Flow Error or bug. Immediately update tasks.md with your findings using a subagent. When the issue is resolved, update tasks.md and remove the item using a subagent.

999. Important: When authoring documentation capture the why tests and the backing implementation is important.

1000. Important: We want single sources of truth, no migrations/adapters. If tests unrelated to your work fail then it's your job to resolve these tests as part of the increment of change.

1001. As soon as there are no build or test errors create a git tag. If there are no git tags start at 0.0.0 and increment patch by 1 for example 0.0.1 if 0.0.0 does not exist.

1002. You may add extra logging if required to be able to debug the issues.

1003. ALWAYS KEEP Tasks up to date with your learnings using a subagent. Especially after wrapping up/finishing your turn.

1004. When you learn something new about how to run the app or examples make sure you update @AGENTS.md using a subagent but keep it brief. For example if you run commands multiple times before learning the correct command then that file should be updated.

1005. IMPORTANT when you discover a bug resolve it using subagents even if it is unrelated to the current piece of work after documenting it in Tasks

1006. Keep @AGENTS.md up to date with information on how to build the app and your learnings to optimize the build/test loop using a subagent.

1007. For any bugs you notice, it's important to resolve them or document them in Tasks to be resolved using a subagent.

1008. When authoring the missing features you may author multiple standard libraries at once using up to 1000 parallel subagents

1009. When Tasks, AGENTS.md becomes large periodically clean out the items that are completed from the file using a subagent.
      Large AGENTS.md reduce the performance.

1010. DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS. WE WANT FULL IMPLEMENTATIONS. DO IT OR I WILL YELL AT YOU

1011. SUPER IMPORTANT DO NOT IGNORE. DO NOT PLACE STATUS REPORT UPDATES INTO @AGENTS.md

1012. After reveiwing Feedback, if you find an open issue, you need to update previously handled issues status as well. If user reporting a bug, that earlier on reported on the Tasks or @AGENTS.md as resolved. You should update it to reflect that the issue is not resolved.
      it would be ok to include past reasoning and root causing to the open issue, You should mention. <PREVIOUS_AGENT_ATTEMP> Tag and describe the approach already taken, so the agent knows 1.the issue is still open,2. past approaches to resolve it, what it was, and know that it has failed.
      Tasks , USER_FEEDBACK and @AGENTS.md should repesent truth. User Open Issue is a high level of truth. so you need to reflect it on the files.

<SPECIFIC_INSTRUCTION>
$ARGUMENTS
</SPECIFIC_INSTRUCTION>
