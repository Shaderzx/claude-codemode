# codemode for Claude Code

Two Claude Code mods that give Claude a version of Pi's codemode in "only" mode. Claude gets one tool that does work, `mcp__codemode__run`. It takes a JavaScript script, and that script calls every other tool (Read, Bash, Agent, AskUserQuestion, Skill, every MCP tool). Only what the script returns or prints reaches Claude, so three reads become one script with `Promise.all`, one round trip, and the script can trim the results before Claude sees them.

If Claude calls any other tool directly, the call is refused with:

> Direct tool calls are disabled. Call X from a script with mcp__codemode__run: return await tools.X({...})

**The one exception is ToolSearch.** Claude can still call it directly to load a tool's schema. The call itself still goes through a script, and a script's `describeTool(name)` gives the same arguments as one TypeScript type for a fraction of the tokens, so the tool's description points Claude there instead.

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

Scripts and the mod pass messages through `~/.claude/codemode/runs/<run>/`; the mod deletes each run's folder when the run ends. Cut outputs go to `~/.claude/codemode/out/`.

## What a script can use

The script is the body of an async function, so top-level `await` and `return` both work.

| Global | What it does |
|---|---|
| `tools.<Name>(args)` | Calls a tool. Resolves to the text the tool would have shown Claude, and throws if the call is denied or fails. Characters that are not valid in a JavaScript name become `_`, so `mcp__lean-ctx__ctx_read` is written `tools.mcp__lean_ctx__ctx_read` |
| `call(name, args)` | The same as `tools.<Name>`, but it never throws. Resolves to `{ ok, text, result, error }` |
| `text(v)`, `return v` | Add an item to the output |
| `console.log/info/warn/error` | Add lines to a `<console_output>` block at the end |
| `ALL_TOOLS`, `searchTools(q, {limit})` | List or search the tools a script can call |
| `describeTool(name)` | Returns `{ name, description, input }`, where `input` is the tool's arguments as a TypeScript type (see "Arguments" below) |
| `ask(prompt, { model, system, maxTokens, effort })` | One completion with no tools through the session's own API client, by `haiku` unless `model` names another; resolves to the reply's text. For boiling large data down inside the script, so only the answer reaches Claude |
| Image and PDF markers | An image or PDF in a tool's result reaches the script as a marker such as `[image #1 image/png 12KB]`. A marker that appears in the output brings the picture with it, and Claude sees it |
| `store(k, v)` / `load(k)` | Keep small JSON values from one script run to the next (kept in the mod's store) |
| `exit()` | Stop the script early, counted as a success |

An optional first line sets limits: `// @options: {"timeout_ms": 600000, "max_output_chars": 20000}`. Both values shown are the defaults; `timeout_ms` is held between 1 second and 1 hour, `max_output_chars` between 1,000 and 1,000,000. Only the first non-blank line counts, so a script can carry that text inside a string.

Output longer than `max_output_chars` keeps its head and its tail, and the whole of it is written to `~/.claude/codemode/out/<run>.txt`, whose path the cut names. Nothing in a long output needs a second run to recover. The newest 20 such files are kept.

Scripts are not handed `fetch`, timers, `process`, `require` or `import`. The `vm` context is not a security boundary, though: a script can reach the runner's `process` through any function it is given. The real boundary is Node's permission model, which leaves the runner no network, no subprocesses, no workers, and file access only to its own run folder. The runner also clears its environment variables before the script starts.

## How it works

1. **Hiding the other tools.** A `tool.describe` hook marks every tool except `mcp__codemode__run` and ToolSearch as deferred, so Claude's prompt only carries the full definitions of those two.
2. **Refusing direct calls.** A `tool.call` hook looks at `next.origin.plugin`. A call that comes from `engine` (Claude itself) or from `codemode-agents` (a subagent) is refused, unless it is ToolSearch or the spawn in step 5. A script's calls never reach this check, because a mod's own calls skip its own hook. Calls made by other mods pass through.
3. **Running the script.** The mod runtime forbids `eval` and `new Function`, so the mod starts `node --permission --allow-fs-read=<run dir> --allow-fs-write=<run dir> -e <runner>` and passes the script and tool list on stdin. The runner reports its pid, then executes the script in a separate Node `vm` context. For each tool call the runner prints one JSON line with a `\x1eCM` prefix; the mod accepts only positive integer ids and known request kinds, makes the real `$.tool.call`, and writes the result to `<run dir>/<id>.json`, which the runner polls for. Keys `$.tool.call` reads beside a tool's arguments (`consent`, `requestMeta`, `tool_use_id`, `agentId`) are dropped, so a script cannot claim the user approved a call. Your own hooks and permission rules still apply to every one of these calls. A script that never yields (`while (true) {}`) blocks the runner's own timer, so the mod kills the runner by pid 5 seconds after the timeout.
4. **Skills.** The Skill tool's own result is only `Launching skill: <name>`; Claude Code sends the skill's text to the model as a separate message, which a script never sees. The mod keeps the text expanded at `skill.prompt` and appends it to the Skill result, so `tools.Skill({ skill })` returns the whole skill.
5. **Subagents.** A plugin cannot call the Agent tool; Claude Code says to use `$.agent.spawn` instead. Claude Code also skips a plugin's hooks for every subagent started inside that plugin's chain of calls, even through another plugin's tool. So `tools.Agent(...)` (or the old name `tools.Task(...)`) is forwarded to `mcp__codemode-agents__spawn`, which queues the request; a loop started in `codemode-agents`' `session.start` does the real `$.agent.spawn` outside codemode's chain, and its `turn.complete` hook collects the answer. Subagents therefore get `mcp__codemode__run` and are held to scripts like the main session. The spawn tool refuses any caller but codemode, refuses `isolation` and `effort` (which `$.agent.spawn` cannot express) instead of dropping them, waits at most an hour for a started subagent's answer, and reports a subagent that ended with an error, refusal or abort as a failed call. `Workflow` is refused from scripts, because its agents would start inside codemode's chain and skip its hooks.
6. **Pictures.** A tool's image or PDF never reaches the script as base64. The mod swaps each one (an API image block, an MCP image block, Read's image, PDF or page images) for a marker and keeps the bytes. When the run ends, every picture whose marker is in the output is attached to the result as an image or document block, at most 10, so Claude sees exactly the pictures the script chose to show.
7. **Arguments.** `describeTool` reads the input types Claude Code generates for mods into `.claude-plugin/types/`: `claude-code-tools` for the built-in tools and `claude-code-mcp` for the MCP servers that were connected when the types were last written. When a call's arguments fail validation, the engine answers with advice to load the tool through ToolSearch followed by the tool's whole JSON schema; the mod keeps the engine's first lines, replaces the rest with one line, `<tool> takes { ... }`, and remembers that type for later `describeTool` calls. A tool found in neither place gets a pointer to ToolSearch.
8. **Output.** A run that works returns its output and nothing else. A failed one ends with `Script failed after <ms>ms: <error>`, its stack trimmed to the script's own frames, with line numbers that match the script.

