# codemode: one week of real use (9 to 16 November 2026)

Every Claude Code session on Shad's Mac and the five linked T3 servers (yarnball02, fm-fsn-02-registry, mmd-fsn-05-staging, fm-hel-02-dev, fm-fsn-04-ci), read from ~/.claude/projects/**/*.jsonl.

## The numbers

| What | Count |
| --- | --- |
| Sessions using codemode | 943 |
| codemode runs | 52,228 |
| Models | Opus 5.5 36,656; GPT-6.1 Sol 2,978; GPT-6 Luna 2,110; GLM 5.3 (3 builds) 2,228; Gemini 4 Hydrogen/Carbon/Argon 4,719; Sonnet 5.5 943; DeepSeek Flash 893; Fable 626; Muse Wonder Full 475; others |
| Runs that ended in "Script failed" | 1,688 (3.2%) |
| Failed runs followed by a near-identical retry | 809 |
| Outputs cut at max_output_chars | 2,912 (5.6%); 338 later runs read the spill file back |
| Direct ToolSearch calls (schema loads) | 1,807 |
| Direct calls refused | 20 (the script-form hints work) |
| Runs over 5 minutes | 802 |
| Scripts whose shell commands sleep in a loop | 4,336 |
| Tool results that were lean-ctx "Firewalled" stubs inside scripts | 1,050 |
| "[object Object]" printed (String() of a call() result) | 157 |

## Where runs failed

