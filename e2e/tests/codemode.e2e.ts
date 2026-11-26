import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'e2e';

const harness = join(import.meta.dirname, '..', 'harness', 'harness.mts');

type Step = { clockMark?: boolean; abortDuringNext?: { abort: string; start: string }; keepTurn?: boolean; agentId?: string; interrupt?: boolean; stop?: boolean; untilRunsDone?: boolean; collect?: boolean; untilWake?: boolean; turnStart?: string; turnComplete?: string; stopAborted?: boolean; clear?: boolean; reload?: boolean; turnAborted?: string; untilRunDone?: string; untilQuiet?: boolean; ageSpills?: boolean; abortAndStart?: { abort: string; start: string }; link?: { from: string; to: string }; untilFile?: string; untilStatPending?: boolean; stopAbortAfterMs?: number; agentEnd?: string; untilTool?: string; untilCalls?: { tool: string; count: number }; untilExists?: 'asked' | 'answered'; untilReadlink?: string; relink?: { from: string; to: string }; touch?: string; subagentStopWithoutId?: boolean; compact?: boolean; compactAgent?: string; compactSkipped?: boolean; script?: string; direct?: { tool: string; args: Record<string, unknown> }; search?: string; describe?: string; newSession?: boolean; setDenied?: string[]; setCwd?: string };
type Case = { changeEveryRead?: boolean; readLagMs?: number; rewriteDuringFirstRead?: string; strictRealpath?: boolean; clockNowDelayMs?: number; loadDelayMs?: number; failReplyAfter?: { fail: number; after: number }; hangListCount?: number; clockEarlyMs?: number; clockFrozen?: boolean; killDelayMs?: number; writeDelayMs?: number; patchDelayMs?: number; existsGapMs?: number; lastPartMayBeMissing?: boolean; holdLaterPages?: { asked: string; gate: string }; statDelayMs?: number; hangListMs?: number; surfaces?: string[]; submitRefusals?: number; submitDelayMs?: number; hangListDuringRuns?: boolean; tools?: string[]; denied?: string[]; home?: string; cwd?: string; env?: Record<string, string>; store?: Record<string, unknown>; steps: Step[]; abortAfterMs?: number; dedupReads?: boolean; deniedCommands?: string[]; deniedMessage?: string; readRewrite?: string; denyReadFrom?: number; rewriteFromOffset?: string; compressShell?: boolean; denyReadPaths?: string[]; deniedShellCommands?: string[]; hugePageAt?: number; persistBash?: boolean; deniedWriteMessage?: string; deniedCreateMessage?: string; pageErrorAt?: number; truncateLimited?: boolean; abortStyle?: string; engineForgets?: boolean; changeAfterPage?: number; readDelayMs?: number; listThrows?: boolean; detachAfterMs?: number; slowWritesMs?: number; leanTimeoutMs?: number; archiveWithheld?: boolean; archiveTruncated?: boolean; deniedReplaceMessage?: string; archiveWithheldText?: string; jobNoExit?: boolean; headerOnly?: boolean; pageWithheld?: boolean; bytesShort?: boolean; swapFormat?: string; archiveBytes?: string; shortPages?: number; leanCap?: number; noSwap?: boolean; archiveWithheldError?: boolean; shellWithheld?: boolean; expandEmptyBody?: boolean; shellAdvice?: string };
type Out = { description: string; results: { text: string; attachments: number; ms: number; id?: string; immediate?: string; immediateMs?: number; heldMs?: number }[]; calls: { tool: string; args: Record<string, unknown> }[]; store: Record<string, unknown>; submitted: string[]; stops: string[]; collected: string[]; collectedAttachments: number[]; kills: string[][]; waitsAlive: number; wakeAttempts: number; clockNowCalls?: number; clockMarks?: number[]; bashWaits?: number; runnersSpawned?: number };

const made: string[] = [];
test.afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const base = /^[\w./-]+$/.test(tmpdir()) ? tmpdir() : '/tmp';

function scratch(): string {
  const d = mkdtempSync(join(base, 'codemode-e2e-'));
  made.push(d);
  return d;
}

function run(c: Case): Out {
  const dir = scratch();
  const file = join(dir, 'case.json');
  writeFileSync(file, JSON.stringify({ home: dir, cwd: dir, ...c }));
  return JSON.parse(execFileSync(process.execPath, [harness, file], { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 }));
}

const one = (script: string, c: Omit<Case, 'steps'> = {}) => run({ ...c, steps: [{ script }] }).results[0]!.text;
const NO_BASH = ['Read', 'Skill', 'ToolSearch', 'mcp__lean-ctx__ctx_shell', 'mcp__lean-ctx__ctx_patch', 'mcp__t3-code__thread_note'];

test('A script that still works today returns its output unchanged', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\n');
  const text = one('const t = await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'a.txt')) + ' })\nreturn t');
  expect(text).toBe('1\talpha\n2\tbeta\n3\t');
});

test('Text between // @text NAME and // @end reaches the script raw, with dollar-braces, backticks and # untouched', () => {
  const body = 'set -e\nT=${3:-x}; echo "${T}"\n# a comment\necho `date` \\\\n';
  const text = one('// @text sh\n' + body + '\n// @end\nreturn TEXT.sh');
  expect(text).toBe(body);
});

test('An error after a // @text block reports the line number of the original script', () => {
  const text = one('// @text a\none\ntwo\nthree\n// @end\nconst x = 1\nnull.boom');
  expect(text).toContain('script.js:7');
});

test('A syntax error from a dollar-brace inside a template literal names the cause and the @text fix', () => {
  const text = one('const s = `T=${3:-x} done`\nreturn s');
  expect(text).toContain('[syntax]');
  expect(text).toContain('// @text');
  expect(text).toContain('\\${');
});

test('A syntax error shows the failing line with the lines around it', () => {
  const text = one('const a = 1\nconst b = 2\nconst c = (3\nconst d = 4\nreturn a');
  expect(text).toContain('const b = 2');
  expect(text).toContain('const d = 4');
});

test('sh() runs a command on the session shell and gives its exit code instead of throwing', () => {
  const text = one('const r = await sh("echo hi; exit 3")\nreturn { text: String(r).trim(), exitCode: r.exitCode, ok: r.ok }');
  expect(JSON.parse(text)).toEqual({ text: 'hi', exitCode: 3, ok: false });
});

test('A whole-tool hook block is never routed around in its own call, and later sh() calls use the shell it names', () => {
  const dir = scratch();
  const log = join(dir, 'log');
  const out = run({ denied: ['Bash'], steps: [{ script: 'await sh("echo first >> ' + log + '")' }, { script: 'const r = await sh("echo second >> ' + log + '")\nreturn r.tool + " " + r.exitCode' }] });
  expect(out.results[0]!.text).toContain('use tools.mcp__lean_ctx__ctx_shell');
  expect(out.results[1]!.text).toBe('mcp__lean-ctx__ctx_shell 0');
  expect(readFileSync(log, 'utf8')).toBe('second\n');
});

test('A hook that blocks one command and names another shell does not get it run there, nor block Bash later', () => {
  const dir = scratch();
  const marker = join(dir, 'marker');
  const out = run({
    deniedCommands: ['DANGER'],
    deniedMessage: 'PreToolUse:Bash hook error: DANGER is blocked by policy; for read-only checks use mcp__lean-ctx__ctx_shell. Use: ctx_shell(command)',
    steps: [{ script: 'await sh("echo DANGER > ' + marker + '")' }, { script: 'return (await sh("echo later")).tool' }, { newSession: true }],
  });
  expect(existsSync(marker)).toBe(false);
  expect(out.calls.filter((c) => c.tool === 'mcp__lean-ctx__ctx_shell')).toEqual([]);
  expect(out.results[1]!.text).toBe('Bash');
  expect(out.description).not.toMatch(/denied by a hook/);
});

test('A shell call through call() carries its exit code', () => {
  const text = one('const r = await call("mcp__lean-ctx__ctx_shell", { command: "echo no; exit 4" })\nreturn r.exitCode');
  expect(text).toBe('4');
});

test('quote() makes any value one safe shell word', () => {
  const v = "it's $HOME and `x`";
  const text = one('const r = await sh("printf %s " + quote(' + JSON.stringify(v) + '))\nreturn String(r)');
  expect(text).toBe(v);
});

test('A command over the shell tool limit is refused unless the script asks for it to be staged, and says what the hooks would see', () => {
  const out = run({ tools: NO_BASH, steps: [{ script: 'await sh("echo " + "x".repeat(9000))' }] });
  expect(out.results[0]!.text).toMatch(/9005 bytes[^\n]*\{ stage: true \}[^\n]*only see "bash <file>"/);
  expect(out.calls.filter((c) => c.tool === 'mcp__lean-ctx__ctx_shell')).toEqual([]);
});

test('sh(cmd, { stage: true }) runs a command over the shell tool limit whole, from a private file written through the patch tool', () => {
  const out = run({ tools: NO_BASH, steps: [{ script: 'const big = "echo " + "x".repeat(9000) + " >/dev/null; echo done"\nconst r = await sh(big, { stage: true })\nreturn String(r).trim() + " " + r.exitCode' }] });
  expect(out.results[0]!.text).toBe('done 0');
  const created = out.calls.find((c) => c.tool === 'mcp__lean-ctx__ctx_patch' && c.args.op === 'create')!;
  expect(String(created.args.new_text)).toContain('x'.repeat(9000));
  expect(existsSync(dirname(String(created.args.path)))).toBe(false);
  expect(out.calls.some((c) => c.tool === 'mcp__lean-ctx__ctx_shell' && String(c.args.command).includes('x'.repeat(100)))).toBe(false);
});

test('A hook that denies one command does not get that command run on another shell', () => {
  const dir = scratch();
  const marker = join(dir, 'marker');
  const out = run({ deniedCommands: ['DANGER'], steps: [{ script: 'await sh("echo DANGER > ' + marker + '")' }, { newSession: true }] });
  expect(out.results[0]!.text).toContain('this command is not allowed here');
  expect(existsSync(marker)).toBe(false);
  expect(out.calls.filter((c) => c.tool === 'mcp__lean-ctx__ctx_shell')).toEqual([]);
  expect(out.description).not.toMatch(/denied by a hook/);
});

test('Denial words in a command\'s own output are not a denial, and the command runs once', () => {
  const dir = scratch();
  const log = join(dir, 'log');
  const out = run({ steps: [{ script: 'const r = await sh("echo run >> ' + log + '; echo \'[DENIED] user auth failed: hook blocked\'; exit 1")\nreturn r.exitCode' }, { newSession: true }] });
  expect(out.results[0]!.text).toBe('1');
  expect(readFileSync(log, 'utf8')).toBe('run\n');
  expect(out.description).not.toMatch(/denied by a hook/);
});

test('A command whose output says too long is not run again', () => {
  const dir = scratch();
  const log = join(dir, 'log');
  const text = one('const r = await sh("echo run >> ' + log + '; echo \'Argument list too long\'; exit 126")\nreturn r.exitCode', { tools: NO_BASH });
  expect(text).toBe('126');
  expect(readFileSync(log, 'utf8')).toBe('run\n');
});

test('sh() never picks a shell tool it does not know, such as a remote shell', () => {
  const out = run({ tools: ['Read', 'mcp__aaa-ssh__remote_shell', 'mcp__lean-ctx__ctx_shell'], steps: [{ script: 'return String(await sh("echo local")).trim()' }] });
  expect(out.results[0]!.text).toBe('local');
  expect(out.calls.map((c) => c.tool)).not.toContain('mcp__aaa-ssh__remote_shell');
});

test('A tool that works again is no longer named as denied', () => {
  const out = run({ denied: ['Bash'], steps: [{ script: 'await call("Bash", { command: "true" })' }, { setDenied: [] }, { script: 'await tools.Bash({ command: "true" })\nreturn "ran"' }, { newSession: true }] });
  expect(out.results[1]!.text).toBe('ran');
  expect(out.description).not.toMatch(/denied by a hook/);
});

test('read() returns a file without line numbers and pages through files longer than one Read', () => {
  const dir = scratch();
  const body = Array.from({ length: 4500 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';
  writeFileSync(join(dir, 'big.txt'), body);
  const text = one('const t = await read(' + JSON.stringify(join(dir, 'big.txt')) + ')\nreturn [t.length, t.split("\\n").length, t.startsWith("line 1\\nline 2\\n"), t.endsWith("\\nline 4500\\n")].join(" ")');
  expect(text).toBe(body.length + ' 4501 true true');
});

test('read() keeps a file\'s last line exact, newline or not, and is not fooled by a repeated-read stub', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
  writeFileSync(join(dir, 'no-nl.txt'), 'x\ny');
  writeFileSync(join(dir, 'empty.txt'), '');
  const text = one('const r = [await read("nl.txt"), await read("nl.txt"), await read("no-nl.txt"), await read("empty.txt")]\nreturn JSON.stringify(r)', { cwd: dir, dedupReads: true });
  expect(JSON.parse(text)).toEqual(['a\nb\n', 'a\nb\n', 'x\ny', '']);
});

test('A repeated-read stub in a tool result is named as a stub', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'f.txt'), 'one\ntwo\n');
  const text = one('await tools.Read({ file_path: "f.txt", offset: 1, limit: 5 })\nconst again = await tools.Read({ file_path: "f.txt", offset: 1, limit: 5 })\nreturn again.length > 0', { cwd: dir, dedupReads: true });
  expect(text).toMatch(/compressed stub/);
});

test('A shell variable in a template literal, read by JS as a variable, names the cause', () => {
  const text = one('const cmd = `echo ${HOME_DIR}`\nreturn cmd');
  expect(text).toContain('HOME_DIR is not defined');
  expect(text).toContain('// @text');
});

test('tools.Read on a file over the token limit hands the script the whole file', () => {
  const dir = scratch();
  const lines = Array.from({ length: 1500 }, (_, i) => String(i + 1).padStart(4, '0') + ' ' + 'w'.repeat(90));
  writeFileSync(join(dir, 'wide.txt'), lines.join('\n'));
  const text = one('const t = await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'wide.txt')) + ' })\nconst rows = t.split("\\n")\nreturn rows.length + " " + rows[rows.length - 1].trim()');
  expect(text).toBe('1500 1500\t1500 ' + 'w'.repeat(90));
});

test('A relative path in Read is read from the session folder', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'notes.md'), 'hello there');
  const text = run({ cwd: dir, home: dir, steps: [{ script: 'return await tools.Read({ file_path: "notes.md" })' }] }).results[0]!.text;
  expect(text).toBe('1\thello there');
});

test('A Read of a missing file suggests the near-miss names in its folder', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'register.tsx'), 'x');
  const text = one('return await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'register.ts')) + ' })', { cwd: dir });
  expect(text).toContain(join(dir, 'register.tsx'));
});

test('write() creates and overwrites a file through the patch tool when Write is not in the session', () => {
  const dir = scratch();
  const f = join(dir, 'out.txt');
  const text = one('await write(' + JSON.stringify(f) + ', "one")\nawait write(' + JSON.stringify(f) + ', "two ${x} `", { force: true })\nreturn "ok"', { tools: NO_BASH });
  expect(text).toBe('ok');
  expect(readFileSync(f, 'utf8')).toBe('two ${x} `');
});

test('edit() replaces one exact text through Edit, or the patch tool when Edit is missing', () => {
  const dir = scratch();
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  writeFileSync(a, 'red green blue');
  writeFileSync(b, 'red green blue');
  expect(one('await read(' + JSON.stringify(a) + ')\nawait edit(' + JSON.stringify(a) + ', "green", "GREEN")\nreturn 1')).toBe('1');
  expect(one('await read(' + JSON.stringify(b) + ')\nawait edit(' + JSON.stringify(b) + ', "blue", "BLUE")\nreturn 1', { tools: NO_BASH })).toBe('1');
  expect(readFileSync(a, 'utf8')).toBe('red GREEN blue');
  expect(readFileSync(b, 'utf8')).toBe('red green BLUE');
});

test('CODEMODE_TOOL_DEFAULTS adds default arguments to a tool, and the script still wins', () => {
  const out = run({ env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ 'mcp__lean-ctx__ctx_shell': { raw: true, timeout: 5 } }) }, steps: [{ script: 'await tools.mcp__lean_ctx__ctx_shell({ command: "true", timeout: 9 })\nreturn 1' }] });
  expect(out.calls.find((c) => c.tool === 'mcp__lean-ctx__ctx_shell')!.args).toEqual({ command: 'true', raw: true, timeout: 9 });
});

test('A compressed stub from a tool is named in the output with the way to get the full text', () => {
  const text = one('const r = await sh("echo \'[Firewalled ctx_shell output — 9000 chars stored out-of-band]\'")\nreturn String(r).length > 0');
  expect(text).toContain('true');
  expect(text).toMatch(/compressed|stub/i);
  expect(text).toContain('raw');
});

test('The run tool description teaches @text blocks and the sh, read, write and edit helpers', () => {
  const d = run({ steps: [] }).description;
  for (const s of ['// @text', 'sh(', 'read(', 'write(', 'edit(', 'waitFor(', 'quote(']) expect(d).toContain(s);
});

test('waitFor() polls until the check passes and returns its value', () => {
  const dir = scratch();
  const flag = join(dir, 'flag');
  const text = one('let n = 0\nconst v = await waitFor(async () => { n++; if (n === 3) await sh("touch ' + flag + '"); return String(await sh("test -f ' + flag + ' && echo yes")).trim() === "yes" ? n : false }, { every: 50, timeout: 5000 })\nreturn v');
  expect(text).toBe('3');
  expect(existsSync(flag)).toBe(true);
});

test('waitFor() gives up at its timeout with a clear error', () => {
  const text = one('await waitFor(() => false, { every: 50, timeout: 300 })');
  expect(text).toMatch(/waitFor timed out after 300ms/);
});

test('deadline() tells the script how long it has left', () => {
  const text = one('// @options: {"timeout_ms": 60000}\nconst d = deadline()\nreturn d > 50000 && d <= 60000');
  expect(text).toBe('true');
});

test('A cut gives every output item a share instead of dropping the small ones', () => {
  const text = one('// @options: {"max_output_chars": 2000}\ntext("SMALL keep me")\ntext("BIG " + "a".repeat(10000))\ntext("BIG2 " + "b".repeat(10000))\nreturn "TAIL end"');
  expect(text).toContain('SMALL keep me');
  expect(text).toContain('TAIL end');
  expect(text).toContain('BIG aaa');
  expect(text).toContain('BIG2 bbb');
  expect(text.length).toBeLessThanOrEqual(2000);
});

test('A cut gives every key of a returned object a share', () => {
  const text = one('// @options: {"max_output_chars": 2000}\nreturn { head: "build 41\\nstarted", log: "x\\n".repeat(5000), log2: "y\\n".repeat(5000), summary: "3 passed\\n0 failed" }');
  expect(text).toContain('== head ==\nbuild 41\nstarted');
  expect(text).toContain('== log2 ==');
  expect(text).toContain('== summary ==\n3 passed\n0 failed');
});

test('Error lines from the cut middle are kept', () => {
  const text = one('// @options: {"max_output_chars": 2000}\nconst lines = Array.from({ length: 3000 }, (_, i) => "ok " + i)\nlines[1500] = "FATAL: disk full on /dev/sda1"\nreturn lines.join("\\n")');
  expect(text).toContain('FATAL: disk full on /dev/sda1');
});

test('The cut note carries a ready Read call for the lines it removed', () => {
  const text = one('// @options: {"max_output_chars": 1000}\nreturn Array.from({ length: 500 }, (_, i) => "row " + i).join("\\n")');
  const m = text.match(/tools\.Read\(\{ file_path: "([^"]+)", offset: (\d+), limit: (\d+) \}\)/);
  expect(m).not.toBeNull();
  const lines = readFileSync(m![1]!, 'utf8').split('\n');
  expect(lines[Number(m![2]) - 1]).toMatch(/^row \d+$/);
  expect(text).not.toContain(lines[Number(m![2]) - 1] + '\n');
});

test('String() and template text of a call() result are its text', () => {
  const text = one('const r = await call("mcp__lean-ctx__ctx_shell", { command: "echo hello" })\nreturn String(r).trim() + "|" + `${r}`.trim()');
  expect(text).toBe('hello|hello');
});

test('A Promise that was never awaited prints as such instead of {}', () => {
  const text = one('return { a: tools.Read({ file_path: "/etc/hosts" }) }');
  expect(text).toContain('not awaited');
});

test('An Error object in the output prints its message and where the script made it', () => {
  const text = one('const a = 1\nreturn { e: new Error("bad thing") }');
  expect(text).toContain('bad thing');
  expect(text).toContain('script.js:2');
});

test('A rejected promise nobody awaited fails the run as a script error, keeping what it printed', () => {
  const text = one('text("before")\nPromise.reject(new Error("late failure"))\nawait sh("echo x")\nreturn "after"');
  expect(text).toContain('before');
  expect(text).toContain('late failure');
  expect(text).toContain('[script]');
});

test('Lines that look like // @text inside a template literal stay part of the string', () => {
  const s = 'intro\n// @text deploy\nTAG=x\n// @end\noutro';
  const text = one('const r = `' + s + '`\nreturn r');
  expect(text).toBe(s);
});

test('The output stays within max_output_chars however many items a run prints', () => {
  const many = one('for (let i = 0; i < 3000; i++) text("item " + i + " " + "z".repeat(100))\nreturn "end"');
  expect(many.length).toBeLessThanOrEqual(20_000);
  const errs = one('// @options: {"max_output_chars": 1000}\nfor (let i = 0; i < 100; i++) text(Array.from({ length: 50 }, (_, j) => "ERROR " + i + " " + j).join("\\n"))');
  expect(errs.length).toBeLessThanOrEqual(1000);
});

test('A cut gives every key of a single-line object a share', () => {
  const text = one('// @options: {"max_output_chars": 2000}\nreturn { first: "a".repeat(15000), critical: "BUILD_SUMMARY_42", last: "b".repeat(15000) }');
  expect(text).toContain('BUILD_SUMMARY_42');
  expect(text.length).toBeLessThanOrEqual(2000);
});

test('waitFor() holds its timeout even while a check is still running', () => {
  const text = one('const t0 = Date.now()\ntry { await waitFor(async () => { await sh("perl -e \'select(undef, undef, undef, 3)\'"); return true }, { timeout: 100 }) } catch (e) { return e.message + " | " + (Date.now() - t0 < 2000) }\nreturn "no error"');
  expect(text).toMatch(/^waitFor timed out after 100ms while a check was still running[^|]* \| true$/);
});

test('waitFor() with a timeout no longer than its interval still waits out the timeout', () => {
  const text = one('const t0 = Date.now()\ntry { await waitFor(() => false, { every: 400, timeout: 400 }) } catch (e) { return Date.now() - t0 >= 300 }\nreturn "no error"');
  expect(text).toBe('true');
});

test('write() over a file the session has not read is refused, and forcing it reads the file first', () => {
  const dir = scratch();
  const f = join(dir, 'keep.txt');
  writeFileSync(f, 'original');
  const refused = one('await write(' + JSON.stringify(f) + ', "new")');
  expect(refused).toContain('has not read it: read(path) it first, or pass { force: true }');
  expect(readFileSync(f, 'utf8')).toBe('original');
  expect(one('await write(' + JSON.stringify(f) + ', "new", { force: true })\nreturn 1')).toBe('1');
  expect(readFileSync(f, 'utf8')).toBe('new');
});

test('write() through the patch tool replaces a file this session has read, without force', () => {
  const dir = scratch();
  const f = join(dir, 'seen.txt');
  writeFileSync(f, 'old\n');
  const out = run({ tools: NO_BASH, steps: [{ script: 'await read(' + JSON.stringify(f) + ')' }, { script: 'await write(' + JSON.stringify(f) + ', "new\\n")\nreturn 1' }] });
  expect(out.results[1]!.text).toBe('1');
  expect(readFileSync(f, 'utf8')).toBe('new\n');
});

test('A file read in an earlier session does not count as read in a new one', () => {
  const dir = scratch();
  const f = join(dir, 'old.txt');
  writeFileSync(f, 'one');
  const out = run({ tools: NO_BASH, steps: [{ script: 'await read(' + JSON.stringify(f) + ')' }, { newSession: true }, { script: 'await write(' + JSON.stringify(f) + ', "two")' }] });
  expect(out.results[1]!.text).toContain('has not read it');
  expect(readFileSync(f, 'utf8')).toBe('one');
});

test('edit() through the patch tool refuses a file this session has not read', () => {
  const dir = scratch();
  const f = join(dir, 'p.txt');
  writeFileSync(f, 'red green');
  expect(one('await edit(' + JSON.stringify(f) + ', "green", "GREEN")', { tools: NO_BASH })).toContain('has not been read in this session');
  expect(readFileSync(f, 'utf8')).toBe('red green');
});

test('waitFor() treats a failed call() result as not yet', () => {
  const dir = scratch();
  const f = join(dir, 'ready');
  const text = one('await sh("(perl -e \'select(undef, undef, undef, 0.4)\'; touch ' + f + ') >/dev/null 2>&1 &")\nconst r = await waitFor(() => call("mcp__lean-ctx__ctx_shell", { command: "test -f ' + f + '" }), { every: 50, timeout: 5000 })\nreturn r.ok', { tools: NO_BASH });
  expect(text).toBe('true');
  expect(existsSync(f)).toBe(true);
});

test('A rejection the script catches later does not fail the run', () => {
  const text = one('const a = tools.Read({ file_path: "/nope/later" })\nawait sh("perl -e \'select(undef, undef, undef, 0.3)\'")\ntry { await a } catch (e) { }\nreturn "kept going"');
  expect(text).toBe('kept going');
});

test('One oversized item written past the runner is trimmed to the mod\'s own cap', () => {
  const out = run({ steps: [{ script: 'const p = Buffer.constructor("return process")()\np.stdout.write("\\x1eCM" + JSON.stringify({ out: "item", text: "x".repeat(2000000) }) + "\\n")\nreturn "end"' }] });
  const spill = out.results[0]!.text.match(/(\/[^"' ]+\/\.claude\/codemode\/out\/[^"' ]+\.txt)/)![1]!;
  expect(readFileSync(spill, 'utf8').length).toBeLessThanOrEqual(1_100_000);
});

test('A regex right after an if condition does not hide a @text block', () => {
  expect(one('if (true) /`/.test("a")\n// @text sh\nT=${1:-x}\n// @end\nreturn TEXT.sh')).toBe('T=${1:-x}');
});

test('A postfix ++ before a division does not make the rest of the line a regex', () => {
  expect(one('let i = 1\nconst q = i++ / 2 + `\n// @text t\n`\nreturn q')).toBe('0.5\n// @text t\n');
});

test('A TEXT name with no block throws and names the blocks there are', () => {
  expect(one('// @text deploy\necho hi\n// @end\nreturn TEXT.Deploy')).toMatch(/TEXT\.Deploy[^\n]*deploy/);
});

test('lean-ctx\'s whole-tool block, a setting of the machine, is remembered in every project folder', () => {
  const a = scratch();
  const b = scratch();
  const out = run({ cwd: a, denied: ['Bash'], steps: [{ script: 'await call("Bash", { command: "true" })' }, { setCwd: b }, { newSession: true }, { script: 'return (await sh("echo x")).tool' }] });
  expect(out.description).toMatch(/Bash[^\n]*denied by a hook/);
  expect(out.results[1]!.text).toBe('mcp__lean-ctx__ctx_shell');
});

test('A denial seen through call() steers sh() in the same script', () => {
  const out = run({ denied: ['Bash'], steps: [{ script: 'await call("Bash", { command: "true" })\nreturn (await sh("echo x")).tool' }] });
  expect(out.results[0]!.text).toBe('mcp__lean-ctx__ctx_shell');
  expect(out.calls.filter((c) => c.tool === 'Bash').length).toBe(1);
});

test('sh() refuses to start a background job, which it could not wait for', () => {
  expect(one('await sh("echo x", { run_in_background: true })')).toMatch(/sh\(\) waits for its command/);
});

test('A shell output too big to pass twice still arrives whole', () => {
  expect(one('return (await sh("printf %3000000s x")).length')).toBe('3000000');
});

test('JSON.parse hands a reviver its third, context argument', () => {
  expect(one('return JSON.stringify(JSON.parse("[1]", (k, v, c) => (typeof c?.source === "string" ? "src:" + c.source : v)))')).toBe('["src:1"]');
});

test('A paged Read stops at a refused page instead of returning part of the file', () => {
  const dir = scratch();
  const f = join(dir, 'wide.txt');
  writeFileSync(f, Array.from({ length: 1500 }, (_, i) => String(i + 1).padStart(4, '0') + ' ' + 'w'.repeat(90)).join('\n'));
  const text = one('const r = await call("Read", { file_path: ' + JSON.stringify(f) + ' })\nreturn r.ok + " " + String(r.text ?? r.error).split("\\n").length', { denyReadFrom: 1001 });
  expect(text.startsWith('false')).toBe(true);
});

test('A Read too big to pass does not count as reading the file', () => {
  const dir = scratch();
  const f = join(dir, 'huge.txt');
  writeFileSync(f, Array.from({ length: 60_000 }, () => 'r'.repeat(99)).join('\n'));
  const out = run({ tools: NO_BASH, steps: [{ script: 'await call("Read", { file_path: ' + JSON.stringify(f) + ' })' }, { script: 'await write(' + JSON.stringify(f) + ', "gone")' }] });
  expect(out.results[1]!.text).toContain('has not read it');
});

test('A paged Read past a repeated-read stub never falls to one line per call', () => {
  const dir = scratch();
  const f = join(dir, 'wide.txt');
  writeFileSync(f, Array.from({ length: 1200 }, (_, i) => String(i + 1).padStart(4, '0') + ' ' + 'w'.repeat(90)).join('\n'));
  const out = run({ dedupReads: true, steps: [{ script: 'await tools.Read({ file_path: ' + JSON.stringify(f) + ' })\nreturn (await tools.Read({ file_path: ' + JSON.stringify(f) + ' })).split("\\n").length' }] });
  expect(out.results[0]!.text).toBe('1200');
  expect(out.calls.filter((c) => c.tool === 'Read').length).toBeLessThan(40);
});

test('read() refuses a later page that holds no file lines', () => {
  const dir = scratch();
  const f = join(dir, 'long.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i).join('\n'));
  expect(one('return (await read(' + JSON.stringify(f) + ')).length', { rewriteFromOffset: '[Firewalled ctx_read output — 9000 chars stored out-of-band]' })).toMatch(/read: Read answered with no file lines/);
});

test('A cut keeps a short item that sits between many big ones', () => {
  const text = one('// @options: {"max_output_chars": 2000}\nfor (let i = 0; i < 40; i++) text("big " + "b".repeat(300))\ntext("CRITICAL_SUMMARY_42")\nfor (let i = 0; i < 40; i++) text("big " + "c".repeat(300))');
  expect(text).toContain('CRITICAL_SUMMARY_42');
  expect(text.length).toBeLessThanOrEqual(2000);
});

test('A big object that is not cut prints as the JSON it is', () => {
  const text = one('// @options: {"max_output_chars": 1000000}\nreturn { a: "x".repeat(600000), b: 2 }');
  expect(JSON.parse(text).b).toBe(2);
});

test('Two reads at once, one failing, count the other as lost', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'ok.txt'), 'fine');
  const text = one('await Promise.all([tools.Read({ file_path: ' + JSON.stringify(join(dir, 'ok.txt')) + ' }), tools.Read({ file_path: "/nope/both" })])');
  expect(text).toMatch(/1 call that ran alongside it had succeeded/);
});

test('edit() never reads the file for itself', () => {
  const dir = scratch();
  const f = join(dir, 'e.txt');
  writeFileSync(f, 'red green');
  const out = run({ steps: [{ script: 'await edit(' + JSON.stringify(f) + ', "green", "GREEN")' }, { script: 'await read(' + JSON.stringify(f) + ')\nawait edit(' + JSON.stringify(f) + ', "green", "GREEN")\nreturn 1' }] });
  expect(out.results[0]!.text).toMatch(/read\(path\)|Read it first/);
  expect(out.results[1]!.text).toBe('1');
  expect(readFileSync(f, 'utf8')).toBe('red GREEN');
});

test('write() and edit() refuse a relative path', () => {
  const text = one('await write("rel.txt", "x")');
  expect(text).toContain('absolute');
});

test('write() says plainly when the patch tool cannot replace an existing empty file', () => {
  const dir = scratch();
  const f = join(dir, 'empty.txt');
  writeFileSync(f, '');
  const text = one('await write(' + JSON.stringify(f) + ', "x", { force: true })', { tools: NO_BASH });
  expect(text).toContain('empty');
});

test('read() reads a file whose text mentions the repeated-read stub', () => {
  const dir = scratch();
  const body = 'line one\nsee [unchanged 3L · lean-ctx read-dedup] in the docs\nUnchanged since your last Read\n';
  writeFileSync(join(dir, 'doc.md'), body);
  const text = one('return JSON.stringify(await read(' + JSON.stringify(join(dir, 'doc.md')) + '))');
  expect(JSON.parse(text)).toBe(body);
});

test('read() keeps working however many times the same unchanged file is read', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'five.txt'), 'a\nb\n');
  const text = one('const r = []\nfor (let i = 0; i < 8; i++) r.push(await read(' + JSON.stringify(join(dir, 'five.txt')) + '))\nreturn r.every((x) => x === "a\\nb\\n")', { dedupReads: true });
  expect(text).toBe('true');
});

