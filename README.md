# codemode for Claude Code

Two Claude Code mods that give Claude a version of Pi's codemode in "only" mode. Claude gets one tool that does work, `mcp__codemode__run`. It takes a JavaScript script, and that script calls every other tool (Read, Bash, Agent, AskUserQuestion, Skill, every MCP tool). Only what the script returns or prints reaches Claude, so three reads become one script with `Promise.all`, one round trip, and the script can trim the results before Claude sees them.

If Claude calls any other tool directly, the call is refused with:

> Direct tool calls are disabled. Call X from a script with mcp__codemode__run: return await tools.X({...})

**The one exception is ToolSearch.** Claude can still call it directly, but only to load a tool's schema (its argument list). The call itself still goes through a script. A mod cannot read tool schemas: `$.tool.list()` returns only names and descriptions.

| Folder | What it is |
|---|---|
| `codemode/` | The main mod: the script tool, the gate that refuses direct calls, and the script runner (`hooks/register.tsx`) |
| `codemode-agents/` | A small helper mod that starts subagents for scripts (`hooks/register.tsx`) |

Built and checked on Claude Code 2.1.314 with Node 26. It needs `node` 25 or later on `PATH`: the script runner is a Node child process, and older Node versions do not block network access under `--permission`.

## Install

```sh
git clone https://github.com/Shaderzx/claude-codemode.git
mkdir -p ~/.claude/mods
cp -R claude-codemode/codemode claude-codemode/codemode-agents ~/.claude/mods/
```

If the `node` on Claude Code's `PATH` is older than 25, install a newer one anywhere and set `env.CODEMODE_NODE` in `~/.claude/settings.json` to its path; the runner uses it instead of `node`.

Then add both folders to the end of `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (colon separated), for example `"CLAUDE_CODE_PLUGIN_DIRS": "...:~/.claude/mods/codemode:~/.claude/mods/codemode-agents"`. Both mods load in every new session; sessions that are already running are not affected. Claude Code writes the TypeScript types the `tsconfig.json` files point at into `.claude-plugin/types/` on load; that folder is not committed.

**To turn it off:** remove the two paths from `CLAUDE_CODE_PLUGIN_DIRS` and start a new session. To try it in one session only, leave settings alone and run `claude --plugin-dir ~/.claude/mods/codemode --plugin-dir ~/.claude/mods/codemode-agents`.

Scripts and the mod pass messages through `~/.claude/codemode/runs/<run>/`; the mod deletes each run's folder when the run ends.

## What a script can use

The script is the body of an async function, so top-level `await` and `return` both work.

| Global | What it does |
|---|---|
| `tools.<Name>(args)` | Calls a tool. Resolves to the text the tool would have shown Claude, and throws if the call is denied or fails. Characters that are not valid in a JavaScript name become `_`, so `mcp__lean-ctx__ctx_read` is written `tools.mcp__lean_ctx__ctx_read` |
| `call(name, args)` | The same as `tools.<Name>`, but it never throws. Resolves to `{ ok, text, result, error }` |
| `text(v)`, `return v` | Add an item to the output |
| `console.log/info/warn/error` | Add lines to a `<console_output>` block at the end |
| `ALL_TOOLS`, `searchTools(q, {limit})` | List or search the tools a script can call |
| `describeTool(name)` | Returns `{ name, description }` and points to ToolSearch for the schema |
| `store(k, v)` / `load(k)` | Keep small JSON values from one script run to the next (kept in the mod's store) |
| `exit()` | Stop the script early, counted as a success |

An optional first line sets limits: `// @options: {"timeout_ms": 600000, "max_output_chars": 40000}`. Both values shown are the defaults; `timeout_ms` is held between 1 second and 1 hour, `max_output_chars` between 1,000 and 1,000,000.

Scripts are not handed `fetch`, timers, `process`, `require` or `import`. The `vm` context is not a security boundary, though: a script can reach the runner's `process` through any function it is given. The real boundary is Node's permission model, which leaves the runner no network, no subprocesses, no workers, and file access only to its own run folder. The runner also clears its environment variables before the script starts.

## How it works

