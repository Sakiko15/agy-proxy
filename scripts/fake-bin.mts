// Fake agy binary materializer for the verify harnesses (perf.mts / soak.mts).
//
// The old win32 fake was an `agy.cmd` shim (`@node fake-agy.mjs %*`). Two
// hardening layers since the recorded baseline make that unspawnable: Node's
// CVE-2024-27980 mitigation throws EINVAL on shell-less .cmd/.bat spawns, and
// the gateway's own S-H4 refusal rejects cmd shims outright (the prompt and
// fallback-catalog model slug are request-controlled argv). The production
// posture stays untouched — the harness compiles a 10-line C# launcher into a
// real agy.exe with the .NET Framework compiler that ships with every Windows
// install; the launcher only re-execs `node fake-agy.mjs <args>` with MSVCRT
// argv quoting (lossless for quotes/backslashes/trailing backslashes/unicode
// — verified against FAKE_AGY_ARGS_FILE), inherits stdio pipes (streaming
// first-delta timing stays honest), and propagates the child exit code, so
// taskkill /T /F tree kills and every failure classification keep working.
// POSIX keeps the plain sh wrapper.
import { existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
]

const LAUNCHER_CS = String.raw`using System;
using System.Diagnostics;
using System.Text;

class FakeAgyLauncher
{
    static int Main(string[] args)
    {
        string node = Environment.GetEnvironmentVariable("AGY_FAKE_NODE");
        string script = Environment.GetEnvironmentVariable("AGY_FAKE_SCRIPT");
        if (string.IsNullOrEmpty(node) || string.IsNullOrEmpty(script))
        {
            Console.Error.WriteLine("fake-agy launcher: AGY_FAKE_NODE/AGY_FAKE_SCRIPT not set");
            return 3;
        }
        var sb = new StringBuilder();
        sb.Append(Quote(script));
        foreach (string a in args) sb.Append(' ').Append(Quote(a));
        var psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = sb.ToString();
        psi.UseShellExecute = false;
        Process p;
        try { p = Process.Start(psi); }
        catch (Exception e) { Console.Error.WriteLine("fake-agy launcher: " + e.Message); return 3; }
        p.WaitForExit();
        return p.ExitCode;
    }

    // MSVCRT argv quoting: backslashes are literal unless they precede a
    // quote (double them plus one) or trail the value (double them).
    static string Quote(string s)
    {
        if (s == null) s = "";
        var sb = new StringBuilder();
        sb.Append('"');
        int bs = 0;
        foreach (char c in s)
        {
            if (c == '\\') { bs++; }
            else if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
            else { sb.Append('\\', bs); bs = 0; sb.Append(c); }
        }
        sb.Append('\\', bs * 2);
        sb.Append('"');
        return sb.ToString();
    }
}`

/** Materialize the platform fake-agy binary in `binDir`; returns the path to
 *  hand to AGY_PROXY_BIN. Node + fake-script paths ride AGY_FAKE_NODE /
 *  AGY_FAKE_SCRIPT through the gateway's spawn env (set them on the child). */
export function writeFakeBin(binDir: string, nodePath: string, fakeScript: string): string {
  if (process.platform !== 'win32') {
    writeFileSync(join(binDir, 'agy'), `#!/bin/sh\nexec "${nodePath}" "${fakeScript}" "$@"\n`, { mode: 0o755 })
    return join(binDir, 'agy')
  }
  const exe = join(binDir, 'agy.exe')
  const src = join(binDir, 'fake-agy-launcher.cs')
  writeFileSync(src, LAUNCHER_CS)
  const csc = CSC_CANDIDATES.find((p) => existsSync(p))
  if (csc === undefined) throw new Error('fake agy.exe: no .NET Framework csc.exe found to compile the win32 fake-agy launcher')
  const r = spawnSync(csc, ['/nologo', '/out:' + exe, '/target:exe', src], { stdio: 'pipe' })
  if (r.status !== 0 || !existsSync(exe)) {
    throw new Error('fake agy.exe compile failed: ' + String(r.stderr))
  }
  return exe
}