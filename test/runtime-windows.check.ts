// Actual Windows ownership/recovery integration using only a harmless child copied from node.exe.
// No sing-box, TUN, routes, or external network. Other processes are never signalled.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { RuntimeJournal } from '../src/main/runtime-journal'
import { ctrlBreak } from '../src/main/stop'

let checks = 0
const eq = (actual: unknown, expected: unknown, label: string) => {
  checks++
  if (actual !== expected) throw new Error(`${label}: ${String(actual)} != ${String(expected)}`)
}
async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('Native fixture did not exit')) }, 5000)
    child.once('exit', done)
  })
}

;(async () => {
  if (process.platform !== 'win32') {
    console.log('[SKIP] runtime-windows.check: native Windows process/CIM recovery requires Windows')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'waarp-native-'))
  let child: ChildProcess | undefined
  let bystander: ChildProcess | undefined
  let noConsole: ChildProcess | undefined
  try {
    const oldDir = join(dir, "build-old O'Brien"), newDir = join(dir, 'build-new')
    mkdirSync(oldDir); mkdirSync(newDir)
    const fileName = `waarp-fixture-${basename(dir)}.exe`
    const oldExe = join(oldDir, fileName), newExe = join(newDir, fileName)
    copyFileSync(process.execPath, oldExe)
    child = spawn(oldExe, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject) })
    const runDir = join(dir, 'runtime')
    const oldJournal = new RuntimeJournal(runDir, oldExe, 'run.json')
    eq(await oldJournal.record(child.pid), true, 'actual CIM records the own harmless child')
    const ownerFile = join(runDir, 'run.json.owner'), configFile = join(runDir, 'run.json')
    const owner = readFileSync(ownerFile, 'utf8')
    writeFileSync(configFile, '{}')
    const found = await RuntimeJournal.inspectUntracked(oldExe)
    eq(found.ok, false, 'actual process enumeration detects the recorded executable')
    if (!found.ok) eq(found.reason, 'process_running', 'own process path is readable on Windows')
    eq((await RuntimeJournal.inspectUntracked(newExe)).ok, true, 'different extraction path is not mistaken for the current file')
    writeFileSync(ownerFile, 'null')
    const upgraded = new RuntimeJournal(runDir, newExe, 'run.json')
    eq(await upgraded.recover(), false, 'corrupt owner cannot be discarded while an old extraction process is alive')
    eq(existsSync(ownerFile), true, 'corrupt owner remains until absence can be proved')
    eq(child.exitCode, null, 'corrupt owner never authorizes native termination')
    bystander = spawn(oldExe, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { bystander!.once('spawn', resolve); bystander!.once('error', reject) })
    // A different actual process with the same path must not become owned by reusing its PID in an old lease.
    writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(owner), pid: bystander.pid }))
    eq(await upgraded.recover(), true, 'native identity distinguishes a reused PID by its different creation time')
    eq(bystander.exitCode, null, 'mismatched creation time never authorizes native termination')
    eq(child.exitCode, null, 'a reused-PID lease cannot terminate the original unrelated PID either')
    writeFileSync(ownerFile, owner)
    writeFileSync(configFile, '{}')
    eq(await upgraded.recover(), true, 'exact native child is recovered through its original path after portable upgrade')
    await waitForExit(child)
    eq(existsSync(ownerFile), false, 'confirmed native exit removes ownership lease')
    eq(existsSync(configFile), false, 'confirmed native exit removes temporary config')
    eq(bystander.exitCode, null, 'another process with the exact same executable path survives recovery')
    eq((await RuntimeJournal.inspectUntracked(oldExe, true)).ok, false, 'all-path scan still detects the untouched bystander')
    bystander.kill()
    await waitForExit(bystander)
    eq((await RuntimeJournal.inspectUntracked(oldExe, true)).ok, true, 'actual all-path scan proves every fixture process gone')
    writeFileSync(ownerFile, 'null')
    eq(await upgraded.recover(), true, 'corrupt owner is safely cleared after actual process absence')
    writeFileSync(ownerFile, owner)
    eq(await upgraded.recover(), true, 'stale old-path owner with exited PID also recovers through CIM')
    // Production's windowsHide + non-inherited stdio sets CREATE_NO_WINDOW in libuv. An exact
    // ownership match must not be mistaken for proof that a console signal can be delivered.
    noConsole = spawn(oldExe, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { noConsole!.once('spawn', resolve); noConsole!.once('error', reject) })
    const signalJournal = new RuntimeJournal(join(dir, 'signal'), oldExe, 'run.json')
    eq(await signalJournal.record(noConsole.pid), true, 'native no-console child has a recorded owner')
    const identity = signalJournal.recordedIdentity(noConsole.pid!)
    if (!identity) throw new Error('Missing native signal identity')
    eq(await ctrlBreak(noConsole.pid!, { ...identity, path: newExe }), false, 'console helper refuses a matching PID with a different path')
    eq(await ctrlBreak(noConsole.pid!, { ...identity, started: '2000-01-01T00:00:00.0000000Z' }), false, 'console helper refuses a matching PID and path with a different creation time')
    eq(await ctrlBreak(noConsole.pid!, identity), false, 'console-less native process never reports a delivered CTRL_BREAK')
    eq(noConsole.exitCode, null, 'failed native console signal leaves the process alive for the owned-handle fallback')
    noConsole.kill()
    await waitForExit(noConsole)
    eq(signalJournal.clear(), true, 'confirmed owned-handle exit allows ownership cleanup')
    console.log(`runtime-windows.check: ${checks} native checks`)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await waitForExit(child) }
    if (bystander && bystander.exitCode === null && bystander.signalCode === null) { bystander.kill(); await waitForExit(bystander) }
    if (noConsole && noConsole.exitCode === null && noConsole.signalCode === null) { noConsole.kill(); await waitForExit(noConsole) }
    rmSync(dir, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