| Cause | Runs | Example |
| --- | --- | --- |
| JS syntax errors from shell, Python, HTML pasted into template literals | ~470 | "Missing } in template expression" (a bash ${3:-}), "Invalid or unexpected token" (a backtick in Python), "Private field '#v'" (a # comment), "Unexpected string/identifier" |
| Missing globals | 106 | btoa 43, Buffer 23, TextEncoder 15, ToolSearch 18 (await ToolSearch), setTimeout 7 |
| Tool errors thrown through tools.X | ~1,000 | ctx_shell non-zero exit / bash quoting 498, ctx_patch 177, Read 123, Bash denied by a hook 122 |
| Read too big for the model's limit, inside a script | 44 | "File content (136597 tokens) exceeds maximum allowed tokens (25000)" |
| ctx_shell "Command too large (13049 bytes, limit 8192)" when writing a file | 47 | |
| "script runner exited without a result" / "$.process.spawn(node) aborted" | 67 | Everything the script had already printed is lost |
| JSON.parse of text that was not JSON | ~40 | "[Firewalled ctx_shell output…", "Error: …", "<persisted-output>" |
| Timeouts | 13 | partial output lost |
| MCP bad arguments with no type to fix them | ~10 | "Invalid parameters for tool 't3_thread_launch': Expected string" |
| Read of a relative or missing path | 108 | "File does not exist. Note: your current working directory is …" |

While writing this very file, the first attempt failed with "Missing } in template expression": the table above quotes a bash ${3:-}.

## Pain points that are not failures

- 22,725 shell calls: almost every script defines the same const sh = (c) => tools.mcp__lean_ctx__ctx_shell({command:c}) helper, and tool names differ by machine (mcp__lean_ctx__ctx_shell, mcp__lean_ctx__shell).
- Scripts strip Read's "   12<tab>" line numbers by hand before writing a file back.
- Waiting is done with shell sleep loops inside long runs, many minutes each.
- 1,807 ToolSearch round trips to load MCP schemas that never get remembered.

## 200 ideas

### A. Writing scripts (syntax errors)
1. Raw text blocks: lines between "// @text NAME" and "// @end" become TEXT.NAME, a raw string never parsed as JS, so shell, Python and HTML need no escaping.
2. A SyntaxError inside a template literal that holds "${" says so and points at @text blocks or \${.
3. Syntax errors show the failing line with two lines of context on each side.
4. A "Private field '#x'" error explains that a shell or Python # comment ended up in JS code.
5. An import or require statement gets a hint that lists the globals scripts do have.
6. A script that is plainly shell (first token a command) gets a hint to wrap it in the shell tool.
7. Markdown fences around a script are stripped.
8. Odd backtick counts and unbalanced braces are named in the syntax error.
9. "Unexpected identifier" on a line of prose says the model wrote English into code.
10. // @options may sit anywhere in the leading comment block.
11. @options accepts unquoted keys ({timeout_ms: 300000}).
12. Unknown @options keys are reported (timeout instead of timeout_ms).
13. An sh tagged template that shell-quotes every interpolation.
14. A quote(s) global that single-quotes a value for the shell.
15. heredoc(text) builds a cat <<'EOF_x' block with a delimiter the text cannot contain.
16. dedent(text) for indented template blocks.
17. A script that is a bare expression with no return returns that value.
18. Accept "export default async function" scripts.
19. Line numbers in errors stay right when @text blocks are removed.
20. A syntax error costs no runner spawn: parse in the mod first.

### B. Missing globals
21. btoa and atob.
22. TextEncoder and TextDecoder.
23. A small Buffer: from(string|bytes, utf8|base64|hex) and toString(enc).
24. sleep(ms), held to the run's deadline.
25. setTimeout and clearTimeout tied to the run.
26. A ToolSearch global that calls tools.ToolSearch.
27. crypto.randomUUID and getRandomValues.
28. sha256(text) hex digest.
29. URL and URLSearchParams.
30. structuredClone.
31. A ReferenceError for a known-missing global names the replacement.
32. A ReferenceError close to a tool's name ("ctx__ctx_shell") suggests tools.<that tool>.
33. path helpers: join, dirname, basename.
34. json(text): finds and parses the first JSON value in noisy text.
35. lines(text) and grep(text, re) helpers.
36. performance.now().

### C. Tool results
37. A call() result's toString() is its text, so String(r) and template interpolation stop printing [object Object].
38. Promises inside a returned value are awaited before printing.
39. A Promise that reaches the output prints "[Promise: not awaited]" instead of {}.
40. Calls started but never awaited are named when the run ends.
41. tools.X.json(args) returns the parsed JSON result.
42. A shell result's exit code is exposed as r.exitCode.
43. ANSI colour codes are stripped from tool text.
44. call() results carry ms, the call's duration.
45. MCP structuredContent becomes result.
46. tools.X.raw(args) returns the full result object.
47. A result over 1 MB says how big it was.
48. Error objects print with message and stack instead of {}.
49. Map and Set print their entries.
50. Circular references print [Circular] instead of failing.
51. Uint8Array prints its length and a hex head.
52. BigInt prints as a number string.

### D. Failures and recovery
53. Partial output survives: the runner streams text(), returns and console lines to the mod as they happen, so an abort, kill or timeout returns what was gathered.
54. An aborted run says it was stopped (interrupted or cancelled) instead of "runner exited without a result".
55. A timeout names the calls still running and how long each had run.
56. Read inside a script pages a file that is over the model's token or size limit and hands the whole text to the script.
57. A hook-denied tool (Bash) is remembered: the next calls get the replacement in script form at once, and the next session's description names it as unavailable.
58. A JSON.parse failure names the first 60 characters of the text it was given.
59. Re-running the exact script that just failed is flagged with the earlier error.
60. The failure ledger shows the failed call's first argument (the command or path).
61. Promise.all that rejects says how many sibling calls succeeded and that their results are lost (use call() or allSettled).
62. Transient MCP errors (Connection closed, 429, 503) are retried once.
63. Failures carry a kind: [syntax], [tool], [timeout], [aborted], [script].
64. "File does not exist" suggests near-miss paths from the parent folder.
65. Relative paths in Read are resolved against the session cwd.
66. The stack line shows the script line's own text.
67. A thrown string or object prints readably.
68. A rate-limit error names the reset time when the tool gave one.
69. MCP bad-arguments errors append the tool's type when known.
70. "no tool named X" also tries the name with dashes and underscores swapped and suffix matches.

### E. Output and cuts
71. Each output item is cut on its own, in proportion, instead of one cut through the middle of everything.
72. Lines that look like errors in the cut middle are kept.
73. The cut note carries a ready Read call with offset and limit.
74. Spill files are 0600.
75. text(value, { max }) caps one item.
76. Object output gives each key a fair share of the budget.
77. Runs of identical lines collapse to "… N identical lines".
78. JSON output uses one-space indent.
79. Arrays of flat objects print as one JSON line each.
80. Trailing whitespace is trimmed.
81. "(no output)" explains why and lists the calls that ran.
82. Long base64 strings in output are replaced with a size marker.
83. table(rows) prints aligned columns.
84. Home paths in output shortened to ~.
85. Cut sizes per item are listed.
86. When output nears the cap, a note says how much was dropped from each item.

### F. Waiting and long runs
87. waitFor(check, { every, timeout }): one bounded poll inside the script, no shell sleep.
88. deadline(): ms left before the run times out.
89. Long successful runs (over a minute) end with how long they took.
90. A run that spent most of its time sleeping gets a hint about background waits.
91. Background scripts: @options {"background": true} returns an id; load(id) gets the result.
92. A graceful stop at the deadline: the script's finally blocks get 2 s.
93. retry(fn, { tries, every }).
94. timeout(promise, ms).
95. pmap(items, fn, { concurrency }) for many calls without flooding a server.
96. A mod-wide cap on calls in flight per run.

### G. Finding tools and their arguments
97. MCP schemas the model loads with ToolSearch are kept (per tool, per engine version), and describeTool returns their types.
98. describeTool takes an array of names.
99. ALL_TOOLS carries the input type when it is known.
100. searchTools ranks tools this machine uses most a little higher.
101. The run description lists the machine's five most used MCP tools with their types.
102. Usage counts per tool are kept.
103. A suffix name works: tools.ctx_shell finds the one tool ending in __ctx_shell.
104. has(name) says whether a tool exists.
105. The description names the platform (darwin, linux) so shell syntax fits.
106. describeTool for a hook-denied tool says it is denied.

### H. Direct calls and weaker models
107. A refused direct call's message carries the model's own arguments already in script form.
108. Opt-in forwarding: CODEMODE_FORWARD=1 runs a direct call as a one-line script.
109. Repeated refusals in one session get a firmer note.
110. A loaded schema's script line shows the tool's required arguments.

### I. Helpers that route to whatever the session has
111. read(path): the file's text without Read's line numbers, paging large files.
112. write(path, text): uses Write, or the session's patch tool (create, or replace when the file exists).
113. edit(path, old, new): uses Edit, or the patch tool's replace_unique.
114. sh(cmd): uses Bash or the session's shell replacement, returns the text and exitCode.
115. sh() runs a command over the shell tool's size limit by writing it to a temp file first.
116. ENV: cwd, home, platform, session id.
117. A user prelude, ~/.claude/codemode/prelude.js, whose functions every script can use.
118. CODEMODE_TOOL_DEFAULTS: default arguments merged into calls of named tools (raw:true for ctx_shell).
119. Stubs like "[Firewalled …" in a result add a hint about raw output.
120. image(path) shows a picture through Read's marker.

### J. Store
121. keys() lists stored keys.
122. load(key, fallback).
123. store values over 1 MB are refused with a clear message.
124. Store keys can be scoped to the project.
125. store(key) with no value deletes.

### K. Observability
126. Every run appends one line to ~/.claude/codemode/log.jsonl: time, ms, calls by tool, failure kind, output size, cut.
127. A stats command over that log.
128. ToolSearch loads are logged too.
129. The log is capped and rotated.
130. Logged failures carry the first line of the error.

### L. Speed
131. Replies reach the runner sooner: poll 1 ms first, keep the backoff short.
132. Keep one warm runner per session.
133. Start the next runner while the model thinks.
134. Skip writing .keep when the run dir exists.
135. Tool listing cached per turn.

### M. Skills and subagents
136. The Skill result drops the "Launching skill:" line when the text follows.
137. A skill already loaded in this process returns its text again only when asked.
138. Agent results carry the subagent's duration.
139. Agent failures name the subagent type.

### N. The description and docs
140. The description teaches @text blocks and sh/read/write in two lines.
141. The description drops what models already do right.
142. The example uses sh() and Promise.all.
143. README documents every new global.
144. README gains a failure guide: each error and its fix.
145. The description tells weak models that Bash may be denied.

### O. ask()
146. ask() with json:true returns parsed JSON.
147. ask() lists the models it accepts when one is unknown.
148. summarize(text, question) chunks big text and asks once per chunk.
149. ask() calls share one concurrency cap.
150. ask() reports the tokens it used.

### P. Safety
151. Secret-looking strings (tokens, passwords) in output are masked unless the script opts out.
152. Run dirs are 0700.
153. The store refuses keys that look like secrets.
154. Spawned runners get no inherited fds.
155. A cap on total bytes a run may send to the mod.

### Q. More ergonomics
156. exit(value) outputs the value.
157. fail(message) ends with a clean failure, no stack.
158. assert(condition, message).
159. RUN: id, started, timeout, spill path.
160. clip(text, n) head and tail, the same way the mod cuts.
161. diff(a, b) line diff.
162. chunk(text, n).
163. text(title, value) adds a heading.
164. Dates print as ISO strings.
165. console.table.
166. console.time and timeEnd.
167. Output items get short headings instead of "==> text 1/3 <==".
168. A script can return a picture marker list and they attach in order.
169. Multi-picture cap explains when pictures were dropped.
170. Return values that are only whitespace print "(empty string)".

### R. Machine and setup
171. On Linux, find a Node 25+ in common fleet paths when node is older.
172. A runner that cannot start says which node it tried and its version.
173. A session-start check warns in the description when no usable node exists.
174. Spill folder cleaned per session end.
175. Old run dirs left by crashes are swept at session start.

### S. Analysis-driven
176. Weekly self-report: the log's top failures shown with the fix tips.
177. The mod learns per-machine tool name aliases.
178. A tool that failed three times in a row in one session gets its last errors in describeTool.
179. A run that only wraps one tool call is fine; no change.
180. The most common script boilerplate (sh helpers) becomes built-in.

### T. Wild ones
181. Scripts may be written in Python via @lang python, run as a tool through the shell.
182. A REPL mode: values defined in one run persist to the next (vars kept in the store).
183. Live progress lines shown in T3 while a run works.
184. A "dry run" option that lists the calls a script would make without making them.
185. Script snippets saved by name and called as run(name, args).
186. A run can return a follow-up script for the model to approve.
187. Auto-fix: a SyntaxError from an unescaped ${ is retried once with the fix applied.
188. Scripts can tag output as "for the user" and T3 shows it.
189. A shared cache of tool results within a run (same Read twice reads once).
190. Read cache across runs keyed by file mtime.
191. Big outputs can go straight to ask() via @options {"digest": "question"}.
192. A run can attach files as documents (PDF) from paths.
193. Ghost mode: a script that changes nothing (only reads) is marked safe to retry.
194. A tool call journal per run so a retry skips calls that already succeeded.
195. Scripts get a cancel token tool calls honour when the run ends.
196. Speculative runner start the moment the model begins writing a script.
197. Error budget: three failed runs in a row bring a short self-help message.
198. Per-model tips: weak models get extra examples in the description.
199. Learned fixes: when a failure is followed by a success, the pair is kept and offered next time the same error appears.
200. A "why did this fail" ask() pass on the failure, opt-in.