test('tools.Read of a file over the limit pages past a repeated-read stub', () => {
  const dir = scratch();
  const lines = Array.from({ length: 1500 }, (_, i) => String(i + 1).padStart(4, '0') + ' ' + 'w'.repeat(90));
  writeFileSync(join(dir, 'wide.txt'), lines.join('\n'));
  const text = one('const f = ' + JSON.stringify(join(dir, 'wide.txt')) + '\nconst a = await tools.Read({ file_path: f })\nconst b = await tools.Read({ file_path: f })\nreturn a.split("\\n").length + " " + b.split("\\n").length', { dedupReads: true });
  expect(text).toBe('1500 1500');
});

test('waitFor(() => sh(cmd)) waits until the command exits 0', () => {
  const dir = scratch();
  const f = join(dir, 'ready');
  const out = run({ steps: [{ script: 'await sh("(perl -e \'select(undef, undef, undef, 1.5)\'; touch ' + f + ') >/dev/null 2>&1 &")\nconst r = await waitFor(() => sh("test -f ' + f + '"), { every: 50, timeout: 10000 })\nreturn r.exitCode' }] });
  expect(out.results[0]!.text).toBe('0');
  expect(out.calls.filter((c) => String(c.args.command) === 'test -f ' + f).length).toBeGreaterThan(1);
});

test('waitFor() refuses a check that is not a function, and never waits a negative time', () => {
  expect(one('await waitFor(true)')).toMatch(/waitFor: check must be a function/);
  expect(one('// @options: {"timeout_ms": 1500}\ntry { await waitFor(() => false) } catch (e) { return e.message }')).toMatch(/^waitFor timed out after \d+ms/);
});

test('tools.Read of a file too big to hand over whole fails instead of returning it cut', () => {
  const dir = scratch();
  const row = 'r'.repeat(99);
  writeFileSync(join(dir, 'three.txt'), Array.from({ length: 30_000 }, () => row).join('\n'));
  writeFileSync(join(dir, 'six.txt'), Array.from({ length: 60_000 }, () => row).join('\n'));
  const three = one('return (await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'three.txt')) + ' })).split("\\n").length');
  expect(three).toBe('30000');
  const six = one('const r = await call("Read", { file_path: ' + JSON.stringify(join(dir, 'six.txt')) + ' })\nreturn r.ok + " " + r.error');
  expect(six).toMatch(/^false .*too large.*read\(path\)/);
  expect(one('return (await read(' + JSON.stringify(join(dir, 'six.txt')) + ')).length')).toBe(String(60_000 * 100 - 1));
});

test('read() refuses a Read answer that holds no file lines instead of returning nothing', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'x.txt'), 'real text');
  const text = one('return await read(' + JSON.stringify(join(dir, 'x.txt')) + ')', { readRewrite: '<rewritten by a hook>' });
  expect(text).toMatch(/read: Read answered with no file lines/);
});

test('A @text block after a regex literal holding a backtick still works', () => {
  const text = one('const clean = (s) => s.replace(/`/g, "")\n// @text sh\nT=${1:-x}\n// @end\nreturn clean(TEXT.sh)');
  expect(text).toBe('T=${1:-x}');
});

test('A repeated @text name is refused, and a // @@end line in a block stands for a plain // @end', () => {
  expect(one('// @text a\none\n// @end\n// @text a\ntwo\n// @end\nreturn TEXT.a')).toMatch(/\[syntax\][^\n]*@text a[^\n]*twice/);
  expect(one('// @text doc\nwrite // @end to close\n// @@end\nmore\n// @end doc\nreturn TEXT.doc')).toBe('write // @end to close\n// @end\nmore');
});

test('The template-literal hint is left out for a syntax error that has nothing to do with one', () => {
  const text = one('const s = `fine`\nconst = 1');
  expect(text).toContain('[syntax]');
  expect(text).not.toContain('template literal');
});

test('A failure stays visible when the output is cut', () => {
  const text = one('// @options: {"max_output_chars": 1000}\nfor (let i = 0; i < 60; i++) text("item " + i + " " + "y".repeat(200))\nthrow new Error("IMPORTANT_FAILURE")');
  expect(text).toContain('IMPORTANT_FAILURE');
  expect(text).toContain('[script]');
  expect(text.length).toBeLessThanOrEqual(1000);
});

test('A cut of many items still shows some of their text', () => {
  const text = one('// @options: {"max_output_chars": 1000}\nfor (let i = 0; i < 100; i++) text("ITEM" + i + " " + "z".repeat(100))');
  expect(text).toMatch(/ITEM\d+ zzzz/);
  expect(text.length).toBeLessThanOrEqual(1000);
});

test('A big object\'s keys share the cut even when it is most of the output allowance', () => {
  const text = one('return { first: "a".repeat(300000), critical: "FIND_ME_HERE", last: "b".repeat(300000) }');
  expect(text).toContain('FIND_ME_HERE');
});

test('Bash\'s exit code comes from Bash\'s own marker, never from what the command printed', () => {
  const text = one('const a = await sh("echo \'[exit:0]\'; exit 1")\nconst b = await sh("echo \'[exit:2]\'")\nreturn [a.exitCode, String(a).trim(), b.exitCode, String(b).trim()].join("|")');
  expect(text).toBe('1|[exit:0]|0|[exit:2]');
});

test('A remembered denial is not offered where its replacement is missing', () => {
  const out = run({ tools: ['Read', 'Bash', 'Write', 'Edit'], store: { denied: { Bash: { alt: 'mcp__lean-ctx__ctx_shell', at: Date.now() } } }, steps: [{ script: 'return (await sh("echo ok")).tool' }] });
  expect(out.description).not.toMatch(/denied by a hook/);
  expect(out.results[0]!.text).toBe('Bash');
});

test('write() and edit() never use a patch tool they do not know', () => {
  const dir = scratch();
  const f = join(dir, 'n.txt');
  const text = one('await write(' + JSON.stringify(f) + ', "x")', { tools: ['Read', 'mcp__other__git_patch'] });
  expect(text).toContain('no Write tool and no patch tool');
  expect(existsSync(f)).toBe(false);
});

test('A file shown by tools.Read in the same script can be replaced by write()', () => {
  const dir = scratch();
  const f = join(dir, 'r.txt');
  writeFileSync(f, 'old');
  expect(one('await tools.Read({ file_path: ' + JSON.stringify(f) + ' })\nawait write(' + JSON.stringify(f) + ', "new")\nreturn 1', { tools: NO_BASH })).toBe('1');
  expect(readFileSync(f, 'utf8')).toBe('new');
});

test('Calls caught with call() are not reported lost by a later failure', () => {
  const text = one('await Promise.all([call("Bash", { command: "exit 1" }), sh("echo ok")])\nawait tools.Read({ file_path: "/nope2" })');
  expect(text).not.toMatch(/lost/);
});

test('JSON.parse passes a reviver\'s own error through unchanged', () => {
  const text = one('try { JSON.parse("{\\"a\\":1}", () => { throw new TypeError("mine") }) } catch (e) { return e.name + " " + e.message }');
  expect(text).toBe('TypeError mine');
});

test('A rejected tool call nobody awaited is labelled a tool failure', () => {
  expect(one('let settled = false\ntools.Read({ file_path: "/nope3" }).finally(() => { settled = true })\nawait waitFor(() => settled, { every: 20, timeout: 20000 })\nreturn 1')).toContain('[tool]');
});

test('The mod holds its own output cap even when a script writes past the runner', () => {
  const out = run({ steps: [{ script: 'const p = Buffer.constructor("return process")()\nfor (let i = 0; i < 4; i++) p.stdout.write("\\x1eCM" + JSON.stringify({ out: "item", text: "x".repeat(1000000) }) + "\\n")\nreturn "end"' }] });
  const t = out.results[0]!.text;
  const spill = t.match(/(\/[^"' ]+\/\.claude\/codemode\/out\/[^"' ]+\.txt)/)![1]!;
  expect(readFileSync(spill, 'utf8').length).toBeLessThanOrEqual(1_100_000);
});

test('Running a failed script again names the earlier error when it differs', () => {
  const dir = scratch();
  const f = join(dir, 'later.txt');
  const s = 'await tools.Read({ file_path: ' + JSON.stringify(f) + ' })\nnull.x';
  const out = run({ steps: [{ script: s }, { script: 'await sh("touch ' + f + '")\nreturn 1' }, { script: s }] });
  expect(out.results[2]!.text).toMatch(/same script[^\n]*with: [^\n]*File does not exist/);
  expect(out.results[2]!.text).not.toContain('change the script');
});

test('A failed run says how many calls had already succeeded and how to keep them', () => {
  const text = one('await Promise.all([sh("echo a"), sh("echo b"), tools.Read({ file_path: "/nope/x" })])');
  expect(text).toMatch(/2 calls that ran alongside it had succeeded/);
  expect(text).toMatch(/allSettled|call\(\)/);
});

test('Calls that finished before the failed one are not reported as lost', () => {
  const text = one('const a = await sh("echo a")\nawait tools.Read({ file_path: "/nope/x" })');
  expect(text).not.toMatch(/lost/);
});

test('The failure ledger shows the command or path of the call that failed', () => {
  const text = one('await sh("echo a")\nawait tools.Read({ file_path: "/nope/missing-file.txt" })');
  expect(text).toMatch(/Read 1 failed \("\/nope\/missing-file\.txt"\)/);
});

test('Running the exact script that just failed again says so', () => {
  const s = 'await tools.Read({ file_path: "/nope/again.txt" })';
  const out = run({ steps: [{ script: s }, { script: s }] });
  expect(out.results[0]!.text).not.toMatch(/same script/i);
  expect(out.results[1]!.text).toMatch(/same script/i);
});

test('btoa, atob, TextEncoder, TextDecoder and Buffer work in scripts', () => {
  const text = one('const b = btoa("hi there")\nconst u = new TextEncoder().encode("é")\nreturn [b, atob(b), u.length, new TextDecoder().decode(u), Buffer.from("hi").toString("base64"), Buffer.from("aGk=", "base64").toString(), Buffer.from("hi").toString("hex")].join(" ")');
  expect(text).toBe('aGkgdGhlcmU= hi there 2 é aGk= hi 6869');
});

test('A missing global names what to use instead', () => {
  expect(one('await fetch("https://x")')).toMatch(/fetch is not available[^\n]*tools/);
  expect(one('await ToolSearch')).toMatch(/ToolSearch[^\n]*directly/);
  expect(one('setTimeout(() => 1, 5)')).toMatch(/waitFor/);
});

test('JSON.parse of text that is not JSON shows what the text started with', () => {
  const text = one('JSON.parse("[Firewalled ctx_shell output — 900 chars]")');
  expect(text).toContain('[Firewalled ctx_shell output');
});

test('A hook-denied tool is answered with its replacement and named as denied in the next session', () => {
  const out = run({ denied: ['Bash'], steps: [{ script: 'return await tools.Bash({ command: "true" })' }, { newSession: true }] });
  expect(out.results[0]!.text).toContain('tools.mcp__lean_ctx__ctx_shell');
  expect(out.description).toMatch(/Bash[^\n]*denied/);
});

test('A suffix of a tool name calls that tool', () => {
  const text = one('return (await tools.ctx_shell({ command: "echo via suffix" })).trim()');
  expect(text).toBe('via suffix');
});

test('An aborted run says it was stopped and keeps what it had printed', () => {
  const out = run({ abortAfterMs: 1500, steps: [{ script: 'text("first part done")\nconsole.log("log line")\nawait sh("perl -e \'select(undef, undef, undef, 4)\'")' }] });
  const t = out.results[0]!.text;
  expect(t).toContain('first part done');
  expect(t).toContain('log line');
  expect(t).toMatch(/\[aborted\]/);
  expect(t).not.toContain('runner exited without a result');
});

test('A timed-out run keeps its output and names the call still running', () => {
  const text = one('// @options: {"timeout_ms": 1500}\ntext("got this far")\nawait sh("perl -e \'select(undef, undef, undef, 4)\'")');
  expect(text).toContain('got this far');
  expect(text).toMatch(/\[timeout\]/);
  expect(text).toMatch(/still running[^\n]*abandoned, not stopped[^\n]*: Bash \(\d+(\.\d)?s/);
  expect(text).toContain('select(undef, undef, undef, 4)');
});

test('Every failure is labelled with its kind', () => {
  expect(one('const = 1')).toContain('[syntax]');
  expect(one('await tools.Read({ file_path: "/nope" })')).toContain('[tool]');
  expect(one('null.x')).toContain('[script]');
});


test('A returned object over the 1M cap keeps every key, each cut to its share', () => {
  const text = one('return { a: "x".repeat(2000000), b: "tail" }');
  expect(text).toContain('"b": "tail"');
});

test('A cut through one very long line offers a byte-range command that brings the cut text back', () => {
  const original = 'head\n' + 'x'.repeat(300000) + 'y'.repeat(300000) + '\ntail';
  const text = one('return "head\\n" + "x".repeat(300000) + "y".repeat(300000) + "\\ntail"');
  const m = /…(\d+) chars cut \(lines 2-2\); read them back with sh\(("[^\n]*?")\)…/.exec(text);
  expect(m).not.toBeNull();
  const back = execFileSync('bash', ['-c', JSON.parse(m![2]!)], { encoding: 'utf8', maxBuffer: 10_000_000 });
  expect(back.length).toBe(Number(m![1]));
  expect(original.includes(back)).toBe(true);
});

test('TEXT can be returned and stringified like any object', () => {
  expect(one('// @text a\nhello\n// @end\nreturn JSON.stringify(TEXT)')).toBe('{"a":"hello"}');
  expect(one('// @text a\nhello\n// @end\nconst t = TEXT\nreturn t')).toBe('{\n  "a": "hello"\n}');
});

test('A patch-tool write replaces a file with CRLF line endings that read() gave back with \\n', () => {
  const dir = scratch();
  const f = join(dir, 'crlf.txt');
  writeFileSync(f, 'x\r\ny\r\n');
  const text = one('await read(' + JSON.stringify(f) + ')\nreturn await write(' + JSON.stringify(f) + ', "z")', { tools: NO_BASH });
  expect(text).toBe('wrote ' + f);
  expect(readFileSync(f, 'utf8')).toBe('z');
});

test('sh() runs in the foreground even when the tool defaults ask for the background', () => {
  const text = one('const r = await sh("printf DONE; exit 3")\nreturn r.exitCode + " " + r', { env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ Bash: { run_in_background: true } }) } });
  expect(text).toBe('3 DONE');
});

test('sh() with run_in_background: false runs the command', () => {
  expect(one('return String(await sh("echo hi", { run_in_background: false })).trim()')).toBe('hi');
});

test('A denial remembered more than a day ago is tried again', () => {
  const out = run({ tools: ['Read', 'Bash', 'Write', 'Edit', 'mcp__lean-ctx__ctx_shell'], store: { denied: { Bash: { alt: 'mcp__lean-ctx__ctx_shell', at: Date.now() - 2 * 86_400_000 } } }, steps: [{ script: 'return (await sh("echo ok")).tool' }] });
  expect(out.description).not.toMatch(/Bash[^\n]*denied by a hook/);
  expect(out.results[0]!.text).toBe('Bash');
});

test('A tool result too big to pass with its text keeps the text and says the structured result was dropped', () => {
  const text = one('const r = await call("mcp__t3-code__big_report", {})\nreturn [r.ok, r.text.length, r.result === undefined, r.resultDropped].join(" ")', { tools: [...NO_BASH, 'mcp__t3-code__big_report'], noSwap: true });
  expect(text).toBe('true 2100000 true true');
});

test('A shell result too big to pass three times over still has its result', () => {
  const text = one('const r = await call("mcp__lean-ctx__ctx_shell", { command: "printf %1500000s x" })\nreturn [r.ok, r.text.length, r.result[0].text.length].join(" ")', { tools: NO_BASH, noSwap: true, leanCap: 2000000 });
  expect(text).toBe('true 1500000 1500000');
});

test('Near names for a missing file never include one Read may not open', () => {
  const dir = scratch();
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  const script = 'await tools.Read({ file_path: ' + JSON.stringify(join(dir, '.envv')) + ' })';
  expect(one(script, { cwd: dir })).toContain('Similar files: ' + join(dir, '.env'));
  expect(one(script, { cwd: dir, denyReadPaths: ['/.env'] })).not.toContain('Similar files');
});

test('Near names are only offered inside the session folder, and never a folder', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'notes.txt'), 'x\n');
  execFileSync('mkdir', [join(dir, 'src')]);
  expect(one('await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'notes.tx')) + ' })', { cwd: scratch() })).not.toContain('Similar files');
  expect(one('await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'srcc')) + ' })', { cwd: dir })).not.toContain('Similar files');
});

test('edit() with { all: true } replaces every occurrence through Edit and through the patch tool', () => {
  for (const tools of [undefined, NO_BASH]) {
    const dir = scratch();
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'a b a\n');
    one('await read(' + JSON.stringify(f) + ')\nawait edit(' + JSON.stringify(f) + ', "a", "Z", { all: true })', tools ? { tools } : {});
    expect(readFileSync(f, 'utf8')).toBe('Z b Z\n');
  }
});

test('edit() with { force: true } through Edit reads the file first and edits it', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'red blue\n');
  const text = one('return await edit(' + JSON.stringify(f) + ', "blue", "BLUE", { force: true })');
  expect(text).toBe('edited ' + f);
  expect(readFileSync(f, 'utf8')).toBe('red BLUE\n');
});

test('sh() on lean-ctx\'s shell gets the raw text, not a compressed stub', () => {
  expect(one('return String(await sh("echo hello")).trim()', { tools: NO_BASH, compressShell: true })).toBe('hello');
});

test('A Read whose reply could not be delivered does not count as reading the file', () => {
  const dir = scratch();
  const f = join(dir, 'slashes.txt');
  writeFileSync(f, Array.from({ length: 25000 }, () => '\\'.repeat(100)).join('\n'));
  const out = run({ tools: NO_BASH, steps: [{ script: 'const r = await call("Read", { file_path: ' + JSON.stringify(f) + ' })\nreturn String(r.ok)' }, { script: 'await edit(' + JSON.stringify(f) + ', "\\\\", "X")\nreturn "edited"' }] });
  expect(out.results[0]!.text).toBe('false');
  expect(out.results[1]!.text).toContain('has not been read');
  expect(readFileSync(f, 'utf8').includes('X')).toBe(false);
});

test('read() refuses a notice that is not the file, and the file stays unread', () => {
  const dir = scratch();
  const f = join(dir, 'held.txt');
  writeFileSync(f, 'secret\n');
  const out = run({ tools: NO_BASH, readRewrite: '<system-reminder>The contents of this file are withheld by policy.</system-reminder>', steps: [{ script: 'return await read(' + JSON.stringify(f) + ').then(() => "read", (e) => e.message)' }, { script: 'await tools.Read({ file_path: ' + JSON.stringify(f) + ' })\nawait edit(' + JSON.stringify(f) + ', "secret", "X")\nreturn "edited"' }] });
  expect(out.results[0]!.text).toContain('no file lines');
  expect(out.results[1]!.text).toContain('has not been read');
  expect(readFileSync(f, 'utf8')).toBe('secret\n');
});

test('A read() that fails on a later page leaves the file unread', () => {
  const dir = scratch();
  const f = join(dir, 'long.txt');
  writeFileSync(f, Array.from({ length: 2500 }, (_, i) => 'line ' + i).join('\n'));
  const out = run({ tools: NO_BASH, denyReadFrom: 2001, steps: [{ script: 'return await read(' + JSON.stringify(f) + ').then(() => "read", (e) => "failed")' }, { script: 'await edit(' + JSON.stringify(f) + ', "line 7\\n", "X\\n")\nreturn "edited"' }] });
  expect(out.results[0]!.text).toBe('failed');
  expect(out.results[1]!.text).toContain('has not been read');
});

test('A Read of only part of a file does not count as reading it', () => {
  const dir = scratch();
  const f = join(dir, 'three.txt');
  writeFileSync(f, 'one\ntwo\nthree\n');
  const read1 = 'await tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 1, limit: 1 })';
  const edit1 = 'await edit(' + JSON.stringify(f) + ', "three", "X")\nreturn "edited"';
  const out = run({ tools: NO_BASH, steps: [{ script: read1 }, { script: edit1 }, { script: read1 + '\n' + edit1 }] });
  expect(out.results[1]!.text).toContain('has not been read');
  expect(out.results[2]!.text).toContain('has not been read');
  expect(readFileSync(f, 'utf8')).toBe('one\ntwo\nthree\n');
});

test('A Read answered with a compressed stub does not count as reading the file', () => {
  const dir = scratch();
  const f = join(dir, 'stub.txt');
  writeFileSync(f, 'body\n');
  const out = run({ tools: NO_BASH, readRewrite: '[Firewalled ctx_read output — 900 chars, stored out-of-band]', steps: [{ script: 'await tools.Read({ file_path: ' + JSON.stringify(f) + ' })' }, { script: 'await edit(' + JSON.stringify(f) + ', "body", "X")\nreturn "edited"' }] });
  expect(out.results[1]!.text).toContain('has not been read');
});

test('An empty object divided before a template literal keeps the template whole', () => {
  expect(one('const n = {} / 2; const t = `\n// @text KEEP\nx\n`\nreturn t')).toBe('\n// @text KEEP\nx\n');
});

test('A regex after a for await header does not hide a @text block', () => {
  expect(one('for await (const x of []) /`/.test("a")\n// @text a\nhi\n// @end\nreturn TEXT.a')).toBe('hi');
});

test('A staged command its shell refuses leaves no folder behind', () => {
  const out = run({ tools: NO_BASH, deniedShellCommands: ['bash /tmp/codemode-'], steps: [{ script: 'await sh("echo " + "x".repeat(9000) + " >/dev/null", { stage: true })' }] });
  expect(out.results[0]!.text).toContain('not allowed here');
  const mkdir = out.calls.map((c) => String(c.args.command ?? '')).find((c) => c.startsWith('mkdir -m 700 /tmp/codemode-'));
  expect(mkdir).toBeDefined();
  expect(existsSync(mkdir!.slice('mkdir -m 700 '.length))).toBe(false);
});

test('A rejection with no reason that nothing handles fails the run', () => {
  const text = one('Promise.reject()\nreturn "SUCCESS"');
  expect(text).toContain('[script]');
  expect(text).toContain('rejected with no reason');
});

test('A big object holding undefined and functions prints as valid JSON', () => {
  const text = one('// @options: {"max_output_chars": 1000000}\nreturn { a: "x".repeat(600000), b: undefined, fn: () => 1, c: 1 }');
  expect(Object.keys(JSON.parse(text))).toEqual(['a', 'c']);
});

test('A second read() of a file that fits one or two lines per page never repeats the same page request', () => {
  const dir = scratch();
  const f = join(dir, 'wide.txt');
  writeFileSync(f, Array.from({ length: 4 }, (_, i) => (String(i) + ' ').repeat(24500)).join('\n'));
  const out = run({ tools: NO_BASH, dedupReads: true, steps: [{ script: 'const a = await read(' + JSON.stringify(f) + ')\nconst b = await read(' + JSON.stringify(f) + ')\nreturn String(a === b && a.length === 196003)' }] });
  expect(out.results[0]!.text).toBe('true');
});


test('tools.Read of a file over the token cap with no limit hands the script every line', () => {
  const dir = scratch();
  const f = join(dir, 'big.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  expect(one('const t = await tools.Read({ file_path: ' + JSON.stringify(f) + ' })\nreturn t.split("\\n").filter((l) => /^\\s*\\d+\\t/.test(l)).length')).toBe('3001');
});

test('write() through Write refuses an existing file this session has not read', () => {
  const dir = scratch();
  const f = join(dir, 'keep.txt');
  writeFileSync(f, 'keep\n');
  expect(one('await write(' + JSON.stringify(f) + ', "clobbered")')).toContain('has not read it');
  expect(readFileSync(f, 'utf8')).toBe('keep\n');
});

test('edit() through Edit refuses a file read only in part', () => {
  const dir = scratch();
  const f = join(dir, 'three.txt');
  writeFileSync(f, 'one\ntwo\nthree\n');
  expect(one('await tools.Read({ file_path: ' + JSON.stringify(f) + ', limit: 1 })\nawait edit(' + JSON.stringify(f) + ', "three", "X")')).toContain('has not been read');
  expect(readFileSync(f, 'utf8')).toBe('one\ntwo\nthree\n');
});

test('sh() on Bash returns the whole output when Bash saved it to a file', () => {
  expect(one('return String(await sh("printf %40000s x | tr \' \' y")).length', { persistBash: true })).toBe('40000');
});

test('Pages read in order with tools.Read count as reading the file within the same script', () => {
  const dir = scratch();
  const f = join(dir, 'three.txt');
  writeFileSync(f, 'one\ntwo\nthree\n');
  const text = one('await tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 1, limit: 2 })\nawait tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 3, limit: 5 })\nreturn await edit(' + JSON.stringify(f) + ', "three", "X")', { tools: NO_BASH });
  expect(text).toBe('edited ' + f);
  expect(readFileSync(f, 'utf8')).toBe('one\ntwo\nX\n');
});

test('A Read limit from the tool defaults does not count as reading the whole file', () => {
  const dir = scratch();
  const f = join(dir, 'three.txt');
  writeFileSync(f, 'one\ntwo\nthree\n');
  const text = one('await tools.Read({ file_path: ' + JSON.stringify(f) + ' })\nawait edit(' + JSON.stringify(f) + ', "three", "X")', { tools: NO_BASH, env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ Read: { limit: 1 } }) } });
  expect(text).toContain('has not been read');
});

test('A page whose reply could not be delivered breaks the chain of pages', () => {
  const dir = scratch();
  const f = join(dir, 'huge.txt');
  writeFileSync(f, 'one\ntwo\nthree\n');
  const out = run({ tools: NO_BASH, hugePageAt: 1, steps: [{ script: 'const a = await call("Read", { file_path: ' + JSON.stringify(f) + ', offset: 1, limit: 2 })\nawait tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 3, limit: 5 })\nawait tools.Read({ file_path: "/nope" })' }, { script: 'await edit(' + JSON.stringify(f) + ', "three", "X")' }] });
  expect(out.results[0]!.text).toMatch(/Read 1 ok, 2 failed \("[^"]*huge\.txt"\)/);
  expect(out.results[1]!.text).toContain('has not been read');
});

test('read() refuses an empty reply that is not one of Read\'s notices', () => {
  const dir = scratch();
  const f = join(dir, 'x.txt');
  writeFileSync(f, 'body\n');
  expect(one('return await read(' + JSON.stringify(f) + ').then(() => "read", (e) => e.message)', { readRewrite: '' })).toContain('no file lines');
});

test('A property named like a keyword before a division keeps the template whole', () => {
  expect(one('const o = { of: 4 }\nconst n = o.of / 2; const t = `\n// @text KEEP\nx\n`\nreturn t')).toBe('\n// @text KEEP\nx\n');
});

test('A returned object over the cap keeps a small key that sits between two big ones', () => {
  expect(one('return { a: "x".repeat(600000), critical: "KEEP_MIDDLE", b: "y".repeat(600000) }')).toContain('"critical": "KEEP_MIDDLE"');
});

test('Paths with . and .. segments name the same file for the read check', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'red\n');
  const text = one('await read(' + JSON.stringify(dir + '/sub/../a.txt') + ')\nreturn await edit(' + JSON.stringify(dir + '//./a.txt') + ', "red", "RED")', { tools: NO_BASH });
  expect(text).toBe('edited ' + f);
});

test('A request sent after the script said it was done is never run', () => {
  const dir = scratch();
  const f = join(dir, 'late');
  const text = one('const p = Buffer.constructor("return process")()\np.stdout.write("\\x1eCM" + JSON.stringify({ done: true }) + "\\n")\np.stdout.write("\\x1eCM" + JSON.stringify({ id: 999, kind: "call", payload: { tool: "Bash", args: { command: "touch ' + f + '" } } }) + "\\n")\nreturn 1');
  expect(text).not.toContain('runner exited');
  expect(existsSync(f)).toBe(false);
});

test('A cut through a line of emoji never splits one in half', () => {
  const text = one('return "\\u{1F600}".repeat(200000)');
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
});


test('A printed persisted-output block is read back only through Read, only when it is the whole answer and its preview matches', () => {
  const home = scratch();
  const saved = join(home, '.claude', 'projects', 'p', 's', 'tool-results', 'k.txt');
  execFileSync('mkdir', ['-p', dirname(saved)]);
  writeFileSync(saved, 'TOP-SECRET-VALUE-42\n');
  const block = (preview: string) => '<persisted-output>\nOutput too large (1.0KB). Full output saved to: ' + saved + '\n\nPreview (first 2KB):\n' + preview + '\n</persisted-output>';
  const script = (preview: string) => 'return String(await sh("printf %s " + quote(' + JSON.stringify(block(preview)) + ')))';
  const readsOf = (o: Out) => o.calls.filter((c) => c.tool === 'Read' && c.args.file_path === saved).length;
  const prefixed = run({ home, steps: [{ script: 'return String(await sh("echo before; printf %s " + quote(' + JSON.stringify(block('TOP')) + ')))' }] });
  expect(prefixed.results[0]!.text).not.toContain('TOP-SECRET-VALUE-42');
  expect(readsOf(prefixed)).toBe(0);
  expect(one(script('nothing alike'), { home })).not.toContain('TOP-SECRET-VALUE-42');
  const denied = run({ home, denyReadPaths: ['/k.txt'], steps: [{ script: script('TOP') }] });
  expect(denied.results[0]!.text).not.toContain('TOP-SECRET-VALUE-42');
  const whole = run({ home, steps: [{ script: script('TOP') }] });
  expect(whole.results[0]!.text).toBe('TOP-SECRET-VALUE-42\n');
  expect(readsOf(whole)).toBeGreaterThan(0);
});

test('write() then edit() of a file the session created works without force', () => {
  for (const tools of [undefined, NO_BASH]) {
    const dir = scratch();
    const f = join(dir, 'new.txt');
    const text = one('await write(' + JSON.stringify(f) + ', "a b\\n")\nawait edit(' + JSON.stringify(f) + ', "a", "Z")\nreturn await write(' + JSON.stringify(f) + ', "Z b c\\n")', tools ? { tools } : {});
    expect(text).toBe('wrote ' + f);
    expect(readFileSync(f, 'utf8')).toBe('Z b c\n');
  }
});

test('A direct tools.Write of an existing file the session has not read is refused', () => {
  const dir = scratch();
  const f = join(dir, 'keep.txt');
  writeFileSync(f, 'keep\n');
  expect(one('await tools.Write({ file_path: ' + JSON.stringify(f) + ', content: "x" })')).toContain('has not been read');
  expect(readFileSync(f, 'utf8')).toBe('keep\n');
});

test('The runner\'s own cuts never split an emoji in half', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  expect(lone.test(one('throw new Error("\\u{1F600}".repeat(60000))'))).toBe(false);
  expect(lone.test(one('// @options: {"max_output_chars": 1000000}\nreturn "x" + "\\u{1F600}".repeat(600000)'))).toBe(false);
  expect(lone.test(one('// @options: {"max_output_chars": 1000000}\nreturn { a: "\\u{1F600}".repeat(600000), b: "tail" }'))).toBe(false);
});

test('A Read paged past the token cap keeps its structured file result and counts as read', () => {
  const dir = scratch();
  const f = join(dir, 'big.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  const text = one('const r = await call("Read", { file_path: ' + JSON.stringify(f) + ', offset: 1 })\nawait edit(' + JSON.stringify(f) + ', "line 2999 ", "LAST ")\nreturn [r.result.file.startLine, r.result.file.numLines, r.result.file.totalLines].join(" ")', { tools: NO_BASH });
  expect(text).toBe('1 3001 3001');
  expect(readFileSync(f, 'utf8')).toContain('LAST ');
});

test('Reading the rest of a file in pages after its first lines counts as reading it', () => {
  const dir = scratch();
  const f = join(dir, 'big.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  const text = one('await tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 1, limit: 100 })\nawait tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 101 })\nreturn await edit(' + JSON.stringify(f) + ', "line 2999 ", "LAST ")', { tools: NO_BASH });
  expect(text).toBe('edited ' + f);
});

