# codemode for Claude Code

Two Claude Code mods that give Claude a version of Pi's codemode in "only" mode. Claude gets one tool that does work, `mcp__codemode__run`. It takes a JavaScript script, and that script calls every other tool (Read, Bash, Agent, AskUserQuestion, Skill, every MCP tool). Only what the script returns or prints reaches Claude, so three reads become one script with `Promise.all`, one round trip, and the script can trim the results before Claude sees them.

If Claude calls any other tool directly, the call is refused with:

> Direct tool calls are disabled. Call X from a script with mcp__codemode__run: return await tools.X({...})

**The one exception is ToolSearch.** Claude can still call it directly to load a tool's schema. The call itself still goes through a script. For built-in tools a script's `describeTool(name)` gives the arguments as one TypeScript type for a fraction of the tokens once it knows them; for MCP tools ToolSearch is the only source of a schema. ToolSearch's description carries one extra sentence: a tool it loads is still called from a script, never directly.

| Folder | What it is |
|---|---|
| `codemode/` | The main mod: the script tool, the gate that refuses direct calls, and the script runner (`hooks/register.tsx`) |
| `codemode-agents/` | A small helper mod that starts subagents for scripts (`hooks/register.tsx`) |

Built and checked on Claude Code 2.1.318 with Node 26. It needs `node` 25 or later on `PATH`: the script runner is a Node child process, and older Node versions do not block network access under `--permission`.

## Install

```sh
git clone https://github.com/Shaderzx/claude-codemode.git
mkdir -p ~/.claude/mods
cp -R claude-codemode/codemode claude-codemode/codemode-agents ~/.claude/mods/
```

If the `node` on Claude Code's `PATH` is older than 25, install a newer one anywhere and set `env.CODEMODE_NODE` in `~/.claude/settings.json` to its path; the runner uses it instead of `node`.