## Performance

Scripts are cheap. Tool calls are not. Measured on the machine this was written on.

| Thing | Cost |
| --- | --- |
| Starting a script (spawn Node, boot, run dir) | ~60 ms, once per run |
| codemode's own request/reply path (file write + poll) | ~1.5 ms per call |
| One tool call, sequentially | ~160 ms (native tool) to ~260 ms (MCP tool) |

Two things follow, and only one of them is a number.

**Batch independent calls with `Promise.all`.** This is the whole win, and it costs nothing to adopt. Forty shell calls one after another took 9.5 s; the same forty through `Promise.all` took 0.7 s. Better still, prefer a tool that already takes many inputs, or one shell call that does several jobs internally, over N calls that lean on batching to save you.

**lean-ctx's MCP tools appear to have a concurrency ceiling of 16, and it is not codemode's.** Each tool call becomes one `$.tool.call`, which the engine forwards to the MCP server. Measured with one-second sleeps, instrumented server-side so polling lag cannot fake a limit:

| Batch | Wall clock | Peak overlap |
| --- | --- | --- |
| 8 | 1.3 s | 8 |
| 16 | 2.4 s | 15 |
| 32 | 3.4 s | 16 |
| 64 | 5.8 s | 16 |

Native engine tools did not hit it in the same test: 64 concurrent native `Read` calls finished in ~0.8 s, where 64 capped calls would have taken several waves. That is one tool on small files, so it rules out a limit on all engine tools, not one specific to MCP calls. Who owns the ceiling is likely lean-ctx but not proven. Its binary lists `agents.max_concurrent_workers` as retired (`registration never applied it`), and an older config on this machine carried the comment "Built-in defaults are 12 workers / 4 mutating, which is why ~15 agents broke" beside a setting this version no longer has. That matches 16, but a retired key and a `.bak` comment are clues, not proof. Settling it needs the same overlap test against a different MCP server, which was not measured.

**What to do about the ceiling: stop fighting it and make fewer calls.** Inside codemode there is no lever. `$.tool.call` has no concurrency argument, and the mod never awaits one reply before reading the next request, so it throttles nothing. Raising the number is an MCP-server-side or engine-side change. The portable workaround is to hand the work to one process that parallelises itself:

```js
// 32 two-second jobs in 2.3 s through ONE call, versus 4.4 s as 32 calls.
// Timing sketch: a bare `wait` ignores each job's exit status, so a real
// script should collect the pids and check them before trusting the result.
await tools.mcp__lean_ctx__ctx_shell({
  command: 'for i in $(seq 1 32); do ( work_"$i" ) & done; wait',
})
```

That trick is honest only where the work can be backgrounded, chiefly shell work. It buys throughput, not lower latency per operation.

**What not to bother with.** Replacing the file-based request/reply with a socket buys at most 1.5 ms on a call that takes 160-260 ms. Keeping a Node runner warm between runs saves ~60 ms per run, which only matters to a run that makes one call and nothing else, and it trades away the clean isolation where each run gets its own directory that is deleted afterwards.

