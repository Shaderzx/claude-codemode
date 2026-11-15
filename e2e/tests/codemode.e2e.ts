import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'e2e';

// codemode's real mod source runs under Node (harness/harness.mts) with a real Node
// runner child, real files and real shell commands; only Claude Code's $ is a stand-in.
// Each test hands the mod scripts the way the model does and checks what comes back.
const harness = join(import.meta.dirname, '..', 'harness', 'harness.mts');

type Step = { script?: string; direct?: { tool: string; args: Record<string, unknown> }; search?: string; describe?: string; newSession?: boolean };
type Case = { tools?: string[]; denied?: string[]; home?: string; cwd?: string; env?: Record<string, string>; store?: Record<string, unknown>; steps: Step[]; abortAfterMs?: number };
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
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('A script that still works today returns its output unchanged', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\n');
  const text = one('const t = await tools.Read({ file_path: ' + JSON.stringify(join(dir, 'a.txt')) + ' })\nreturn t');
  expect(text).toBe('     1\talpha\n     2\tbeta');
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

test('sh() uses the shell replacement when Bash is denied by a hook', () => {
  const out = run({ denied: ['Bash'], steps: [{ script: 'const r = await sh("echo routed")\nreturn String(r).trim() + " " + r.exitCode' }] });
  expect(out.results[0]!.text).toBe('routed 0');
  expect(out.calls.map((c) => c.tool)).toContain('mcp__lean-ctx__ctx_shell');
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

test('sh() runs a command longer than the shell tool allows by writing it to a file first', () => {
  const text = one('const big = "echo " + "x".repeat(9000) + " >/dev/null; echo done"\nconst r = await sh(big)\nreturn String(r).trim() + " " + r.exitCode', { tools: NO_BASH });
  expect(text).toBe('done 0');
});

test('read() returns a file without line numbers and pages through files longer than one Read', () => {
  const dir = scratch();
  const body = Array.from({ length: 4500 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';
  writeFileSync(join(dir, 'big.txt'), body);
  const text = one('const t = await read(' + JSON.stringify(join(dir, 'big.txt')) + ')\nreturn sha256(t)');
  expect(text).toBe(sha(body));
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
  expect(text).toBe('     1\thello there');
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
  const text = one('await write(' + JSON.stringify(f) + ', "one")\nawait write(' + JSON.stringify(f) + ', "two ${x} `")\nreturn "ok"', { tools: NO_BASH });
  expect(text).toBe('ok');
  expect(readFileSync(f, 'utf8')).toBe('two ${x} `');
});

test('edit() replaces one exact text through Edit, or the patch tool when Edit is missing', () => {
  const dir = scratch();
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  writeFileSync(a, 'red green blue');
  writeFileSync(b, 'red green blue');
  expect(one('await edit(' + JSON.stringify(a) + ', "green", "GREEN")\nreturn 1')).toBe('1');
  expect(one('await edit(' + JSON.stringify(b) + ', "blue", "BLUE")\nreturn 1', { tools: NO_BASH })).toBe('1');
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

test('An Error object in the output prints its message', () => {
  const text = one('return { e: new Error("bad thing") }');
  expect(text).toContain('bad thing');
});

test('A failed run says how many calls had already succeeded and how to keep them', () => {
  const text = one('await Promise.all([sh("echo a"), sh("echo b"), tools.Read({ file_path: "/nope/x" })])');
  expect(text).toMatch(/2 other calls had succeeded/);
  expect(text).toMatch(/allSettled|call\(\)/);
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

test('A ReferenceError close to a tool name suggests that tool', () => {
  const text = one('return await ctx__ctx_shell({ command: "true" })');
  expect(text).toContain('tools.mcp__lean_ctx__ctx_shell');
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
  const out = run({ abortAfterMs: 1500, steps: [{ script: 'text("first part done")\nconsole.log("log line")\nawait sh("perl -e \"select(undef, undef, undef, 4)\"")' }] });
  const t = out.results[0]!.text;
  expect(t).toContain('first part done');
  expect(t).toContain('log line');
  expect(t).toMatch(/\[aborted\]/);
  expect(t).not.toContain('runner exited without a result');
});

test('A timed-out run keeps its output and names the call still running', () => {
  const text = one('// @options: {"timeout_ms": 1500}\ntext("got this far")\nawait sh("perl -e \"select(undef, undef, undef, 4)\"")');
  expect(text).toContain('got this far');
  expect(text).toMatch(/\[timeout\]/);
  expect(text).toMatch(/still running: Bash \(\d+(\.\d)?s/);
  expect(text).toContain('select(undef, undef, undef, 4)');
});

test('Every failure is labelled with its kind', () => {
  expect(one('const = 1')).toContain('[syntax]');
  expect(one('await tools.Read({ file_path: "/nope" })')).toContain('[tool]');
  expect(one('null.x')).toContain('[script]');
});
