# codemode for Claude Code

Two Claude Code mods that give Claude a version of Pi's codemode in "only" mode. Claude gets one tool that does work, `mcp__codemode__run`. It takes a JavaScript script, and that script calls every other tool (Read, Bash, Agent, AskUserQuestion, Skill, every MCP tool). Only what the script returns or prints reaches Claude, so three reads become one script with `Promise.all`, one round trip, and the script can trim the results before Claude sees them.

If Claude calls any other tool directly, the call is refused with:

> Direct tool calls are disabled. Call X from a script with mcp__codemode__run: return await tools.X({...})

**The one exception is ToolSearch.** Claude can still call it directly to load a tool's schema. The call itself still goes through a script. For built-in tools a script's `describeTool(name)` gives the arguments as one TypeScript type for a fraction of the tokens once it knows them; for MCP tools ToolSearch is the only source of a schema. ToolSearch's description carries one extra sentence: a tool it loads is still called from a script, never directly.

| Folder | What it is |
|---|---|
| `codemode/` | The main mod: the script tool, the gate that refuses direct calls, and the script runner (`hooks/register.tsx`) |
| `codemode-agents/` | A small helper mod that starts subagents for scripts (`hooks/register.tsx`) |

Built and checked on Claude Code 2.1.325 with Node 26. It needs `node` 25 or later on `PATH`: the script runner is a Node child process, and older Node versions do not block network access under `--permission`.

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
| `tools.<Name>(args)` | Calls a tool. Resolves to the text the tool would have shown Claude, and throws if the call is denied or fails. Characters that are not valid in a JavaScript name become `_`, so `mcp__lean-ctx__ctx_read` is written `tools.mcp__lean_ctx__ctx_read`; a suffix that only one tool's name ends in works too (`tools.ctx_read`), since tool names differ between machines |
| `call(name, args)` | The same as `tools.<Name>`, but it never throws. Resolves to `{ ok, text, result, error }`, plus `resultDropped: true` when the structured result was too big to pass beside the text, and `exitCode` for a shell tool (Bash, or a tool whose name ends in `shell`). `String(r)` and `${r}` give its text (the error when it failed), never `[object Object]` |
| `sh(cmd, args?)` | Runs a command on the session's shell: `CODEMODE_SHELL` when set, else Bash, else lean-ctx's `ctx_shell` (a tool that merely ends in `shell`, a remote host's say, is never picked). Resolves to the output as a string with `.exitCode`, `.ok` and `.tool`; a non-zero exit does not throw, and a command that ran is never run a second time. A command a hook refuses is thrown, never run again on another tool; when the refusal is lean-ctx's block of the whole of Bash, which names its replacement, later `sh()` calls go to that shell. A command over 7,000 bytes on lean-ctx's shell (which takes at most 8,192) is refused, saying how to run it: with `{ stage: true }` it is written whole through `write()` into a new private folder in `/tmp`, run from there and removed, and the shell tool's hooks then see only `bash <file>` (the write tool's hooks see the command). It starts no background job, since it could not wait for one, and drops a default argument that asks for one (`CODEMODE_TOOL_DEFAULTS`); `run_in_background: false` is fine. A command Bash moves to the background before it finishes (its timeout ran out) fails with the task id instead of passing as exit 0. A command lean-ctx's shell detaches into a background job (it does past about 110 seconds) is waited for: `sh()` polls the job until it ends, within the run's time, and gives its real exit code and output, fetched through lean-ctx's `ctx_expand` page by page whether the job passed or failed, deciding from the archive's own line and character counts whether a page was cut (or from its archive file through Read where there is no `ctx_expand` or a line is too long to page; a long output is paged through `ctx_expand` to its end, so lean-ctx's policy answers for every page, and a run out of time fails naming the archive; a line too long even for Read comes back in 21 KB base64 byte ranges through the same shell, each checked against the file's `wc -c` size and decoded as strict UTF-8, so a short range or bytes that are not UTF-8 fail instead of passing; a refused `ctx_expand` is never routed around, though a whole short output the job's own failure reply already gave is kept); `.truncated` is set when lean-ctx cut the archive, an output lean-ctx withheld by its policy (as a reply or an error, on the first page or a later one, or in the foreground) comes back as lean-ctx's notice with `.withheld` and `.truncated` set and is never read around, a completed job that names no exit code does not pass, and an output that cannot be fetched fails naming the archive instead of passing as empty. A failed command's output over 10,000 chars is cut in the middle by Claude Code itself (it keeps the first and last 5,000 chars); `sh()` marks such a result `.truncated` and the run ends with a note, and a failed background job's output is fetched whole through `ctx_expand` instead. A foreground lean-ctx output over lean-ctx's own cap (about 32K tokens, which it cuts and archives, naming the archive in its last line) is fetched whole from that archive; a failed one loses its exit code in lean-ctx's cut but keeps it at the end of the archive (`\n[exit:N]`), so it comes back whole with its real exit code and without that marker (a failed background job's archive likewise). lean-ctx's own advice line after an output (`[ctx_shell: …]`) is left out. Any MCP tool's result Claude Code saved to a file instead of returning it (over its 25K-token limit, under any format label) is read back through Read, or for lean-ctx's shell in byte ranges when one line is over Read's cap, and kept only when its size matches the notice; a Bash `<persisted-output>` with a line over Read's cap is read back in byte ranges through Bash, kept only when every range and the total match the file's size; otherwise the notice stays and the run ends with a note. Only lean-ctx's own job reply counts (`shell_` and 16 hex digits), so a command that prints JSON shaped like a job is left alone. On lean-ctx's shell it passes `raw: true` unless the script sets `raw`, since the script, not the model, reads the text, and a `timeout_ms` of the run's remaining time (lean-ctx otherwise ends a command at 120 seconds), both only where neither the script nor `CODEMODE_TOOL_DEFAULTS` sets them, and a staged command's folder is removed even when the shell refuses to run it. An output Bash saved to a file instead of returning it (`<persisted-output>`, with a 2 KB preview) comes back whole: only when the whole answer is that block, the file is in a `tool-results` folder under Claude Code's `projects` (`CLAUDE_CONFIG_DIR` respected), it is read back through Read (so Read's rules and hooks apply) and it starts with the preview Bash showed; otherwise the block stays and a note says so. Read drops `\r`, so CRLF output comes back with `\n` |
| `quote(s)` | Makes any value one single-quoted shell word |
| `read(path)` | A file's whole text without Read's line numbers, exactly (Read shows a final newline as one last empty line), read in pages of 2,000 lines, halved while a page is over the model's limit. A page that comes back as lean-ctx's repeated-read stub is asked for again as another range. A Read answer with no file lines (a picture, a binary file, a hook's rewrite) is an error, never an empty string; only Read's own notices for an empty file and for an offset past the end count as no lines. Lines Read itself shortens stay shortened, and line endings come back as `\n`, since Read drops a file's `\r` |
| `write(path, text, { force }?)`, `edit(path, old, new, { all, force }?)` | Write a file, or replace one exact text in it (every occurrence with `{ all: true }`), through Write and Edit, or lean-ctx's patch tool (`ctx_patch`: `create`, then `replace_unique` of the whole text, or `replace_all`); no other patch tool is ever used. Paths must be absolute. The read-before-write check holds on both paths and the mod keeps it itself, since Claude Code 2.1.325 does not check a script's Write and Edit: a file counts as read once this session's scripts have read all of it and the text reached the script, or wrote or edited it (`read()`, or a `tools.Read` with no `offset` or `limit`, or pages read in order from line 1 to the end); a stub, a notice, a part of the file or a reply too big to deliver does not count. Changing one not yet read takes `{ force: true }`, which reads it first, in the open; neither ever reads for itself. A text not found in a file says that `read()` gives CRLF line endings back as `\n` |
| `waitFor(check, { every, timeout })`, `deadline()` | Calls `check` every `every` ms (1,000 by default) until it returns something truthy, and returns that, or throws at `timeout` (by default a second before the run's own); a check still running at the timeout does not hold the wait up. A result with `ok: false` (a failed `sh()` or `call()`) counts as not yet, so `waitFor(() => sh("test -f /tmp/ready"))` works. `deadline()` is the ms left before the run times out. One bounded wait inside the script instead of a shell `sleep` loop |
| `TEXT.<NAME>` | The raw text of a `// @text NAME` block (below); a name with no block throws and lists the blocks there are |
| `btoa`, `atob`, `TextEncoder`, `TextDecoder`, `Buffer` | As in Node |
| `text(v)`, `return v` | Add an item to the output. A plain object or array holding multi-line strings prints each top-level entry under a `== key ==` heading with the text raw, instead of JSON full of `\n` and `\"` escapes; anything else prints as JSON (`return JSON.stringify(v)` for exact JSON) |
| `console.log/info/warn/error` | Add lines to a `<console_output>` block at the end |
| `ALL_TOOLS`, `searchTools(q, {limit})` | List or search the tools a script can call. Each description is cut to its first sentence (120 characters at most); the search still ranks on the whole description, and `describeTool` returns all of it |
| `describeTool(name)` | Returns `{ name, description, input }`, where `input` is the tool's arguments as a TypeScript type when known (see "Arguments" below). For a name the session does not have, `input` says so and names up to three similar tools |
| `ask(prompt, { model, system, maxTokens, effort })` | One completion with no tools through the session's own API client, by `haiku` unless `model` names another; resolves to the reply's text. For boiling large data down inside the script, so only the answer reaches Claude |
| Image and PDF markers | An image or PDF in a tool's result reaches the script as a marker such as `[image #1 image/png 12KB]`. A marker that appears in the output brings the picture with it, and Claude sees it |
| `store(k, v)` / `load(k)` | Keep small JSON values from one script run to the next (kept in the mod's store) |
| `jobs()`, `cancel(id)` | `jobs()` lists the caller's other runs still going, `[{ id, state, seconds }]`, `state` being `running`, or `finishing` once its runner has exited and its output is being put together; `cancel(id)` kills a running one by its runner's pid (or keeps one that has not started its runner from starting) and resolves `true`, its output coming back as `Script stopped after … [cancelled]` with what it printed first and the tool calls still running then, which may still finish; it resolves `false` for a run already finishing or finished, its output back or not. A run cannot cancel itself (`exit()` ends it), nor a run of another agent |
| `exit()` | Stop the script early, counted as a success |

An optional first line sets limits: `// @options: {"timeout_ms": 600000, "max_output_chars": 20000}`. Both values shown are the defaults; `timeout_ms` is held between 1 second and 1 hour, `max_output_chars` between 1,000 and 1,000,000. Only the first non-blank line counts, so a script can carry that text inside a string.

Text that holds `${`, backticks or `#` (a shell script, Python, HTML) goes in a raw block, not a template literal, where `${` starts an expression and a backtick ends the string (the cause of about 470 failed runs in one week):

```js
// @text deploy
set -e
TAG=${1:-latest}; echo "deploying ${TAG}"   # bash, untouched
// @end
return await sh(TEXT.deploy)
```

The block's lines never reach the JS parser, and they are left blank in the script, so line numbers in errors stay those the model wrote. A directive is only seen outside strings, template literals, comments and regex literals, so a string that quotes `// @text` keeps it. A block ends at its first `// @end` (or `// @end NAME`); a `// @@end` line inside it stands for a plain `// @end` line of text. A block with no end, or a name used twice, fails at once.

`CODEMODE_TOOL_DEFAULTS`, a JSON object in the environment (`env` in `~/.claude/settings.json`), gives tools default arguments that a script's own arguments override, for example `{"mcp__lean-ctx__ctx_shell": {"raw": true}}` so scripts get lean-ctx's full output rather than a compressed stub. A run whose tool returned such a stub (`[Firewalled …`) says so at the end, with this way out.

Output longer than `max_output_chars` is cut part by part, within the cap: the notes and the failure at the end are kept first; every output item, and every key of a big returned object (one line each, or under its `== key ==` heading), is a part, grouped into one group per 400 characters of room (40 at most). The small ones stay whole and the big ones share what is left, each keeping its head and tail on line ends and up to 8 lines from the cut middle that look like errors, all counted against the cap, and a last hard cut holds it. The whole output is written to `~/.claude/codemode/out/<run>.txt`, and every cut carries a ready call for the lines it removed, `tools.Read({ file_path: "…", offset: 73, limit: 166 })`, so the next run reads back only that part. Files under a day old are kept, at most 200: every session shares the folder, so a plain count would let busy parallel sessions delete a file another session's cut still points to.

Scripts are not handed `fetch`, timers, `process`, `require` or `import` (`waitFor` and `deadline` cover waiting). The `vm` context is not a security boundary, though: a script can reach the runner's `process` through any function it is given. The real boundary is Node's permission model, which leaves the runner no network, no subprocesses, no workers, and file access only to its own run folder. The runner also clears its environment variables before the script starts.

## Every run goes to the background

No run blocks Claude, however short. `mcp__codemode__run` answers at once with the run's id, `Started r3 in the background.`, naming the runs still going (`Still running: r1 (12.4s), r2 (0.3s).`), and Claude goes on with other work, which can be more runs, while the script runs. A run's output always reaches Claude as a tool result, never as a prompt, so text a script fetched keeps a tool result's standing:

- **With the next run's reply.** A run that finished by the time Claude starts another comes back under that reply, after a header line `[r1 finished after 2.1s]` (`[r1 stopped after …]` for a cancelled or interrupted one, `, 2 attachments` added when it brings pictures), with its images and PDFs attached in run order. One reply holds as many finished runs as fit in 20,000 characters and 10 pictures (always at least one run); the rest are named, `r5 finished too; its output comes with the reply to your next run.`
- **An empty script** runs nothing and answers with the finished output waiting, or `No run has finished output waiting.`
- **A notice when the turn ends.** Where nobody is watching (`claude -p`, the SDK) and in every subagent, a `Stop` hook (`SubagentStop` for a subagent, which waits only for its own runs) waits for the caller's runs still going, then blocks the stop with a notice, `Background run r1 finished. Call mcp__codemode__run with an empty script to read the output.` The wait watches the runners' pids from one `$.process.run` at a time (so it costs the hook none of its 10 seconds), ends within 0.2 s of the last runner, leaves no process behind, gives up after three failed waits in a row, and ends early when the session interrupts the hook, naming nothing then, so the output waits for the next reply. This also keeps a headless session, which exits when its turn ends, from losing a run.
- **A wake prompt, where a person is watching** (a terminal, the desktop app). Ending the turn does not wait, and a run that finishes afterwards is named in the same notice through `$.prompt.submit`, which starts a turn of its own, as Claude Code's own background tasks do. A notice the engine refuses is tried again at the next turn's end, and the output waits for the next reply. The engine shows a blocked stop as a "stop hook problem", which is why a watched session is never held.

A turn's end only counts for the turn that is running (by its `turnId`), so a late end of an older turn cannot mark a newer one idle. Interrupting the turn (Esc) stops its runs: they come back marked `[aborted]` with the next run's reply, and wake nothing. A subagent's runs still going when its turn ends are stopped and dropped. A new session (`/clear`, `/resume`) stops the runs of the one before and never sees their output. Syntax errors in `// @options` or a `// @text` block are still answered at once, since no run starts. A file a run read counts as read for other runs only once that run's output is back (a stopped run's reads never count); within the run it counts at once.
## How it works

1. **Hiding the other tools, and describing the rest.** A `tool.describe` hook marks every tool except `mcp__codemode__run` and ToolSearch as deferred, so Claude's prompt only carries the full definitions of those two. The same hook ends every deferred tool's description with one line in script form, `Under codemode, call this only inside a mcp__codemode__run script: await tools.<name>({...}). A direct call is refused.`, so the schema ToolSearch loads says how to call the tool at the moment the model reads it (GLM 5.3 read ToolSearch's own note, loaded a tool and still called it directly). A deferred description stays out of the prompt until its tool is loaded, so the line costs nothing before then and about 30 tokens per loaded tool after. The run tool's description is built once, when the session starts, from `$.tool.list()` (an MCP server that connects later is not seen, so a missing built-in may be named without its replacement): its argument lines name only the built-in tools the session has, and built-ins a model reaches for by habit (Bash, Edit, Write, Grep, Glob) are named as missing, with the session's likeliest replacement, in the form a script calls it, for example `Bash (use tools.mcp__lean_ctx__ctx_shell)` (named bare, DeepSeek would load it with ToolSearch and then call it directly, which is refused). It also asks for a whole step per script: every call that can already be named at once, and the steps that need no judgment in between chained inside the script, because each run is a round trip that re-sends the whole conversation.
2. **Refusing direct calls.** A `tool.call` hook looks at `next.origin.plugin`. A call that comes from `engine` (Claude itself) or from `codemode-agents` (a subagent) is refused, unless it is ToolSearch or the spawn in step 5. A script's calls never reach this check, because a mod's own calls skip its own hook. Calls made by other mods pass through.
3. **Running the script.** The mod runtime forbids `eval` and `new Function`, so the mod starts `node --permission --allow-fs-read=<run dir> --allow-fs-write=<run dir> -e <runner>` and passes the script and tool list on stdin. The runner reports its pid, then executes the script in a separate Node `vm` context. For each tool call the runner prints one JSON line with a `\x1eCM` prefix; the mod accepts only positive integer ids and known request kinds, makes the real `$.tool.call`, and writes the result to `<run dir>/<id>.json`, which the runner polls for. Keys `$.tool.call` reads beside a tool's arguments (`consent`, `requestMeta`, `tool_use_id`, `agentId`) are dropped, so a script cannot claim the user approved a call. Your own hooks and permission rules still apply to every one of these calls. A script that never yields (`while (true) {}`) blocks the runner's own timer, so the mod kills the runner by pid 5 seconds after the timeout.
4. **Skills.** The Skill tool's own result is only `Launching skill: <name>`; Claude Code sends the skill's text to the model as a separate message, which a script never sees. The mod keeps the text expanded at `skill.prompt`, numbered, and appends it to every Skill call that started before that expansion, so `tools.Skill({ skill })` returns the whole skill even when several Skill calls run at once (before, the second of two parallel calls got only `Launching skill: <name>`), and never a text an earlier call expanded. Calls to the same skill take turns, so each gets the text expanded for its own `args`; different skills still run in parallel. A call that has waited 60 seconds for an earlier one fails with a message saying so, rather than share that call's turn.
5. **Subagents.** A plugin cannot call the Agent tool; Claude Code says to use `$.agent.spawn` instead. Claude Code also skips a plugin's hooks for every subagent started inside that plugin's chain of calls, even through another plugin's tool. So `tools.Agent(...)` (or the old name `tools.Task(...)`) is forwarded to `mcp__codemode-agents__spawn`, which queues the request; a loop started in `codemode-agents`' `session.start` does the real `$.agent.spawn` outside codemode's chain, and its `turn.complete` hook collects the answer. Subagents therefore get `mcp__codemode__run` and are held to scripts like the main session. The spawn tool refuses any caller but codemode, refuses `isolation` and `effort` (which `$.agent.spawn` cannot express) instead of dropping them, waits at most an hour for a started subagent's answer, and reports a subagent that ended with an error, refusal or abort as a failed call. `Workflow` is refused from scripts, because its agents would start inside codemode's chain and skip its hooks.
6. **Pictures.** A tool's image or PDF never reaches the script as base64. The mod swaps each one (an API image block, an MCP image block, Read's image, PDF or page images) for a marker and keeps the bytes. When the run ends, every picture whose marker is in the output is attached to the result as an image or document block, at most 10, so Claude sees exactly the pictures the script chose to show.
7. **Arguments.** Claude Code 2.1.309 and older wrote input types for mods into `.claude-plugin/types/` (`claude-code-tools` for the built-in tools, `claude-code-mcp` for the MCP servers then connected); 2.1.318 writes none in headless, `plugin test`, `plugin validate` or T3 sessions, and `$.tool.list()` gives only names and descriptions. So the live source is the engine's answer to bad arguments: advice to load the tool through ToolSearch followed by its whole JSON schema. The mod keeps the engine's first lines, replaces the rest with one line, `<tool> takes { ... }`, and keeps that type in memory and in its store under the engine version, so later sessions on the same version know it too. Only a built-in's error carries its schema (an MCP server writes its own errors), so only built-ins are learned, and only from an error that starts the way the engine's own does (`InputValidationError: <tool> failed due to the following issue`), so a failing command that prints the same advice cannot plant a type. No engine version known, nothing is stored. `describeTool` prefers a type learned in this process, then a generated file, then a stored type; an unknown built-in gets "a call with wrong arguments answers with its type", an unknown MCP tool gets "call ToolSearch directly".
8. **Output.** A run that works returns its output and nothing else. The runner sends what a script prints (`text()`, its return value, console lines) to the mod as it is made, so a run the session stops, or one that times out or is killed, still returns everything printed before that. A failed one ends with `Script failed after <ms>ms [<kind>]: <error>`, the kind being `syntax`, `tool` (a tool call threw), `timeout`, `script` or `runner`; a run the session stopped ends with `Script stopped after <ms>ms [aborted]` instead of a crash. Its stack is trimmed to the script's own frames, with line numbers that match the script. A syntax error shows the failing line with two lines around it, and names the usual cause: shell, Python or HTML in a template literal, a `#` comment, an `import`. A missing global (`fetch`, `require`, `process`, timers, `ToolSearch`) says what to use instead, and `JSON.parse` of text that is not JSON shows what the text started with. When the run made tool calls, one more line names them, `Tool calls before the failure: Bash 2 ok; Read 1 failed ("/repo/missing.txt")`, with the failed call's command or path, and calls still running marked `may still finish`, because those side effects stand and the next run should not repeat them blind; a run that failed on its own waits up to 1.5 s for its last calls to settle first. When a tool call threw after others had worked, the run says how many, and that `call()` or `Promise.allSettled` keeps their results. A timeout names the calls still running, abandoned rather than stopped, with how long each had run and its command. Running the exact script that just failed again is told so. A call to a tool the session does not have fails with up to three similar names.
9. **Files and hooks.** A relative path in Read starts at the session's starting folder (`write()` and `edit()` refuse relative paths, since that folder can move). A Read of a missing file names up to three close names in its folder, only inside the session folder and only files a one-line Read may open (never a folder). A Read of a file over the model's limit, made with no `limit`, is read in pages and handed to the script whole, since the script, not the model, takes the text: Claude Code 2.1.325 cuts such a read at its token cap and says so only in the structured result (`file.truncatedByTokenCap`), where older versions answered with an error, and a whole read answered with lean-ctx's repeated-read stub is read in pages too; a page that is refused or is not file lines fails the whole read, and a result too big to pass (over 3.8 million characters) fails and says so, never handed over cut and never counted as read. A refusal is only the engine's own: a permission denial, or an error that starts `PreToolUse:<tool> hook` with no exit code; a command whose output says "denied" is no refusal. A refused call is never repeated on another tool. Only a refusal of a whole tool in lean-ctx's form, `PreToolUse:Bash hook error: [DENIED] Native Shell blocked. Use: ctx_shell(...)`, naming a replacement that does the same job (a lean-ctx shell for Bash, its patch tool for Write and Edit), is remembered: the error says so in script form, later `sh()`, `write()` and `edit()` calls (and calls after a `call()` that saw it) use that tool, and the mod's store keeps the denial for a day (lean-ctx's block is a setting of the machine, so in every project), so the next session names the tool as denied, where it has the replacement. A tool that works again is forgotten. Any other refusal, such as a hook that blocks one command, is a plain failure. What a script read, and which scripts failed, belong to one session.

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

### GLM 5.3

The same tasks and setup with `--model glm-5.3[1m]` through the same gateway, three runs per cell. "Input" is uncached input plus cache reads. The middle column is 0.3.0 with the script-form hints above, the last adds the script-form line to every deferred tool's description.

| Task | 0.2.0 | 0.3.0 | 0.3.0, loaded schemas in script form |
| --- | --- | --- | --- |
| Find `clip` and `format` and explain how a long output reaches the model | 192.2k input, 13.7 calls, 2.3 failed | 94.4k, 9.0, 0.0 | 86.3k, 9.7, 0.0 |
| Report the last commit, README's line count and the TypeScript files | 47.7k, 7.0, 2.3 | 50.0k, 6.3, 0.0 | 24.3k, 4.0, 0.7 |
| Change one constant and show the changed line | 54.4k, 8.7, 1.3 | 31.1k, 5.0, 0.3 | 30.6k, 4.7, 0.0 |

- Summed: input 294.3k, 175.5k, 141.2k; output 5,645, 3,588, 4,122; the gateway's cost $0.318, $0.215, $0.220 (-31% from 0.2.0). Every run finished its task.
- GLM loads tools through ToolSearch more than the others do, and then called the loaded tool directly: 8 refused direct calls in 9 runs with 0.2.0, 9 with 0.3.0, 2 with the line. ToolSearch calls fell from 21 to 8. The saving is in cache reads; uncached input (28.3k, 28.8k) and the cost stayed flat.
- Sonnet and DeepSeek with the line, run at the same time as 0.3.0 (sessions where lean-ctx failed to start left out): Sonnet 127.2k input and $0.104 against 114.7k and $0.096, DeepSeek 149.0k and $0.258 against 149.0k and $0.254. No refused direct calls with the line, 2 for DeepSeek without it. The request after a load grows by about 30 tokens per loaded tool; the rest of the spread is run-to-run noise (one Sonnet run searched "edit file" and loaded several schemas at once).
- 18 GLM runs at once hit the provider's rate limit (429) in 4 runs, which were rerun two at a time. 36 runs at once left lean-ctx unconnected in 5 sessions.

## Gotchas

- No `eval` and no `setTimeout` in the mod runtime. Use `$.clock.after` for timers.
- The mod loader rejects code that stores or passes `$`. Write `$.noun.event(...)` where it is called.
- Hooks get 10 seconds of their own time. Waiting on a `$` call does not count against it, but waiting on a plain promise does, so the spawn tool waits by looping on `$.process.run(['sleep','0.3'])`.
- `next.origin` is the only way to tell Claude's calls from a plugin's. Calls raised by an Agent spawn carry the spawning plugin's origin and no `agentId`.
- lean-ctx names a background job after its command text, so the same command started twice while one copy is still running (two identical long `sh()` calls at once, or a rerun while an abandoned run's copy goes on) joins one job and both get one output. Make such commands differ (a `# 1` / `# 2` suffix) when they must run apart.
- Your own permission rules and hooks still apply inside scripts. If something denies native Bash, Edit or Write (lean-ctx replace mode does), scripts have to use the replacement tools you allow instead (for lean-ctx, `ctx_patch` and `ctx_shell`).

## Known limits

- AskUserQuestion and permission dialogs from inside a script were never tried (headless runs have no dialogs).
- Claude Code 2.1.325 does not check that a script read a file before its Write or Edit, so the mod checks every one a script makes, `tools.Write` and `call("Edit")` included: an existing file this session has not wholly read, written or edited is refused (`write()` and `edit()` take `{ force: true }` to read it first). The path is checked as Claude Code will use it (trimmed, `~` expanded), and a relative path is refused, since a shell `cd` can move where it lands. A file changed on disk since it was read (its modification time or size) is refused by the mod on every path; `{ force: true }` reads it again.
- Direct calls to lean-ctx's patch tool pass as they are: its `replace_unique` is a no-read edit by design (the exact old text has to match), so only `write()` and `edit()` hold it to the read check, and such an edit never counts as reading the file: any patch op or batch on a file the session read keeps it counted only when the file was unchanged since the read.
- What the session read is forgotten when the main conversation is compacted, as Claude Code forgets it, so a script reads again before it writes; a subagent's compaction, a precompute pass or a compaction a hook skipped keeps it. A file counts as read only at the version it was read at (its modification time and size): pages read across a change do not add up, a whole Read paged by the mod fails if the file changes meanwhile, and a lean-ctx patch of a read file changed outside since stops counting it as read.
- What the session read, its starting folder and the tools it found denied are kept once per Claude Code process, which runs one session at a time: a new session (`/clear`, `/resume`) starts them over, and subagents share the main session's, as they share Claude Code's own record of read files.
- If codemode's own hook fails, the run tool answers with a `[runner]` failure, and a direct tool call it could not check is refused rather than let through.
- `run_in_background` subagents are not tested. A subagent starting its own subagent from a script is expected to fail: the helper mod's hooks are skipped inside its own subagents.
- A subagent's script calls run in the main session's loop, so an agent type's `tools` or `disallowedTools` list is not applied inside its scripts.
- A `context: fork` skill run through `tools.Skill` starts its agent inside codemode's chain, so that agent is not held to scripts.
- An escaped script can still signal processes owned by the same user; the permission model does not cover signals.
- When a script times out its unfinished tool calls are abandoned; the mod cannot stop them.
- `sh(cmd, { stage: true })` runs a long command from a file, so a shell hook that filters commands sees only `bash <file>`; the write tool's hooks see the whole command. It is off unless a script asks for it, and with lean-ctx's patch tool as the only writer it fails cleanly, since lean-ctx keeps writes inside the project and the private folder is in `/tmp`.
- `read()` cannot keep CRLF line endings: Read drops the `\r`, so `write()` of a text taken from `read()` turns such a file into LF.
- A result over the 4 MiB the mod can pass keeps its text and drops its structured `result`, and `call()` then says `resultDropped: true`.
- A cut through a line longer than 50,000 characters names a byte range of the spill file to read back with `sh()`, since Read cannot return a line that long.
- `describeTool` knows built-in types from generated files (engines up to 2.1.309), from bad-arguments errors, and from its store. It has no source for MCP schemas other than ToolSearch.
- At most 10 pictures are attached to one output; `ask` has no tools and no history.
- A run's output that is waiting to come back lives in the Claude Code process: quitting Claude Code while a run is going loses its output.
- Two runs that change the same files at once are not ordered for each other; start the second once the first's output is back.
- `SubagentStop` is matched to a subagent's runs by its `agent_id`; one without it holds nothing.
- `npm ci && npx e2e run` in `e2e/` runs the end-to-end suite: the mod's real source under Node with a stand-in for Claude Code's `$`, a real runner child, real files and real shell commands (`e2e/harness/harness.mts`). `claude plugin test` in each mod folder runs the older unit tests, which replace the runner with a fake one. Everything else was checked with live headless `claude -p` runs.