Then add both folders to the end of `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (colon separated), for example `"CLAUDE_CODE_PLUGIN_DIRS": "...:~/.claude/mods/codemode:~/.claude/mods/codemode-agents"`. Both mods load in every new session; sessions that are already running are not affected. Claude Code up to 2.1.309 wrote the TypeScript types the `tsconfig.json` files point at into `.claude-plugin/types/` on load (newer versions do not; see "Arguments"); that folder is not committed.

**To turn it off:** remove the two paths from `CLAUDE_CODE_PLUGIN_DIRS` and start a new session. To try it in one session only, leave settings alone and run `claude --plugin-dir ~/.claude/mods/codemode --plugin-dir ~/.claude/mods/codemode-agents`.

Scripts and the mod pass messages through `~/.claude/codemode/runs/<run>/`; the mod deletes each run's folder when the run ends. Cut outputs go to `~/.claude/codemode/out/`.

## What a script can use

The script is the body of an async function, so top-level `await` and `return` both work.

| Global | What it does |
|---|---|
| `tools.<Name>(args)` | Calls a tool. Resolves to the text the tool would have shown Claude, and throws if the call is denied or fails. Characters that are not valid in a JavaScript name become `_`, so `mcp__lean-ctx__ctx_read` is written `tools.mcp__lean_ctx__ctx_read` |
| `call(name, args)` | The same as `tools.<Name>`, but it never throws. Resolves to `{ ok, text, result, error }` |
| `text(v)`, `return v` | Add an item to the output. A plain object or array holding multi-line strings prints each top-level entry under a `== key ==` heading with the text raw, instead of JSON full of `\n` and `\"` escapes; anything else prints as JSON (`return JSON.stringify(v)` for exact JSON) |
| `console.log/info/warn/error` | Add lines to a `<console_output>` block at the end |
| `ALL_TOOLS`, `searchTools(q, {limit})` | List or search the tools a script can call. Each description is cut to its first sentence (120 characters at most); the search still ranks on the whole description, and `describeTool` returns all of it |
| `describeTool(name)` | Returns `{ name, description, input }`, where `input` is the tool's arguments as a TypeScript type when known (see "Arguments" below). For a name the session does not have, `input` says so and names up to three similar tools |
| `ask(prompt, { model, system, maxTokens, effort })` | One completion with no tools through the session's own API client, by `haiku` unless `model` names another; resolves to the reply's text. For boiling large data down inside the script, so only the answer reaches Claude |
| Image and PDF markers | An image or PDF in a tool's result reaches the script as a marker such as `[image #1 image/png 12KB]`. A marker that appears in the output brings the picture with it, and Claude sees it |
| `store(k, v)` / `load(k)` | Keep small JSON values from one script run to the next (kept in the mod's store) |
| `exit()` | Stop the script early, counted as a success |

An optional first line sets limits: `// @options: {"timeout_ms": 600000, "max_output_chars": 20000}`. Both values shown are the defaults; `timeout_ms` is held between 1 second and 1 hour, `max_output_chars` between 1,000 and 1,000,000. Only the first non-blank line counts, so a script can carry that text inside a string.

Output longer than `max_output_chars` keeps its head and its tail, and the whole of it is written to `~/.claude/codemode/out/<run>.txt`, whose path the cut names along with the cut's line numbers (`lines 73-238 of 300`), so the next run can read back only that part. Files under a day old are kept, at most 200: every session shares the folder, so a plain count would let busy parallel sessions delete a file another session's cut still points to.

Scripts are not handed `fetch`, timers, `process`, `require` or `import`. The `vm` context is not a security boundary, though: a script can reach the runner's `process` through any function it is given. The real boundary is Node's permission model, which leaves the runner no network, no subprocesses, no workers, and file access only to its own run folder. The runner also clears its environment variables before the script starts.

## How it works

1. **Hiding the other tools, and describing the rest.** A `tool.describe` hook marks every tool except `mcp__codemode__run` and ToolSearch as deferred, so Claude's prompt only carries the full definitions of those two. The run tool's description is built once, when the session starts, from `$.tool.list()` (an MCP server that connects later is not seen, so a missing built-in may be named without its replacement): its argument lines name only the built-in tools the session has, and built-ins a model reaches for by habit (Bash, Edit, Write, Grep, Glob) are named as missing, with the session's likeliest replacement, in the form a script calls it, for example `Bash (use tools.mcp__lean_ctx__ctx_shell)` (named bare, DeepSeek would load it with ToolSearch and then call it directly, which is refused). It also asks for a whole step per script: every call that can already be named at once, and the steps that need no judgment in between chained inside the script, because each run is a round trip that re-sends the whole conversation.
2. **Refusing direct calls.** A `tool.call` hook looks at `next.origin.plugin`. A call that comes from `engine` (Claude itself) or from `codemode-agents` (a subagent) is refused, unless it is ToolSearch or the spawn in step 5. A script's calls never reach this check, because a mod's own calls skip its own hook. Calls made by other mods pass through.
3. **Running the script.** The mod runtime forbids `eval` and `new Function`, so the mod starts `node --permission --allow-fs-read=<run dir> --allow-fs-write=<run dir> -e <runner>` and passes the script and tool list on stdin. The runner reports its pid, then executes the script in a separate Node `vm` context. For each tool call the runner prints one JSON line with a `\x1eCM` prefix; the mod accepts only positive integer ids and known request kinds, makes the real `$.tool.call`, and writes the result to `<run dir>/<id>.json`, which the runner polls for. Keys `$.tool.call` reads beside a tool's arguments (`consent`, `requestMeta`, `tool_use_id`, `agentId`) are dropped, so a script cannot claim the user approved a call. Your own hooks and permission rules still apply to every one of these calls. A script that never yields (`while (true) {}`) blocks the runner's own timer, so the mod kills the runner by pid 5 seconds after the timeout.
4. **Skills.** The Skill tool's own result is only `Launching skill: <name>`; Claude Code sends the skill's text to the model as a separate message, which a script never sees. The mod keeps the text expanded at `skill.prompt`, numbered, and appends it to every Skill call that started before that expansion, so `tools.Skill({ skill })` returns the whole skill even when several Skill calls run at once (before, the second of two parallel calls got only `Launching skill: <name>`), and never a text an earlier call expanded. Calls to the same skill take turns, so each gets the text expanded for its own `args`; different skills still run in parallel. A call that has waited 60 seconds for an earlier one fails with a message saying so, rather than share that call's turn.
5. **Subagents.** A plugin cannot call the Agent tool; Claude Code says to use `$.agent.spawn` instead. Claude Code also skips a plugin's hooks for every subagent started inside that plugin's chain of calls, even through another plugin's tool. So `tools.Agent(...)` (or the old name `tools.Task(...)`) is forwarded to `mcp__codemode-agents__spawn`, which queues the request; a loop started in `codemode-agents`' `session.start` does the real `$.agent.spawn` outside codemode's chain, and its `turn.complete` hook collects the answer. Subagents therefore get `mcp__codemode__run` and are held to scripts like the main session. The spawn tool refuses any caller but codemode, refuses `isolation` and `effort` (which `$.agent.spawn` cannot express) instead of dropping them, waits at most an hour for a started subagent's answer, and reports a subagent that ended with an error, refusal or abort as a failed call. `Workflow` is refused from scripts, because its agents would start inside codemode's chain and skip its hooks.
6. **Pictures.** A tool's image or PDF never reaches the script as base64. The mod swaps each one (an API image block, an MCP image block, Read's image, PDF or page images) for a marker and keeps the bytes. When the run ends, every picture whose marker is in the output is attached to the result as an image or document block, at most 10, so Claude sees exactly the pictures the script chose to show.
7. **Arguments.** Claude Code 2.1.309 and older wrote input types for mods into `.claude-plugin/types/` (`claude-code-tools` for the built-in tools, `claude-code-mcp` for the MCP servers then connected); 2.1.318 writes none in headless, `plugin test`, `plugin validate` or T3 sessions, and `$.tool.list()` gives only names and descriptions. So the live source is the engine's answer to bad arguments: advice to load the tool through ToolSearch followed by its whole JSON schema. The mod keeps the engine's first lines, replaces the rest with one line, `<tool> takes { ... }`, and keeps that type in memory and in its store under the engine version, so later sessions on the same version know it too. Only a built-in's error carries its schema (an MCP server writes its own errors), so only built-ins are learned, and only from an error that starts the way the engine's own does (`InputValidationError: <tool> failed due to the following issue`), so a failing command that prints the same advice cannot plant a type. No engine version known, nothing is stored. `describeTool` prefers a type learned in this process, then a generated file, then a stored type; an unknown built-in gets "a call with wrong arguments answers with its type", an unknown MCP tool gets "call ToolSearch directly".
8. **Output.** A run that works returns its output and nothing else. A failed one ends with `Script failed after <ms>ms: <error>`, its stack trimmed to the script's own frames, with line numbers that match the script. When the run made tool calls, one more line names them, `Tool calls before the failure: Read 2 ok; mcp__lean-ctx__ctx_patch 1 failed`, with calls still running marked `may still finish`, because those side effects stand (a failed call can have changed things too) and the next run should not repeat them blind. A call to a tool the session does not have fails with up to three similar names.

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