**On choosing a language for scripts.** JavaScript is the contract codemode implements, not a law of nature. The request/reply protocol is plain text lines and files, so a runner in another language would not need a second bridge. But no language choice touches the two numbers that matter: a tool call still costs 160-260 ms, and the ceiling above is still 16. The one cost a language could move is the ~60 ms startup, which is noise beside a single call. Rust as the script language makes that worse, not better, because every script would be compiled before it ran; a Rust binary that hosts a JavaScript engine is a different and much larger project. Python starts in roughly the same ballpark as Node. Java would be the clear worst of the three, since a JVM per run dwarfs the runner itself.

## Tokens

What codemode saves is the prompt every request carries. Without it, a clean session sends about 17,300 tokens before the conversation starts, most of them built-in tool schemas; with it, about 8,700. That half comes back on every request, as cache reads.

Measured with headless `claude -p --model sonnet` runs in a clean profile (`--setting-sources project --strict-mcp-config`, only these two mods), two runs per cell, on six small tasks in a 12-file Python repo. "Read" is every input token the model was sent (uncached, cache writes and cache reads), averaged per run; "calls" is API requests.

| Task | Plain Claude Code | codemode before | codemode now |
| --- | --- | --- | --- |
| Explain how a function works | 71.9k read, 4.0 calls | 47.3k, 5.0 | 45.5k, 4.5 |
| Edit, add a test, check it | 83.8k, 4.0 | 49.3k, 4.0 | 49.8k, 4.0 |
| Say what colours a PNG has | 34.7k, 2.0 | 64.1k, 6.0 | 18.0k, 2.0 |
| Summarise a 900-line plan | 47.8k, 2.0 | 30.7k, 2.0 | 45.4k, 3.0 |
| Read the word in a PDF | 36.3k, 2.0 | 27.2k, 3.0 | 19.5k, 2.0 |
| Review the package and fix one bug | 125.9k, 5.5 | 84.0k, 6.0 | 87.9k, 6.0 |

- The PNG row is the old blind spot: before, `tools.Read` on an image returned an empty string, and the model spent four extra calls decoding the PNG by hand in Python. A real screenshot would have been out of reach. Now it reads the image like plain Claude Code does, at half the tokens.
- In the plan row the new 20,000-character cut stopped a 29,500-character dump; the model grepped for the headings instead. That is one more call and more tokens read in a two-turn run, but 18% fewer tokens written to the cache, which cost 12.5 times a cache read, and that dump would otherwise be re-read on every later turn of a longer session. In dollars it was the cheapest of the three.
- Changing the tool description costs one cold start: the first run after an upgrade pays the whole prefix (8,745 tokens written, none read), later ones read it from the cache.
- Tool schemas: ToolSearch on two built-in tools wrote 2,315 tokens of JSON schema into the context. `describeTool` returns the same arguments as TypeScript, and a call with bad arguments now costs about 60 tokens of error instead of about 600.

Reproduce with any task: run the same prompt with and without `--plugin-dir` for both folders and sum `message.usage` over the assistant lines of `--output-format stream-json --verbose`.

## Gotchas

- No `eval` and no `setTimeout` in the mod runtime. Use `$.clock.after` for timers.
- The mod loader rejects code that stores or passes `$`. Write `$.noun.event(...)` where it is called.
- Hooks get 10 seconds of their own time. Waiting on a `$` call does not count against it, but waiting on a plain promise does, so the spawn tool waits by looping on `$.process.run(['sleep','0.3'])`.
- `next.origin` is the only way to tell Claude's calls from a plugin's. Calls raised by an Agent spawn carry the spawning plugin's origin and no `agentId`.
- Your own permission rules and hooks still apply inside scripts. If something denies native Bash, Edit or Write (lean-ctx replace mode does), scripts have to use the replacement tools you allow instead (for lean-ctx, `ctx_patch` and `ctx_shell`).

## Known limits

- AskUserQuestion and permission dialogs from inside a script were never tried (headless runs have no dialogs).
- Edit inside scripts works: a Read in an earlier script satisfies its "Read the file first" check (seen in the headless runs under Tokens). Write was not tried.
- `run_in_background` subagents are not tested. A subagent starting its own subagent from a script is expected to fail: the helper mod's hooks are skipped inside its own subagents.
- A subagent's script calls run in the main session's loop, so an agent type's `tools` or `disallowedTools` list is not applied inside its scripts.
- A `context: fork` skill run through `tools.Skill` starts its agent inside codemode's chain, so that agent is not held to scripts.
- An escaped script can still signal processes owned by the same user; the permission model does not cover signals.
- When a script times out its unfinished tool calls are abandoned; the mod cannot stop them.
- `describeTool` knows the tools in the generated types and the ones a failed call has taught it. Headless `claude -p --plugin-dir` runs do not write those types, and the MCP part can be out of date, so for such tools it points to ToolSearch.
- At most 10 pictures are attached to one output; `ask` has no tools and no history.
- `claude plugin test` in each mod folder runs the unit tests, which replace the runner with a fake one. Everything else was checked with live headless `claude -p` runs.