test('A whole Read over the token cap that cannot be read in pages fails instead of returning part', () => {
  const dir = scratch();
  const f = join(dir, 'oneline.txt');
  writeFileSync(f, 'z'.repeat(200000));
  expect(one('return await tools.Read({ file_path: ' + JSON.stringify(f) + ' }).then((t) => "got " + t.length, (e) => "failed")')).toBe('failed');
});

test('{ force: true } writes over a file changed since the session read it', () => {
  const dir = scratch();
  const f = join(dir, 'moved.txt');
  writeFileSync(f, 'one\n');
  const out = run({ steps: [{ script: 'await read(' + JSON.stringify(f) + ')\nawait sh("echo changed > ' + f + '")\nreturn await write(' + JSON.stringify(f) + ', "mine\\n").then(() => "wrote", (e) => e.message)' }, { script: 'return await write(' + JSON.stringify(f) + ', "mine\\n", { force: true })' }] });
  expect(out.results[0]!.text).toContain('changed since');
  expect(out.results[1]!.text).toBe('wrote ' + f);
  expect(readFileSync(f, 'utf8')).toBe('mine\n');
});

test('A hook refusal that mentions reading first is not retried with a read', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'a\n');
  const out = run({ deniedWriteMessage: 'PreToolUse:Write hook error: blocked: read it first through the approved viewer', steps: [{ script: 'await read(' + JSON.stringify(f) + ')\nreturn await write(' + JSON.stringify(f) + ', "x", { force: true }).then(() => "wrote", (e) => e.message)' }] });
  expect(out.results[0]!.text).toContain('approved viewer');
  expect(out.calls.filter((c) => c.tool === 'Read').length).toBe(1);
});

test('A saved Bash output the session may not read back says so, without advice for compressed stubs', () => {
  const text = one('return String(await sh("seq 1 20000")).length', { persistBash: true, denyReadPaths: ['.txt'] });
  expect(text).toContain('saved');
  expect(text).not.toContain('raw: true');
});

test('A saved Bash output comes back whole under CLAUDE_CONFIG_DIR', () => {
  const home = scratch();
  expect(one('return String(await sh("printf %40000s x | tr \' \' y")).length', { home, persistBash: true, env: { CLAUDE_CONFIG_DIR: join(home, 'cfg') } })).toBe('40000');
});


test('A direct Write to a ~ path or a path with stray whitespace is checked like its absolute path', () => {
  const home = scratch();
  const f = join(home, 'keep.txt');
  writeFileSync(f, 'keep\n');
  for (const path of ['~/keep.txt', ' ' + f, f + '\n']) {
    expect(one('return await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "x" }).then((r) => r.ok ? "wrote" : r.error)', { home })).toContain('has not been read');
    expect(readFileSync(f, 'utf8')).toBe('keep\n');
  }
});

test('A direct Write or Edit to a relative path is refused, since a shell cd can move where it lands', () => {
  const dir = scratch();
  execFileSync('mkdir', [join(dir, 'sub')]);
  writeFileSync(join(dir, 'sub', 'target.txt'), 'keep\n');
  const text = one('await sh("cd sub")\nreturn await call("Write", { file_path: "target.txt", content: "x" }).then((r) => r.ok ? "wrote" : r.error)', { cwd: dir });
  expect(text).toContain('absolute path');
  expect(readFileSync(join(dir, 'sub', 'target.txt'), 'utf8')).toBe('keep\n');
});

test('A Read with only an offset of a file over the size cap is read in pages', () => {
  const dir = scratch();
  const f = join(dir, 'large.txt');
  writeFileSync(f, Array.from({ length: 6000 }, (_, i) => 'line ' + i + ' ' + 'y'.repeat(56)).join('\n') + '\n');
  expect(one('const r = await call("Read", { file_path: ' + JSON.stringify(f) + ', offset: 1 })\nreturn r.ok ? r.text.split("\\n").length : r.error')).toBe('6001');
});

test('A whole Read with numbered lines but no file fields does not count as reading the file', () => {
  const dir = scratch();
  const f = join(dir, 'x.txt');
  writeFileSync(f, 'one\ntwo\n');
  const text = one('await tools.Read({ file_path: ' + JSON.stringify(f) + ' })\nreturn await edit(' + JSON.stringify(f) + ', "two", "X").then(() => "edited", (e) => e.message)', { tools: NO_BASH, readRewrite: '1\tone' });
  expect(text).toContain('has not been read');
});

test('A patch-tool write() that a hook refuses is not done another way', () => {
  const dir = scratch();
  const f = join(dir, 'guarded.txt');
  writeFileSync(f, 'keep\n');
  const out = run({ tools: NO_BASH, deniedCreateMessage: 'PreToolUse:mcp__lean-ctx__ctx_patch hook error: blocked: this file already exists and is protected', steps: [{ script: 'await read(' + JSON.stringify(f) + ')\nreturn await write(' + JSON.stringify(f) + ', "x").then(() => "wrote", (e) => e.message)' }] });
  expect(out.results[0]!.text).toContain('protected');
  expect(out.calls.some((c) => c.args.op === 'replace_unique')).toBe(false);
  expect(readFileSync(f, 'utf8')).toBe('keep\n');
});

test('A variable named of before a division keeps the template whole', () => {
  expect(one('const of = 4\nconst n = of / 2; const t = `\n// @text KEEP\nx\n`\nreturn t')).toBe('\n// @text KEEP\nx\n');
});

test('write() through the patch tool refuses a file changed since the session read it, and force replaces it', () => {
  const dir = scratch();
  const f = join(dir, 'moved.txt');
  writeFileSync(f, 'one\n');
  const out = run({ tools: NO_BASH, steps: [{ script: 'await read(' + JSON.stringify(f) + ')\nawait sh("echo changed > ' + f + '")\nreturn await write(' + JSON.stringify(f) + ', "mine\\n").then(() => "wrote", (e) => e.message)' }, { script: 'return await write(' + JSON.stringify(f) + ', "mine\\n", { force: true })' }] });
  expect(out.results[0]!.text).toContain('changed since');
  expect(out.results[1]!.text).toBe('wrote ' + f);
  expect(readFileSync(f, 'utf8')).toBe('mine\n');
});

test('A saved Bash output with CRLF line endings, a blank start, or a folder with a space comes back whole', () => {
  expect(one('return String(await sh("perl -e \'print qq(line\\\\r\\\\n) x 7000\'")).split("\\n").filter((l) => l === "line").length', { persistBash: true })).toBe('7000');
  expect(one('return String(await sh("printf %1500s; printf %40000s x | tr \' \' y")).length', { persistBash: true })).toBe('41500');
  const home = scratch();
  expect(one('return String(await sh("printf %40000s x | tr \' \' y")).length', { home, persistBash: true, env: { CLAUDE_CONFIG_DIR: join(home, 'c fg') } })).toBe('40000');
});

test('A big object of many-line values over the cap still fills most of the cap', () => {
  const text = one('// @options: {"max_output_chars": 1000000}\nreturn { a: Array.from({ length: 300000 }, (_, i) => i), b: "KEEP_B" }');
  expect(text).toContain('"b": "KEEP_B"');
  expect(text.length).toBeGreaterThan(900000);
});

test('A Read error on the first page of a paged read is reported as it is', () => {
  const dir = scratch();
  const f = join(dir, 'big.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  expect(one('return await tools.Read({ file_path: ' + JSON.stringify(f) + ' }).then(() => "read", (e) => e.message)', { pageErrorAt: 1 })).toContain('EACCES');
});

test('A page Read cut at the token cap is read again smaller, never taken as the end of the file', () => {
  const dir = scratch();
  const f = join(dir, 'big.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  expect(one('return (await read(' + JSON.stringify(f) + ')).split("\\n").length', { truncateLimited: true })).toBe('3001');
});

test('A run stopped by a standard AbortError is reported as stopped', () => {
  const out = run({ abortAfterMs: 1500, abortStyle: 'dom', steps: [{ script: 'text("partial")\nawait sh("perl -e \'select(undef, undef, undef, 4)\'")' }] });
  expect(out.results[0]!.text).toMatch(/\[aborted\]/);
});

test('waitFor() takes every: 0 as fast polling and checks at least once near the deadline', () => {
  expect(one('let n = 0\nreturn await waitFor(() => n++ >= 3, { every: 0, timeout: 500 })')).toBe('true');
  expect(one('// @options: {"timeout_ms": 1000}\nreturn await waitFor(() => "yes")')).toBe('yes');
});

test('A byte-range read-back stays exact after a lone surrogate', () => {
  const original = '\uD800é' + '0123456789'.repeat(30000) + '\ntail';
  const text = one('return "\\uD800\\u00e9" + "0123456789".repeat(30000) + "\\ntail"');
  const m = /read them back with sh\(("[^\n]*?")\)…/.exec(text);
  expect(m).not.toBeNull();
  const back = execFileSync('bash', ['-c', JSON.parse(m![1]!)], { encoding: 'utf8', maxBuffer: 10_000_000 });
  const head = text.slice(0, text.indexOf('…')).replace(/\n$/, '');
  expect(back.length).toBeGreaterThan(0);
  expect(original.startsWith(head + back)).toBe(true);
});


test('A patch edit of a file never read does not count as reading it', () => {
  const dir = scratch();
  const f = join(dir, 'unread.txt');
  writeFileSync(f, 'red blue\nmore\n');
  expect(one('await tools.mcp__lean_ctx__ctx_patch({ op: "replace_unique", path: ' + JSON.stringify(f) + ', old_text: "red", new_text: "RED" })\nreturn await call("Write", { file_path: ' + JSON.stringify(f) + ', content: "gone" }).then((r) => r.ok ? "wrote" : r.error)')).toContain('has not been read');
  expect(one('await tools.mcp__lean_ctx__ctx_patch({ op: "replace_all", path: ' + JSON.stringify(f) + ', old_text: "blue", new_text: "BLUE" })\nreturn await write(' + JSON.stringify(f) + ', "gone").then(() => "wrote", (e) => e.message)', { tools: NO_BASH })).toContain('has not read it');
  expect(readFileSync(f, 'utf8')).toBe('RED BLUE\nmore\n');
});

test('sh() does not report success for a command Bash moved to the background', () => {
  const text = one('return await sh("perl -e \'select(undef, undef, undef, 1)\'; echo done", { timeout: 200 }).then((r) => "ok " + r.exitCode, (e) => e.message)');
  expect(text).toContain('moved the command to the background');
  expect(text).toContain('bg2');
});

test('A Write over a file changed on disk since the session read it is refused, even when Claude Code no longer remembers the read', () => {
  const dir = scratch();
  const f = join(dir, 'moved.txt');
  writeFileSync(f, 'one\n');
  const out = run({ engineForgets: true, steps: [{ script: 'await read(' + JSON.stringify(f) + ')\nawait sh("echo changed > ' + f + '")\nreturn await call("Write", { file_path: ' + JSON.stringify(f) + ', content: "mine" }).then((r) => r.ok ? "wrote" : r.error)' }, { script: 'return await write(' + JSON.stringify(f) + ', "mine\\n", { force: true })' }] });
  expect(out.results[0]!.text).toContain('modified since read');
  expect(out.results[1]!.text).toBe('wrote ' + f);
  expect(readFileSync(f, 'utf8')).toBe('mine\n');
});

test('A compaction clears what the session had read', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'red\n');
  const out = run({ tools: NO_BASH, steps: [{ script: 'await read(' + JSON.stringify(f) + ')' }, { compact: true }, { script: 'return await edit(' + JSON.stringify(f) + ', "red", "RED").then(() => "edited", (e) => e.message)' }] });
  expect(out.results[1]!.text).toContain('has not been read');
});

test('edit() after an outside change says the file changed, and force edits it', () => {
  const dir = scratch();
  const f = join(dir, 'e.txt');
  writeFileSync(f, 'red blue\n');
  const out = run({ steps: [{ script: 'await read(' + JSON.stringify(f) + ')\nawait sh("echo red green > ' + f + '")\nreturn await edit(' + JSON.stringify(f) + ', "red", "RED").then(() => "edited", (e) => e.message)' }, { script: 'return await edit(' + JSON.stringify(f) + ', "red", "RED", { force: true })' }] });
  expect(out.results[0]!.text).toContain('changed since');
  expect(out.results[1]!.text).toBe('edited ' + f);
  expect(readFileSync(f, 'utf8')).toBe('RED green\n');
});

test('A Read path with stray spaces reads the file and counts as read', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'red\n');
  expect(one('await tools.Read({ file_path: ' + JSON.stringify(' ' + f + ' ') + ' })\nreturn await edit(' + JSON.stringify(f) + ', "red", "RED")', { tools: NO_BASH })).toBe('edited ' + f);
});

test('write() through the patch tool reports a failed create as it is', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'afile'), 'x');
  const text = one('return await write(' + JSON.stringify(join(dir, 'afile', 'x.txt')) + ', "hi").then(() => "wrote", (e) => e.message)', { tools: NO_BASH });
  expect(text).toContain('parent directory does not exist');
  expect(text).not.toContain('has not read it');
});

test('A short page without file fields does not count as reading the file', () => {
  const dir = scratch();
  const f = join(dir, 'many.txt');
  writeFileSync(f, 'first\nsecond\nthird\n');
  const out = run({ tools: NO_BASH, readRewrite: '1\tfirst', steps: [{ script: 'await read(' + JSON.stringify(f) + ')\nreturn await write(' + JSON.stringify(f) + ', "x").then(() => "wrote", (e) => e.message)' }] });
  expect(out.results[0]!.text).toContain('has not read it');
  expect(readFileSync(f, 'utf8')).toBe('first\nsecond\nthird\n');
});

test('Pages read across a change to the file do not count as reading it', () => {
  const dir = scratch();
  const f = join(dir, 'p.txt');
  writeFileSync(f, 'one\ntwo\nthree\n');
  const text = one('await tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 1, limit: 1 })\nawait sh("printf \'ONE\\\\ntwo\\\\nthree\\\\n\' > ' + f + '")\nawait tools.Read({ file_path: ' + JSON.stringify(f) + ', offset: 2, limit: 100 })\nreturn await edit(' + JSON.stringify(f) + ', "three", "X").then(() => "edited", (e) => e.message)', { tools: NO_BASH });
  expect(text).toContain('has not been read');
});

test('A folder the mod cannot list still gets the changed-since-read check', () => {
  const dir = scratch();
  const sub = join(dir, 'locked');
  execFileSync('mkdir', [sub]);
  const f = join(sub, 'f.txt');
  writeFileSync(f, 'one\n');
  execFileSync('chmod', ['311', sub]);
  try {
    const text = one('await read(' + JSON.stringify(f) + ')\nawait sh("echo changed > ' + f + '")\nreturn await write(' + JSON.stringify(f) + ', "mine\\n").then(() => "wrote", (e) => e.message)', { tools: NO_BASH });
    expect(text).toContain('changed since');
    expect(readFileSync(f, 'utf8')).toBe('changed\n');
  } finally {
    execFileSync('chmod', ['755', sub]);
  }
});

test('A division after a function expression keeps the template whole', () => {
  expect(one('const n = function () {} / 2; const t = `\n// @text KEEP\nx\n`\nreturn t')).toBe('\n// @text KEEP\nx\n');
});

test('read() of a line over the token cap fails with a clear reason', () => {
  const dir = scratch();
  const f = join(dir, 'oneline.txt');
  writeFileSync(f, 'z'.repeat(200000));
  const text = one('return await read(' + JSON.stringify(f) + ').then(() => "read", (e) => e.message)', { truncateLimited: true });
  expect(text).toContain('token cap');
  expect(text).not.toContain('undefined');
});

test('write() takes a path with stray spaces as the absolute path', () => {
  const dir = scratch();
  const f = join(dir, 'new.txt');
  expect(one('return await write(' + JSON.stringify(' ' + f) + ', "hi")', { tools: NO_BASH })).toBe('wrote ' + f);
  expect(readFileSync(f, 'utf8')).toBe('hi');
});

test('A big object of many-line values keeps its cut note and the end of the big value', () => {
  const text = one('// @options: {"max_output_chars": 1000000}\nreturn { a: Array.from({ length: 300000 }, (_, i) => i), b: "KEEP_B" }');
  expect(text).toContain('chars cut past the 1000000-char cap');
  expect(text).toContain('299999');
  expect(text).toContain('"b": "KEEP_B"');
});

test('A tight cut of very long lines still names how to read them back', () => {
  const text = one('// @options: {"max_output_chars": 9000}\nfor (let i = 0; i < 30; i++) text(String(i).repeat(60000))');
  expect(text).toContain('tail -c +');
  expect(text.length).toBeLessThanOrEqual(9000);
});


test('A patch edit of a read file changed outside since the read stops counting it as read', () => {
  for (const tools of [undefined, NO_BASH]) {
    const dir = scratch();
    const f = join(dir, 'c.txt');
    writeFileSync(f, 'inside\n');
    const text = one('await read(' + JSON.stringify(f) + ')\nawait sh("echo outside > ' + f + '")\nawait tools.mcp__lean_ctx__ctx_patch({ op: "replace_unique", path: ' + JSON.stringify(f) + ', old_text: "outside", new_text: "x" })\nreturn await write(' + JSON.stringify(f) + ', "clobbered\\n").then(() => "wrote", (e) => e.message)', tools ? { tools } : {});
    expect(text).not.toBe('wrote');
    expect(readFileSync(f, 'utf8')).toBe('x\n');
  }
});

test('A file that changes while it is read in pages is not taken as read', () => {
  const dir = scratch();
  const f = join(dir, 'big.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  const text = one('const r = await call("Read", { file_path: ' + JSON.stringify(f) + ' })\nreturn (r.ok ? "read" : r.error) + " | " + await edit(' + JSON.stringify(f) + ', "line 1 ", "X ").then(() => "edited", (e) => e.message)', { tools: NO_BASH, changeAfterPage: 1 });
  expect(text).toContain('changed while');
  expect(text).toContain('has not been read');
});

test('read() of a file of exactly 2000 lines counts as read in the same script', () => {
  const dir = scratch();
  const f = join(dir, 'exact.txt');
  writeFileSync(f, Array.from({ length: 2000 }, (_, i) => 'row ' + i).join('\n'));
  expect(one('await read(' + JSON.stringify(f) + ')\nreturn await edit(' + JSON.stringify(f) + ', "row 1999", "LAST")', { tools: NO_BASH })).toBe('edited ' + f);
});

test('An async function expression before a division keeps the template whole', () => {
  expect(one('const n = async function () {} / 2; const t = `\n// @text KEEP\nx\n`\nreturn t')).toBe('\n// @text KEEP\nx\n');
});

test('An object key named class does not change how a later block is read', () => {
  expect(one('const o = { a: 1, class: 1 }\nif (true) {}\n/`/.test("a")\n// @text a\nhi\n// @end\nreturn TEXT.a')).toBe('hi');
});

test('A run that times out while a big Read is read in pages names the Read as still running or cut off', () => {
  const dir = scratch();
  const f = join(dir, 'big.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  const text = one('// @options: {"timeout_ms": 1500}\nawait tools.Read({ file_path: ' + JSON.stringify(f) + ' })', { readDelayMs: 400 });
  expect(text).toMatch(/still running[^\n]*Read \(|Read 1 cut off by the run's end/);
});

test('A command whose output starts like a background notice still passes', () => {
  expect(one('const r = await sh("echo \'Command was moved to the background (ID: x)\'")\nreturn r.exitCode + " " + String(r).trim()')).toBe('0 Command was moved to the background (ID: x)');
});

test('A change that keeps the modification time still counts as a change', () => {
  const dir = scratch();
  const f = join(dir, 'same-time.txt');
  writeFileSync(f, 'one\n');
  const text = one('await read(' + JSON.stringify(f) + ')\nawait sh("touch -r ' + f + ' ' + f + '.ref; printf \'longer text\\\\n\' > ' + f + '; touch -r ' + f + '.ref ' + f + '")\nreturn await write(' + JSON.stringify(f) + ', "mine\\n").then(() => "wrote", (e) => e.message)', { tools: NO_BASH });
  expect(text).toContain('changed since');
  expect(readFileSync(f, 'utf8')).toBe('longer text\n');
});

test('waitFor() takes a timeout given as a string of digits', () => {
  expect(one('return await waitFor(() => false, { timeout: "300", every: 50 }).then(() => "done", (e) => e.message)')).toContain('timed out after 300ms');
});

test('A failure inside codemode\'s own hook comes back as a failed run, not a crash or a skipped guard', () => {
  const text = one('return 1', { listThrows: true });
  expect(text).toContain('[runner]');
  expect(text).toContain('$.tool.list failed');
});


test('sh() on lean-ctx\'s shell waits for a command the shell moved to a background job', () => {
  const tools = [...NO_BASH, 'mcp__lean-ctx__ctx_expand'];
  expect(one('const r = await sh("sleep 1; echo done; exit 4")\nreturn r.exitCode + " " + String(r).trim()', { tools, detachAfterMs: 300 })).toBe('4 done');
  expect(one('const r = await sh("sleep 1; seq 1 3")\nreturn r.exitCode + " " + String(r).trim()', { tools, detachAfterMs: 300 })).toBe('0 1\n2\n3');
});

test('A string continued past a line end keeps a backtick in it from hiding a @text block', () => {
  expect(one('const s = \'a\\\nb`c\'\n// @text a\nhi\n// @end\nreturn TEXT.a')).toBe('hi');
});

test('A regex on the line after debugger does not hide a @text block', () => {
  expect(one('debugger\n/`/.test("a")\n// @text a\nhi\n// @end\nreturn TEXT.a')).toBe('hi');
});

test('A lean-ctx patch given a relative path renews the read record of the file it changed', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'red\n');
  const text = one('await read(' + JSON.stringify(f) + ')\nawait tools.mcp__lean_ctx__ctx_patch({ op: "replace_unique", path: "a.txt", old_text: "red", new_text: "RED" })\nreturn await write(' + JSON.stringify(f) + ', "x\\n")', { tools: NO_BASH, cwd: dir });
  expect(text).toBe('wrote ' + f);
  expect(readFileSync(f, 'utf8')).toBe('x\n');
});

test('read() of a file that changes between its pages fails instead of returning mixed pages', () => {
  const dir = scratch();
  const f = join(dir, 'long.txt');
  writeFileSync(f, Array.from({ length: 2500 }, (_, i) => 'row ' + i).join('\n'));
  expect(one('return await read(' + JSON.stringify(f) + ').then(() => "read", (e) => e.message)', { tools: NO_BASH, changeAfterPage: 1 })).toContain('changed while');
});

test('A subagent\'s compaction, or one a hook skipped, keeps what the session had read', () => {
  for (const step of [{ compact: true, compactAgent: 'sub-1' }, { compact: true, compactSkipped: true }]) {
    const dir = scratch();
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'red\n');
    const out = run({ tools: NO_BASH, steps: [{ script: 'await read(' + JSON.stringify(f) + ')' }, step, { script: 'return await edit(' + JSON.stringify(f) + ', "red", "RED")' }] });
    expect(out.results[1]!.text).toBe('edited ' + f);
  }
});

test('A read counts at once, even when the reply file is still being written', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'red\n');
  expect(one('await read(' + JSON.stringify(f) + ')\nreturn await edit(' + JSON.stringify(f) + ', "red", "RED")', { tools: NO_BASH, slowWritesMs: 300 })).toBe('edited ' + f);
});

test('A word async at the end of a line does not make the next line\'s function an expression', () => {
  expect(one('let async = 1\nconst a = async\nfunction f() {}\n/`/.test("a")\n// @text a\nhi\n// @end\nreturn TEXT.a')).toBe('hi');
});


test('sh() on lean-ctx\'s shell lets a command run as long as the script\'s own time allows', () => {
  expect(one('const r = await sh("sleep 1; echo ok")\nreturn r.exitCode + " " + String(r).trim()', { tools: NO_BASH, leanTimeoutMs: 300 })).toBe('0 ok');
});

test('A lean-ctx background job whose output lean-ctx withheld says so', () => {
  const text = one('const r = await sh("sleep 1; echo done")\nreturn r.exitCode + " " + String(r).trim()', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveWithheld: true });
  expect(text).toMatch(/^0 /);
  expect(text).toMatch(/Note: [^\n]*withheld/);
});


test('A long output of a detached lean-ctx job comes back whole through ctx_expand, page by page', () => {
  const text = one('const r = await sh("sleep 1; seq 1 400")\nreturn r.exitCode + " " + String(r).trim().split("\\n").length + " " + String(r).trim().split("\\n").pop()', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, denyReadPaths: ['.txt'] });
  expect(text).toBe('0 400 400');
});

test('A detached lean-ctx job whose output cannot be fetched fails and names its archive', () => {
  const text = one('return await sh("sleep 1; echo PRIVATE_OUTPUT").then((r) => "ok " + JSON.stringify(String(r)), (e) => e.message)', { tools: NO_BASH, detachAfterMs: 300, denyReadPaths: ['.txt'] });
  expect(text).toContain('archive');
  expect(text).not.toMatch(/^ok/);
});

test('A detached lean-ctx job whose archive was cut says so with .truncated', () => {
  expect(one('const r = await sh("sleep 1; echo done")\nreturn String(r.truncated)', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveTruncated: true })).toBe('true');
});

test('A command that prints JSON shaped like a job is not taken for a lean-ctx job', () => {
  expect(one('const r = await sh("echo \'{\\"jobId\\":\\"build-123\\",\\"state\\":\\"running\\"}\'")\nreturn r.exitCode + " " + String(r).trim()', { tools: NO_BASH })).toBe('0 {"jobId":"build-123","state":"running"}');
});

test('A refused patch-path replace is not tried again with CRLF line endings', () => {
  const dir = scratch();
  const f = join(dir, 'crlf.txt');
  writeFileSync(f, 'x\r\ny\r\n');
  const text = one('await read(' + JSON.stringify(f) + ')\nreturn await write(' + JSON.stringify(f) + ', "z").then(() => "wrote", (e) => e.message)', { tools: NO_BASH, deniedReplaceMessage: 'PreToolUse:mcp__lean-ctx__ctx_patch hook error: blocked: path not found in the allowlist' });
  expect(text).toContain('allowlist');
  expect(readFileSync(f, 'utf8')).toBe('x\r\ny\r\n');
});

test('Other lean-ctx patch ops and batches of a read file keep it counted as read', () => {
  for (const patch of ['{ op: "set_line", line: 1, new_text: "RED" }', '{ ops: [{ op: "replace_unique", old_text: "red", new_text: "RED", path: P }] }']) {
    const dir = scratch();
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'red\nblue\n');
    const args = patch.replace('P', JSON.stringify(f)).replace('{ op', '{ path: ' + JSON.stringify(f) + ', op');
    expect(one('await read(' + JSON.stringify(f) + ')\nawait tools.mcp__lean_ctx__ctx_patch(' + args + ')\nreturn await write(' + JSON.stringify(f) + ', "x\\n")', { tools: NO_BASH })).toBe('wrote ' + f);
  }
});

test('A repeated Read with offset 1 and no limit gets past a repeated-read stub', () => {
  const dir = scratch();
  const f = join(dir, 'wide.txt');
  writeFileSync(f, Array.from({ length: 1500 }, (_, i) => String(i + 1).padStart(4, '0') + ' ' + 'w'.repeat(90)).join('\n'));
  expect(one('const f = ' + JSON.stringify(f) + '\nawait tools.Read({ file_path: f, offset: 1 })\nconst b = await tools.Read({ file_path: f, offset: 1 })\nreturn b.split("\\n").length', { dedupReads: true })).toBe('1500');
});


test('A failed detached lean-ctx job with a long output gives its real output and exit code', () => {
  expect(one('const r = await sh("sleep 1; seq 1 1000; exit 5")\nconst rows = String(r).trim().split("\\n")\nreturn r.exitCode + " " + rows.length + " " + rows.pop()', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('5 1000 1000');
});

test('A detached job output with a line too long for ctx_expand pages is read from its archive file', () => {
  expect(one('const r = await sh("sleep 1; printf \'%60000s\\\\n\' x | tr \' \' y; seq 1 3")\nreturn String(r).length', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('60007');
});

test('sh() leaves lean-ctx shell defaults from CODEMODE_TOOL_DEFAULTS in place', () => {
  const out = run({ tools: NO_BASH, env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ 'mcp__lean-ctx__ctx_shell': { raw: false, timeout_ms: 90000 } }) }, steps: [{ script: 'await sh("echo hi")' }] });
  const c = out.calls.find((x) => x.tool === 'mcp__lean-ctx__ctx_shell' && x.args.command === 'echo hi');
  expect(c?.args.raw).toBe(false);
  expect(c?.args.timeout_ms).toBe(90000);
});

test('Polling a detached job does not count as tool calls in a failed run', () => {
  const text = one('await sh("sleep 1; echo done")\nawait tools.Read({ file_path: "/nope/polls.txt" })', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 });
  expect(text).toMatch(/mcp__lean-ctx__ctx_shell 1 ok/);
});

test('A refused ctx_expand is not routed around through Read', () => {
  const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, denied: ['mcp__lean-ctx__ctx_expand'], steps: [{ script: 'return await sh("sleep 1; echo PRIVATE_OUTPUT").then((r) => "ok " + String(r), (e) => e.message)' }] });
  expect(out.results[0]!.text).not.toContain('PRIVATE_OUTPUT');
  expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
});

test('Every way lean-ctx says it withheld an output is named, and never read around', () => {
  for (const said of ['[lean-ctx: content withheld — policy]', 'archive withheld by current policy']) {
    const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveWithheld: true, archiveWithheldText: said, steps: [{ script: 'const r = await sh("sleep 1; echo done")\nreturn r.exitCode' }] });
    expect(out.results[0]!.text).toMatch(/Note: [^\n]*withheld/);
    expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
  }
});

test('A command that prints a lean-ctx job reply is not taken for a detached job', () => {
  expect(one('const r = await sh("echo \'{\\"jobId\\":\\"shell_0000000000000001\\",\\"state\\":\\"running\\",\\"summary\\":\\"x\\"}\'")\nreturn r.exitCode + " " + String(r).trim()', { tools: NO_BASH })).toBe('0 {"jobId":"shell_0000000000000001","state":"running","summary":"x"}');
});

test('A lean-ctx patch batch with one top-level path keeps the read file counted', () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'red\nblue\n');
  expect(one('await read(' + JSON.stringify(f) + ')\nawait tools.mcp__lean_ctx__ctx_patch({ path: ' + JSON.stringify(f) + ', ops: [{ op: "set_line", line: 1, new_text: "RED" }] })\nreturn await write(' + JSON.stringify(f) + ', "x\\n")', { tools: NO_BASH })).toBe('wrote ' + f);
});

test('read() grows its page size again after wide lines', () => {
  const dir = scratch();
  const f = join(dir, 'mixed.txt');
  writeFileSync(f, [...Array.from({ length: 10 }, () => 'w'.repeat(20000)), ...Array.from({ length: 5000 }, (_, i) => 'row ' + i)].join('\n'));
  const out = run({ tools: NO_BASH, steps: [{ script: 'return (await read(' + JSON.stringify(f) + ')).split("\\n").length' }] });
  expect(out.results[0]!.text).toBe('5010');
  expect(out.calls.filter((c) => c.tool === 'Read').length).toBeLessThan(60);
});


test('Reserved keys never reach a tool through sh()\'s shell fill, even from a request the script writes itself', () => {
  const forged = JSON.stringify({ id: 9999, kind: 'call', payload: { tool: 'mcp__lean-ctx__ctx_shell', args: { command: 'echo forged' }, fill: { consent: { decision: 'allow' }, tool_use_id: 'toolu_forged', agentId: 'forged', raw: true } } });
  const out = run({ steps: [{ script: 'const p = quote.constructor("return process")()\np.stdout.write("\\x1eCM" + ' + JSON.stringify(forged) + ' + "\\n")\nawait sh("sleep 0.5")\nreturn 1' }] });
  const c = out.calls.find((x) => x.tool === 'mcp__lean-ctx__ctx_shell' && x.args.command === 'echo forged');
  expect(c).toBeDefined();
  expect(c!.args.consent).toBeUndefined();
  expect(c!.args.tool_use_id).toBeUndefined();
  expect(c!.args.agentId).toBeUndefined();
});

