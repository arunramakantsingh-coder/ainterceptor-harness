/**
 * The local capability probe, as a command string.
 *
 * HARD-WON CONSTRAINT: the JavaScript payload below must contain ONLY single
 * quotes. PowerShell's single-quoted string turns `''` into one `'`, so double
 * quotes written as `\"` inside the payload are stripped before Node ever sees
 * them - which produced `require(node:os)` and `SyntaxError: Expected ','`.
 * Using bare single quotes throughout survives that round trip intact.
 *
 * Runs the same Node binary that is running the harness, so the report always
 * describes the real machine regardless of which shell exists (this host has no
 * `pwsh`, only Windows PowerShell 5.1).
 *
 * Emits ONE JSON object on stdout.
 */
import { platform } from "node:os";

export function buildLocalProbeCommand(): string {
  const script = [
    "const os=require('node:os');",
    "const cp=require('node:child_process');",
    "function v(e,a){try{return cp.execFileSync(e,a,{encoding:'utf8',timeout:5000,windowsHide:true}).split(/\\r?\\n/)[0].trim();}catch(x){return '';}}",
    "function w(e){try{const c=process.platform==='win32'?'where':'which';return cp.execFileSync(c,[e],{encoding:'utf8',timeout:5000,windowsHide:true}).split(/\\r?\\n/)[0].trim();}catch(x){return '';}}",
    "const caps={node:process.version,git:v('git',['--version']),python:v(process.platform==='win32'?'python':'python3',['--version']),npm:v('npm',['--version']),docker:v('docker',['--version']),ssh:w('ssh'),pwsh:w('pwsh'),powershell:w('powershell'),curl:w('curl')};",
    "const a=[];const ni=os.networkInterfaces();for(const k of Object.keys(ni)){for(const i of (ni[k]||[])){if(i&&i.family==='IPv4'&&!i.internal){a.push(i.address);}}}",
    "let disk='';",
    "try{if(process.platform==='win32'){const d=cp.execFileSync('powershell.exe',['-NoProfile','-Command','(Get-PSDrive C).Free'],{encoding:'utf8',timeout:8000,windowsHide:true}).trim();disk=(Math.round(Number(d)/1073741824*10)/10)+' GB free';}else{disk=cp.execFileSync('df',['-h','/'],{encoding:'utf8',timeout:5000}).split(/\\r?\\n/)[1].split(/\\s+/)[3]+' free';}}catch(x){}",
    "process.stdout.write(JSON.stringify({hostname:os.hostname(),os:os.platform()+' '+os.release(),kernel:os.version(),arch:process.arch,uptime:Math.floor(os.uptime()/60)+' min',cpuCores:os.cpus().length,cpuModel:(os.cpus()[0]||{}).model,memTotalMb:Math.round(os.totalmem()/1048576),memAvailMb:Math.round(os.freemem()/1048576),diskFree:disk,addr4:a,caps:caps}));",
  ].join("");

  const exePath = process.execPath;
  if (platform() === "win32") {
    // `& 'C:\path\node.exe' -e '<script>'` parses unambiguously in PowerShell,
    // including paths containing spaces.
    const esc = (s: string) => s.replace(/'/g, "''");
    return `& '${esc(exePath)}' -e '${esc(script)}'`;
  }
  const esc = (s: string) => s.replace(/'/g, `'\\''`);
  return `'${esc(exePath)}' -e '${esc(script)}'`;
}