### Session-aware description, round trips and failures (Claude Code 2.1.318)

Measured the same way with `claude -p --model sonnet`, set up the way codemode is used beside lean-ctx: lean-ctx as the only MCP server, and Bash, Edit, Write, Grep and Glob denied, as lean-ctx's replace mode does. Three runs per cell, each in its own copy of this repo; "failed" is scripts whose result ended with `Script failed after`. Every run finished its task.

| Task | Before | After |
| --- | --- | --- |
| Find `clip` and `format` and explain how a long output reaches the model | 79.3k read, 8.0 calls, 1.0 failed | 52.0k, 5.0, 0.0 |
| Report the last commit, README's line count and the TypeScript files | 67.1k, 7.0, 1.0 | 38.8k, 4.3, 0.0 |
| Change one constant and show the changed line | 80.1k, 8.0, 1.0 | 35.3k, 4.0, 0.0 |

- Before, the first script of most runs called `Bash` or `Grep`, which the old description offered and the session did not have; after, the description names each as missing with its replacement, and the model's first call goes to `mcp__lean-ctx__ctx_shell` or `ctx_search`.
- The run tool's description for this setup is 2,800 characters, down from 3,138, with the batching rule added.
- By kind, summed over the three tasks, from each session's final usage: cache reads 190.8k to 94.0k (-51%), cache writes 35.8k to 32.1k (-10%), output 3,633 to 2,087 (-43%); the gateway's cost fell from $0.145 to $0.111 (-24%). Cache writes barely move because each fresh session writes its ~10k-token prompt prefix once; reads, which grow with every round trip, carry the saving.
- In Shad's own transcripts (257 runs over five days) 43% of scripts made one tool call or none, script output was 87% of what codemode added to the context, and 9% of runs hit the 20,000-character cut. The cut size stays at 20,000: a smaller one would trade context for more follow-up reads, and the cut note now gives line numbers to make those reads small.

### DeepSeek V4.1 Flash

The same tasks and setup with `--model deepseek-v4.1-flash[1m]` through the same gateway, three runs per cell. DeepSeek's caching is automatic, so the gateway reports no cache writes; "input" is uncached input plus cache reads. The middle column is 0.3.0 with replacements named bare (`use mcp__lean-ctx__ctx_shell`), the last the script form this README describes.

| Task | 0.2.0 | 0.3.0, bare names | 0.3.0, script form |
| --- | --- | --- | --- |
| Find `clip` and `format` and explain how a long output reaches the model | 88.4k input, 9.3 calls, 1.0 failed | 67.8k, 8.7, 0.7 | 72.9k, 8.3, 0.3 |
| Report the last commit, README's line count and the TypeScript files | 55.6k, 7.3, 1.3 | 34.4k, 5.3, 0.3 | 13.4k, 2.3, 0.0 |
| Change one constant and show the changed line | 61.7k, 9.0, 1.7 | 52.0k, 6.3, 0.0 | 41.9k, 5.7, 0.3 |

- Summed: input 205.7k, 154.2k, 128.3k; output 5,001, 3,804, 3,216; the gateway's cost $0.314, $0.252, $0.214 (-32% from 0.2.0). Every run finished its task.
- With bare names DeepSeek loaded the lean-ctx tools through ToolSearch and then called them directly in 2 of 9 runs, a refused call and a wasted round trip each (0.2.0 never named them, and Sonnet never did it). The script form cut that to 1 of 9. Sonnet with the script form: input 107.8k against 126.1k with bare names, cost $0.106 against $0.111, also 1 run of 9 with one refused direct call.

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
- `describeTool` knows built-in types from generated files (engines up to 2.1.309), from bad-arguments errors, and from its store. It has no source for MCP schemas other than ToolSearch.
- At most 10 pictures are attached to one output; `ask` has no tools and no history.
- `claude plugin test` in each mod folder runs the unit tests, which replace the runner with a fake one. Everything else was checked with live headless `claude -p` runs.