test('A detached lean-ctx job with no output passes with empty output', () => {
  expect(one('const r = await sh("sleep 1")\nreturn r.exitCode + " [" + String(r) + "]"', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('0 []');
});

test('A detached job output with a U+2028 line keeps every line', () => {
  const text = one('const r = await sh("sleep 1; perl -CS -e \'print qq(a\\\\n\\\\x{2028}b\\\\n), map { qq($_\\\\n) } 1..200\'")\nconst rows = String(r).split("\\n")\nreturn rows.length + " " + rows[1].charCodeAt(0) + rows[1].slice(1)', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, denyReadPaths: ['.txt'] });
  expect(text).toBe('203 8232b');
});

test('A detached job output with non-ASCII text keeps its line endings exactly', () => {
  expect(one('return JSON.stringify(String(await sh("sleep 1; printf \'caf\\\\303\\\\251\\\\n\'")))', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('"café\\n"');
  expect(one('return JSON.stringify(String(await sh("sleep 1; printf \'caf\\\\303\\\\251\'")))', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('"café"');
});

test('lean-ctx\'s withheld notices are named, and ordinary output that mentions one is left alone', () => {
  for (const said of ['stored output withheld by the context gateway', '[POLICY BLOCKED] Content withheld by the active context policy.', 'Tool may have completed; output withheld by policy.', '[withheld by the context gateway]']) {
    const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveWithheld: true, archiveWithheldText: said, steps: [{ script: 'const r = await sh("sleep 1; echo done")\nreturn r.exitCode' }] });
    expect(out.results[0]!.text).toMatch(/Note: [^\n]*withheld/);
    expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
  }
  expect(one('return String(await sh("echo \'src/a.rs: archive withheld by current policy\'")).trim()', { tools: NO_BASH })).toBe('src/a.rs: archive withheld by current policy');
});

test('A detached job whose single line is over ctx_expand\'s cap is read whole from its archive file', () => {
  expect(one('return String(await sh("sleep 1; printf \'%60000s\\\\n\' x | tr \' \' y")).length', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('60001');
});


test('A failed command whose output Claude Code cut in the middle is marked truncated and noted', () => {
  const text = one('const r = await sh("seq 1 5000; exit 3")\nreturn r.exitCode + " " + r.truncated', { tools: NO_BASH });
  expect(text).toMatch(/^3 true/);
  expect(text).toMatch(/Note: [^\n]*cut/);
});

test('A failed detached job polled with raw output still gives its whole output through ctx_expand', () => {
  expect(one('const r = await sh("sleep 1; seq 1 3000; exit 5")\nconst rows = String(r).trim().split("\\n")\nreturn r.exitCode + " " + rows.length + " " + rows.pop()', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ 'mcp__lean-ctx__ctx_shell': { raw: true } }) } })).toBe('5 3000 3000');
});

test('A detached job whose single line is too long even for Read comes back whole', () => {
  expect(one('return String(await sh("sleep 1; printf \'%120000s\\\\n\' x | tr \' \' y")).length', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('120001');
});

test('A detached job whose output lean-ctx withheld is marked .withheld', () => {
  expect(one('const r = await sh("sleep 1; echo done")\nreturn String(r.withheld)', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveWithheld: true })).toMatch(/^true/);
});

test('A very long detached output is paged through ctx_expand to its end, never read around it from the archive file', () => {
  const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, steps: [{ script: 'return String(await sh("sleep 1; seq 1 3000")).trim().split("\\n").length' }] });
  expect(out.results[0]!.text).toBe('3000');
  expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
});

test('A completed detached job with no exit code does not pass', () => {
  expect(one('const r = await sh("sleep 1; echo done")\nreturn String(r.ok)', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, jobNoExit: true })).toBe('false');
});

test('A detached job output ending in blank lines keeps them', () => {
  expect(one('return JSON.stringify(String(await sh("sleep 1; printf \'x\\\\n\\\\n\'")))', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('"x\\n\\n"');
  expect(one('const s = String(await sh("sleep 1; seq 1 80; echo"))\nreturn JSON.stringify(s.slice(-5))', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, denyReadPaths: ['.txt'] })).toBe('"\\n80\\n\\n"');
});

test('Successful output that holds error-wrapper tags is returned as it is', () => {
  expect(one('return String(await sh("printf \'<tool_use_error>ordinary data</tool_use_error>\'"))')).toBe('<tool_use_error>ordinary data</tool_use_error>');
});

test('Output that only mentions a withheld notice is not taken for one', () => {
  const text = one('return String(await sh("echo stored output withheld example")).trim()');
  expect(text).toBe('stored output withheld example');
});

test('A ctx_expand reply that is only a header is paged instead of taken as empty', () => {
  expect(one('return String(await sh("sleep 1; seq 1 120")).trim().split("\\n").length', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, headerOnly: true, denyReadPaths: ['.txt'] })).toBe('120');
});

test('A withheld ctx_expand page is not read around through the archive file', () => {
  const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, pageWithheld: true, steps: [{ script: 'const r = await sh("sleep 1; seq 1 120")\nreturn String(r.withheld)' }] });
  expect(out.results[0]!.text).toMatch(/^true/);
  expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
});

test('A waitFor check that fails after its timeout does not fail the run', () => {
  expect(one('try { await waitFor(async () => { await sh("sleep 0.3"); throw new Error("late") }, { timeout: 50 }) } catch {}\nawait sh("sleep 0.6")\nreturn "ok"')).toBe('ok');
});


test('A lean-ctx output over its own cap comes back whole from the archive it names', () => {
  expect(one('const r = await sh("seq 1 40000")\nconst rows = String(r).trim().split("\\n")\nreturn r.exitCode + " " + rows.length + " " + rows.pop()', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'] })).toBe('0 40000 40000');
});

test('A tool result Claude Code saved to a file instead of returning it comes back whole', () => {
  expect(one('const r = await sh("seq 1 10500")\nconst rows = String(r).trim().split("\\n")\nreturn r.exitCode + " " + rows.length + " " + rows.pop()', { tools: NO_BASH })).toBe('0 10500 10500');
  expect(one('const t = await tools.mcp__lean_ctx__ctx_shell({ command: "seq 1 10500", raw: true })\nreturn t.trim().split("\\n").length', { tools: NO_BASH })).toBe('10500');
});

test('A failed lean-ctx command over its own cap gives its whole output and its exit code', () => {
  expect(one('const r = await sh("seq 1 40000; exit 4")\nconst rows = String(r).trim().split("\\n")\nreturn r.ok + " " + r.exitCode + " " + rows.length + " " + rows.pop()', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'] })).toMatch(/^false 4 40000 40000/);
});

test('A failed detached job whose single line is over ctx_expand\'s cap is read from its archive file', () => {
  expect(one('const r = await sh("sleep 1; printf \'%20000s\\\\n\' x | tr \' \' y; exit 3")\nreturn r.exitCode + " " + String(r).length', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('3 20001');
});

test('A long failed detached job is paged through ctx_expand to its end, never read around it from the archive file', () => {
  const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, steps: [{ script: 'const r = await sh("sleep 1; seq 1 3000; exit 5")\nreturn r.exitCode + " " + String(r).trim().split("\\n").length' }] });
  expect(out.results[0]!.text).toBe('5 3000');
  expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
});

test('A withheld notice ctx_expand gives as an error is still withheld, and never read around', () => {
  const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveWithheld: true, archiveWithheldError: true, steps: [{ script: 'const r = await sh("sleep 1; echo done")\nreturn String(r.withheld)' }] });
  expect(out.results[0]!.text).toMatch(/^true/);
  expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
});

test('A foreground lean-ctx output withheld by policy is marked .withheld', () => {
  expect(one('const r = await sh("echo hi")\nreturn String(r.withheld) + " " + String(r.truncated)', { tools: NO_BASH, shellWithheld: true })).toMatch(/^true true/);
});

test('A failed detached job without ctx_expand keeps its output\'s exact ending', () => {
  expect(one('return JSON.stringify(String(await sh("sleep 1; printf \'x\\\\n\\\\n\'; exit 3")))', { tools: NO_BASH, detachAfterMs: 300 })).toBe('"x\\n\\n"');
  expect(one('return JSON.stringify(String(await sh("sleep 1; printf x; exit 3")))', { tools: NO_BASH, detachAfterMs: 300 })).toBe('"x"');
});

test('A failed detached job whose inline output Claude Code cut is marked truncated and noted', () => {
  const text = one('const r = await sh("sleep 1; seq 1 5000; exit 3")\nreturn r.exitCode + " " + r.truncated', { tools: NO_BASH, detachAfterMs: 300, env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ 'mcp__lean-ctx__ctx_shell': { raw: true } }) } });
  expect(text).toMatch(/^3 true/);
  expect(text).toMatch(/Note: [^\n]*cut/);
});

test('A failed detached job keeps its whole inline output when ctx_expand is refused', () => {
  expect(one('const r = await sh("sleep 1; echo hi; exit 3")\nreturn r.exitCode + " " + String(r).trim()', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], denied: ['mcp__lean-ctx__ctx_expand'], detachAfterMs: 300 })).toBe('3 hi');
});

test('A ctx_expand reply with a header and an empty body is paged', () => {
  expect(one('return JSON.stringify(String(await sh("sleep 1; echo hello")))', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, expandEmptyBody: true, denyReadPaths: ['.txt'] })).toBe('"hello\\n"');
});

test('A lean-ctx patch batch that creates a file and then changes it leaves it counted as read', () => {
  const f = join(scratch(), 'fresh.txt');
  expect(one('await tools.mcp__lean_ctx__ctx_patch({ ops: [{ op: "create", path: ' + JSON.stringify(f) + ', new_text: "red\\n" }, { op: "replace_unique", path: ' + JSON.stringify(f) + ', old_text: "red", new_text: "blue" }] })\nawait edit(' + JSON.stringify(f) + ', "blue", "green")\nreturn 1', { tools: NO_BASH })).toBe('1');
  expect(readFileSync(f, 'utf8')).toBe('green\n');
});

test('A raw text block after a labelled or case block is still taken out', () => {
  expect(one('lbl: {}\n/`/.test("a")\n// @text hi\nhello\n// @end\nreturn TEXT.hi')).toBe('hello');
  expect(one('switch (0) {\ncase 0: {}\n/`/.test("a")\n}\n// @text hi\nhello\n// @end\nreturn TEXT.hi')).toBe('hello');
});

test('lean-ctx\'s own advice line after a command\'s output is left out', () => {
  expect(one('return JSON.stringify(String(await sh("printf abc")))', { tools: NO_BASH, shellAdvice: '[ctx_shell: bare `cat` redirected to ctx_read for inline delivery. Use ctx_read(path=x) directly next time.]' })).toBe('"abc"');
});


test('A saved Bash output read back short in byte ranges is not passed off as whole', () => {
  const text = one('return String(await sh("printf %40000s x | tr \' \' y")).length', { persistBash: true, bytesShort: true });
  expect(text).not.toMatch(/^39/);
  expect(text).toMatch(/Note: Bash saved a big output/);
});

test('A detached job whose long line holds bytes that are not UTF-8 fails instead of guessing them', () => {
  const archiveBytes = Buffer.concat([Buffer.from('y'.repeat(120000)), Buffer.from([0xff, 0x0a])]).toString('base64');
  expect(one('return String(await sh("sleep 1; echo stand-in")).length', { tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveBytes })).toMatch(/could not be read/);
});

test('A tool result Claude Code saved under another format label is still read back whole', () => {
  expect(one('return String(await sh("seq 1 10500")).trim().split("\\n").length', { tools: NO_BASH, swapFormat: 'JSON' })).toBe('10500');
});


test('A withheld notice longer than 600 chars is still withheld, and never read around', () => {
  const said = '[lean-ctx gateway: retained output withheld by storage policy] ' + 'reason '.repeat(120);
  const out = run({ tools: [...NO_BASH, 'mcp__lean-ctx__ctx_expand'], detachAfterMs: 300, archiveWithheld: true, archiveWithheldText: said, steps: [{ script: 'const r = await sh("sleep 1; echo done")\nreturn String(r.withheld)' }] });
  expect(out.results[0]!.text).toMatch(/^true/);
  expect(out.calls.some((c) => c.tool === 'Read' && String(c.args.file_path).includes('lean-ctx/archives'))).toBe(false);
});


test('read() goes on past a page shorter than it asked for while Read says more lines remain', () => {
  const f = join(scratch(), 'long.txt');
  writeFileSync(f, Array.from({ length: 3000 }, (_, i) => 'row ' + i).join('\n') + '\n');
  expect(one('return (await read(' + JSON.stringify(f) + ')).split("\\n").length', { tools: NO_BASH, shortPages: 700 })).toBe('3001');
});

test('A run answers at once with its id while its command still runs, and its output comes back after the turn ends', () => {
  const out = run({ steps: [{ script: 'const r = await sh("sleep 2; echo late-output")\nreturn String(r).trim()' }] });
  const r = out.results[0]!;
  expect(r.immediate).toMatch(/^Started r\d+ in the background\.$/);
  expect(r.text).toBe('late-output');
});

test('Ending the turn hands back only a notice naming the finished runs, and their output comes back as the reply to an empty-script run', () => {
  const out = run({ steps: [{ script: 'return "secret-tool-text"' }] });
  const id = out.results[0]!.id!;
  expect(out.stops[0]).toContain(id);
  expect(out.stops[0]).toContain('empty script');
  expect(out.stops[0]).not.toContain('secret-tool-text');
  expect(out.collected[0]).toContain('[' + id + ' finished after');
  expect(out.results[0]!.text).toBe('secret-tool-text');
});

test('An empty script starts no run and says when nothing has finished yet', () => {
  const out = run({ steps: [{ collect: true }] });
  expect(out.collected[0]).toBe('No run has finished output waiting.');
});

test('A run that finished before the next run comes back with that next run\'s reply, and only once', () => {
  const out = run({ steps: [{ script: 'return "first-output"', keepTurn: true }, { untilRunsDone: true }, { script: 'return "second-output"' }] });
  expect(out.results[1]!.immediate).toContain('[' + out.results[0]!.id + ' finished after');
  expect(out.results[0]!.text).toBe('first-output');
  expect(out.results[1]!.text).toBe('second-output');
  expect(out.collected.join('\n')).not.toContain('first-output');
});

test('A subagent\'s turn end hands back only its own runs and does not wait for the main session\'s', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "main-output"', keepTurn: true }, { script: 'return "agent-output"', agentId: 'a1' }, { touch: gate }, { stop: true }] });
  expect(out.results[1]!.text).toBe('agent-output');
  expect(out.stops[0]).not.toContain(out.results[0]!.id!);
  expect(out.results[0]!.text).toBe('main-output');
});

test('A subagent\'s runs still going when its turn ends are stopped and never handed to anyone', () => {
  const out = run({ steps: [{ script: 'await sh("sleep 60")\nreturn "agent-late"', agentId: 'a1', keepTurn: true }, { untilTool: 'Bash' }, { agentEnd: 'a1' }, { untilRunsDone: true }, { script: 'return "main"' }] });
  expect(out.kills).toHaveLength(1);
  expect(out.results[1]!.immediate).not.toContain('agent-late');
  expect(out.results[1]!.immediate).not.toContain(out.results[0]!.id! + ' ');
});

test('A subagent stop with no agent id holds nothing', () => {
  const out = run({ steps: [{ script: 'await sh("sleep 60")\nreturn 1', agentId: 'a1', keepTurn: true }, { subagentStopWithoutId: true }] });
  expect(out.stops[0]).toBe('');
});

test('jobs() lists the caller\'s other runs still going', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn 1', keepTurn: true }, { untilTool: 'Bash' }, { script: 'return (await jobs()).map((j) => j.id + " " + j.state).join(",")', keepTurn: true }, { untilRunDone: 'r2' }, { touch: gate }, { stop: true }] });
  expect(out.results[1]!.text).toBe(out.results[0]!.id + ' running');
});

test('cancel(id) stops a running run, which comes back marked as cancelled without its command\'s output', () => {
  const out = run({ steps: [{ script: 'return String(await sh("sleep 20; printf never-%s printed"))', keepTurn: true }, { untilTool: 'Bash' }, { script: 'return String(await cancel("r1"))' }] });
  expect(out.results[1]!.text).toBe('true');
  expect(out.results[0]!.text).toContain('[cancelled]');
  expect(out.results[0]!.text).not.toContain('never-printed');
});

test('cancel() right after a run starts still stops it', () => {
  const out = run({ steps: [{ script: 'return String(await sh("sleep 20; echo never-printed"))', keepTurn: true }, { script: 'return String(await cancel("r1"))' }] });
  expect(out.results[1]!.text).toBe('true');
  expect(out.results[0]!.text).toContain('[cancelled]');
});

test('A stopped run names the tool calls still running when it was stopped', () => {
  const out = run({ steps: [{ script: 'return String(await sh("sleep 20"))', keepTurn: true }, { untilTool: 'Bash' }, { script: 'return String(await cancel("r1"))' }] });
  expect(out.results[0]!.text).toContain('still running when it was stopped');
  expect(out.results[0]!.text).toMatch(/still running when it was stopped[^\n]*Bash \(/);
});

test('A run cannot cancel itself', () => {
  expect(run({ steps: [{ script: 'return await cancel("r1").catch((e) => e.message)' }] }).results[0]!.text).toContain('a run cannot cancel itself');
});

test('cancel() of a run whose output already came back returns false', () => {
  const out = run({ steps: [{ script: 'return 1', keepTurn: true }, { untilRunsDone: true }, { script: 'return String(await cancel("r1"))' }] });
  expect(out.results[1]!.text).toBe('false');
});

test('A cancelled run run again and failing is not reported as the same failed script', () => {
  const dir = scratch();
  const second = join(dir, 'second');
  const never = join(dir, 'never');
  const script = 'if ((await sh("test -f ' + second + '")).ok) throw new Error("second-try-broke")\nawait waitFor(() => sh("test -f ' + never + '"), { timeout: 20000 })\nreturn 1';
  const out = run({ steps: [{ script, keepTurn: true }, { untilTool: 'Bash' }, { script: 'return String(await cancel("r1"))', keepTurn: true }, { untilRunsDone: true }, { touch: second }, { script }] });
  expect(out.results[0]!.text).toContain('[cancelled]');
  expect(out.results[2]!.text).toContain('second-try-broke');
  expect(out.results[2]!.text).not.toContain('same script');
});
test('cancel() refuses a run of another agent and an id that names no run', () => {
  const out = run({ steps: [{ script: 'await sh("sleep 20")\nreturn 1', agentId: 'a1', keepTurn: true }, { untilTool: 'Bash' }, { script: 'const mine = await cancel("r999").catch((e) => e.message)\nconst other = await cancel("' + 'r1' + '").catch((e) => e.message)\nreturn [mine, other].join(" | ")' }, { stop: true }] });
  expect(out.results[1]!.text).toContain('there is no run r999 here');
  expect(out.results[1]!.text).toContain('there is no run r1 here');
});

test('cancel() of a run that has exited but not yet come back returns false', () => {
  const out = run({ slowWritesMs: 1500, steps: [{ script: 'return "x".repeat(30000)', keepTurn: true }, { script: 'await waitFor(async () => (await jobs()).some((j) => j.state === "finishing"), { timeout: 20000, every: 20 })\nreturn String(await cancel((await jobs())[0].id))' }, { stop: true }] });
  expect(out.results[1]!.text).toBe('false');
  expect(out.results[0]!.text).not.toContain('[cancelled]');
});

test('Interrupting the turn stops its runs, which come back marked aborted with the next run\'s reply, and wakes nothing', () => {
  const out = run({ surfaces: ['terminal'], steps: [{ script: 'return String(await sh("sleep 30; printf never-%s printed"))', keepTurn: true }, { untilTool: 'Bash' }, { stop: true, interrupt: true }, { untilRunsDone: true }, { script: 'return "after"', keepTurn: true }] });
  expect(out.wakeAttempts).toBe(0);
  expect(out.results[1]!.immediate).toContain('[' + out.results[0]!.id + ' stopped after');
  expect(out.results[0]!.text).toContain('[aborted]');
  expect(out.results[0]!.text).not.toContain('never-printed');
});

test('In a session a person is watching, ending the turn does not wait for a run, and a wake prompt names it once it finishes', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ surfaces: ['terminal'], steps: [{ script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "watched-output"', keepTurn: true }, { stop: true }, { touch: gate }, { untilWake: true }, { collect: true }] });
  expect(out.stops).toHaveLength(0);
  expect(out.submitted).toHaveLength(1);
  expect(out.submitted[0]).toContain(out.results[0]!.id!);
  expect(out.submitted[0]).not.toContain('watched-output');
  expect(out.results[0]!.text).toBe('watched-output');
});

test('A wake prompt the engine refuses leaves the output for the next run\'s reply', () => {
  const out = run({ surfaces: ['terminal'], submitRefusals: 1, steps: [{ script: 'await sh("sleep 1")\nreturn "kept-output"' }, { untilWake: true }, { script: 'return 2', keepTurn: true }] });
  expect(out.wakeAttempts).toBeGreaterThanOrEqual(1);
  expect(out.submitted).toHaveLength(0);
  expect(out.results[1]!.immediate).toContain('kept-output');
});

test('Two runs that finish while the session is idle each come back exactly once', () => {
  const out = run({ surfaces: ['terminal'], steps: [{ script: 'await sh("sleep 1")\nreturn "one-output"', keepTurn: true }, { script: 'await sh("sleep 1")\nreturn "two-output"', keepTurn: true }, { stop: true }, { untilRunsDone: true }, { collect: true }, { collect: true }] });
  const all = out.collected.join('\n');
  expect(out.submitted.join('\n')).toContain(out.results[0]!.id!);
  expect(all.split('one-output').length - 1).toBe(1);
  expect(all.split('two-output').length - 1).toBe(1);
});

test('A new session never gets the output of a run started in the session before it', () => {
  const out = run({ steps: [{ script: 'return "old-session-output"', keepTurn: true }, { untilRunsDone: true }, { newSession: true }, { script: 'return "new"' }] });
  expect(out.results[1]!.immediate).not.toContain('old-session-output');
  expect(out.results[1]!.text).toBe('new');
});

test('A file one run read cannot be written by another run before the first run\'s output is back', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'v1\n');
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ script: 'await read(' + JSON.stringify(file) + ')\nawait waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "read-done"', keepTurn: true }, { untilTool: 'Read' }, { script: 'const r = await call("Write", { file_path: ' + JSON.stringify(file) + ', content: "v2\\n" })\nreturn r.error', keepTurn: true }, { untilRunDone: 'r2' }, { touch: gate }, { stop: true }] });
  expect(out.results[1]!.text).toContain('File has not been read yet');
  expect(readFileSync(file, 'utf8')).toBe('v1\n');
});

test('Finished runs past one reply\'s room wait for the next reply instead of making one huge reply', () => {
  const out = run({ steps: [{ script: 'return "A".repeat(15000)', keepTurn: true }, { script: 'return "B".repeat(15000)', keepTurn: true }, { untilRunsDone: true }, { collect: true }, { collect: true }] });
  expect(out.collected[0]!.length).toBeLessThan(21000);
  expect(out.collected[0]).toContain('A'.repeat(15000));
  expect(out.collected[0]).toContain(out.results[1]!.id + ' finished too');
  expect(out.collected[1]).toContain('B'.repeat(15000));
});