1. **Hiding the other tools.** A `tool.describe` hook marks every tool except `mcp__codemode__run` and ToolSearch as deferred, so Claude's prompt only carries the full definitions of those two.
2. **Refusing direct calls.** A `tool.call` hook looks at `next.origin.plugin`. A call that comes from `engine` (Claude itself) or from `codemode-agents` (a subagent) is refused, unless it is ToolSearch or the spawn in step 5. A script's calls never reach this check, because a mod's own calls skip its own hook. Calls made by other mods pass through.
3. **Running the script.** The mod runtime forbids `eval` and `new Function`, so the mod starts `node --permission --allow-fs-read=<run dir> --allow-fs-write=<run dir> -e <runner>` and passes the script and tool list on stdin. The runner reports its pid, then executes the script in a separate Node `vm` context. For each tool call the runner prints one JSON line with a `\x1eCM` prefix; the mod accepts only positive integer ids and known request kinds, makes the real `$.tool.call`, and writes the result to `<run dir>/<id>.json`, which the runner polls for. Keys `$.tool.call` reads beside a tool's arguments (`consent`, `requestMeta`, `tool_use_id`, `agentId`) are dropped, so a script cannot claim the user approved a call. Your own hooks and permission rules still apply to every one of these calls. A script that never yields (`while (true) {}`) blocks the runner's own timer, so the mod kills the runner by pid 5 seconds after the timeout.
4. **Skills.** The Skill tool's own result is only `Launching skill: <name>`; Claude Code sends the skill's text to the model as a separate message, which a script never sees. The mod keeps the text expanded at `skill.prompt` and appends it to the Skill result, so `tools.Skill({ skill })` returns the whole skill.
5. **Subagents.** A plugin cannot call the Agent tool; Claude Code says to use `$.agent.spawn` instead. Claude Code also skips a plugin's hooks for every subagent started inside that plugin's chain of calls, even through another plugin's tool. So `tools.Agent(...)` (or the old name `tools.Task(...)`) is forwarded to `mcp__codemode-agents__spawn`, which queues the request; a loop started in `codemode-agents`' `session.start` does the real `$.agent.spawn` outside codemode's chain, and its `turn.complete` hook collects the answer. Subagents therefore get `mcp__codemode__run` and are held to scripts like the main session. The spawn tool refuses any caller but codemode, refuses `isolation` and `effort` (which `$.agent.spawn` cannot express) instead of dropping them, waits at most an hour for a started subagent's answer, and reports a subagent that ended with an error, refusal or abort as a failed call. `Workflow` is refused from scripts, because its agents would start inside codemode's chain and skip its hooks.

## Gotchas

- No `eval` and no `setTimeout` in the mod runtime. Use `$.clock.after` for timers.
- The mod loader rejects code that stores or passes `$`. Write `$.noun.event(...)` where it is called.
- Hooks get 10 seconds of their own time. Waiting on a `$` call does not count against it, but waiting on a plain promise does, so the spawn tool waits by looping on `$.process.run(['sleep','0.3'])`.
- `next.origin` is the only way to tell Claude's calls from a plugin's. Calls raised by an Agent spawn carry the spawning plugin's origin and no `agentId`.
- Your own permission rules and hooks still apply inside scripts. If something denies native Bash, Edit or Write (lean-ctx replace mode does), scripts have to use the replacement tools you allow instead (for lean-ctx, `ctx_patch` and `ctx_shell`).

## Known limits

- AskUserQuestion and permission dialogs from inside a script were never tried (headless runs have no dialogs).
- Edit and Write inside scripts, including Edit's "Read the file first" check, were not tried; lean-ctx's `ctx_patch` was tested instead.
- `run_in_background` subagents are not tested. A subagent starting its own subagent from a script is expected to fail: the helper mod's hooks are skipped inside its own subagents.
- A subagent's script calls run in the main session's loop, so an agent type's `tools` or `disallowedTools` list is not applied inside its scripts.
- A `context: fork` skill run through `tools.Skill` starts its agent inside codemode's chain, so that agent is not held to scripts.
- An escaped script can still signal processes owned by the same user; the permission model does not cover signals.
- When a script times out its unfinished tool calls are abandoned; the mod cannot stop them.
- Images from tools are not passed back by scripts, there is no `models.*` global like Pi's, and `describeTool` does not return schemas.
- `claude plugin test` in each mod folder runs the unit tests, which replace the runner with a fake one. Everything else was checked with live headless `claude -p` runs.
