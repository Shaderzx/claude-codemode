import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'e2e';

// codemode's real mod source runs under Node (harness/harness.mts) with a real Node
// runner child, real files and real shell commands; only Claude Code's $ is a stand-in.
// Each test hands the mod scripts the way the model does and checks what comes back.
const harness = join(import.meta.dirname, '..', 'harness', 'harness.mts');

type Step = { script?: string; direct?: { tool: string; args: Record<string, unknown> }; search?: string; describe?: string; newSession?: boolean; setDenied?: string[]; setCwd?: string };
type Case = { tools?: string[]; denied?: string[]; home?: string; cwd?: string; env?: Record<string, string>; store?: Record<string, unknown>; steps: Step[]; abortAfterMs?: number; dedupReads?: boolean; deniedCommands?: string[]; deniedMessage?: string; readRewrite?: string; denyReadFrom?: number; rewriteFromOffset?: string };
type Out = { description: string; results: { text: string; attachments: number; ms: number }[]; calls: { tool: string; args: Record<string, unknown> }[]; store: Record<string, unknown> };

// Every folder a test makes is removed after the last test.
const made: string[] = [];
test.afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'codemode-e2e-'));
  made.push(d);
  return d;
}

function run(c: Case): Out {
  const dir = scratch();
  const file = join(dir, 'case.json');
  writeFileSync(file, JSON.stringify({ home: dir, cwd: dir, ...c }));
  return JSON.parse(execFileSync(process.execPath, [harness, file], { encoding: 'utf8', timeout: 120_000 }));
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
  const text = one('await tools.Read({ file_path: "f.txt" })\nconst again = await tools.Read({ file_path: "f.txt" })\nreturn again.length > 0', { cwd: dir, dedupReads: true });
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
  const text = one('return await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'register.ts')) + ' })');
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
  expect(text.length).toBeLessThan(2600);
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
  expect(text.length).toBeLessThanOrEqual(2300);
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
  const spill = out.results[0]!.text.match(/file_path: "([^"]+)"/)![1]!;
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
  const text = one('await sh("(perl -e \'select(undef, undef, undef, 0.3)\'; touch ' + f + ') >/dev/null 2>&1 &")\nconst t0 = Date.now()\nconst r = await waitFor(() => sh("test -f ' + f + '"), { every: 50, timeout: 5000 })\nreturn [r.exitCode, Date.now() - t0 >= 200].join(" ")');
  expect(text).toBe('0 true');
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
  expect(one('tools.Read({ file_path: "/nope3" })\nawait sh("echo x")\nreturn 1')).toContain('[tool]');
});

test('The mod holds its own output cap even when a script writes past the runner', () => {
  const out = run({ steps: [{ script: 'const p = Buffer.constructor("return process")()\nfor (let i = 0; i < 4; i++) p.stdout.write("\\x1eCM" + JSON.stringify({ out: "item", text: "x".repeat(1000000) }) + "\\n")\nreturn "end"' }] });
  const t = out.results[0]!.text;
  const spill = t.match(/file_path: "([^"]+)"/)![1]!;
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
