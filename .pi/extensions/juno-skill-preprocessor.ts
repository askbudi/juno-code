/**
 * Juno Skill Preprocessor — Pi Extension
 *
 * Adds variable substitution ($1, $2, $ARGUMENTS, $@, ${@:N}, ${@:N:L})
 * and shell directive execution (!`command`) to Pi skill invocations.
 *
 * This extension intercepts /skill: commands via the "input" event,
 * BEFORE Pi's internal _expandSkillCommand() runs. It reads the skill
 * file, processes variables and shell directives, wraps the result in
 * <skill> tags, and returns the fully expanded text.
 *
 * Shell directives only execute when the skill's frontmatter contains:
 *   enable-shell-directives: true
 *
 * Variable substitution always runs when arguments are provided.
 *
 * Shipped via juno-code's SkillInstaller to .pi/extensions/.
 */
import type { ExtensionAPI, InputEvent } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

const SHELL_DIRECTIVE_REGEX = /!`([^`]+)`/g;
const DEFAULT_SHELL_TIMEOUT = 5000;

/** Directories to search for skill files, relative to project root. */
const SKILL_DIRS = [".pi/skills", ".claude/skills"];

/**
 * Find a skill's SKILL.md file by name, searching known skill directories.
 * Checks both {dir}/{name}/SKILL.md and {dir}/{name}.md patterns.
 */
function findSkillFile(skillName: string, cwd: string): string | null {
	for (const dir of SKILL_DIRS) {
		const candidates = [join(cwd, dir, skillName, "SKILL.md"), join(cwd, dir, `${skillName}.md`)];
		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * Parse YAML-like frontmatter from a skill file.
 * Returns frontmatter key-value pairs and the body text after the frontmatter block.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string | boolean>; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const yaml = match[1];
	const body = match[2] ?? '';
	const frontmatter: Record<string, string | boolean> = {};

	for (const rawLine of yaml!.split("\n")) {
		const colonIndex = rawLine.indexOf(":");
		if (colonIndex === -1) continue;
		const key = rawLine.slice(0, colonIndex).trim();
		const value = rawLine.slice(colonIndex + 1).trim();
		if (value === "true") {
			frontmatter[key] = true;
		} else if (value === "false") {
			frontmatter[key] = false;
		} else {
			frontmatter[key] = value;
		}
	}

	return { frontmatter, body };
}

/**
 * Parse command arguments respecting single and double quotes.
 * Handles escape characters with backslash.
 *
 * Examples:
 *   'hello world'      → ["hello", "world"]
 *   '"hello world"'    → ["hello world"]
 *   "'hello' \"world\"" → ["hello", "world"]
 */
function parseCommandArgs(input: string): string[] {
	if (!input.trim()) return [];

	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escape = false;

	for (const char of input) {
		if (escape) {
			current += char;
			escape = false;
			continue;
		}
		if (char === "\\") {
			escape = true;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === " " && !inSingle && !inDouble) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) args.push(current);
	return args;
}

/**
 * Substitute argument placeholders in content.
 *
 * Supports (1-indexed, aligned with bash and Pi's prompt-templates):
 *   $1, $2, ...   — positional arguments
 *   $@             — all arguments joined by space
 *   $ARGUMENTS     — all arguments joined by space (alias)
 *   ${@:N}         — arguments from Nth position onwards
 *   ${@:N:L}       — L arguments starting from position N
 */
function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $1, $2, etc. FIRST (before wildcards to prevent re-substitution)
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// Replace ${@:start} or ${@:start:length} (bash-style, 1-indexed)
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);

	return result;
}

/**
 * Process shell directives (!`command`) by executing them and inlining stdout.
 * On error: replaces with [Error executing: command].
 * Timeout: DEFAULT_SHELL_TIMEOUT ms (configurable).
 */
function processShellDirectives(content: string, cwd: string, timeout: number = DEFAULT_SHELL_TIMEOUT): string {
	return content.replace(SHELL_DIRECTIVE_REGEX, (_, command: string) => {
		try {
			return execSync(command, {
				cwd,
				timeout,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		} catch {
			return `[Error executing: ${command}]`;
		}
	});
}

/**
 * Juno Skill Preprocessor Extension
 *
 * Intercepts /skill: commands via the "input" event (before Pi's internal
 * _expandSkillCommand runs), applies variable substitution and shell
 * directive processing, then returns the fully expanded skill block.
 */
export default function junoSkillPreprocessor(pi: ExtensionAPI) {
	pi.on("input", (event: InputEvent) => {
		const text = typeof event.text === "string" ? event.text : "";
		if (!text.startsWith("/skill:")) return { action: "continue" };

		const cwd = process.cwd();

		// Parse skill name and arguments from the command
		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
		const args = parseCommandArgs(argsString);

		// Find the skill file on disk
		const skillPath = findSkillFile(skillName, cwd);
		if (!skillPath) return { action: "continue" }; // Unknown skill — let Pi handle it

		try {
			const content = readFileSync(skillPath, "utf-8");
			const { frontmatter, body } = parseFrontmatter(content);
			let processedBody = body.trim();

			// Substitute variable placeholders with provided arguments
			if (args.length > 0) {
				processedBody = substituteArgs(processedBody, args);
			}

			// Execute shell directives (only when explicitly opted in via frontmatter)
			if (frontmatter["enable-shell-directives"] === true) {
				processedBody = processShellDirectives(processedBody, cwd);
			}

			// Build the <skill> block (matches Pi's _expandSkillCommand format)
			const baseDir = dirname(skillPath);
			const skillBlock = [
				`<skill name="${skillName}" location="${skillPath}">`,
				`References are relative to ${baseDir}.`,
				"",
				processedBody,
				"</skill>",
			].join("\n");

			// Return transformed text — Pi's _expandSkillCommand will see this
			// doesn't start with /skill: and pass it through unchanged.
			return { action: "transform", text: skillBlock };
		} catch {
			// On error, let Pi's native expansion handle it
			return { action: "continue" };
		}
	});
}

// Export internals for testing
export { findSkillFile, parseCommandArgs, parseFrontmatter, processShellDirectives, substituteArgs };
