'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const support = require('../templates/common/editor/plugin-support.cjs');

function abortError() { return Object.assign(new Error('Operation cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
function identityError(pid) { return Object.assign(new Error(`Refusing to stop PID ${pid}: its start time or executable does not match the process recorded by this project.`), { code: 'PROCESS_IDENTITY_MISMATCH' }); }
function validIdentity(value) { return Boolean(value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.startedAt === 'string' && value.startedAt && typeof value.executable === 'string' && path.isAbsolute(value.executable)); }
function matches(a, b) { return Boolean(validIdentity(a) && validIdentity(b) && a.pid === b.pid && a.startedAt === b.startedAt && path.resolve(a.executable).toLowerCase() === path.resolve(b.executable).toLowerCase()); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// JSON is transferred through an environment variable, never interpolated into
// PowerShell source. Keep process handles open from identity validation through
// termination, so termination does not resolve a potentially recycled PID.
const WINDOWS_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = $env:CPD_PROCESS_REQUEST | ConvertFrom-Json
function Open-Identity([int]$number) {
    try { $process = [Diagnostics.Process]::GetProcessById($number) }
    catch [ArgumentException] { return $null }
    try {
        $null = $process.Handle
        $start = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        $exe = $process.MainModule.FileName
        if (-not $exe) { throw 'Cannot read executable identity' }
        return @{ process = $process; identity = @{ pid = $number; startedAt = $start; executable = $exe } }
    } catch {
        $gone = $process.HasExited
        $process.Dispose()
        if ($gone) { return $null }
        throw
    }
}
$entry = Open-Identity ([int]$request.pid)
if ($request.action -eq 'inspect') {
    if ($null -eq $entry) { 'null' } else { $entry.identity | ConvertTo-Json -Compress; $entry.process.Dispose() }
    exit 0
}
if ($null -eq $entry) { '{"stopped":false,"reason":"exited"}'; exit 0 }
$owned = @{}
try {
    if ($entry.identity.startedAt -cne $request.startedAt -or -not [String]::Equals($entry.identity.executable, $request.executable, [StringComparison]::OrdinalIgnoreCase)) {
        '{"mismatch":true}'; exit 0
    }
    $owned[[int]$request.pid] = $entry
    # Capture descendants before stopping their parent. Repeated snapshots also
    # collect children created while the first snapshot was being acquired.
    for ($round = 0; $round -lt 12; $round++) {
        $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
        $added = $true
        while ($added) {
            $added = $false
            foreach ($row in $rows) {
                $number = [int]$row.ProcessId
                $parentNumber = [int]$row.ParentProcessId
                if ($owned.ContainsKey($number) -or -not $owned.ContainsKey($parentNumber)) { continue }
                $parent = $owned[$parentNumber]
                $child = Open-Identity $number
                if ($null -eq $child) { continue }
                # WMI CreationDate has microsecond precision. Verify the process
                # in the snapshot is still the process whose handle we opened.
                $snapshotStart = $row.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
                $handleStart = [DateTime]::FromFileTimeUtc([Int64]$child.identity.startedAt).ToString('yyyyMMddHHmmssffffff')
                if ($snapshotStart -cne $handleStart) { $child.process.Dispose(); continue }
                $start = [Int64]$child.identity.startedAt
                $parentStart = [Int64]$parent.identity.startedAt
                $parentExit = [Int64]::MaxValue
                if ($parent.process.HasExited) { $parentExit = $parent.process.ExitTime.ToUniversalTime().ToFileTimeUtc() }
                if ($start -lt $parentStart -or $start -gt $parentExit) { $child.process.Dispose(); continue }
                $owned[$number] = $child
                $added = $true
            }
        }
        foreach ($item in $owned.Values) {
            if (-not $item.process.HasExited) {
                try { $item.process.Kill() } catch { if (-not $item.process.HasExited) { throw } }
            }
        }
        foreach ($item in $owned.Values) {
            if (-not $item.process.WaitForExit(5000)) { throw 'An owned process did not exit after cancellation' }
        }
        if ($round -gt 0 -and $owned.Count -eq $previousCount) { break }
        $previousCount = $owned.Count
        if ($round -eq 11) { throw 'Could not finish terminating the owned process tree' }
    }
    @{ stopped = $true; reason = 'stopped'; pid = [int]$request.pid; terminated = @($owned.Keys) } | ConvertTo-Json -Compress
} finally {
    foreach ($item in $owned.Values) { $item.process.Dispose() }
    if ($owned.Count -eq 0) { $entry.process.Dispose() }
}
`;

async function windowsRequest(request) {
    const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    return new Promise((resolve, reject) => {
        const child = cp.spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PROCESS_SCRIPT, 'utf16le').toString('base64')], {
            shell: false, windowsHide: true, env: { ...process.env, CPD_PROCESS_REQUEST: JSON.stringify(request) },
        });
        let output = ''; let errors = '';
        let timedOut = false;
        // This helper creates no subprocesses. Timeout terminates only our
        // helper, never an unverified target; callers retain their operation lock.
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, request.action === 'inspect' ? 15000 : 45000);
        child.stdout.on('data', (data) => { output += data; });
        child.stderr.on('data', (data) => { errors += data; });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`Timed out trying to ${request.action} Windows process ${request.pid}.`));
            if (code !== 0) return reject(new Error(`Cannot ${request.action} Windows process ${request.pid}: ${errors.trim() || output.trim()}`));
            try { resolve(JSON.parse(output.replace(/^\uFEFF/, '').trim())); } catch (error) { reject(new Error(`Invalid process identity response: ${error.message}`)); }
        });
    });
}
async function inspect(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('A positive process ID is required.');
    if (process.platform === 'win32') return windowsRequest({ action: 'inspect', pid });
    // Linux support is for portable tests. The product build/run target is Windows.
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[0] === 'Z') return null;
        return { pid, startedAt: fields[19], executable: fs.readlinkSync(`/proc/${pid}/exe`) };
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
async function terminate(identity) {
    if (!validIdentity(identity)) throw new Error('A complete owned-process identity is required.');
    if (process.platform === 'win32') {
        const result = await windowsRequest({ action: 'terminate', ...identity });
        if (result.mismatch) throw identityError(identity.pid);
        return result;
    }
    const current = await inspect(identity.pid);
    if (!current) return { stopped: false, reason: 'exited' };
    if (!matches(identity, current)) throw identityError(identity.pid);
    // Owned children are started in a separate process group on POSIX.
    try { process.kill(-identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let i = 0; i < 100; i++) { if (!await inspect(identity.pid)) return { stopped: true, reason: 'stopped', pid: identity.pid }; await delay(20); }
    throw new Error(`Owned process ${identity.pid} did not terminate.`);
}

function cleanupError(error) {
    if (error.code === 'PROCESS_CLEANUP_FAILED') return error;
    return Object.assign(new Error(`Process cleanup could not be verified: ${error.message}`, { cause: error }), { code: 'PROCESS_CLEANUP_FAILED' });
}
async function stopChild(child, identityPromise, closed) {
    try {
        let identity; let inspectionFailure;
        try { identity = await identityPromise; } catch (error) { inspectionFailure = error; }
        if (identity) await terminate(identity);
        else if (child.pid && child.exitCode === null && child.signalCode === null) {
            // ChildProcess retains the OS handle of the process we spawned.
            // This fallback cannot prove descendant cleanup, so retain the lock.
            if (!child.kill('SIGKILL')) throw new Error(`Cannot stop the spawned process ${child.pid}.`);
            inspectionFailure ||= new Error(`Cannot read the spawned process ${child.pid}'s identity.`);
        }
        let timer;
        try {
            await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Spawned process streams did not close after termination; a descendant may still be running.')), 10000); })]);
        } finally { clearTimeout(timer); }
        if (inspectionFailure) throw inspectionFailure;
    } catch (error) { throw cleanupError(error); }
}

let selfIdentity;
function ownIdentity() { return selfIdentity || (selfIdentity = inspect(process.pid)); }
function recoveryError(directory, reason) {
    return Object.assign(new Error(`Project operation lock needs recovery (${reason}): ${directory}. Confirm that this project's previous build processes have stopped, then remove only this lock directory and retry. No process has been taken over or terminated.`), { code: 'PROJECT_LOCK_RECOVERY_REQUIRED' });
}
async function checkLock(project, directory, file) {
    support.noLinks(project, file);
    let owner;
    try { owner = support.readJson(file); } catch (_) {
        // A new owner creates its record immediately after the directory.
        if (Date.now() - fs.statSync(directory).mtimeMs < 2000) return;
        throw recoveryError(directory, 'missing or unreadable owner record');
    }
    if (!validIdentity(owner.identity) || !owner.token) throw recoveryError(directory, 'invalid owner record');
    if (owner.cleanupFailure) throw recoveryError(directory, owner.cleanupFailure);
    const live = await inspect(owner.identity.pid);
    // An abruptly terminated owner may have left compilers alive. Do not infer
    // safety from a dead owner, nor delete its lock without verified cleanup.
    if (!live || !matches(live, owner.identity)) throw recoveryError(directory, 'the previous owner exited without releasing its lock');
}
async function withLock(project, operation, options = {}) {
    throwIfAborted(options.signal);
    support.ensureLocalIgnore(project);
    const directory = path.join(project, '.plugin-dev/windows-operation.lock');
    const file = path.join(directory, 'owner.json');
    support.noLinks(project, file);
    const identity = await ownIdentity();
    throwIfAborted(options.signal);
    const token = crypto.randomBytes(16).toString('hex');
    const deadline = Date.now() + (options.lockTimeoutMs ?? 15000);
    for (;;) {
        throwIfAborted(options.signal);
        try {
            fs.mkdirSync(directory);
            try { fs.writeFileSync(file, JSON.stringify({ token, identity })); }
            catch (error) { fs.rmdirSync(directory); throw error; }
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try { await checkLock(project, directory, file); }
            catch (recoveryError) { if (!['ENOENT', 'ENOTEMPTY'].includes(recoveryError.code)) throw recoveryError; }
            if (Date.now() >= deadline) throw Object.assign(new Error('Another process is building or controlling this project. Wait for it to finish or cancel that operation.'), { code: 'PROJECT_BUSY' });
            await delay(100);
        }
    }
    let retainLock = false;
    try { throwIfAborted(options.signal); return await operation(); }
    catch (error) {
        if (error.code === 'PROCESS_CLEANUP_FAILED') {
            retainLock = true;
            support.writeJson(file, { token, identity, cleanupFailure: error.message });
            error.message += ` Operation lock retained: ${directory}.`;
        }
        throw error;
    }
    finally {
        if (!retainLock && fs.existsSync(file) && support.readJson(file).token === token) { fs.unlinkSync(file); fs.rmdirSync(directory); }
    }
}

function stateFile(project) { const file = path.join(project, '.plugin-dev/game-process.json'); support.noLinks(project, file); return file; }
async function recorded(project) {
    const file = stateFile(project);
    if (!fs.existsSync(file)) return null;
    const state = support.readJson(file);
    if (state.schemaVersion !== 1 || typeof state.projectPath !== 'string' || path.resolve(state.projectPath).toLowerCase() !== path.resolve(project).toLowerCase() || !validIdentity(state.identity)
        || (state.logOffset !== undefined && (!Number.isSafeInteger(state.logOffset) || state.logOffset < 0))) throw new Error('Invalid project game-process record; it will not be used to terminate any process.');
    const current = await inspect(state.identity.pid);
    if (!current) { fs.unlinkSync(file); return null; }
    if (!matches(current, state.identity)) {
        const error = identityError(state.identity.pid);
        error.message += ` Remove the stale record ${file} to allow a new game launch; the unrelated process will remain untouched.`;
        throw error;
    }
    return state;
}
async function stopUnlocked(project) {
    const state = await recorded(project);
    if (!state) return { stopped: false, reason: 'not-running' };
    let result;
    try { result = await terminate(state.identity); }
    catch (error) { if (error.code === 'PROCESS_IDENTITY_MISMATCH') throw error; throw cleanupError(error); }
    fs.unlinkSync(stateFile(project));
    return { ...result, pid: state.identity.pid };
}
async function startUnlocked(project, executable, options = {}) {
    throwIfAborted(options.signal);
    const current = await recorded(project);
    throwIfAborted(options.signal);
    if (current) return { ...current.identity, logPath: current.logPath, logOffset: current.logOffset, alreadyRunning: true };
    const logPath = options.logPath || path.join(project, '.plugin-dev/logs/runtime.log');
    support.noLinks(project, logPath);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'a');
    let child; let identity; let closed; let logOffset;
    try {
        logOffset = fs.fstatSync(fd).size;
        child = cp.spawn(executable, options.args || [], { cwd: options.cwd || path.dirname(executable), env: options.env || process.env, detached: true, shell: false, windowsHide: true, stdio: ['ignore', fd, fd] });
        closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        identity = await inspect(child.pid);
        if (!identity || child.exitCode !== null || child.signalCode !== null) {
            const exit = await closed;
            throw new Error(`Game exited during startup (exit ${exit.code}, signal ${exit.signal}). See ${logPath}.`);
        }
        throwIfAborted(options.signal);
        support.writeJson(stateFile(project), { schemaVersion: 1, projectPath: path.resolve(project), identity, logPath, logOffset });
        child.unref();
        return { ...identity, logPath, logOffset, alreadyRunning: false };
    } catch (error) {
        error.runLog = { logPath, logOffset };
        try { if (child?.pid) await stopChild(child, identity, closed); }
        catch (cleanupFailure) { cleanupFailure.runLog = error.runLog; throw cleanupFailure; }
        throw error;
    } finally { fs.closeSync(fd); }
}

module.exports = { abortError, throwIfAborted, inspect, terminate, matches, withLock, recorded, stopUnlocked, startUnlocked, stopChild, delay };