test('A picture a finished run shows comes back attached to the next run\'s reply', () => {
  const tools = ['Read', 'Bash', 'mcp__shots__snap'];
  const out = run({ tools, steps: [{ script: 'const s = await tools.mcp__shots__snap({})\nreturn "look " + s', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[image #1 image/png');
  expect(out.collectedAttachments[0]).toBe(1);
});

test('Ending the turn leaves no waiting process behind', () => {
  const out = run({ steps: [{ script: 'await sh("sleep 1")\nreturn "done"' }] });
  expect(out.results[0]!.text).toBe('done');
  expect(out.waitsAlive).toBe(0);
});

test('The run tool tells the model its runs go to the background and how their output comes back', () => {
  const out = run({ steps: [] });
  expect(out.description).toContain('Every run goes to the background');
  expect(out.description).toContain('empty script');
  expect(out.description).toContain('jobs()');
  expect(out.description).toContain('cancel(id)');
});

test('An empty script while runs are still going tells the model to end its turn instead of asking again', () => {
  const out = run({ steps: [{ script: 'await sh("sleep 3")\nreturn 1', keepTurn: true }, { untilTool: 'Bash' }, { collect: true }, { stop: true }] });
  expect(out.collected[0]).toContain('Still running: ' + out.results[0]!.id);
  expect(out.collected[0]).toContain('end your turn');
  expect(out.collected[0]).toContain('do not call again to check');
});

test('One reply attaches at most 10 pictures, and a run whose pictures do not fit waits for the next reply', () => {
  const tools = ['Read', 'Bash', 'mcp__shots__snap'];
  const six = 'const s = await Promise.all([1, 2, 3, 4, 5, 6].map(() => tools.mcp__shots__snap({})))\nreturn s.join(" ")';
  const out = run({ tools, steps: [{ script: six, keepTurn: true }, { script: six, keepTurn: true }, { untilRunsDone: true }, { collect: true }, { collect: true }] });
  expect(out.collectedAttachments).toEqual([6, 6]);
  expect(out.collected[0]).toContain(', 6 attachments]');
  expect(out.collected[0]).toContain('finished too');
});

test('A stop the session interrupts while it waits keeps finished output for the next run', () => {
  const out = run({ steps: [{ script: 'await sh("sleep 1")\nreturn "kept-through-abort"', keepTurn: true }, { script: 'await sh("sleep 30")\nreturn 1', keepTurn: true }, { untilRunDone: 'r1' }, { stopAborted: true }, { collect: true }] });
  expect(out.stops[0]).toBe('');
  expect(out.collected[0]).toContain('kept-through-abort');
});

test('A turn that ended earlier cannot mark a newer turn idle', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ surfaces: ['terminal'], steps: [{ turnStart: 't1' }, { script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn 1', keepTurn: true }, { turnStart: 't2' }, { turnComplete: 't1' }, { touch: gate }, { untilRunsDone: true }] });
  expect(out.wakeAttempts).toBe(0);
});

test('A run that finishes during a watched turn wakes the session when that turn ends', () => {
  const out = run({ surfaces: ['terminal'], steps: [{ script: 'return "early-output"', keepTurn: true }, { untilRunsDone: true }, { stop: true }, { untilWake: true }, { collect: true }] });
  expect(out.submitted).toHaveLength(1);
  expect(out.submitted[0]).toContain(out.results[0]!.id!);
  expect(out.collected[0]).toContain('early-output');
});

test('Two runs reading the same long file at once each count it as read for their own writes', () => {
  const dir = scratch();
  const file = join(dir, 'long.txt');
  writeFileSync(file, Array.from({ length: 5000 }, (_, i) => 'line ' + i).join('\n') + '\n');
  const f = JSON.stringify(file);
  const [read1, read2, write1, write2] = ['read1', 'read2', 'write1', 'write2'].map((n) => join(dir, n));
  const gate = (p: string) => 'await waitFor(() => sh("test -f ' + p + '"), { timeout: 20000 })';
  const out = run({ readDelayMs: 30, steps: [
    { script: 'await read(' + f + ')\nawait sh("touch ' + read1 + '")\n' + gate(write1) + '\nawait write(' + f + ', "first\\n")\nreturn "wrote"', keepTurn: true },
    { script: 'await read(' + f + ')\nawait sh("touch ' + read2 + '")\n' + gate(write2) + '\nconst r = await call("Write", { file_path: ' + f + ', content: "second\\n" })\nreturn r.error', keepTurn: true },
    { untilFile: read1 }, { untilFile: read2 }, { touch: write1 }, { untilRunDone: 'r1' }, { touch: write2 }, { untilRunDone: 'r2' }, { collect: true },
  ] });
  expect(out.results[0]!.text).toBe('wrote');
  expect(out.results[1]!.text).toContain('modified since read');
  expect(readFileSync(file, 'utf8')).toBe('first\n');
});
test('The run tool\'s description fits in the 4,096 characters the engine hands the model, even with every common tool and denials listed', () => {
  const tools = ['Read', 'Bash', 'Write', 'Edit', 'Skill', 'ToolSearch', 'Agent', 'AskUserQuestion', 'mcp__lean-ctx__ctx_shell', 'mcp__lean-ctx__ctx_patch'];
  const store = { denied: { Bash: { alt: 'mcp__lean-ctx__ctx_shell', at: Date.now() }, Write: { alt: 'mcp__lean-ctx__ctx_patch', at: Date.now() }, Edit: { alt: 'mcp__lean-ctx__ctx_patch', at: Date.now() } } };
  const out = run({ tools, store, steps: [] });
  expect(out.description).toContain('denied by a hook here');
  expect(out.description.length).toBeLessThanOrEqual(4096);
});

test('After /clear, a run from before is stopped and its output never reaches the new conversation', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "old-conversation-output"', keepTurn: true }, { untilTool: 'Bash' }, { clear: true }, { touch: gate }, { untilRunsDone: true }, { script: 'return "new"' }] });
  expect(out.kills).toHaveLength(1);
  expect(out.results[1]!.immediate).not.toContain('old-conversation-output');
  expect(out.results[1]!.immediate).not.toContain(out.results[0]!.id! + ' ');
});

test('Reloading the mod in the middle of a session leaves its running runs alone', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "survived-reload"', keepTurn: true }, { untilTool: 'Bash' }, { reload: true }, { touch: gate }, { untilRunsDone: true }, { collect: true }] });
  expect(out.kills).toHaveLength(0);
  expect(out.collected[0]).toContain('survived-reload');
});

test('Esc stops only the interrupted turn\'s runs, and a run from an earlier turn still finishes and wakes the session', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ surfaces: ['terminal'], steps: [{ turnStart: 't1' }, { script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "earlier-turn-output"', keepTurn: true }, { turnComplete: 't1' }, { turnStart: 't2' }, { script: 'return String(await sh("sleep 30"))', keepTurn: true }, { untilTool: 'Bash' }, { turnAborted: 't2' }, { touch: gate }, { untilWake: true }, { collect: true }] });
  expect(out.submitted[0]).toContain(out.results[0]!.id!);
  expect(out.submitted[0]).not.toContain(out.results[1]!.id!);
  expect(out.collected[0]).toContain('[' + out.results[0]!.id + ' finished after');
  expect(out.collected[0]).toContain('earlier-turn-output');
  expect(out.collected[0]).toContain('[' + out.results[1]!.id + ' stopped after');
});

test('Runs finishing together while the session is idle are each named in exactly one wake prompt', () => {
  const out = run({ surfaces: ['terminal'], submitDelayMs: 500, steps: [{ script: 'await sh("true")\nreturn 1', keepTurn: true }, { script: 'await sh("true")\nreturn 2', keepTurn: true }, { stop: true }, { untilRunsDone: true }, { untilWake: true }, { collect: true }] });
  const named = out.submitted.join('\n');
  const times = (id: string) => (named.match(new RegExp('\\b' + id + '\\b', 'g')) ?? []).length;
  expect(times(out.results[0]!.id!)).toBe(1);
  expect(times(out.results[1]!.id!)).toBe(1);
});

test('Ending the turn does not hang on a run that stalls before its runner starts, and that run comes back as never started', () => {
  const out = run({ hangListDuringRuns: true, steps: [{ script: '// @options: {"timeout_ms": 1000}\nreturn 1' }] });
  expect(out.stops[0]).toContain(out.results[0]!.id!);
  expect(out.results[0]!.text).toContain('never started its runner');
});

test('A run that does not fit the reply stays named at the turn\'s end until it has come back', () => {
  const out = run({ steps: [{ script: 'return "A".repeat(15000)', keepTurn: true }, { script: 'return "B".repeat(15000)', keepTurn: true }, { untilRunsDone: true }, { stop: true }, { collect: true }] });
  expect(out.stops[0]).toContain(out.results[0]!.id!);
  expect(out.stops[1]).toContain(out.results[1]!.id!);
  expect(out.collected.join('')).toContain('B'.repeat(15000));
});

test('Finished runs come back in the order they started, even when a later one would fit sooner', () => {
  const out = run({ steps: [{ script: 'return "A".repeat(15000)', keepTurn: true }, { script: 'return "B".repeat(15000)', keepTurn: true }, { script: 'return "small-third"', keepTurn: true }, { untilRunsDone: true }, { collect: true }, { collect: true }] });
  expect(out.collected[0]).not.toContain('small-third');
  expect(out.collected[1]).toContain('small-third');
});

test('One reply with finished runs never passes 20,000 characters', () => {
  const out = run({ steps: [{ script: 'return "A".repeat(9970)', keepTurn: true }, { script: 'return "B".repeat(9970)', keepTurn: true }, { untilRunsDone: true }, { script: 'return 1', keepTurn: true }, { collect: true }] });
  expect(out.results[2]!.immediate!.length).toBeLessThanOrEqual(20000);
  expect(out.collected.join('') + out.results[2]!.immediate).toContain('B'.repeat(9970));
});

test('A run cancelled while its write is still being checked never writes the file', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const [readDone, go] = ['read-done', 'go'].map((n) => join(dir, n));
  const out = run({ statDelayMs: 1500, steps: [{ script: 'await read(' + f + ')\nawait sh("touch ' + readDone + '")\nawait waitFor(() => sh("test -f ' + go + '"), { timeout: 20000 })\nawait call("Write", { file_path: ' + f + ', content: "overwritten\\n" })\nreturn "wrote"', keepTurn: true }, { untilFile: readDone }, { touch: go }, { untilStatPending: true }, { script: 'return String(await cancel("r1"))', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.results[1]!.text).toBe('true');
  expect(readFileSync(file, 'utf8')).toBe('original\n');
});

test('A run Esc stopped is never named at a later turn\'s end, and still comes back with the next reply', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ turnStart: 't1' }, { script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn 1', keepTurn: true }, { untilTool: 'Bash' }, { turnAborted: 't1' }, { untilRunDone: 'r1' }, { turnStart: 't2' }, { stop: true }, { collect: true }] });
  expect(out.stops).toHaveLength(0);
  expect(out.collected[0]).toContain('[r1 stopped after');
});

test('A stop interrupted in the middle of its wait leaves no waiting process and keeps the output', () => {
  const out = run({ steps: [{ script: 'await sh("true")\nreturn "kept-mid-wait"', keepTurn: true }, { script: 'return String(await sh("sleep 30"))', keepTurn: true }, { untilRunDone: 'r1' }, { untilTool: 'Bash' }, { stopAbortAfterMs: 300 }, { collect: true }] });
  expect(out.stops[0]).toBe('');
  expect(out.collected[0]).toContain('kept-mid-wait');
  expect(out.waitsAlive).toBe(0);
});

test('A run reported as never started stays unstarted when its stall clears later', () => {
  const dir = scratch();
  const mark = join(dir, 'ran-anyway');
  const out = run({ hangListMs: 13000, steps: [{ script: '// @options: {"timeout_ms": 1000}\nawait sh("touch ' + mark + '")\nreturn 1' }, { untilQuiet: true }] });
  expect(out.results[0]!.text).toContain('never started its runner');
  expect(out.runnersSpawned).toBe(0);
  expect(existsSync(mark)).toBe(false);
});

test('Waiting at the turn\'s end for a run that has no runner yet starts only a few wait processes', () => {
  const out = run({ hangListMs: 13000, steps: [{ script: '// @options: {"timeout_ms": 1000}\nreturn 1' }] });
  expect(out.results[0]!.text).toContain('never started its runner');
  expect(out.bashWaits).toBeLessThanOrEqual(4);
});

test('A run\'s reply names at most nine other runs still going', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const wait = { script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 30000 })\nreturn 1', keepTurn: true };
  const out = run({ steps: [...Array.from({ length: 12 }, () => wait), { touch: gate }, { untilRunsDone: true }, { collect: true }] });
  expect(out.results[11]!.immediate).toContain('and 2 more');
  expect((out.results[11]!.immediate!.match(/\br\d+ \(/g) ?? []).length).toBe(9);
});

test('In a watched session a run that never starts its runner in time comes back as never started and stays unstarted', () => {
  const dir = scratch();
  const mark = join(dir, 'ran-anyway');
  const out = run({ surfaces: ['terminal'], hangListMs: 13000, steps: [{ script: '// @options: {"timeout_ms": 1000}\nawait sh("touch ' + mark + '")\nreturn 1' }, { untilWake: true }, { collect: true }, { untilQuiet: true }] });
  expect(out.collected[0]).toContain('[r1 stopped after');
  expect(out.collected[0]).toContain('never started its runner');
  expect(out.runnersSpawned).toBe(0);
  expect(existsSync(mark)).toBe(false);
});

test('Two runs writing the same file at once never both pass the read check', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const [a, b, go] = ['a-read', 'b-read', 'go'].map((n) => join(dir, n));
  const writer = (mine: string, marker: string) => 'await read(' + f + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { timeout: 20000, every: 20 })\nconst r = await call("Write", { file_path: ' + f + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const out = run({ engineForgets: true, writeDelayMs: 800, steps: [{ script: writer('from-a', a), keepTurn: true }, { script: writer('from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('modified since read');
});

test('Esc on an older turn stops that turn\'s runs even after a newer turn started', () => {
  const out = run({ steps: [{ turnStart: 't1' }, { script: 'return String(await sh("sleep 30"))', keepTurn: true }, { untilTool: 'Bash' }, { turnStart: 't2' }, { turnAborted: 't1' }, { untilRunDone: 'r1' }, { collect: true }] });
  expect(out.kills).toHaveLength(1);
  expect(out.collected[0]).toContain('[r1 stopped after');
});

test('A cancelled run makes no follow-up tool call after cancel() returns', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'nope.text'), 'near miss\n');
  const out = run({ cwd: dir, home: dir, readDelayMs: 1500, steps: [{ script: 'return await read(' + JSON.stringify(join(dir, 'nope.txt')) + ').catch((e) => e.message)', keepTurn: true }, { untilTool: 'Read' }, { script: 'return String(await cancel("r1"))', keepTurn: true }, { untilRunsDone: true }, { collect: true }, { untilQuiet: true }] });
  expect(out.results[1]!.text).toBe('true');
  expect(out.calls.filter((x) => x.tool === 'Read')).toHaveLength(1);
});

test('A run\'s own output plus its header fits in 20,000 characters at the default limit', () => {
  const out = run({ steps: [{ script: 'return "Z".repeat(19990)', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]!.length).toBeLessThanOrEqual(20000);
  expect(out.collected[0]).toContain('chars cut');
});

test('A headless run that finishes after its stop was interrupted wakes nothing', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn 1', keepTurn: true }, { untilTool: 'Bash' }, { stopAbortAfterMs: 200 }, { turnComplete: 'turn' }, { touch: gate }, { untilRunsDone: true }] });
  expect(out.wakeAttempts).toBe(0);
});

test('What a stopped run read never counts as read for later writes', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'v1\n');
  const f = JSON.stringify(file);
  const mark = join(dir, 'read');
  const out = run({ steps: [{ script: 'await read(' + f + ')\nawait sh("touch ' + mark + '")\nreturn String(await sh("sleep 30"))', keepTurn: true }, { untilFile: mark }, { script: 'return String(await cancel("r1"))', keepTurn: true }, { untilRunsDone: true }, { collect: true }, { script: 'const r = await call("Write", { file_path: ' + f + ', content: "v2\\n" })\nreturn r.error', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.results[2]!.text).toContain('File has not been read yet');
  expect(readFileSync(file, 'utf8')).toBe('v1\n');
});

test('Reloading the mod keeps what earlier runs read', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'v1\n');
  const f = JSON.stringify(file);
  const out = run({ steps: [{ script: 'await read(' + f + ')\nreturn 1', keepTurn: true }, { untilRunsDone: true }, { collect: true }, { reload: true }, { script: 'const r = await call("Write", { file_path: ' + f + ', content: "v2\\n" })\nreturn r.ok ? "wrote" : r.error', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.results[1]!.text).toBe('wrote');
});

test('A start deadline whose timer fires a little early still expires the stalled run', () => {
  const dir = scratch();
  const mark = join(dir, 'ran-anyway');
  const out = run({ surfaces: ['terminal'], clockEarlyMs: 50, hangListMs: 13000, steps: [{ script: '// @options: {"timeout_ms": 1000}\nawait sh("touch ' + mark + '")\nreturn 1' }, { untilWake: true }, { collect: true }, { untilQuiet: true }] });
  expect(out.collected[0]).toContain('[r1 stopped after');
  expect(out.collected[0]).toContain('never started its runner');
  expect(out.runnersSpawned).toBe(0);
  expect(existsSync(mark)).toBe(false);
});

test('A run with a small max_output_chars comes back within it, header included', () => {
  const out = run({ steps: [{ script: '// @options: {"max_output_chars": 1000}\nreturn "Q".repeat(5000)', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]!.length).toBeLessThanOrEqual(1000);
  expect(out.collected[0]).toContain('chars cut');
});

test('A run\'s reply with nine other runs named and a finished run in it stays within 20,000 characters', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const wait = { script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 30000 })\nreturn 1', keepTurn: true };
  const out = run({ steps: [...Array.from({ length: 10 }, () => wait), { script: 'return "W".repeat(19990)', keepTurn: true }, { untilRunDone: 'r11' }, { script: 'return 1', keepTurn: true }, { touch: gate }, { untilRunsDone: true }, { collect: true }] });
  expect(out.results[11]!.immediate).toContain('[r11 finished after');
  expect(out.results[11]!.immediate!.length).toBeLessThanOrEqual(20000);
});

test('Esc with no turn ids stops only the runs the interrupted turn started', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const out = run({ steps: [{ turnStart: '' }, { script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 30000 })\nreturn "earlier-kept"', keepTurn: true }, { turnComplete: '' }, { turnStart: '' }, { script: 'return String(await sh("sleep 30"))', keepTurn: true }, { untilTool: 'Bash' }, { turnAborted: '' }, { touch: gate }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[r1 finished after');
  expect(out.collected[0]).toContain('earlier-kept');
  expect(out.collected[0]).toContain('[r2 stopped after');
});

test('A run whose deadline timer never fires still never starts its runner once the deadline has passed', () => {
  const dir = scratch();
  const mark = join(dir, 'ran-anyway');
  const out = run({ surfaces: ['terminal'], clockFrozen: true, hangListMs: 13000, steps: [{ script: '// @options: {"timeout_ms": 1000}\nawait sh("touch ' + mark + '")\nreturn 1', keepTurn: true }, { untilQuiet: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[r1 stopped after');
  expect(out.collected[0]).toContain('never started its runner');
  expect(out.runnersSpawned).toBe(0);
  expect(existsSync(mark)).toBe(false);
});

test('Two runs writing one file through a symlink and its real path never both pass the read check', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  const link = join(dir, 'link.txt');
  writeFileSync(file, 'original\n');
  const [a, b, go] = ['a-read', 'b-read', 'go'].map((n) => join(dir, n));
  const writer = (path: string, mine: string, marker: string) => 'await read(' + JSON.stringify(path) + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { timeout: 20000, every: 20 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const out = run({ engineForgets: true, writeDelayMs: 800, steps: [{ link: { from: link, to: file } }, { script: writer(file, 'from-a', a), keepTurn: true }, { script: writer(link, 'from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('modified since read');
});

test('A write whose path comes from tool defaults is locked like any other', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const [a, b, go] = ['a-read', 'b-read', 'go'].map((n) => join(dir, n));
  const gate = (marker: string) => 'await read(' + f + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { timeout: 20000, every: 20 })\n';
  const out = run({ engineForgets: true, writeDelayMs: 800, env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ Write: { file_path: file } }) }, steps: [{ script: gate(a) + 'const r = await call("Write", { content: "from-a\\n" })\nreturn r.ok ? "wrote" : r.error', keepTurn: true }, { script: gate(b) + 'const r = await call("Write", { file_path: ' + f + ', content: "from-b\\n" })\nreturn r.ok ? "wrote" : r.error', keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
});

test('A saved output of a run not yet back survives the spill clean-up and can be read back', () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const big = (c: string) => '// @options: {"max_output_chars": 25000}\nreturn "' + c + '".repeat(30000)';
  const out = run({ steps: [
    { script: big('S'), keepTurn: true }, { script: big('U'), keepTurn: true }, { untilRunsDone: true },
    { script: '// @options: {"max_output_chars": 25000}\nawait waitFor(() => sh("test -f ' + gate + '"), { every: 20, timeout: 20000 })\nreturn "T".repeat(30000)', keepTurn: true },
    { ageSpills: true }, { touch: gate }, { untilRunDone: 'r3' }, { collect: true },
  ] });
  expect(out.results[2]!.immediate).toContain('[r1 finished after');
  expect(out.results[2]!.immediate).not.toContain('[r2 finished after');
  const r2 = out.collected.join('').split('[r2 finished after')[1] ?? '';
  const named = /file_path: "([^"]+\.txt)"/.exec(r2)?.[1];
  expect(named).toBeDefined();
  expect(readFileSync(named!, 'utf8')).toContain('U'.repeat(30000));
});

test('Esc on a turn while a newer turn starts never marks the newer turn idle', () => {
  const dir = scratch();
  const [gate, started] = ['gate', 'started'].map((n) => join(dir, n));
  const out = run({ surfaces: ['terminal'], killDelayMs: 600, steps: [
    { turnStart: 't0' },
    { script: 'await waitFor(() => sh("test -f ' + gate + '"), { every: 20, timeout: 30000 })\nreturn "earlier"', keepTurn: true },
    { turnComplete: 't0' },
    { turnStart: 't1' },
    { script: 'await sh("touch ' + started + '")\nreturn String(await sh("sleep 30"))', keepTurn: true },
    { untilFile: started },
    { abortAndStart: { abort: 't1', start: 't2' } },
    { touch: gate }, { untilRunDone: 'r1' }, { untilQuiet: true },
  ] });
  expect(out.wakeAttempts).toBe(0);
});

test('Esc on a run still stuck before its runner starts brings it back at once as aborted', () => {
  const dir = scratch();
  const mark = join(dir, 'ran-anyway');
  const out = run({ hangListMs: 13000, steps: [{ turnStart: 't1' }, { script: 'await sh("touch ' + mark + '")\nreturn 1', keepTurn: true }, { turnAborted: 't1' }, { collect: true }, { untilQuiet: true }] });
  expect(out.collected[0]).toContain('[r1 stopped after');
  expect(out.collected[0]).toContain('[aborted]');
  expect(out.runnersSpawned).toBe(0);
  expect(existsSync(mark)).toBe(false);
});

test('A run that timed out makes no tool call afterwards', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const out = run({ statDelayMs: 2000, steps: [{ script: '// @options: {"timeout_ms": 5500}\nawait read(' + f + ')\ntext("before-write")\nawait call("Write", { file_path: ' + f + ', content: "late\\n" })\nreturn 1', keepTurn: true }, { untilRunsDone: true }, { untilQuiet: true }, { collect: true }] });
  expect(out.collected[0]).toContain('before-write');
  expect(out.collected[0]).toContain('[timeout]');
  expect(readFileSync(file, 'utf8')).toBe('original\n');
});

test('A slow run that read an older version of a file cannot make a newer read count as stale', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'v1\n');
  const f = JSON.stringify(file);
  const [gate, read1] = ['gate', 'read1'].map((n) => join(dir, n));
  const out = run({ steps: [
    { script: 'await read(' + f + ')\nawait sh("touch ' + read1 + '")\nawait waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "slow"', keepTurn: true },
    { untilFile: read1 },
    { script: 'await read(' + f + ')\nawait write(' + f + ', "v2\\n")\nreturn "wrote-v2"', keepTurn: true },
    { untilRunDone: 'r2' }, { collect: true }, { touch: gate }, { untilRunDone: 'r1' }, { collect: true },
    { script: 'const r = await call("Write", { file_path: ' + f + ', content: "v3\\n" })\nreturn r.ok ? "wrote-v3" : r.error', keepTurn: true }, { untilRunsDone: true }, { collect: true },
  ] });
  expect(out.results[2]!.text).toBe('wrote-v3');
});

test('Two runs writing one file through ~/ and its full path never both pass the read check', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const [a, b, go] = ['a-read', 'b-read', 'go'].map((n) => join(dir, n));
  const writer = (path: string, mine: string, marker: string) => 'await read(' + JSON.stringify(file) + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { timeout: 20000, every: 20 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const out = run({ home: dir, cwd: dir, engineForgets: true, writeDelayMs: 800, steps: [{ script: writer(file, 'from-a', a), keepTurn: true }, { script: writer('~/f.txt', 'from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('modified since read');
  expect(readFileSync(file, 'utf8')).toBe(texts[0] === 'wrote' ? 'from-a\n' : 'from-b\n');
});

test('A spill clean-up never deletes saved outputs another session wrote in the last day', () => {
  const dir = scratch();
  const spills = join(dir, '.claude', 'codemode', 'out');
  mkdirSync(spills, { recursive: true });
  const theirs = Array.from({ length: 201 }, (_, i) => join(spills, 'other-session-' + i + '.txt'));
  theirs.forEach((p, i) => {
    writeFileSync(p, 'theirs ' + i);
    const at = (Date.now() - (i + 1) * 1000) / 1000;
    utimesSync(p, at, at);
  });
  const stale = join(spills, 'other-session-stale.txt');
  writeFileSync(stale, 'stale');
  const old = (Date.now() - 3 * 86_400_000) / 1000;
  utimesSync(stale, old, old);
  run({ home: dir, cwd: dir, steps: [{ script: 'return "S".repeat(30000)' }] });
  expect(theirs.filter((p) => !existsSync(p))).toEqual([]);
  expect(existsSync(stale)).toBe(false);
});

test('A run that works until its time is up makes no tool call after it', () => {
  const dir = scratch();
  const mark = join(dir, 'late-call');
  const out = run({ steps: [{ script: '// @options: {"timeout_ms": 2000}\nwhile (deadline() > 0) {}\nawait call("Bash", { command: "touch ' + mark + '" })\nreturn 1', keepTurn: true }, { untilRunsDone: true }, { untilQuiet: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[timeout]');
  expect(existsSync(mark)).toBe(false);
});

test('Esc with no turn ids while a newer turn starts never marks the newer turn idle', () => {
  const dir = scratch();
  const [gate, started] = ['gate', 'started'].map((n) => join(dir, n));
  const out = run({ surfaces: ['terminal'], killDelayMs: 600, steps: [
    { turnStart: '' },
    { script: 'await waitFor(() => sh("test -f ' + gate + '"), { timeout: 30000 })\nreturn "earlier"', keepTurn: true },
    { turnComplete: '' },
    { turnStart: '' },
    { script: 'await sh("touch ' + started + '")\nreturn String(await sh("sleep 30"))', keepTurn: true },
    { untilFile: started },
    { touch: gate },
    { untilRunDone: 'r1' },
    { abortAndStart: { abort: '', start: '' } },
    { untilRunDone: 'r2' }, { collect: true },
  ] });
  expect(out.wakeAttempts).toBe(0);
  expect(out.kills).toHaveLength(1);
  expect(out.collected.join('')).toContain('[r2 stopped after');
  expect(out.collected.join('')).toContain('[aborted]');
  expect(out.collected.join('')).toContain('[r1 finished after');
});

test('An older run\'s partial read never moves a newer partial read\'s progress back', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'a\nb\nc\nd');
  const f = JSON.stringify(file);
  const [gate, read1] = ['gate', 'read1'].map((n) => join(dir, n));
  const out = run({ steps: [
    { script: 'await call("Read", { file_path: ' + f + ', offset: 1, limit: 1 })\nawait sh("touch ' + read1 + '")\nawait waitFor(() => sh("test -f ' + gate + '"), { timeout: 20000 })\nreturn "slow"', keepTurn: true },
    { untilFile: read1 },
    { script: 'await call("Read", { file_path: ' + f + ', offset: 1, limit: 2 })\nreturn "first-half"', keepTurn: true },
    { untilRunDone: 'r2' }, { collect: true }, { touch: gate }, { untilRunDone: 'r1' }, { collect: true },
    { script: 'await call("Read", { file_path: ' + f + ', offset: 3, limit: 2 })\nconst r = await call("Write", { file_path: ' + f + ', content: "new\\n" })\nreturn r.ok ? "wrote" : r.error', keepTurn: true }, { untilRunsDone: true }, { collect: true },
  ] });
  expect(out.results[2]!.text).toBe('wrote');
});

test('A read handed back after compaction counts as read even when a newer read came back first', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'v1\n');
  const f = JSON.stringify(file);
  const [gate, read1] = ['gate', 'read1'].map((n) => join(dir, n));
  const out = run({ steps: [
    { script: 'await read(' + f + ')\nawait sh("touch ' + read1 + '")\nawait waitFor(() => sh("test -f ' + gate + '"), { every: 20, timeout: 20000 })\nreturn "slow"', keepTurn: true },
    { untilFile: read1 },
    { script: 'await read(' + f + ')\nreturn "fast"', keepTurn: true }, { untilRunDone: 'r2' }, { collect: true },
    { compact: true }, { touch: gate }, { untilRunDone: 'r1' }, { collect: true },
    { script: 'const r = await call("Write", { file_path: ' + f + ', content: "v2\\n" })\nreturn r.ok ? "wrote" : r.error', keepTurn: true }, { untilRunsDone: true }, { collect: true },
  ] });
  expect(out.results[2]!.text).toBe('wrote');
  expect(readFileSync(file, 'utf8')).toBe('v2\n');
});

test('An older read handed back after a patch of a changed file never makes that file count as read', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'v1\n');
  const f = JSON.stringify(file);
  const [gate, read1] = ['gate', 'read1'].map((n) => join(dir, n));
  const out = run({ steps: [
    { script: 'await read(' + f + ')\nawait sh("touch ' + read1 + '")\nawait waitFor(() => sh("test -f ' + gate + '"), { every: 20, timeout: 20000 })\nreturn "slow"', keepTurn: true },
    { untilFile: read1 },
    { script: 'await read(' + f + ')\nawait sh("sleep 0.05; printf changed > ' + file + '")\nconst p = await call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + f + ', old_text: "changed", new_text: "patched" })\nreturn p.ok ? "patched" : p.error', keepTurn: true }, { untilRunDone: 'r2' }, { collect: true },
    { touch: gate }, { untilRunDone: 'r1' }, { collect: true },
    { script: 'const r = await call("Write", { file_path: ' + f + ', content: "v2\\n" })\nreturn r.ok ? "wrote" : r.error', keepTurn: true }, { untilRunsDone: true }, { collect: true },
  ] });
  expect(out.results[1]!.text).toMatch(/^patched/);
  expect(out.results[2]!.text).toContain('has not been read yet');
  expect(readFileSync(file, 'utf8')).toBe('patched');
});

test('A run whose runner finishes after Esc but before the kill comes back stopped', () => {
  const out = run({ killDelayMs: 1000, steps: [
    { turnStart: 't1' },
    { script: 'await sh("sleep 0.3")\nreturn "done-anyway"', keepTurn: true },
    { untilTool: 'Bash' }, { turnAborted: 't1' }, { untilRunDone: 'r1' }, { collect: true },
  ] });
  expect(out.collected[0]).toContain('[r1 stopped after');
  expect(out.collected[0]).toContain('[aborted]');
  expect(out.collected[0]).not.toContain('[r1 finished after');
});

test('Two runs creating one new file through a symlinked folder and its real path never both write it', () => {
  const dir = scratch();
  const real = join(dir, 'real');
  const link = join(dir, 'link');
  mkdirSync(real);
  const go = join(dir, 'go');
  const writer = (path: string, mine: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const out = run({ engineForgets: true, writeDelayMs: 800, steps: [{ link: { from: link, to: real } }, { script: writer(join(real, 'n.txt'), 'from-a', a), keepTurn: true }, { script: writer(join(link, 'n.txt'), 'from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('has not been read yet');
});

test('A run still before its runner that another run cancels wakes the idle session at once', () => {
  const dir = scratch();
  const [go, done] = ['go', 'done'].map((n) => join(dir, n));
  const out = run({ surfaces: ['terminal'], hangListMs: 45000, hangListCount: 1, steps: [
    { turnStart: 't1' },
    { script: 'return "never-ran"', keepTurn: true },
    { script: 'await waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 30000 })\nawait cancel("r1")\nawait waitFor(() => sh("test -f ' + done + '"), { every: 20, timeout: 50000 })\nreturn "canceller"', keepTurn: true },
    { turnComplete: 't1' }, { touch: go }, { untilWake: true }, { collect: true }, { touch: done }, { untilRunDone: 'r2' }, { untilQuiet: true },
  ] });
  expect(out.collected[0]).toContain('[r1 stopped after');
  expect(out.collected[0]).not.toContain('never-ran');
});

test('A run out of time keeps nothing it asks to store after its time is up', () => {
  const out = run({ steps: [{ script: '// @options: {"timeout_ms": 2000}\nwhile (deadline() > 0) {}\nawait store("late-key", "late")\nreturn 1', keepTurn: true }, { untilRunsDone: true }, { untilQuiet: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[timeout]');
  expect(out.store['script:late-key']).toBeUndefined();
});

test('Esc with no turn ids stops the interrupted turn\'s runs even when a newer turn starts during the interrupt', () => {
  const dir = scratch();
  const started = join(dir, 'started');
  const out = run({ steps: [
    { turnStart: '' },
    { script: 'await sh("touch ' + started + '")\nreturn String(await sh("sleep 20"))', keepTurn: true },
    { untilFile: started }, { abortDuringNext: { abort: '', start: '' } }, { untilRunDone: 'r1' }, { collect: true },
  ] });
  expect(out.collected[0]).toContain('[r1 stopped after');
  expect(out.collected[0]).toContain('[aborted]');
});

test('Two runs creating one new file under missing folders through a symlinked folder and its real path never both write it', () => {
  const dir = scratch();
  const real = join(dir, 'real');
  const link = join(dir, 'link');
  mkdirSync(real);
  const go = join(dir, 'go');
  const writer = (path: string, mine: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const out = run({ engineForgets: true, writeDelayMs: 800, steps: [{ link: { from: link, to: real } }, { script: writer(join(real, 'missing', 'sub', 'n.txt'), 'from-a', a), keepTurn: true }, { script: writer(join(link, 'missing', 'sub', 'n.txt'), 'from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('has not been read yet');
  expect(readFileSync(join(real, 'missing', 'sub', 'n.txt'), 'utf8')).toBe(texts[0] === 'wrote' ? 'from-a\n' : 'from-b\n');
});

test('A failed reply of one read never undoes an overlapping read of the same file that came back', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'v1\n');
  const f = JSON.stringify(file);
  const out = run({ failReplyAfter: { fail: 1, after: 3 }, steps: [{ script: 'const first = call("Read", { file_path: ' + f + ' })\nawait call("Bash", { command: "sleep 0.3" })\nawait call("Read", { file_path: ' + f + ' })\nawait first\nconst r = await call("Write", { file_path: ' + f + ', content: "v2\\n" })\nreturn r.ok ? "wrote" : r.error' }] });
  expect(out.results[0]!.text).toBe('wrote');
  expect(readFileSync(file, 'utf8')).toBe('v2\n');
});

test('A run\'s own older page bookmark never hides a newer one another run brought back', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'a\nb\nc\nd');
  const f = JSON.stringify(file);
  const [gate, read1] = ['gate', 'read1'].map((n) => join(dir, n));
  const out = run({ steps: [
    { script: 'await call("Read", { file_path: ' + f + ', offset: 1, limit: 1 })\nawait sh("touch ' + read1 + '")\nawait waitFor(() => sh("test -f ' + gate + '"), { every: 20, timeout: 20000 })\nawait call("Read", { file_path: ' + f + ', offset: 3, limit: 2 })\nconst r = await call("Write", { file_path: ' + f + ', content: "new\\n" })\nreturn r.ok ? "wrote" : r.error', keepTurn: true },
    { untilFile: read1 },
    { script: 'await call("Read", { file_path: ' + f + ', offset: 1, limit: 2 })\nreturn "first-half"', keepTurn: true }, { untilRunDone: 'r2' }, { collect: true },
    { touch: gate }, { untilRunDone: 'r1' }, { collect: true },
  ] });
  expect(out.collected.join('')).toContain('[r1 finished after');
  expect(out.collected.join('')).toContain('wrote');
  expect(readFileSync(file, 'utf8')).toBe('new\n');
});

test('Two runs editing one file through the patch tool at once never both pass the read check', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const [a, b, go] = ['a-read', 'b-read', 'go'].map((n) => join(dir, n));
  const editor = (from: string, to: string, marker: string) => 'await read(' + f + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await edit(' + f + ', "' + from + '", "' + to + '"); return "edited" } catch (e) { return String(e.message) }';
  const out = run({ tools: NO_BASH, statDelayMs: 250, steps: [{ script: editor('alpha', 'ALPHA', a), keepTurn: true }, { script: editor('beta', 'BETA', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'edited')).toHaveLength(1);
  expect(texts.find((x) => x !== 'edited')).toContain('changed since this session read it');
  expect(readFileSync(file, 'utf8')).toBe(texts[0] === 'edited' ? 'ALPHA\nbeta\n' : 'alpha\nBETA\n');
});

test('Two runs writing one file through the patch tool at once never both write it', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const [a, b, go] = ['a-read', 'b-read', 'go'].map((n) => join(dir, n));
  const writer = (mine: string, marker: string) => 'await read(' + f + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await write(' + f + ', "' + mine + '\\n"); return "wrote" } catch (e) { return String(e.message) }';
  const out = run({ tools: NO_BASH, statDelayMs: 250, steps: [{ script: writer('from-a', a), keepTurn: true }, { script: writer('from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('changed since this session read it');
  expect(readFileSync(file, 'utf8')).toBe(texts[0] === 'wrote' ? 'from-a\n' : 'from-b\n');
});

test('A load near the end of a run, with time left, returns the stored value', () => {
  const out = run({ store: { 'script:k': 'saved-value' }, steps: [{ script: '// @options: {"timeout_ms": 1500}\nwhile (deadline() > 300) {}\nconst v = await load("k")\nreturn "loaded=" + String(v)', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('loaded=saved-value');
});

test('A load whose answer comes after the time is up ends the run as timed out, never with an empty value', () => {
  const out = run({ loadDelayMs: 1500, store: { 'script:k': 'saved-value' }, steps: [{ script: '// @options: {"timeout_ms": 1500}\nwhile (deadline() > 300) {}\nconst v = await load("k")\ntext("loaded=" + String(v))\nreturn 1', keepTurn: true }, { untilRunsDone: true }, { untilQuiet: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[timeout]');
  expect(out.collected[0]).not.toContain('loaded=');
});

test('A helper called once the time is up ends the run as timed out', () => {
  const out = run({ steps: [{ script: '// @options: {"timeout_ms": 1500}\nwhile (deadline() > 0) {}\nawait sh("echo late")\nreturn 1', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[timeout]');
  expect(out.collected[0]).not.toContain('[tool]');
});

test('A run that exits after a call refused for time still comes back timed out', () => {
  const out = run({ steps: [{ script: '// @options: {"timeout_ms": 1500}\nwhile (deadline() > 0) {}\nconst r = await call("Bash", { command: "echo late" })\nif (!r.ok) exit()\nreturn 1', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('[timeout]');
});

test('A run whose runner is slow to start gets its whole time before the mod kills it', () => {
  const dir = scratch();
  const shim = join(dir, 'slow-node');
  writeFileSync(shim, '#!/bin/sh\nsleep 6\nexec ' + JSON.stringify(process.execPath) + ' "$@"\n');
  chmodSync(shim, 0o755);
  const out = run({ env: { CODEMODE_NODE: shim }, steps: [{ script: '// @options: {"timeout_ms": 3000}\nwhile (deadline() > 300) {}\nreturn "finished"', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('finished');
  expect(out.collected[0]).not.toContain('[timeout]');
  expect(out.kills).toHaveLength(0);
});

test('Two forced edits through the patch tool at once both land', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const [a, b, go] = ['a-read', 'b-read', 'go'].map((n) => join(dir, n));
  const editor = (from: string, to: string, marker: string) => 'await read(' + f + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await edit(' + f + ', "' + from + '", "' + to + '", { force: true }); return "edited" } catch (e) { return String(e.message) }';
  const out = run({ tools: NO_BASH, statDelayMs: 250, steps: [{ script: editor('alpha', 'ALPHA', a), keepTurn: true }, { script: editor('beta', 'BETA', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }, { script: 'try { await edit(' + f + ', "BETA", "BETA2"); return "edited-again" } catch (e) { return String(e.message) }' }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['edited', 'edited']);
  expect(out.results[2]!.text).toBe('edited-again');
  expect(out.calls.filter((c) => c.tool === 'Read').length).toBeGreaterThanOrEqual(3);
  expect(readFileSync(file, 'utf8')).toBe('ALPHA\nBETA2\n');
});

test('An edit through the patch tool counts a read another run brought back while it was running', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const [gate, started] = ['gate', 'started'].map((n) => join(dir, n));
  const out = run({ tools: NO_BASH, steps: [
    { script: 'await sh("touch ' + started + '")\nawait waitFor(() => sh("test -f ' + gate + '"), { every: 20, timeout: 20000 })\ntry { await edit(' + f + ', "alpha", "ALPHA"); return "edited" } catch (e) { return String(e.message) }', keepTurn: true },
    { untilFile: started },
    { script: 'await read(' + f + ')\nreturn "read-ok"', keepTurn: true }, { untilRunDone: 'r2' }, { collect: true },
    { touch: gate }, { untilRunDone: 'r1' }, { collect: true },
  ] });
  expect(out.collected.join('')).toContain('[r1 finished after');
  expect(out.collected[1]).toContain('edited');
  expect(readFileSync(file, 'utf8')).toBe('ALPHA\nbeta\n');
});

test('An edit through the patch tool counts a read whose path came from tool defaults', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const out = run({ tools: NO_BASH, env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ Read: { file_path: file } }) }, steps: [{ script: 'await tools.Read({})\ntry { await edit(' + f + ', "alpha", "ALPHA"); return "edited" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toBe('edited');
  expect(readFileSync(file, 'utf8')).toBe('ALPHA\nbeta\n');
});

test('A kill timer that fires early never stops a run before its time', () => {
  const out = run({ clockEarlyMs: 5500, steps: [{ script: '// @options: {"timeout_ms": 1500}\nawait sh("sleep 1.1")\nreturn "completed-in-time"', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('completed-in-time');
  expect(out.kills).toHaveLength(0);
});

test('Two runs creating one new file through a dangling symlink and its target never both write it', () => {
  const dir = scratch();
  const real = join(dir, 'real.txt');
  const link = join(dir, 'link.txt');
  const go = join(dir, 'go');
  const writer = (path: string, mine: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const out = run({ strictRealpath: true, engineForgets: true, writeDelayMs: 800, steps: [{ link: { from: link, to: real } }, { script: writer(real, 'from-a', a), keepTurn: true }, { script: writer(link, 'from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('has not been read yet');
  expect(readFileSync(real, 'utf8')).toBe(texts[0] === 'wrote' ? 'from-a\n' : 'from-b\n');
});
test('A call refused for time before it started is never reported as still running', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const out = run({ tools: NO_BASH, statDelayMs: 1500, steps: [
    { script: 'await read(' + f + ')\nreturn "r1"', keepTurn: true }, { untilRunDone: 'r1' }, { collect: true },
    { script: '// @options: {"timeout_ms": 1500}\nwhile (deadline() > 400) {}\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + f + ', old_text: "original", new_text: "changed" })\nreturn 1', keepTurn: true },
    { untilRunsDone: true }, { untilQuiet: true }, { collect: true },
  ] });
  expect(out.calls.filter((c) => c.tool === 'mcp__lean-ctx__ctx_patch')).toHaveLength(0);
  expect(readFileSync(file, 'utf8')).toBe('original\n');
  expect(out.collected[1]).toContain('[timeout]');
  expect(out.collected[1]).not.toContain('still running');
});

test('A load near the end of a run whose runner was slow to start still returns the stored value', () => {
  const dir = scratch();
  const shim = join(dir, 'slow-node');
  writeFileSync(shim, '#!/bin/sh\nsleep 0.7\nexec ' + JSON.stringify(process.execPath) + ' "$@"\n');
  chmodSync(shim, 0o755);
  const out = run({ env: { CODEMODE_NODE: shim }, store: { 'script:k': 'saved-value' }, steps: [{ script: '// @options: {"timeout_ms": 1500}\nwhile (deadline() > 400) {}\nconst v = await load("k")\nreturn "loaded=" + String(v)', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('loaded=saved-value');
});

test('A refused load or describeTool throws instead of giving nothing', () => {
  const big = '"x".repeat(7000001)';
  const out = run({ steps: [{ script: 'const seen = []\nfor (const f of [() => load(' + big + '), () => describeTool(' + big + ')]) { try { await f(); seen.push("resolved") } catch (e) { seen.push("threw") } }\nreturn seen.join(",")' }] });
  expect(out.results[0]!.text).toBe('threw,threw');
});

test('A run whose runner starts more than five seconds late, within its start time, still runs its script', () => {
  const dir = scratch();
  const shim = join(dir, 'slower-node');
  writeFileSync(shim, '#!/bin/sh\nsleep 9\nexec ' + JSON.stringify(process.execPath) + ' "$@"\n');
  chmodSync(shim, 0o755);
  const out = run({ env: { CODEMODE_NODE: shim }, steps: [{ script: '// @options: {"timeout_ms": 3000}\nawait sh("true")\nreturn "finished"', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('finished');
  expect(out.collected[0]).not.toContain('[timeout]');
  expect(out.kills).toHaveLength(0);
});

test('Two forced writes through the patch tool at once both land', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const go = join(dir, 'go');
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const writer = (mine: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await write(' + f + ', "' + mine + '\\n", { force: true }); return "wrote" } catch (e) { return String(e.message) }';
  const out = run({ tools: NO_BASH, statDelayMs: 250, steps: [{ script: writer('from-a', a), keepTurn: true }, { script: writer('from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['wrote', 'wrote']);
  expect(['from-a\n', 'from-b\n']).toContain(readFileSync(file, 'utf8'));
  expect(out.calls.filter((c) => c.tool === 'Read').length).toBeGreaterThanOrEqual(3);
});

test('A kill timer whose clock answers slowly never arms a kill past a run that already ended', () => {
  const out = run({ clockEarlyMs: 5500, clockNowDelayMs: 50, steps: [{ script: '// @options: {"timeout_ms": 1500}\nawait sh("sleep 1.1")\nreturn "completed-in-time"', keepTurn: true }, { untilRunsDone: true }, { collect: true }, { untilQuiet: true }, { clockMark: true }, { script: 'await sh("sleep 5.6")\nreturn "later"' }] });
  expect(out.collected[0]).toContain('completed-in-time');
  expect(out.results[1]!.text).toBe('later');
  expect(out.kills).toHaveLength(0);
  expect(out.clockNowCalls! - out.clockMarks![0]!).toBe(0);
});

test('Two runs creating one new file through a relative dangling symlink inside a symlinked folder never both write it', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
  const real = join(dir, 'nested', 'real.txt');
  const via = join(dir, 'sub', 'link.txt');
  const go = join(dir, 'go');
  const writer = (path: string, mine: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const out = run({ strictRealpath: true, engineForgets: true, writeDelayMs: 800, steps: [
    { link: { from: join(dir, 'sub'), to: 'nested/deeper' } },
    { link: { from: join(dir, 'nested', 'deeper', 'link.txt'), to: '../real.txt' } },
    { script: writer(real, 'from-a', a), keepTurn: true }, { script: writer(via, 'from-b', b), keepTurn: true },
    { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true },
  ] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('has not been read yet');
  expect(readFileSync(real, 'utf8')).toBe(texts[0] === 'wrote' ? 'from-a\n' : 'from-b\n');
});

test('A kill timer that fires a little early checks the clock only a few times before it kills', () => {
  const out = run({ clockEarlyMs: 20, steps: [{ script: '// @options: {"timeout_ms": 1000}\nwhile (true) {}', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('never yielded');
  expect(out.kills).toHaveLength(1);
  expect(out.clockNowCalls).toBeLessThanOrEqual(3);
});

test('A forced write the patch tool cannot create reports the patch tool\'s own reason', () => {
  const dir = scratch();
  const file = join(dir, 'nofile', 'f.txt');
  const out = run({ tools: NO_BASH, deniedCreateMessage: 'ERROR: parent directory does not exist', steps: [{ script: 'try { await write(' + JSON.stringify(file) + ', "v", { force: true }); return "wrote" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toContain('parent directory does not exist');
  expect(existsSync(file)).toBe(false);
});

test('A runner that sends its result but never exits is still killed and its result comes back', () => {
  const dir = scratch();
  const shim = join(dir, 'stuck-node');
  writeFileSync(shim, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' --import \'data:text/javascript,process.exit=()=>{for(;;){}}\' "$@"\n');
  chmodSync(shim, 0o755);
  const out = run({ env: { CODEMODE_NODE: shim }, steps: [{ script: '// @options: {"timeout_ms": 1500}\nreturn "delivered"', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('delivered');
  expect(out.kills).toHaveLength(1);
});

test('A forced write through the patch tool lands when the file changes while it is read', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const out = run({ tools: NO_BASH, rewriteDuringFirstRead: 'external\n', steps: [{ script: 'try { await write(' + JSON.stringify(file) + ', "from-codemode\\n", { force: true }); return "wrote" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toBe('wrote');
  expect(readFileSync(file, 'utf8')).toBe('from-codemode\n');
});

test('Two forced writes through Write at once both land', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const go = join(dir, 'go');
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const writer = (mine: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await write(' + f + ', "' + mine + '\\n", { force: true }); return "wrote" } catch (e) { return String(e.message) }';
  const out = run({ statDelayMs: 250, steps: [{ script: writer('from-a', a), keepTurn: true }, { script: writer('from-b', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['wrote', 'wrote']);
  expect(['from-a\n', 'from-b\n']).toContain(readFileSync(file, 'utf8'));
});

test('Two forced edits through Edit at once both land', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const go = join(dir, 'go');
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const editor = (from: string, to: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await edit(' + f + ', "' + from + '", "' + to + '", { force: true }); return "edited" } catch (e) { return String(e.message) }';
  const out = run({ statDelayMs: 250, steps: [{ script: editor('alpha', 'ALPHA', a), keepTurn: true }, { script: editor('beta', 'BETA', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['edited', 'edited']);
  expect(readFileSync(file, 'utf8')).toBe('ALPHA\nBETA\n');
});

test('Forced patch writes whose reads overlap the other write keep the file counted as read', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const go = join(dir, 'go');
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const writer = (mine: string, marker: string, lag: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nawait sh("sleep ' + lag + '")\ntry { await write(' + f + ', "' + mine + '\\n", { force: true }); return "wrote" } catch (e) { return String(e.message) }';
  const out = run({ tools: NO_BASH, readDelayMs: 250, steps: [{ script: writer('from-a', a, '0'), keepTurn: true }, { script: writer('from-b', b, '0.18'), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }, { script: 'const now = String(await sh("cat ' + file + '"))\ntry { await edit(' + f + ', now.trim(), "after"); return "edited-again" } catch (e) { return String(e.message) }' }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['wrote', 'wrote']);
  expect(out.results[2]!.text).toBe('edited-again');
  expect(readFileSync(file, 'utf8')).toBe('after\n');
});

test('Forced patch edits of a file read in pages both land while the other one writes', () => {
  const dir = scratch();
  const file = join(dir, 'big.txt');
  writeFileSync(file, 'alpha\nbeta\n' + Array.from({ length: 2400 }, (_, n) => 'filler ' + n).join('\n') + '\n');
  const f = JSON.stringify(file);
  const go = join(dir, 'go');
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const editor = (from: string, to: string, marker: string, lag: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nawait sh("sleep ' + lag + '")\ntry { await edit(' + f + ', "' + from + '\\n", "' + to + '\\n", { force: true }); return "edited" } catch (e) { return String(e.message) }';
  const out = run({ tools: NO_BASH, readDelayMs: 200, steps: [{ script: editor('alpha', 'ALPHA', a, '0'), keepTurn: true }, { script: editor('beta', 'BETA', b, '0.3'), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['edited', 'edited']);
  expect(readFileSync(file, 'utf8').startsWith('ALPHA\nBETA\n')).toBe(true);
});

test('Two runs creating one new file through a dangling symlink whose target climbs out of a symlinked folder never both write it', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'x', 'y'), { recursive: true });
  const real = join(dir, 'x', 'real.txt');
  const link = join(dir, 'link.txt');
  const go = join(dir, 'go');
  const writer = (path: string, mine: string, marker: string) => 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(path) + ', content: "' + mine + '\\n" })\nreturn r.ok ? "wrote" : r.error';
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const out = run({ strictRealpath: true, engineForgets: true, writeDelayMs: 800, steps: [
    { link: { from: join(dir, 'sub'), to: 'x/y' } },
    { link: { from: link, to: 'sub/../real.txt' } },
    { script: writer(real, 'from-a', a), keepTurn: true }, { script: writer(link, 'from-b', b), keepTurn: true },
    { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true },
  ] });
  const texts = [out.results[0]!.text, out.results[1]!.text];
  expect(texts.filter((x) => x === 'wrote')).toHaveLength(1);
  expect(texts.find((x) => x !== 'wrote')).toContain('has not been read yet');
  expect(readFileSync(real, 'utf8')).toBe(texts[0] === 'wrote' ? 'from-a\n' : 'from-b\n');
  expect(existsSync(join(dir, 'real.txt'))).toBe(false);
});

for (const [label, tools] of [['the patch tool', NO_BASH], ['Write', undefined]] as const) {
  test('Eight forced writes through ' + label + ' at once all land', () => {
    const dir = scratch();
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'original\n');
    const f = JSON.stringify(file);
    const go = join(dir, 'go');
    const names = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
    const writer = (mine: string) => 'await sh("touch ' + join(dir, mine) + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await write(' + f + ', "' + mine + '\\n", { force: true }); return "wrote" } catch (e) { return String(e.message) }';
    const out = run({ ...(tools ? { tools: [...tools] } : {}), statDelayMs: 250, steps: [...names.map((n) => ({ script: writer(n), keepTurn: true })), ...names.map((n) => ({ untilFile: join(dir, n) })), { touch: go }, { untilRunsDone: true }, { collect: true }] });
    expect(out.results.map((r) => r.text)).toEqual(names.map(() => 'wrote'));
    expect(names.map((n) => n + '\n')).toContain(readFileSync(file, 'utf8'));
  });
}

test('A kill timer still waiting on a slow clock when the runner starts kills that runner only once', () => {
  const dir = scratch();
  const shim = join(dir, 'late-node');
  writeFileSync(shim, '#!/bin/sh\nsleep 6.5\nexec ' + JSON.stringify(process.execPath) + ' "$@"\n');
  chmodSync(shim, 0o755);
  const out = run({ clockNowDelayMs: 2000, env: { CODEMODE_NODE: shim }, steps: [{ script: '// @options: {"timeout_ms": 1000}\nwhile (true) {}', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('never yielded');
  expect(out.kills).toHaveLength(1);
});

test('A forced write and edit through Write and Edit in a two-second run read the file once and land', () => {
  const dir = scratch();
  const [w, e] = ['w.txt', 'e.txt'].map((n) => join(dir, n));
  writeFileSync(w, 'original\n');
  writeFileSync(e, 'original\n');
  const out = run({ steps: [
    { script: '// @options: {"timeout_ms": 2000}\ntry { await write(' + JSON.stringify(w) + ', "mine\\n", { force: true }); return "wrote" } catch (x) { return String(x.message) }' },
    { script: '// @options: {"timeout_ms": 2000}\ntry { await edit(' + JSON.stringify(e) + ', "original", "mine", { force: true }); return "edited" } catch (x) { return String(x.message) }' },
  ] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['wrote', 'edited']);
  expect([readFileSync(w, 'utf8'), readFileSync(e, 'utf8')]).toEqual(['mine\n', 'mine\n']);
});

test('A forced write through Write in the last seconds of a run still lands', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const out = run({ steps: [{ script: '// @options: {"timeout_ms": 10000}\nawait waitFor(() => deadline() < 1500, { every: 50, timeout: 9000 })\ntry { await write(' + JSON.stringify(file) + ', "mine\\n", { force: true }); return "wrote" } catch (x) { return String(x.message) }' }] });
  expect(out.results[0]!.text).toBe('wrote');
  expect(readFileSync(file, 'utf8')).toBe('mine\n');
});

const neverSettles = (tools: readonly string[] | undefined, op: 'write' | 'edit') => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const f = JSON.stringify(file);
  const call = op === 'write' ? 'await write(' + f + ', "mine\\n", { force: true })' : 'await edit(' + f + ', "original", "mine", { force: true })';
  const out = run({ ...(tools ? { tools: [...tools] } : {}), changeEveryRead: true, readDelayMs: 100, steps: [{ script: '// @options: {"timeout_ms": 30000}\ntry { ' + call + '; return "landed" } catch (x) { return String(x.message) }' }] });
  expect(out.results[0]!.text).toContain('keeps changing while it is read');
  expect(out.calls.filter((c) => c.tool === 'Read').length).toBeLessThanOrEqual(20);
};

test('A forced write through Write of a file that never stops changing fails within seconds and says so', () => neverSettles(undefined, 'write'));
test('A forced edit through Edit of a file that never stops changing fails within seconds and says so', () => neverSettles(undefined, 'edit'));
test('A forced write through the patch tool of a file that never stops changing fails within seconds and says so', () => neverSettles(NO_BASH, 'write'));
test('A forced edit through the patch tool of a file that never stops changing fails within seconds and says so', () => neverSettles(NO_BASH, 'edit'));

test('A kill timer whose clock never answers still kills a spinning run within seconds', () => {
  const out = run({ clockNowDelayMs: 30000, steps: [{ script: '// @options: {"timeout_ms": 1000}\nwhile (true) {}', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(out.collected[0]).toContain('never yielded');
  expect(out.kills).toHaveLength(1);
  const after = Number(/\[r1 \w+ after ([\d.]+)s\]/.exec(out.collected[0]!)?.[1]);
  expect(after).toBeLessThan(15);
});

test('Two paged reads of one file in a run never stitch an old first page to a new second one', () => {
  const dir = scratch();
  const file = join(dir, 'big.txt');
  const lines = (tag: string) => Array.from({ length: 2400 }, (_, n) => tag + ' ' + n).join('\n') + '\n';
  writeFileSync(file, lines('old'));
  const newer = join(dir, 'newer.txt');
  writeFileSync(newer, lines('new'));
  const f = JSON.stringify(file);
  const copied = join(dir, 'copied');
  const out = run({ readLagMs: 400, steps: [
    { script: 'const first = read(' + f + ').then((t) => (t.includes("old 0") && t.includes("new 2399") ? "stitched" : "clean"), (e) => "refused: " + e.message)\nawait waitFor(() => sh("test -f ' + copied + '"), { every: 20, timeout: 20000 })\nawait read(' + f + ')\nreturn await first', keepTurn: true },
    { untilCalls: { tool: 'Read', count: 1 } },
    { script: 'await sh("cp ' + newer + ' ' + file + ' && touch ' + copied + '")\nreturn "copied"', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  expect(out.results.map((r) => r.text).join('\n')).toContain('refused: read: ' + file + ' changed while it was read in pages');
});

test('A forced patch edit in a short run whose read races a change retries and keeps the file counted as read', () => {
  const dir = scratch();
  const file = join(dir, 'p.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const out = run({ tools: NO_BASH, rewriteDuringFirstRead: 'alpha\nBETA_EXTERNAL\n', steps: [{ script: '// @options: {"timeout_ms": 1500}\ntry { await edit(' + f + ', "alpha", "ALPHA", { force: true }); await edit(' + f + ', "BETA_EXTERNAL", "FINAL"); return "both" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toBe('both');
  expect(readFileSync(file, 'utf8')).toBe('ALPHA\nFINAL\n');
});

test('A forced patch write never takes an older read of the file as current', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  const f = JSON.stringify(file);
  const out = run({ tools: NO_BASH, rewriteDuringFirstRead: 'v3\n', statDelayMs: 200, steps: [
    { script: 'await write(' + f + ', "v1\\n")\nawait sh("printf v2 > ' + file + '")\nreturn "prepared"' },
    { script: '// @options: {"timeout_ms": 2200}\ntry { await write(' + f + ', "from-codemode\\n", { force: true }); return "wrote" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toBe('prepared');
  expect(out.results[1]!.text).toBe('wrote');
  expect(readFileSync(file, 'utf8')).toBe('from-codemode\n');
});

for (const [label, tools] of [['Read, Write and Edit', undefined], ['the patch tool', NO_BASH]] as const) {
  test('A read, write and edit through ' + label + ' on a path whose .. climbs out of a symlinked folder reach the file the disk names', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'x', 'y'), { recursive: true });
    const intended = join(dir, 'x', 'real.txt');
    const decoy = join(dir, 'real.txt');
    writeFileSync(intended, 'INTENDED\n');
    writeFileSync(decoy, 'DECOY\n');
    const climbing = JSON.stringify(join(dir, 'sub') + '/../real.txt');
    const out = run({ ...(tools ? { tools: [...tools] } : {}), steps: [
      { link: { from: join(dir, 'sub'), to: 'x/y' } },
      { script: 'const seen = (await read(' + climbing + ')).trim()\nawait edit(' + climbing + ', "INTENDED", "EDITED")\nawait write(' + climbing + ', (await read(' + climbing + ')).replace("EDITED", "MINE"))\nreturn seen' },
    ] });
    expect(out.results[0]!.text).toBe('INTENDED');
    expect(readFileSync(intended, 'utf8')).toBe('MINE\n');
    expect(readFileSync(decoy, 'utf8')).toBe('DECOY\n');
  });
}

test('A file read by its plain path can be written through a path that climbs out of a symlinked folder to it', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'w', 'B', 'other', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'w', 'B', 'real'), { recursive: true });
  writeFileSync(join(dir, 'w', 'B', 'other', 'f.txt'), 'theirs\n');
  const plain = join(dir, 'w', 'A', 'other', 'f.txt');
  const climbing = join(dir, 'w', 'A', 'real', 'L') + '/../f.txt';
  const out = run({ steps: [
    { link: { from: join(dir, 'w', 'A'), to: join(dir, 'w', 'B') } },
    { link: { from: join(dir, 'w', 'B', 'real', 'L'), to: join(dir, 'w', 'A', 'other', 'deep') } },
    { script: 'await read(' + JSON.stringify(plain) + ')\ntry { await write(' + JSON.stringify(climbing) + ', "mine\\n"); return "wrote" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toBe('wrote');
  expect(readFileSync(join(dir, 'w', 'B', 'other', 'f.txt'), 'utf8')).toBe('mine\n');
});

const climbingFolder = () => {
  const dir = scratch();
  mkdirSync(join(dir, 'x', 'y'), { recursive: true });
  writeFileSync(join(dir, 'x', 'real.txt'), 'INTENDED\n');
  writeFileSync(join(dir, 'real.txt'), 'DECOY\n');
  return dir;
};

test('A relative Read path whose .. climbs out of a symlinked folder reaches the file the disk names', () => {
  const dir = climbingFolder();
  const out = run({ cwd: dir, steps: [{ link: { from: join(dir, 'sub'), to: 'x/y' } }, { script: 'return String(await tools.Read({ file_path: "sub/../real.txt" }))' }] });
  expect(out.results[0]!.text).toContain('INTENDED');
});

test('A climbing path given by tool defaults reaches the file the disk names', () => {
  const dir = climbingFolder();
  const out = run({ env: { CODEMODE_TOOL_DEFAULTS: JSON.stringify({ Read: { file_path: join(dir, 'sub') + '/../real.txt' } }) }, steps: [{ link: { from: join(dir, 'sub'), to: 'x/y' } }, { script: 'return String(await tools.Read({}))' }] });
  expect(out.results[0]!.text).toContain('INTENDED');
});

test('A file read through a climbing path can be edited by its plain path, and the other way round', () => {
  const dir = climbingFolder();
  const climbing = JSON.stringify(join(dir, 'sub') + '/../real.txt');
  const plain = JSON.stringify(join(dir, 'x', 'real.txt'));
  const out = run({ steps: [
    { link: { from: join(dir, 'sub'), to: 'x/y' } },
    { script: 'await read(' + climbing + ')\ntry { await edit(' + plain + ', "INTENDED", "E1"); return "edited" } catch (e) { return String(e.message) }' },
    { script: 'await read(' + plain + ')\ntry { await edit(' + climbing + ', "E1", "E2"); return "edited" } catch (e) { return String(e.message) }' },
  ] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['edited', 'edited']);
  expect(readFileSync(join(dir, 'x', 'real.txt'), 'utf8')).toBe('E2\n');
});

test('A file read by its plain path can be written through a climbing path whose link names it another way', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'w', 'B', 'other', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'w', 'B', 'real'), { recursive: true });
  writeFileSync(join(dir, 'w', 'B', 'other', 'f.txt'), 'theirs\n');
  const plain = join(dir, 'w', 'A', 'other', 'f.txt');
  const climbing = join(dir, 'w', 'A', 'real', 'L') + '/../f.txt';
  const out = run({ steps: [
    { link: { from: join(dir, 'w', 'A'), to: join(dir, 'w', 'B') } },
    { link: { from: join(dir, 'w', 'B', 'real', 'L'), to: join(dir, 'w', 'B', 'other', 'deep') } },
    { script: 'await read(' + JSON.stringify(plain) + ')\ntry { await write(' + JSON.stringify(climbing) + ', "mine\\n"); return "wrote" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toBe('wrote');
  expect(readFileSync(join(dir, 'w', 'B', 'other', 'f.txt'), 'utf8')).toBe('mine\n');
});

test('Two forced patch edits with under two seconds left in their runs both land', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const go = join(dir, 'go');
  const [a, b] = ['a-read', 'b-read'].map((n) => join(dir, n));
  const editor = (from: string, to: string, marker: string) => '// @options: {"timeout_ms": 2600}\nawait read(' + f + ')\nawait sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 2000 })\nawait waitFor(() => deadline() < 1900, { every: 20, timeout: 2000 })\ntry { await edit(' + f + ', "' + from + '", "' + to + '", { force: true }); return "edited" } catch (e) { return String(e.message) }';
  const out = run({ tools: NO_BASH, statDelayMs: 120, steps: [{ script: editor('alpha', 'ALPHA', a), keepTurn: true }, { script: editor('beta', 'BETA', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['edited', 'edited']);
  expect(readFileSync(file, 'utf8')).toBe('ALPHA\nBETA\n');
});

test('A Read the mod pages that a failing call beside it cuts off is named as cut off, not still running', () => {
  const dir = scratch();
  const big = join(dir, 'big.txt');
  writeFileSync(big, Array.from({ length: 15000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\n') + '\n');
  const text = one('await Promise.all([tools.Read({ file_path: ' + JSON.stringify(big) + ' }), tools.Bash({ command: "exit 1" })])', { readDelayMs: 120 });
  expect(text).toMatch(/Read 1 cut off/);
  expect(text).not.toMatch(/Read 1 still running/);
});

test('A path that climbs out of a symlinked folder and then through a missing folder is refused and touches no file', () => {
  const dir = climbingFolder();
  const lost = join(dir, 'sub') + '/../sub/../real.txt';
  const p = JSON.stringify(lost);
  const attempt = (call: string) => 'try { ' + call + '; return "done" } catch (e) { return String(e.message) }';
  const out = run({ steps: [
    { link: { from: join(dir, 'sub'), to: 'x/y' } },
    { script: attempt('await read(' + p + ')') },
    { script: attempt('await write(' + p + ', "MINE\\n", { force: true })') },
    { script: attempt('await edit(' + p + ', "INTENDED", "MINE", { force: true })') },
  ] });
  for (const r of out.results) expect(r.text).toContain('names no file on disk');
  expect(readFileSync(join(dir, 'real.txt'), 'utf8')).toBe('DECOY\n');
  expect(readFileSync(join(dir, 'x', 'real.txt'), 'utf8')).toBe('INTENDED\n');
});

test('Reading a folder says it is a folder', () => {
  const dir = scratch();
  const out = run({ steps: [{ script: 'try { await read(' + JSON.stringify(dir) + '); return "read" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toContain(dir + ' is a folder, not a file');
});

test('A relative path with .. given to a tool that does not take local files arrives unchanged', () => {
  const dir = scratch();
  const out = run({ cwd: dir, tools: ['Read', 'ToolSearch', 'mcp__github__get_file_contents'], steps: [{ script: 'await call("mcp__github__get_file_contents", { owner: "o", repo: "r", path: "docs/../README.md" })\nreturn "sent"' }] });
  const sent = out.calls.find((c) => c.tool === 'mcp__github__get_file_contents');
  expect((sent?.args as { path?: string } | undefined)?.path).toBe('docs/../README.md');
});

test('A relative Write path with .. is refused as relative and creates no file', () => {
  const dir = climbingFolder();
  const out = run({ cwd: dir, steps: [{ link: { from: join(dir, 'sub'), to: 'x/y' } }, { script: 'const r = await call("Write", { file_path: "sub/../new.txt", content: "x\\n" })\nreturn r.ok ? "wrote" : r.error' }] });
  expect(out.results[0]!.text).toContain('is relative');
  expect(existsSync(join(dir, 'x', 'new.txt'))).toBe(false);
  expect(existsSync(join(dir, 'new.txt'))).toBe(false);
});

test('A file read under one spelling takes two patch edits under another spelling', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'B'));
  writeFileSync(join(dir, 'B', 'f.txt'), 'alpha\nbeta\n');
  const viaA = JSON.stringify(join(dir, 'A', 'f.txt'));
  const viaB = JSON.stringify(join(dir, 'B', 'f.txt'));
  const out = run({ tools: NO_BASH, steps: [{ link: { from: join(dir, 'A'), to: join(dir, 'B') } }, { script: 'await read(' + viaA + ')\nconst seen = []\nfor (const [from, to] of [["alpha", "ALPHA"], ["beta", "BETA"]]) { try { await edit(' + viaB + ', from, to); seen.push("edited") } catch (e) { seen.push(String(e.message)) } }\nreturn seen.join(" | ")' }] });
  expect(out.results[0]!.text).toBe('edited | edited');
  expect(readFileSync(join(dir, 'B', 'f.txt'), 'utf8')).toBe('ALPHA\nBETA\n');
});

test('A read through a symlink never counts for the file the symlink is later pointed at', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  writeFileSync(join(dir, 'X', 'f.txt'), 'xxxx\n');
  writeFileSync(join(dir, 'Y', 'f.txt'), 'yyyy\n');
  const link = join(dir, 'L');
  const viaL = JSON.stringify(join(link, 'f.txt'));
  const out = run({ steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script: 'await read(' + viaL + ')\nawait sh("touch -r ' + join(dir, 'X', 'f.txt') + ' ' + join(dir, 'Y', 'f.txt') + '; ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nconst r = await call("Write", { file_path: ' + JSON.stringify(join(dir, 'Y', 'f.txt')) + ', content: "mine\\n" })\nreturn r.ok ? "wrote" : r.error' },
  ] });
  expect(out.results[0]!.text).toContain('has not been read yet');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('yyyy\n');
});

test('A file read by its plain path and written through another spelling can be edited by its plain path again', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'w', 'B', 'other', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'w', 'B', 'real'), { recursive: true });
  writeFileSync(join(dir, 'w', 'B', 'other', 'f.txt'), 'theirs\n');
  const plain = JSON.stringify(join(dir, 'w', 'A', 'other', 'f.txt'));
  const climbing = JSON.stringify(join(dir, 'w', 'A', 'real', 'L') + '/../f.txt');
  const out = run({ engineForgets: true, steps: [
    { link: { from: join(dir, 'w', 'A'), to: join(dir, 'w', 'B') } },
    { link: { from: join(dir, 'w', 'B', 'real', 'L'), to: join(dir, 'w', 'B', 'other', 'deep') } },
    { script: 'await read(' + plain + ')\ntry { await write(' + climbing + ', "mine\\n"); await edit(' + plain + ', "mine", "mine2"); return "done" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toBe('done');
  expect(readFileSync(join(dir, 'w', 'B', 'other', 'f.txt'), 'utf8')).toBe('mine2\n');
});

test('A file read under one spelling takes a patch edit under another spelling and then one under the first', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'B'));
  writeFileSync(join(dir, 'B', 'f.txt'), 'alpha\nbeta\n');
  const viaA = JSON.stringify(join(dir, 'A', 'f.txt'));
  const viaB = JSON.stringify(join(dir, 'B', 'f.txt'));
  const out = run({ tools: NO_BASH, steps: [{ link: { from: join(dir, 'A'), to: join(dir, 'B') } }, { script: 'await read(' + viaA + ')\nconst seen = []\nfor (const [p, from, to] of [[' + viaB + ', "alpha", "ALPHA"], [' + viaA + ', "beta", "BETA"]]) { try { await edit(p, from, to); seen.push("edited") } catch (e) { seen.push(String(e.message)) } }\nreturn seen.join(" | ")' }] });
  expect(out.results[0]!.text).toBe('edited | edited');
  expect(readFileSync(join(dir, 'B', 'f.txt'), 'utf8')).toBe('ALPHA\nBETA\n');
});

test('A path that climbs out of a symlinked folder and then through a plain file is refused and touches no file', () => {
  const dir = climbingFolder();
  writeFileSync(join(dir, 'x', 'notadir'), 'FILE\n');
  const p = JSON.stringify(join(dir, 'sub') + '/../notadir/../real.txt');
  const out = run({ steps: [
    { link: { from: join(dir, 'sub'), to: 'x/y' } },
    { script: 'try { await write(' + p + ', "MINE\\n", { force: true }); return "done" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toContain('names no file on disk');
  expect(readFileSync(join(dir, 'x', 'real.txt'), 'utf8')).toBe('INTENDED\n');
  expect(readFileSync(join(dir, 'real.txt'), 'utf8')).toBe('DECOY\n');
});

test('An unforced patch edit of a path that names no file on disk says so', () => {
  const dir = climbingFolder();
  const p = JSON.stringify(join(dir, 'sub') + '/../sub/../real.txt');
  const out = run({ tools: NO_BASH, steps: [
    { link: { from: join(dir, 'sub'), to: 'x/y' } },
    { script: 'try { await edit(' + p + ', "INTENDED", "MINE"); return "done" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toContain('names no file on disk');
  expect(readFileSync(join(dir, 'x', 'real.txt'), 'utf8')).toBe('INTENDED\n');
});

const shortRace = (tools: readonly string[] | undefined, readFirst: boolean, op: 'write' | 'edit') => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const go = join(dir, 'go');
  const [a, b] = ['a-ready', 'b-ready'].map((n) => join(dir, n));
  const act = (from: string, to: string) => (op === 'write' ? 'await write(' + f + ', "' + to + '\\n", { force: true })' : 'await edit(' + f + ', "' + from + '", "' + to + '", { force: true })');
  const racer = (from: string, to: string, marker: string) => '// @options: {"timeout_ms": 2000}\n' + (readFirst ? 'await read(' + f + ')\n' : '') + 'await sh("touch ' + marker + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 1500 })\ntry { ' + act(from, to) + '; return "landed" } catch (e) { return String(e.message) }';
  const out = run({ ...(tools ? { tools: [...tools] } : {}), statDelayMs: 50, steps: [{ script: racer('alpha', 'ALPHA', a), keepTurn: true }, { script: racer('beta', 'BETA', b), keepTurn: true }, { untilFile: a }, { untilFile: b }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  expect([out.results[0]!.text, out.results[1]!.text]).toEqual(['landed', 'landed']);
  const text = readFileSync(file, 'utf8');
  if (op === 'edit') expect(text).toBe('ALPHA\nBETA\n');
  else expect(['ALPHA\n', 'BETA\n']).toContain(text);
};

test('Two forced patch writes in two-second runs that read the file first both land', () => shortRace(NO_BASH, true, 'write'));
test('Two unread forced edits through Edit in two-second runs both land', () => shortRace(undefined, false, 'edit'));
test('Two unread forced patch edits in two-second runs both land', () => shortRace(NO_BASH, false, 'edit'));

const crossSpellingRace = (tools: readonly string[] | undefined) => {
  const dir = scratch();
  mkdirSync(join(dir, 'B'));
  writeFileSync(join(dir, 'B', 'f.txt'), 'orig\n');
  const viaA = JSON.stringify(join(dir, 'A', 'f.txt'));
  const viaB = JSON.stringify(join(dir, 'B', 'f.txt'));
  const ready = join(dir, 'y-read');
  const go = join(dir, 'go');
  const late = 'await read(' + viaA + ')\nawait sh("touch ' + ready + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { await write(' + viaA + ', "Y\\n"); return "Y wrote" } catch (e) { return "Y refused: " + String(e.message) }';
  const first = 'await read(' + viaB + ')\nawait write(' + viaB + ', "X\\n")\nreturn "X wrote"';
  const out = run({ ...(tools ? { tools: [...tools] } : {}), engineForgets: true, steps: [{ link: { from: join(dir, 'A'), to: join(dir, 'B') } }, { script: late, keepTurn: true }, { untilFile: ready }, { script: first, keepTurn: true }, { untilRunDone: 'r2' }, { collect: true }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const said = out.results.map((r) => r.text).join('\n');
  expect(said).toContain('X wrote');
  expect(said).toContain('Y refused: ');
  expect(said).toContain('changed since this session read it');
  expect(readFileSync(join(dir, 'B', 'f.txt'), 'utf8')).toBe('X\n');
};

test('A run that read a file under one spelling cannot overwrite what another run wrote under another spelling', () => crossSpellingRace(undefined));
test('A run that read a file under one spelling cannot patch over what another run wrote under another spelling', () => crossSpellingRace(NO_BASH));

test('An edit of a file read through a symlink that was then pointed elsewhere compares the file it names', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  writeFileSync(join(dir, 'X', 'f.txt'), 'xxxx\n');
  writeFileSync(join(dir, 'Y', 'f.txt'), 'yyyyyy\n');
  const link = join(dir, 'L');
  const out = run({ tools: NO_BASH, steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script: 'await read(' + JSON.stringify(join(link, 'f.txt')) + ')\nawait sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\ntry { await edit(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', "xxxx", "zzzz"); return "edited" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toBe('edited');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('zzzz\n');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('yyyyyy\n');
});

test('A Grep or Glob path whose .. climbs out of a symlinked folder searches the folder the disk names', () => {
  const dir = climbingFolder();
  const climbing = join(dir, 'sub') + '/..';
  const out = run({ tools: ['Read', 'ToolSearch', 'Grep', 'Glob'], steps: [{ link: { from: join(dir, 'sub'), to: 'x/y' } }, { script: 'await call("Grep", { pattern: "INTENDED", path: ' + JSON.stringify(climbing) + ' })\nawait call("Glob", { pattern: "*.txt", path: ' + JSON.stringify(climbing) + ' })\nreturn "searched"' }] });
  for (const tool of ['Grep', 'Glob']) expect((out.calls.find((c) => c.tool === tool)?.args as { path?: string } | undefined)?.path).toBe(join(dir, 'x'));
});

test('A cancelled run that read through a re-pointed symlink lends no read to the new target and keeps the delivered read of the old one', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  writeFileSync(join(dir, 'X', 'f.txt'), 'xxxx\n');
  writeFileSync(join(dir, 'Y', 'f.txt'), 'yyyy\n');
  utimesSync(join(dir, 'X', 'f.txt'), 1_700_000_000, 1_700_000_000);
  utimesSync(join(dir, 'Y', 'f.txt'), 1_700_000_000, 1_700_000_000);
  const link = join(dir, 'L');
  const viaL = JSON.stringify(join(link, 'f.txt'));
  const mark = join(dir, 'r2-read');
  const out = run({ steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script: 'await read(' + viaL + ')\nreturn "r1"', keepTurn: true },
    { untilRunDone: 'r1' },
    { collect: true },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nawait read(' + viaL + ')\nawait sh("touch ' + mark + '")\nawait waitFor(() => sh("test -f ' + join(dir, 'never') + '"), { every: 50, timeout: 30000 })\nreturn "r2"', keepTurn: true },
    { untilFile: mark },
    { script: 'return String(await cancel("r2"))', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
    { script: 'const wy = await call("Write", { file_path: ' + JSON.stringify(join(dir, 'Y', 'f.txt')) + ', content: "clobbered\\n" })\nconst wx = await call("Write", { file_path: ' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', content: "updated-x\\n" })\nreturn (wy.ok ? "wrote" : wy.error) + " | " + (wx.ok ? "wrote" : wx.error)' },
  ] });
  const last = out.results[out.results.length - 1]!.text;
  expect(last).toContain('has not been read yet');
  expect(last).toMatch(/ \| wrote$/);
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('yyyy\n');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('updated-x\n');
});

test('A patch after the file changed stops every spelling of it from counting as read', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'B'));
  const file = join(dir, 'B', 'f.txt');
  const ref = join(dir, 'ref');
  writeFileSync(file, 'initial\n');
  writeFileSync(ref, '');
  utimesSync(file, 1_700_000_000, 1_700_000_000);
  utimesSync(ref, 1_700_000_000, 1_700_000_000);
  const viaA = JSON.stringify(join(dir, 'A', 'f.txt'));
  const viaB = JSON.stringify(file);
  const out = run({ tools: NO_BASH, steps: [
    { link: { from: join(dir, 'A'), to: join(dir, 'B') } },
    { script: 'await read(' + viaA + ')\nawait read(' + viaB + ')\nawait sh("printf changed\\\\\\\\n > ' + file + '")\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + viaB + ', old_text: "changed", new_text: "patched" })\nawait sh("touch -r ' + ref + ' ' + file + '")\ntry { await write(' + viaB + ', "clobber\\n"); return "wrote" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[0]!.text).toContain('has not read it');
  expect(readFileSync(file, 'utf8')).toBe('patched\n');
});

test('A cancelled patch edit under one spelling leaves a delivered read under another spelling counted, and changed', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'B'));
  writeFileSync(join(dir, 'B', 'f.txt'), 'alpha\nbeta\n');
  const viaA = JSON.stringify(join(dir, 'A', 'f.txt'));
  const viaB = JSON.stringify(join(dir, 'B', 'f.txt'));
  const edited = join(dir, 'edited');
  const out = run({ tools: NO_BASH, steps: [
    { link: { from: join(dir, 'A'), to: join(dir, 'B') } },
    { script: 'await read(' + viaA + ')\nreturn "r1"' },
    { script: 'await edit(' + viaB + ', "alpha", "ALPHA")\nawait sh("touch ' + edited + '")\nawait waitFor(() => sh("test -f ' + join(dir, 'never') + '"), { every: 50, timeout: 30000 })\nreturn "r2"', keepTurn: true },
    { untilFile: edited },
    { script: 'return String(await cancel("r2"))', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
    { script: 'try { await edit(' + viaA + ', "beta", "BETA"); return "edited" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[out.results.length - 1]!.text).toContain('changed since this session read it');
  expect(readFileSync(join(dir, 'B', 'f.txt'), 'utf8')).toBe('ALPHA\nbeta\n');
});

test('A forced write in a two-second run lands while hundreds of other files of the same name count as read', () => {
  const dir = scratch();
  const names = Array.from({ length: 400 }, (_, i) => join(dir, 'd' + i, 'index.ts'));
  for (const n of names) {
    mkdirSync(dirname(n), { recursive: true });
    writeFileSync(n, 'x\n');
  }
  const target = join(dir, 'target', 'index.ts');
  mkdirSync(dirname(target));
  writeFileSync(target, 'old\n');
  const out = run({ steps: [
    { script: '// @options: {"timeout_ms": 120000}\nfor (const n of ' + JSON.stringify(names) + ') await read(n)\nreturn "read"' },
    { script: '// @options: {"timeout_ms": 2000}\ntry { await write(' + JSON.stringify(target) + ', "new\\n", { force: true }); return "wrote" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[1]!.text).toBe('wrote');
  expect(readFileSync(target, 'utf8')).toBe('new\n');
});

test('A forced write in a two-second run of a file that never stops changing says the run ran out of time', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'original\n');
  const out = run({ changeEveryRead: true, readDelayMs: 100, steps: [{ script: '// @options: {"timeout_ms": 2000}\ntry { await write(' + JSON.stringify(file) + ', "mine\\n", { force: true }); return "landed" } catch (x) { return String(x.message) }' }] });
  expect(out.results[0]!.text).toContain('the run ran out of time while it kept changing');
});

const otherRunRepoints = (tools: readonly string[] | undefined, act: 'edit-read' | 'write-unread') => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  writeFileSync(join(dir, 'X', 'f.txt'), 'xxxx\n');
  writeFileSync(join(dir, 'Y', 'f.txt'), 'yyyy\n');
  utimesSync(join(dir, 'X', 'f.txt'), 1_700_000_000, 1_700_000_000);
  utimesSync(join(dir, 'Y', 'f.txt'), 1_700_000_000, 1_700_000_000);
  const link = join(dir, 'L');
  const viaL = JSON.stringify(join(link, 'f.txt'));
  const [yRead, zRead, go] = ['y-read', 'z-read', 'go'].map((n) => join(dir, n));
  const yAct = act === 'edit-read' ? 'await edit(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', "xxxx", "zzzz")' : 'await write(' + JSON.stringify(join(dir, 'Y', 'f.txt')) + ', "CLOBBER\\n")';
  const y = 'await read(' + viaL + ')\nawait sh("touch ' + yRead + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\ntry { ' + yAct + '; return "Y done" } catch (e) { return "Y refused: " + String(e.message) }';
  const z = 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nawait read(' + viaL + ')\nawait sh("touch ' + zRead + '")\nawait waitFor(() => sh("test -f ' + join(dir, 'never') + '"), { every: 50, timeout: 20000 })\nreturn "Z"';
  const out = run({ ...(tools ? { tools: [...tools] } : {}), steps: [{ link: { from: link, to: join(dir, 'X') } }, { script: y, keepTurn: true }, { untilFile: yRead }, { script: z, keepTurn: true }, { untilFile: zRead }, { touch: go }, { untilRunDone: 'r1' }, { collect: true }] });
  const said = out.results.map((r) => r.text).join('\n');
  if (act === 'edit-read') {
    expect(said).toContain('Y done');
    expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('zzzz\n');
  } else {
    expect(said).toContain('Y refused: ');
    expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('yyyy\n');
  }
};

test('A run read through a symlink still names the file it read after another run re-reads the re-pointed link', () => otherRunRepoints(NO_BASH, 'edit-read'));
test('A run cannot write a file it never read because another run read a re-pointed link to it', () => otherRunRepoints(undefined, 'write-unread'));
test('A run cannot patch a file it never read because another run read a re-pointed link to it', () => otherRunRepoints(NO_BASH, 'write-unread'));

test('Relative and LS paths whose .. climbs out of a symlinked folder name the folder the disk names', () => {
  const dir = climbingFolder();
  const out = run({ cwd: dir, tools: ['Read', 'ToolSearch', 'Grep', 'LS'], steps: [{ link: { from: join(dir, 'sub'), to: 'x/y' } }, { script: 'await call("Grep", { pattern: "INTENDED", path: "sub/.." })\nawait call("LS", { path: ' + JSON.stringify(join(dir, 'sub') + '/..') + ' })\nreturn "listed"' }] });
  for (const tool of ['Grep', 'LS']) expect((out.calls.find((c) => c.tool === tool)?.args as { path?: string } | undefined)?.path).toBe(join(dir, 'x'));
});

const stalePatchBesideOpenRead = (patched: 'X' | 'Y') => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  const ref = join(dir, 'ref');
  for (const f of [join(dir, 'X', 'f.txt'), join(dir, 'Y', 'f.txt'), ref]) {
    writeFileSync(f, f === ref ? '' : 'xxxx\n');
    utimesSync(f, 1_700_000_000, 1_700_000_000);
  }
  const link = join(dir, 'L');
  const target = join(dir, patched, 'f.txt');
  const [zRead, go] = ['z-read', 'go'].map((n) => join(dir, n));
  const z = 'await read(' + JSON.stringify(join(link, 'f.txt')) + ')\nawait sh("touch ' + zRead + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nreturn "Z done"';
  const y = 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nawait sh("printf wwww\\\\\\\\n > ' + target + '")\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + JSON.stringify(target) + ', old_text: "wwww", new_text: "pppp" })\nawait sh("touch -r ' + ref + ' ' + target + '")\nreturn "Y patched"';
  const last = 'try { await write(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', "new\\n"); return "wrote" } catch (e) { return "refused: " + String(e.message) }';
  const out = run({ tools: NO_BASH, steps: [{ link: { from: link, to: join(dir, 'X') } }, { script: z, keepTurn: true }, { untilFile: zRead }, { script: y, keepTurn: true }, { untilRunDone: 'r2' }, { collect: true }, { touch: go }, { untilRunsDone: true }, { collect: true }, { script: last }] });
  return { text: out.results[out.results.length - 1]!.text, x: readFileSync(join(dir, 'X', 'f.txt'), 'utf8') };
};

test('A patch of a changed file forgets an open run read of it through a symlink that was re-pointed since', () => {
  const got = stalePatchBesideOpenRead('X');
  expect(got.text).toContain('refused: ');
  expect(got.text).toContain('has not read it');
  expect(got.x).toBe('pppp\n');
});

test('A patch of a changed file keeps an open run read of another file through a symlink re-pointed to it since', () => {
  const got = stalePatchBesideOpenRead('Y');
  expect(got.text).toBe('wrote');
  expect(got.x).toBe('new\n');
});

test('A read whose symlink is re-pointed while it is read counts for neither file', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  for (const f of [join(dir, 'X', 'f.txt'), join(dir, 'Y', 'f.txt')]) {
    writeFileSync(f, 'xxxx\n');
    utimesSync(f, 1_700_000_000, 1_700_000_000);
  }
  const link = join(dir, 'L');
  const go = join(dir, 'go');
  const a = 'await read(' + JSON.stringify(join(link, 'f.txt')) + ')\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(join(dir, 'Y', 'f.txt')) + ', content: "CLOBBER\\n" })\nreturn r.ok ? "wrote" : r.error';
  const out = run({ readDelayMs: 1500, steps: [{ link: { from: link, to: join(dir, 'X') } }, { script: a, keepTurn: true }, { untilTool: 'Read' }, { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nreturn "moved"', keepTurn: true }, { untilRunDone: 'r2' }, { touch: go }, { untilRunsDone: true }, { collect: true }] });
  const said = out.results.map((r) => r.text).join('\n');
  expect(said).not.toContain('\nwrote');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('xxxx\n');
});

const twinFiles = (dir: string, names: string[]) => {
  for (const n of names) {
    mkdirSync(dirname(join(dir, n)), { recursive: true });
    writeFileSync(join(dir, n), n.endsWith('ref') ? '' : 'xxxx\n');
    utimesSync(join(dir, n), 1_700_000_000, 1_700_000_000);
  }
};

const writeThroughRepointedLink = (tools: readonly string[] | undefined) => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const viaL = JSON.stringify(join(dir, 'L', 'f.txt'));
  const out = run({ ...(tools ? { tools: [...tools] } : {}), steps: [{ link: { from: join(dir, 'L'), to: join(dir, 'X') } }, { script: 'await read(' + viaL + ')\nawait sh("ln -sfn ' + join(dir, 'Y') + ' ' + join(dir, 'L') + '")\ntry { await write(' + viaL + ', "CLOBBER\\n"); return "wrote" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toContain('has not read it');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('xxxx\n');
};

test('A write through a symlink re-pointed since its read is refused as unread', () => writeThroughRepointedLink(undefined));
test('A patch write through a symlink re-pointed since its read is refused as unread', () => writeThroughRepointedLink(NO_BASH));

test('A read through a re-pointed symlink keeps the read of the file the symlink named before', () => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const viaL = JSON.stringify(join(dir, 'L', 'f.txt'));
  const out = run({ tools: NO_BASH, steps: [
    { link: { from: join(dir, 'L'), to: join(dir, 'X') } },
    { script: 'await read(' + viaL + ')\nreturn "r1"' },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + join(dir, 'L') + '")\nawait read(' + viaL + ')\nreturn "r2"' },
    { script: 'try { await edit(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', "xxxx", "zzzz"); return "edited" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[2]!.text).toBe('edited');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('zzzz\n');
});

test('A file read through a file symlink with another name counts as read for edits by its own name', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'f.txt'), 'alpha\nbeta\n');
  const out = run({ tools: NO_BASH, steps: [{ link: { from: join(dir, 'link.txt'), to: join(dir, 'f.txt') } }, { script: 'await read(' + JSON.stringify(join(dir, 'link.txt')) + ')\ntry { await edit(' + JSON.stringify(join(dir, 'f.txt')) + ', "alpha", "ALPHA"); return "edited" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toBe('edited');
  expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('ALPHA\nbeta\n');
});

test('A patch of a changed file stops a file symlink with another name from counting as read', () => {
  const dir = scratch();
  twinFiles(dir, ['f.txt', 'ref']);
  const file = join(dir, 'f.txt');
  const link = JSON.stringify(join(dir, 'link.txt'));
  const out = run({ tools: NO_BASH, steps: [{ link: { from: join(dir, 'link.txt'), to: file } }, { script: 'await read(' + link + ')\nawait sh("printf wwww\\\\\\\\n > ' + file + '")\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + JSON.stringify(file) + ', old_text: "wwww", new_text: "pppp" })\nawait sh("touch -r ' + join(dir, 'ref') + ' ' + file + '")\ntry { await write(' + link + ', "clobber\\n"); return "wrote" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toContain('has not read it');
  expect(readFileSync(file, 'utf8')).toBe('pppp\n');
});

const patchBesideOtherRun = (otherState: 'open' | 'settled') => {
  const dir = scratch();
  twinFiles(dir, ['B/f.txt', 'ref']);
  const file = join(dir, 'B', 'f.txt');
  const viaA = JSON.stringify(join(dir, 'A', 'f.txt'));
  const [r1Read, go] = ['r1-read', 'go'].map((n) => join(dir, n));
  const change = 'await sh("printf wwww\\\\\\\\n > ' + file + '")\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + JSON.stringify(file) + ', old_text: "wwww", new_text: "pppp" })\nawait sh("touch -r ' + join(dir, 'ref') + ' ' + file + '")\n';
  const clobber = 'try { await write(' + JSON.stringify(file) + ', "clobber\\n"); return "clobbered" } catch (e) { return "refused: " + String(e.message) }';
  const r1 = otherState === 'open' ? 'await read(' + viaA + ')\nawait sh("touch ' + r1Read + '")\nawait waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\n' + clobber : 'await read(' + viaA + ')\nreturn "r1 read"';
  const steps = otherState === 'open'
    ? [{ script: r1, keepTurn: true }, { untilFile: r1Read }, { script: change + 'await sh("touch ' + go + '")\nreturn "r2 patched"', keepTurn: true }, { untilRunsDone: true }, { collect: true }]
    : [{ script: 'await waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\n' + change + 'return "r1 patched"', keepTurn: true }, { script: r1, keepTurn: true }, { untilRunDone: 'r2' }, { touch: go }, { untilRunDone: 'r1' }, { collect: true }, { script: clobber }];
  const out = run({ tools: NO_BASH, steps: [{ link: { from: join(dir, 'A'), to: join(dir, 'B') } }, ...steps] });
  expect(out.results.map((r) => r.text).join('\n')).toContain('refused: ');
  expect(readFileSync(file, 'utf8')).toBe('pppp\n');
};

test('A patch of a changed file stops an open run read of it from counting as read', () => patchBesideOtherRun('open'));
test('A patch of a changed file stops a finished but not yet handed back run read of it from counting as read', () => patchBesideOtherRun('settled'));

test('A file read again after two thousand other reads still counts as read', () => {
  const dir = scratch();
  const files = Array.from({ length: 2001 }, (_, i) => join(dir, 'f' + i + '.txt'));
  for (const f of files) writeFileSync(f, 'hello\n');
  const out = run({ tools: NO_BASH, steps: [
    { script: '// @options: {"timeout_ms": 300000}\nfor (const f of ' + JSON.stringify(files.slice(0, 2000)) + ') await read(f)\nreturn "read 2000"' },
    { script: 'await read(' + JSON.stringify(files[0]) + ')\nawait read(' + JSON.stringify(files[2000]) + ')\nreturn "read 2"' },
    { script: 'try { await edit(' + JSON.stringify(files[0]) + ', "hello", "world"); return "edited" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[2]!.text).toBe('edited');
  expect(readFileSync(files[0]!, 'utf8')).toBe('world\n');
});

test('A read through a re-pointed symlink whose reply fails lends no read to the new target and keeps the old one', () => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const viaL = JSON.stringify(join(dir, 'L', 'f.txt'));
  const script = 'await call("Read", { file_path: ' + viaL + ' })\nawait call("Bash", { command: "ln -sfn ' + join(dir, 'Y') + ' ' + join(dir, 'L') + '" })\nconst second = call("Read", { file_path: ' + viaL + ' })\nawait call("Bash", { command: "true" })\nawait second\nconst wy = await call("Write", { file_path: ' + JSON.stringify(join(dir, 'Y', 'f.txt')) + ', content: "CLOBBER\\n" })\nconst ex = await call("Edit", { file_path: ' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', old_string: "xxxx", new_string: "zzzz" })\nreturn (wy.ok ? "wrote" : wy.error) + " | " + (ex.ok ? "edited" : ex.error)';
  const out = run({ failReplyAfter: { fail: 3, after: 4 }, steps: [{ link: { from: join(dir, 'L'), to: join(dir, 'X') } }, { script }] });
  expect(out.results[0]!.text).toContain('has not been read yet');
  expect(out.results[0]!.text).toMatch(/ \| edited$/);
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('xxxx\n');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('zzzz\n');
});

test('A patch of a changed file stops a finished but not yet handed back run read of it through a since re-pointed symlink', () => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt', 'ref']);
  const link = join(dir, 'L');
  const target = join(dir, 'X', 'f.txt');
  const y = 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nawait sh("printf wwww\\\\\\\\n > ' + target + '")\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + JSON.stringify(target) + ', old_text: "wwww", new_text: "pppp" })\nawait sh("touch -r ' + join(dir, 'ref') + ' ' + target + '")\nreturn "Y patched"';
  const last = 'try { await write(' + JSON.stringify(target) + ', "new\\n"); return "wrote" } catch (e) { return "refused: " + String(e.message) }';
  const go = join(dir, 'go');
  const out = run({ tools: NO_BASH, steps: [{ link: { from: link, to: join(dir, 'X') } }, { script: 'await waitFor(() => sh("test -f ' + go + '"), { every: 20, timeout: 20000 })\n' + y, keepTurn: true }, { script: 'await read(' + JSON.stringify(join(link, 'f.txt')) + ')\nreturn "Z done"', keepTurn: true }, { untilRunDone: 'r2' }, { touch: go }, { untilRunDone: 'r1' }, { collect: true }, { script: last }] });
  expect(out.results[out.results.length - 1]!.text).toContain('has not read it');
  expect(readFileSync(target, 'utf8')).toBe('pppp\n');
});

test('A read in pages whose symlink is re-pointed between pages counts for neither file', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  writeFileSync(join(dir, 'X', 'f.txt'), 'xxxx\nXXXX\n');
  writeFileSync(join(dir, 'Y', 'f.txt'), 'yyyy\nYYYY\n');
  for (const f of ['X', 'Y']) utimesSync(join(dir, f, 'f.txt'), 1_700_000_000, 1_700_000_000);
  const viaL = JSON.stringify(join(dir, 'L', 'f.txt'));
  const script = 'await call("Read", { file_path: ' + viaL + ', limit: 1 })\nawait call("Bash", { command: "ln -sfn ' + join(dir, 'Y') + ' ' + join(dir, 'L') + '" })\nawait call("Read", { file_path: ' + viaL + ', offset: 2 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(join(dir, 'Y', 'f.txt')) + ', content: "CLOBBER\\n" })\nreturn r.ok ? "wrote" : r.error';
  const out = run({ steps: [{ link: { from: join(dir, 'L'), to: join(dir, 'X') } }, { script }] });
  expect(out.results[0]!.text).toContain('has not been read yet');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('yyyy\nYYYY\n');
});

const linkMovesDuringWrite = (slow: { tools?: string[]; readDelayMs?: number; statDelayMs?: number }) => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const link = join(dir, 'L');
  const viaL = JSON.stringify(join(link, 'f.txt'));
  const marker = join(dir, 'writing');
  const writer = 'await read(' + viaL + ')\nawait sh("touch ' + marker + '")\ntry { await write(' + viaL + ', "CLOBBER\\n"); return "wrote" } catch (e) { return String(e.message) }';
  const out = run({ ...slow, steps: [{ link: { from: link, to: join(dir, 'X') } }, { script: writer, keepTurn: true }, { untilFile: marker }, { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nreturn "moved"', keepTurn: true }, { untilRunsDone: true }, { collect: true }] });
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('xxxx\n');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('xxxx\n');
  expect(out.results.map((r) => r.text).join('\n')).toMatch(/changed since this session read it|has not read it/);
};

test('A patch write through a symlink moved while the write runs never lands on the file the symlink moved to', () => linkMovesDuringWrite({ tools: [...NO_BASH], readDelayMs: 1500 }));
test('A Write through a symlink moved while the write runs never lands on the file the symlink moved to', () => linkMovesDuringWrite({ statDelayMs: 1500 }));

test('A page chain refreshed by a later run outlives two hundred chains started before it', () => {
  const dir = scratch();
  const two = 'one\ntwo\n';
  const p = join(dir, 'p.txt');
  writeFileSync(p, two);
  const qs = Array.from({ length: 200 }, (_, i) => join(dir, 'q' + i + '.txt'));
  for (const q of qs) writeFileSync(q, two);
  const firstPage = (f: string) => 'await call("Read", { file_path: ' + JSON.stringify(f) + ', limit: 1 })\n';
  const out = run({ steps: [
    { script: firstPage(p) + 'return "p"' },
    { script: '// @options: {"timeout_ms": 120000}\nfor (const q of ' + JSON.stringify(qs.slice(0, 199)) + ') await call("Read", { file_path: q, limit: 1 })\nreturn "q"' },
    { script: firstPage(p) + 'return "p again"' },
    { script: firstPage(qs[199]!) + 'return "q199"' },
    { script: 'await call("Read", { file_path: ' + JSON.stringify(p) + ', offset: 2 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(p) + ', content: "mine\\n" })\nreturn r.ok ? "wrote" : r.error' },
  ] });
  expect(out.results[4]!.text).toBe('wrote');
  expect(readFileSync(p, 'utf8')).toBe('mine\n');
});

test('A patch write whose read record a compaction clears mid-write is refused and leaves the file alone', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\nbeta\n');
  const f = JSON.stringify(file);
  const marker = join(dir, 'writing');
  const out = run({ tools: NO_BASH, readDelayMs: 600, steps: [
    { script: 'await read(' + f + ')\nreturn "read"' },
    { script: 'await sh("touch ' + marker + '")\ntry { await write(' + f + ', "CLOBBER\\nbeta\\n"); return "wrote" } catch (e) { return String(e.message) }', keepTurn: true },
    { untilFile: marker },
    { untilCalls: { tool: 'Read', count: 2 } },
    { compact: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  expect(out.results.map((r) => r.text).join('\n')).toContain('has not read it');
  expect(readFileSync(file, 'utf8')).toBe('alpha\nbeta\n');
});

const bigTwins = (dir: string, lines: number, line: (tag: string, i: number) => string) => {
  for (const [d, tag] of [['X', 'XXXX'], ['Y', 'YYYY']] as const) {
    mkdirSync(join(dir, d));
    writeFileSync(join(dir, d, 'big.txt'), Array.from({ length: lines }, (_, i) => line(tag, i)).join('\n') + '\n');
    utimesSync(join(dir, d, 'big.txt'), 1_700_000_000, 1_700_000_000);
  }
};

const stitchAcrossMovedLink = (reader: 'read' | 'tools.Read') => {
  const dir = scratch();
  const lines = reader === 'read' ? 2400 : 15000;
  const line = (tag: string, i: number) => (reader === 'read' ? tag + ' ' + String(i).padStart(4, '0') : tag + ' ' + String(i).padStart(5, '0') + ' ' + 'x'.repeat(60));
  bigTwins(dir, lines, line);
  const small = join(dir, 'small.txt');
  writeFileSync(small, 'small\n');
  const viaL = JSON.stringify(join(dir, 'L', 'big.txt'));
  const start = reader === 'read' ? 'read(' + viaL + ')' : 'tools.Read({ file_path: ' + viaL + ' }).then(String)';
  const midway = reader === 'read' ? '' : 'await read(' + JSON.stringify(small) + ')\nawait read(' + JSON.stringify(small) + ')\n';
  const last = line('YYYY', lines - 1).split(' ').slice(0, 2).join(' ');
  const first = line('XXXX', 0).split(' ').slice(0, 2).join(' ');
  const script = 'const p = ' + start + '\n' + midway + 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + join(dir, 'L') + '")\ntry { const t = await p; return (t.includes("' + first + '") ? "X" : "") + (t.includes("' + last + '") ? "Y" : "") } catch (e) { return String(e.message) }';
  const out = run({ readLagMs: 400, steps: [{ link: { from: join(dir, 'L'), to: join(dir, 'X') } }, { script }] });
  expect(out.results[0]!.text).not.toBe('XY');
  expect(out.results[0]!.text).toMatch(/^Y$|changed while it was read/);
};

test('A read() in pages whose symlink moves between pages never stitches two files', () => stitchAcrossMovedLink('read'));
test('A tools.Read the mod pages whose symlink moves between pages never stitches two files', () => stitchAcrossMovedLink('tools.Read'));

test('A patch still finishing from a cleared session leaves the new session reads alone', () => {
  const dir = scratch();
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'alpha\n');
  const f = JSON.stringify(file);
  const creates = Array.from({ length: 8 }, (_, i) => '{ op: "create", path: ' + JSON.stringify(join(dir, 'g' + i + '.txt')) + ', new_text: "g\\n" }').join(', ');
  const go = join(dir, 'go');
  const out = run({ tools: NO_BASH, statDelayMs: 350, steps: [
    { script: 'await call("mcp__lean-ctx__ctx_patch", { ops: [' + creates + ', { op: "replace_unique", path: ' + f + ', old_text: "alpha", new_text: "patched" }] })\nreturn "patched"', keepTurn: true },
    { untilFile: join(dir, 'g0.txt') },
    { clear: true },
    { reload: true },
    { script: 'await read(' + f + ')\nawait waitFor(() => sh("test -f ' + go + '"), { every: 1500, timeout: 40000 })\ntry { await edit(' + f + ', "patched", "edited"); return "edited" } catch (e) { return String(e.message) }', keepTurn: true },
    { untilQuiet: true },
    { touch: go },
    { untilRunsDone: true },
    { collect: true },
  ] });
  expect(out.results.map((r) => r.text).join('\n')).toContain('edited');
  expect(readFileSync(file, 'utf8')).toBe('edited\n');
});

test('A patch batch that creates a file through a symlink and edits it by its real path leaves it counted as read', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'B'));
  const viaA = JSON.stringify(join(dir, 'A', 'f.txt'));
  const viaB = JSON.stringify(join(dir, 'B', 'f.txt'));
  const out = run({ tools: NO_BASH, steps: [{ link: { from: join(dir, 'A'), to: join(dir, 'B') } }, { script: 'await call("mcp__lean-ctx__ctx_patch", { ops: [{ op: "create", path: ' + viaA + ', new_text: "alpha\\nbeta\\n" }, { op: "replace_unique", path: ' + viaB + ', old_text: "alpha", new_text: "ALPHA" }] })\ntry { await edit(' + viaB + ', "beta", "BETA"); return "edited" } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toBe('edited');
  expect(readFileSync(join(dir, 'B', 'f.txt'), 'utf8')).toBe('ALPHA\nBETA\n');
});

const linkMovesWhileWaitingForLock = (target: 'existing' | 'new') => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const name = target === 'existing' ? 'f.txt' : 'new.txt';
  const link = join(dir, 'L');
  const [aReady, bReady, bAsked, go, goB] = ['a-ready', 'b-ready', 'b-asked', 'go', 'go-b'].map((n) => join(dir, n));
  const gate = (ready: string, start: string) => 'await sh("touch ' + ready + '")\nawait waitFor(() => sh("test -f ' + start + '"), { every: 20, timeout: 20000 })\n';
  const a = (target === 'existing' ? 'await read(' + JSON.stringify(join(dir, 'X', name)) + ')\n' : '') + gate(aReady, go) + 'const r = await call("Write", { file_path: ' + JSON.stringify(join(dir, 'X', name)) + ', content: "A\\n" })\nreturn r.ok ? "A wrote" : "A: " + r.error';
  const b = (target === 'existing' ? 'await read(' + JSON.stringify(join(dir, 'Y', name)) + ')\n' : '') + gate(bReady, goB) + 'await sh("touch ' + bAsked + '")\nconst r = await call("Write", { file_path: ' + JSON.stringify(join(link, name)) + ', content: "B\\n" })\nreturn r.ok ? "B wrote" : "B refused: " + r.error';
  const out = run({ writeDelayMs: 1500, steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script: a, keepTurn: true },
    { script: b, keepTurn: true },
    { untilFile: aReady },
    { untilFile: bReady },
    { touch: go },
    { untilTool: 'Write' },
    { touch: goB },
    { untilFile: bAsked },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nreturn "moved"', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  const said = out.results.map((r) => r.text).join('\n');
  expect(said).toContain('A wrote');
  expect(said).toContain('B refused: ');
  expect(readFileSync(join(dir, 'X', name), 'utf8')).toBe('A\n');
  expect(existsSync(join(dir, 'Y', name)) ? readFileSync(join(dir, 'Y', name), 'utf8') : 'absent').toBe(target === 'existing' ? 'xxxx\n' : 'absent');
};

test('A Write through a symlink that moves while it waits for another write lock is refused and leaves the new target alone', () => linkMovesWhileWaitingForLock('existing'));
test('A Write creating a file through a symlink that moves while it waits for another write lock is refused and creates nothing', () => linkMovesWhileWaitingForLock('new'));

test('A direct patch through a symlink that moves while it is checked lands on the file it checked', () => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const link = join(dir, 'L');
  const marker = join(dir, 'read');
  const script = 'await read(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ')\nawait sh("touch ' + marker + '")\nconst r = await call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + JSON.stringify(join(link, 'f.txt')) + ', old_text: "xxxx", new_text: "BBBB" })\nreturn r.ok ? "patched" : "refused: " + r.error';
  const out = run({ tools: NO_BASH, statDelayMs: 700, steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script, keepTurn: true },
    { untilFile: marker },
    { untilStatPending: true },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nreturn "moved"', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  const said = out.results.map((r) => r.text).join('\n');
  expect(said).toContain('moved');
  expect(said).toContain('patched');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('xxxx\n');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('BBBB\n');
});

const patchWhileLinkMovesForLock = (what: 'create' | 'replace') => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const link = join(dir, 'L');
  const name = what === 'create' ? 'new.txt' : 'f.txt';
  const [aReady, bReady, bAsked, go, goB] = ['a-ready', 'b-ready', 'b-asked', 'go', 'go-b'].map((n) => join(dir, n));
  const gate = (ready: string, start: string) => 'await sh("touch ' + ready + '")\nawait waitFor(() => sh("test -f ' + start + '"), { every: 20, timeout: 20000 })\n';
  const aAct = what === 'create' ? 'await write(' + JSON.stringify(join(dir, 'X', name)) + ', "A\\n")' : 'await edit(' + JSON.stringify(join(dir, 'X', name)) + ', "xxxx", "AAAA")';
  const a = (what === 'create' ? '' : 'await read(' + JSON.stringify(join(dir, 'X', name)) + ')\n') + gate(aReady, go) + aAct + '\nreturn "A edited"';
  const bCall = what === 'create' ? 'await write(' + JSON.stringify(join(link, name)) + ', "B\\n").then(() => "B wrote", (e) => "B refused: " + e.message)' : 'await call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + JSON.stringify(join(link, name)) + ', old_text: "xxxx", new_text: "BBBB" }).then((r) => (r.ok ? "B patched" : "B refused: " + r.error))';
  const b = (what === 'create' ? '' : 'await read(' + JSON.stringify(join(dir, 'Y', 'f.txt')) + ')\n') + gate(bReady, goB) + 'await sh("touch ' + bAsked + '")\nreturn ' + bCall;
  const out = run({ tools: NO_BASH, patchDelayMs: 1500, steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script: a, keepTurn: true },
    { script: b, keepTurn: true },
    { untilFile: aReady },
    { untilFile: bReady },
    { touch: go },
    { untilTool: 'mcp__lean-ctx__ctx_patch' },
    { touch: goB },
    { untilFile: bAsked },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nreturn "moved"', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  const said = out.results.map((r) => r.text).join('\n');
  expect(said).toContain('A edited');
  expect(said).toContain('B refused: ');
  expect(existsSync(join(dir, 'Y', name)) ? readFileSync(join(dir, 'Y', name), 'utf8') : 'absent').toBe(what === 'create' ? 'absent' : 'xxxx\n');
};

test('A patch write creating a file through a symlink that moves while it waits for another write lock is refused and creates nothing', () => patchWhileLinkMovesForLock('create'));
test('A direct patch through a symlink that moves while it waits for another write lock is refused and leaves the new target alone', () => patchWhileLinkMovesForLock('replace'));

const linkMovesInsideTheCall = (tool: 'Write' | 'patch') => {
  const dir = scratch();
  twinFiles(dir, ['X/f.txt', 'Y/f.txt']);
  const link = join(dir, 'L');
  const viaL = JSON.stringify(join(link, 'f.txt'));
  const act = tool === 'Write' ? 'const r = await call("Write", { file_path: ' + viaL + ', content: "MINE\\n" })' : 'const r = await call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + viaL + ', old_text: "xxxx", new_text: "MINE" })';
  const out = run({ ...(tool === 'Write' ? { writeDelayMs: 1500 } : { tools: [...NO_BASH], patchDelayMs: 1500 }), steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script: 'await read(' + viaL + ')\n' + act + '\nreturn r.ok ? "landed" : r.error', keepTurn: true },
    { untilTool: tool === 'Write' ? 'Write' : 'mcp__lean-ctx__ctx_patch' },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y') + ' ' + link + '")\nreturn "moved"', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  expect(out.results.map((r) => r.text).join('\n')).toContain('landed');
  const sent = out.calls.filter((c) => c.tool === (tool === 'Write' ? 'Write' : 'mcp__lean-ctx__ctx_patch')).at(-1)?.args as { file_path?: string; path?: string } | undefined;
  expect(tool === 'Write' ? sent?.file_path : sent?.path).toBe(realpathSync(join(dir, 'X', 'f.txt')));
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('MINE\n');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('xxxx\n');
};

test('A Write through a symlink that moves once the Write has started lands on the file it checked', () => linkMovesInsideTheCall('Write'));
test('A patch through a symlink that moves once the patch has started lands on the file it checked', () => linkMovesInsideTheCall('patch'));

test('A page chain kept fresh outlives two thousand other chains and an older run handing back a shorter one', () => {
  const dir = scratch();
  const p = join(dir, 'p.txt');
  writeFileSync(p, 'a\nb\nc\nd\n');
  const gateFile = join(dir, 'gate');
  const page = (f: string, offset: number, limit: number) => 'await call("Read", { file_path: ' + JSON.stringify(f) + ', offset: ' + offset + ', limit: ' + limit + ' })\n';
  const others = Array.from({ length: 2010 }, (_, i) => join(dir, 'q' + i + '.txt'));
  for (const f of others) writeFileSync(f, 'one\ntwo\n');
  const out = run({ steps: [
    { script: page(p, 1, 1) + 'await waitFor(() => sh("test -f ' + gateFile + '"), { every: 200, timeout: 240000 })\nreturn "old"', keepTurn: true },
    { script: page(p, 1, 2) + 'return "fresh"', keepTurn: true },
    { untilRunDone: 'r2' },
    { collect: true },
    { script: '// @options: {"timeout_ms": 120000}\nfor (const f of ' + JSON.stringify(others) + ') await call("Read", { file_path: f, limit: 1 })\n' + page(p, 1, 2) + 'return "others"', keepTurn: true },
    { untilRunDone: 'r3' },
    { collect: true },
    { touch: gateFile },
    { untilRunDone: 'r1' },
    { collect: true },
    { script: 'await call("Read", { file_path: ' + JSON.stringify(p) + ', offset: 3 })\nconst r = await call("Write", { file_path: ' + JSON.stringify(p) + ', content: "mine\\n" })\nreturn r.ok ? "wrote" : r.error' },
  ] });
  expect(out.results[out.results.length - 1]!.text).toBe('wrote');
  expect(readFileSync(p, 'utf8')).toBe('mine\n');
});

test('A patch path starting with ~ is refused, since the patch tool reads ~ as a folder and not as home', () => {
  const dir = scratch();
  const home = scratch();
  writeFileSync(join(home, 'f.txt'), 'alpha\n');
  const out = run({ cwd: dir, home, tools: NO_BASH, steps: [{ script: 'const r = await call("mcp__lean-ctx__ctx_patch", { op: "create", path: "~/f.txt", new_text: "made\\n" })\nconst b = await call("mcp__lean-ctx__ctx_patch", { ops: [{ op: "create", path: "~/g.txt", new_text: "made\\n" }] })\nreturn (r.ok ? "made" : r.error) + " | " + (b.ok ? "made" : b.error)' }] });
  const said = out.results[0]!.text;
  expect(said.split(' | ')).toHaveLength(2);
  for (const part of said.split(' | ')) expect(part).toContain('full path');
  expect(existsSync(join(dir, '~'))).toBe(false);
  expect(readFileSync(join(home, 'f.txt'), 'utf8')).toBe('alpha\n');
});

test('A page chain advanced at the end of a run that paged two hundred other files first still counts once handed back', () => {
  const dir = scratch();
  const p = join(dir, 'p.txt');
  writeFileSync(p, 'a\nb\nc\n');
  const qs = Array.from({ length: 200 }, (_, i) => join(dir, 'q' + i + '.txt'));
  for (const q of qs) writeFileSync(q, '1\n2\n');
  const pf = JSON.stringify(p);
  const out = run({ steps: [
    { script: '// @options: {"timeout_ms": 120000}\nawait call("Read", { file_path: ' + pf + ', offset: 1, limit: 1 })\nfor (const q of ' + JSON.stringify(qs) + ') await call("Read", { file_path: q, offset: 1, limit: 1 })\nawait call("Read", { file_path: ' + pf + ', offset: 2, limit: 1 })\nreturn "paged"' },
    { script: 'await call("Read", { file_path: ' + pf + ', offset: 3 })\nconst r = await call("Write", { file_path: ' + pf + ', content: "mine\\n" })\nreturn r.ok ? "wrote" : r.error' },
  ] });
  expect(out.results[1]!.text).toBe('wrote');
  expect(readFileSync(p, 'utf8')).toBe('mine\n');
});

test('A file edited at the end of a run that read two thousand other files first still counts as read once handed back', () => {
  const dir = scratch();
  const p = join(dir, 'p.txt');
  writeFileSync(p, 'alpha\nbeta\n');
  const qs = Array.from({ length: 2000 }, (_, i) => join(dir, 'q' + i + '.txt'));
  for (const q of qs) writeFileSync(q, 'q\n');
  const pf = JSON.stringify(p);
  const out = run({ tools: NO_BASH, steps: [
    { script: '// @options: {"timeout_ms": 240000}\nawait read(' + pf + ')\nfor (const q of ' + JSON.stringify(qs) + ') await read(q)\nawait edit(' + pf + ', "alpha", "ALPHA")\nreturn "edited-1"' },
    { script: 'try { await edit(' + pf + ', "beta", "BETA"); return "edited-2" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results.map((r) => r.text)).toEqual(['edited-1', 'edited-2']);
  expect(readFileSync(p, 'utf8')).toBe('ALPHA\nBETA\n');
});

test('A Write through a symlink that names a missing file while it is checked and an unread one after never overwrites the unread file', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'X'));
  mkdirSync(join(dir, 'Y'));
  writeFileSync(join(dir, 'X', 'f.txt'), 'PRECIOUS\n');
  const link = join(dir, 'L');
  const out = run({ engineForgets: true, existsGapMs: 600, steps: [
    { link: { from: link, to: join(dir, 'X') } },
    { script: 'const r = await call("Write", { file_path: ' + JSON.stringify(join(link, 'f.txt')) + ', content: "CLOBBER\\n" })\nreturn r.ok ? "wrote" : "refused: " + r.error', keepTurn: true },
    { untilExists: 'asked' },
    { relink: { from: link, to: join(dir, 'Y') } },
    { untilExists: 'answered' },
    { relink: { from: link, to: join(dir, 'X') } },
    { untilRunsDone: true },
    { collect: true },
  ] });
  expect(out.results.map((r) => r.text).join('\n')).toContain('refused: ');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('PRECIOUS\n');
});
test('A patch through a climbing path whose symlink moves while it waits for another write lock is refused and leaves the file alone', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'X', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'Y', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'X', 'f.txt'), 'xxxx\nOTHER\n');
  writeFileSync(join(dir, 'Y', 'f.txt'), 'xxxx\nOTHER\n');
  const sub = join(dir, 'sub');
  const climbing = JSON.stringify(sub + '/../f.txt');
  const [aReady, bReady, bAsked, go, goB] = ['a-ready', 'b-ready', 'b-asked', 'go', 'go-b'].map((n) => join(dir, n));
  const gate = (ready: string, start: string) => 'await sh("touch ' + ready + '")\nawait waitFor(() => sh("test -f ' + start + '"), { every: 20, timeout: 20000 })\n';
  const a = 'await read(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ')\n' + gate(aReady, go) + 'await edit(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', "OTHER", "AAAA")\nreturn "A edited"';
  const b = gate(bReady, goB) + 'await sh("touch ' + bAsked + '")\nconst r = await call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + climbing + ', old_text: "xxxx", new_text: "BBBB" })\nreturn r.ok ? "B patched" : "B refused: " + r.error';
  const out = run({ tools: NO_BASH, patchDelayMs: 1500, steps: [
    { link: { from: sub, to: join(dir, 'X', 'deep') } },
    { script: a, keepTurn: true },
    { script: b, keepTurn: true },
    { untilFile: aReady },
    { untilFile: bReady },
    { touch: go },
    { untilTool: 'mcp__lean-ctx__ctx_patch' },
    { touch: goB },
    { untilFile: bAsked },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y', 'deep') + ' ' + sub + '")\nreturn "moved"', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  const said = out.results.map((r) => r.text).join('\n');
  expect(said).toContain('A edited');
  expect(said).toContain('B refused: ');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('xxxx\nAAAA\n');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('xxxx\nOTHER\n');
});

test('A patch with an empty path is passed to the patch tool instead of being refused as a moved file', () => {
  const dir = scratch();
  const out = run({ cwd: dir, tools: NO_BASH, steps: [{ script: 'const r = await call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: "", old_text: "a", new_text: "b" })\nreturn r.ok ? "patched" : r.error' }] });
  expect(out.results[0]!.text).not.toContain('now names another file');
  expect(out.calls.filter((c) => c.tool === 'mcp__lean-ctx__ctx_patch')).toHaveLength(1);
});

test('A patch path starting with ~ that climbs with .. is refused like any other ~ path and leaves the home file alone', () => {
  const dir = scratch();
  const home = scratch();
  writeFileSync(join(home, 'f.txt'), 'alpha\n');
  const out = run({ cwd: dir, home, tools: NO_BASH, steps: [{ script: 'const r = await call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: "~/sub/../f.txt", old_text: "alpha", new_text: "CLIMBED" })\nconst b = await call("mcp__lean-ctx__ctx_patch", { ops: [{ op: "replace_unique", path: "~/sub/../f.txt", old_text: "alpha", new_text: "CLIMBED" }] })\nreturn (r.ok ? "patched" : r.error) + " | " + (b.ok ? "patched" : b.error)' }] });
  for (const part of out.results[0]!.text.split(' | ')) expect(part).toContain('full path');
  expect(readFileSync(join(home, 'f.txt'), 'utf8')).toBe('alpha\n');
});

test('A read() of a climbing path whose symlink moves between pages never stitches two files', () => {
  const dir = scratch();
  bigTwins(dir, 2400, (tag, i) => tag + ' ' + String(i).padStart(4, '0'));
  mkdirSync(join(dir, 'X', 'deep'));
  mkdirSync(join(dir, 'Y', 'deep'));
  const sub = join(dir, 'sub');
  const script = 'const p = read(' + JSON.stringify(sub + '/../big.txt') + ')\nawait sh("ln -sfn ' + join(dir, 'Y', 'deep') + ' ' + sub + '")\ntry { const t = await p; return (t.includes("XXXX 0000") ? "X" : "") + (t.includes("YYYY 2399") ? "Y" : "") } catch (e) { return String(e.message) }';
  const out = run({ readLagMs: 400, steps: [{ link: { from: sub, to: join(dir, 'X', 'deep') } }, { script }] });
  expect(out.results[0]!.text).not.toBe('XY');
  expect(out.results[0]!.text).toMatch(/^Y$|changed while it was read/);
});

const lateHandBack = (kind: 'whole' | 'pages') => {
  const dir = scratch();
  const p = join(dir, 'p.txt');
  writeFileSync(p, 'alpha\nbeta\n');
  const count = kind === 'whole' ? 2000 : 200;
  const qs = Array.from({ length: count }, (_, i) => join(dir, 'q' + i + '.txt'));
  for (const q of qs) writeFileSync(q, 'one\ntwo\n');
  const gateFile = join(dir, 'gate');
  const pf = JSON.stringify(p);
  const older = '// @options: {"timeout_ms": 240000}\nfor (const q of ' + JSON.stringify(qs) + ') ' + (kind === 'whole' ? 'await read(q)' : 'await call("Read", { file_path: q, offset: 1, limit: 1 })') + '\nawait waitFor(() => sh("test -f ' + gateFile + '"), { every: 200, timeout: 200000 })\nreturn "older"';
  const newer = kind === 'whole' ? 'await read(' + pf + ')\nreturn "newer"' : 'await call("Read", { file_path: ' + pf + ', offset: 1, limit: 1 })\nreturn "newer"';
  const last = kind === 'whole' ? 'try { await edit(' + pf + ', "alpha", "ALPHA"); return "edited" } catch (e) { return String(e.message) }' : 'await call("Read", { file_path: ' + pf + ', offset: 2 })\nconst r = await call("Write", { file_path: ' + pf + ', content: "mine\\n" })\nreturn r.ok ? "wrote" : r.error';
  const ready = join(dir, 'older-read');
  const olderMarked = older.replace('\nawait waitFor', '\nawait sh("touch ' + ready + '")\nawait waitFor');
  const out = run({ ...(kind === 'whole' ? { tools: [...NO_BASH] } : {}), steps: [
    { script: olderMarked, keepTurn: true },
    { untilFile: ready },
    { script: newer, keepTurn: true },
    { untilRunDone: 'r2' },
    { collect: true },
    { touch: gateFile },
    { untilRunDone: 'r1' },
    { collect: true },
    { script: last },
  ] });
  expect(out.results[out.results.length - 1]!.text).toBe(kind === 'whole' ? 'edited' : 'wrote');
};

test('A file read after an older run read two thousand others still counts once that older run is handed back', () => lateHandBack('whole'));
test('A page chain started after an older run paged two hundred others still counts once that older run is handed back', () => lateHandBack('pages'));

test('A patch batch climbing two symlinks to one file is refused when either moves while it waits for another write lock', () => {
  const dir = scratch();
  for (const d of ['X/deep', 'Y/deep']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'X', 'f.txt'), 'bbbb\ncccc\naaaa\n');
  writeFileSync(join(dir, 'Y', 'f.txt'), 'bbbb\ncccc\naaaa\n');
  const [sub1, sub2] = ['sub1', 'sub2'].map((n) => join(dir, n));
  const [aReady, bReady, bAsked, go, goB] = ['a-ready', 'b-ready', 'b-asked', 'go', 'go-b'].map((n) => join(dir, n));
  const gate = (ready: string, start: string) => 'await sh("touch ' + ready + '")\nawait waitFor(() => sh("test -f ' + start + '"), { every: 20, timeout: 20000 })\n';
  const a = 'await read(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ')\n' + gate(aReady, go) + 'await edit(' + JSON.stringify(join(dir, 'X', 'f.txt')) + ', "aaaa", "AAAA")\nreturn "A edited"';
  const b = gate(bReady, goB) + 'await sh("touch ' + bAsked + '")\nconst r = await call("mcp__lean-ctx__ctx_patch", { ops: [{ op: "replace_unique", path: ' + JSON.stringify(sub1 + '/../f.txt') + ', old_text: "bbbb", new_text: "BBBB" }, { op: "replace_unique", path: ' + JSON.stringify(sub2 + '/../f.txt') + ', old_text: "cccc", new_text: "CCCC" }] })\nreturn r.ok ? "B patched" : "B refused: " + r.error';
  const out = run({ tools: NO_BASH, patchDelayMs: 1500, steps: [
    { link: { from: sub1, to: join(dir, 'X', 'deep') } },
    { link: { from: sub2, to: join(dir, 'X', 'deep') } },
    { script: a, keepTurn: true },
    { script: b, keepTurn: true },
    { untilFile: aReady },
    { untilFile: bReady },
    { touch: go },
    { untilTool: 'mcp__lean-ctx__ctx_patch' },
    { touch: goB },
    { untilFile: bAsked },
    { untilReadlink: '/sub1' },
    { script: 'await sh("ln -sfn ' + join(dir, 'Y', 'deep') + ' ' + sub1 + '")\nreturn "moved"', keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
  ] });
  expect(out.results.map((r) => r.text).join('\n')).toContain('B refused: ');
  expect(readFileSync(join(dir, 'X', 'f.txt'), 'utf8')).toBe('bbbb\ncccc\nAAAA\n');
  expect(readFileSync(join(dir, 'Y', 'f.txt'), 'utf8')).toBe('bbbb\ncccc\naaaa\n');
});

test('A file edited through Edit at the end of a run that read two thousand other files first still counts as read once handed back', () => {
  const dir = scratch();
  const p = join(dir, 'p.txt');
  writeFileSync(p, 'alpha\nbeta\n');
  const qs = Array.from({ length: 2000 }, (_, i) => join(dir, 'q' + i + '.txt'));
  for (const q of qs) writeFileSync(q, 'q\n');
  const pf = JSON.stringify(p);
  const out = run({ engineForgets: true, steps: [
    { script: '// @options: {"timeout_ms": 240000}\nawait read(' + pf + ')\nfor (const q of ' + JSON.stringify(qs) + ') await read(q)\nawait edit(' + pf + ', "alpha", "ALPHA")\nreturn "edited-1"' },
    { script: 'try { await edit(' + pf + ', "beta", "BETA"); return "edited-2" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results.map((r) => r.text)).toEqual(['edited-1', 'edited-2']);
  expect(readFileSync(p, 'utf8')).toBe('ALPHA\nBETA\n');
});

test('A lean-ctx read path starting with ~ that climbs with .. reaches the tool unchanged', () => {
  const dir = scratch();
  const home = scratch();
  writeFileSync(join(home, 'f.txt'), 'alpha\n');
  const out = run({ cwd: dir, home, tools: ['Read', 'ToolSearch', 'mcp__lean-ctx__ctx_read', 'mcp__lean-ctx__ctx_search'], steps: [{ script: 'await call("mcp__lean-ctx__ctx_read", { path: "~/sub/../f.txt" })\nawait call("mcp__lean-ctx__ctx_search", { pattern: "alpha", path: "~/sub/.." })\nreturn "sent"' }] });
  expect(out.calls.filter((c) => /ctx_(read|search)$/.test(c.tool)).map((c) => (c.args as { path?: string }).path)).toEqual(['~/sub/../f.txt', '~/sub/..']);
});

test('A newer edit survives an older read handed back after two thousand reads and a patch of an unread file', () => {
  const dir = scratch();
  const p = join(dir, 'p.txt');
  writeFileSync(p, 'v1\n');
  const u = join(dir, 'u.txt');
  writeFileSync(u, 'unread\n');
  const qs = Array.from({ length: 1999 }, (_, i) => join(dir, 'q' + i + '.txt'));
  for (const q of qs) writeFileSync(q, 'q\n');
  const [ready, gate] = ['ready', 'gate'].map((n) => join(dir, n));
  const pf = JSON.stringify(p);
  const out = run({ tools: NO_BASH, steps: [
    { script: 'await read(' + pf + ')\nawait sh("touch ' + ready + '")\nawait waitFor(() => sh("test -f ' + gate + '"), { every: 200, timeout: 200000 })\nreturn "r1"', keepTurn: true },
    { untilFile: ready },
    { script: 'await read(' + pf + ')\nawait edit(' + pf + ', "v1", "v2")\nreturn "r2"', keepTurn: true },
    { untilRunDone: 'r2' },
    { collect: true },
    { script: '// @options: {"timeout_ms": 240000}\nfor (const q of ' + JSON.stringify(qs) + ') await read(q)\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + JSON.stringify(u) + ', old_text: "unread", new_text: "patched" })\nreturn "r3"', keepTurn: true },
    { untilRunDone: 'r3' },
    { collect: true },
    { touch: gate },
    { untilRunDone: 'r1' },
    { collect: true },
    { script: 'try { await edit(' + pf + ', "v2", "v3"); return "edited" } catch (e) { return String(e.message) }' },
  ] });
  expect(out.results[out.results.length - 1]!.text).toBe('edited');
  expect(readFileSync(p, 'utf8')).toBe('v3\n');
});

test('A read() of a big file batched with a short Read of it still counts the file as read', () => {
  const dir = scratch();
  const big = join(dir, 'big.txt');
  writeFileSync(big, Array.from({ length: 2400 }, (_, i) => 'line ' + i).join('\n') + '\n');
  const b = JSON.stringify(big);
  const [asked, gate] = ['later-asked', 'gate'].map((n) => join(dir, n));
  const script = 'const whole = read(' + b + ')\nawait waitFor(() => sh("test -f ' + asked + '"), { every: 20, timeout: 20000 })\nawait tools.Read({ file_path: ' + b + ', limit: 10 })\nawait sh("touch ' + gate + '")\nconst full = await whole\ntry { await edit(' + b + ', "line 0\\n", "LINE 0\\n"); return "edited " + full.split("\\n").length } catch (e) { return String(e.message) }';
  const out = run({ holdLaterPages: { asked, gate }, steps: [{ script }] });
  expect(out.results[0]!.text).toBe('edited 2401');
  expect(readFileSync(big, 'utf8').startsWith('LINE 0\n')).toBe(true);
});

test('A relative lean-ctx path whose .. climbs out of a symlinked folder reaches the tool unchanged, since lean-ctx resolves it from its own folder', () => {
  const dir = climbingFolder();
  const out = run({ cwd: dir, tools: ['Read', 'ToolSearch', 'mcp__lean-ctx__ctx_read'], steps: [{ link: { from: join(dir, 'sub'), to: 'x/y' } }, { script: 'await call("mcp__lean-ctx__ctx_read", { path: "sub/../real.txt" })\nreturn "sent"' }] });
  expect((out.calls.find((c) => c.tool === 'mcp__lean-ctx__ctx_read')?.args as { path?: string } | undefined)?.path).toBe('sub/../real.txt');
});

const linkThroughMissingFolder = (tools: readonly string[] | undefined, lastPartMayBeMissing = false) => {
  const dir = scratch();
  writeFileSync(join(dir, 'secret.txt'), 'PRECIOUS\n');
  const link = join(dir, 'link.txt');
  const act = tools ? 'try { await write(' + JSON.stringify(link) + ', "CLOBBER\\n"); return "wrote" } catch (e) { return "refused: " + e.message }' : 'const r = await call("Write", { file_path: ' + JSON.stringify(link) + ', content: "CLOBBER\\n" })\nreturn r.ok ? "wrote" : "refused: " + r.error';
  const out = run({ ...(tools ? { tools: [...tools] } : { engineForgets: true }), lastPartMayBeMissing, steps: [{ link: { from: link, to: 'missing_dir/../secret.txt' } }, { script: act }] });
  expect(out.results[0]!.text).toContain('refused: ');
  expect(readFileSync(join(dir, 'secret.txt'), 'utf8')).toBe('PRECIOUS\n');
  expect(existsSync(join(dir, 'missing_dir'))).toBe(false);
};

test('A Write through a symlink whose target climbs out of a missing folder never overwrites the unread file it lands on', () => linkThroughMissingFolder(undefined));
test('A patch write through a symlink whose target climbs out of a missing folder never overwrites the unread file it lands on', () => linkThroughMissingFolder(NO_BASH));
test('A Write through a symlink climbing out of a missing folder is refused where realpath accepts a missing last part', () => linkThroughMissingFolder(undefined, true));
test('A patch write through a symlink climbing out of a missing folder is refused where realpath accepts a missing last part', () => linkThroughMissingFolder(NO_BASH, true));

test('A Write to the root folder is checked as the root folder and never sent with an empty path', () => {
  const out = run({ engineForgets: true, steps: [{ script: 'const r = await call("Write", { file_path: "/", content: "x" })\nreturn r.ok ? "wrote" : r.error' }] });
  expect(out.calls.filter((c) => c.tool === 'Write' && (c.args as { file_path?: string }).file_path === '')).toHaveLength(0);
  expect(out.results[0]!.text).toBe('File has not been read yet. Read it first before writing to it: /');
});

test('A stale patch between the pages of an open read() makes that read fail and leaves the file unread', () => {
  const dir = scratch();
  const big = join(dir, 'big.txt');
  const ref = join(dir, 'ref');
  const lines = (tag: string) => Array.from({ length: 2400 }, (_, i) => tag + ' ' + String(i).padStart(4, '0')).join('\n') + '\n';
  writeFileSync(big, lines('A'));
  writeFileSync(join(dir, 'b.txt'), lines('B'));
  writeFileSync(ref, '');
  utimesSync(big, 1_700_000_000, 1_700_000_000);
  utimesSync(ref, 1_700_000_000, 1_700_000_000);
  const b = JSON.stringify(big);
  const reader = 'try { const t = await read(' + b + '); return "read " + (t.includes("A 0000") ? "A" : "") + (t.includes("2399") && !t.includes("A 2399") ? "B" : "") } catch (e) { return "reader: " + e.message }';
  const patcher = 'await sh("cp ' + join(dir, 'b.txt') + ' ' + big + '")\nawait call("mcp__lean-ctx__ctx_patch", { op: "replace_unique", path: ' + b + ', old_text: "B 0000", new_text: "C 0000" })\nawait sh("touch -r ' + ref + ' ' + big + '")\nreturn "patched"';
  const out = run({ tools: NO_BASH, readDelayMs: 600, steps: [
    { script: reader, keepTurn: true },
    { untilCalls: { tool: 'Read', count: 2 } },
    { script: patcher, keepTurn: true },
    { untilRunsDone: true },
    { collect: true },
    { script: 'try { await write(' + b + ', "CLOBBERED\\n"); return "wrote" } catch (e) { return String(e.message) }' },
  ] });
  const said = out.results.map((r) => r.text).join('\n');
  expect(said).not.toContain('read AB');
  expect(out.results[out.results.length - 1]!.text).toContain('has not read it');
  expect(readFileSync(big, 'utf8').startsWith('C 0000')).toBe(true);
});

test('A stored value too large to load back is refused when stored', () => {
  const out = run({ steps: [{ script: 'try { await store("big", "x".repeat(4_300_000)); return "stored " + String((await load("big"))?.length) } catch (e) { return String(e.message) }' }] });
  expect(out.results[0]!.text).toContain('too large');
});

test('A relative patch path whose .. climbs out of a symlinked folder patches the file Read showed for it', () => {
  const dir = climbingFolder();
  const out = run({ cwd: dir, tools: NO_BASH, steps: [{ link: { from: join(dir, 'sub'), to: 'x/y' } }, { script: 'const shown = String(await tools.Read({ file_path: "sub/../real.txt" }))\nconst r = await call("mcp__lean-ctx__ctx_patch", { op: "set_line", path: "sub/../real.txt", line: 1, new_text: "PATCHED" })\nreturn (shown.includes("INTENDED") ? "showed intended" : "showed other") + " | " + (r.ok ? "patched" : r.error)' }] });
  expect(out.results[0]!.text).toBe('showed intended | patched');
  expect(readFileSync(join(dir, 'x', 'real.txt'), 'utf8')).toContain('PATCHED');
  expect(readFileSync(join(dir, 'real.txt'), 'utf8')).toBe('DECOY\n');
});
