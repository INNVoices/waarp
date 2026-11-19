import { loadLocale, localized } from '../src/shared/localization'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { relaunchArgs, relaunchParent, waitForRelaunchParent } from '../src/main/relaunch'

let checks = 0
const eq = (actual: unknown, expected: unknown, label: string) => {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

;(async () => {
  eq(relaunchArgs(['C:\\app with spaces', '--hidden'], 512), ['C:\\app with spaces', '--hidden', '--waarp-wait-parent', '512'], 'ordinary arguments survive relaunch')
  eq(relaunchArgs(['--waarp-wait-parent', '100', '--hidden', '--waarp-wait-parent=200'], 512), ['--hidden', '--waarp-wait-parent', '512'], 'an inherited parent is replaced rather than chained')
  eq(relaunchParent(['--waarp-wait-parent', '512'], 600), 512, 'separate parent argument is parsed')
  eq(relaunchParent(['--waarp-wait-parent=512'], 600), 512, 'equals parent argument is parsed')
  eq(relaunchParent(['--hidden'], 600), undefined, 'ordinary startup has no parent')
  for (const args of [
    ['--waarp-wait-parent'], ['--waarp-wait-parent', 'not-a-pid'], ['--waarp-wait-parent=-1'],
    ['--waarp-wait-parent=4'], ['--waarp-wait-parent=1.5'], ['--waarp-wait-parent=600'],
    ['--waarp-wait-parent=512', '--waarp-wait-parent=513'], ['--waarp-wait-parent=9007199254740992']
  ]) {
    let threw = false
    try { relaunchParent(args, 600) } catch { threw = true }
    eq(threw, true, `invalid parent is rejected: ${args.join(' ')}`)
  }
  let calls = 0
  eq(await waitForRelaunchParent(['--hidden'], async () => { calls++; return true }), true, 'normal startup needs no native handoff')
  eq(calls, 0, 'normal startup does not add PowerShell work')
  eq(await waitForRelaunchParent(['--waarp-wait-parent=bad'], async () => { calls++; return true }), false, 'invalid handoff fails closed')
  eq(calls, 0, 'invalid handoff never enters a native script')
  const parent = process.pid === 512 ? 513 : 512
  for (const result of [true, false, [], 'true', null]) {
    eq(await waitForRelaunchParent([`--waarp-wait-parent=${parent}`], async (script, timeout) => {
      eq(timeout, 22_000, 'helper has an execution bound beyond the twenty-second native wait')
      eq(script.includes(`GetProcessById(${parent})`) && script.includes('WaitForExit(20000)'), true, 'helper waits the captured process handle')
      eq(/Terminate|Kill|Stop-Process/i.test(script), false, 'parent waiting never signals a process')
      return result
    }), result === true, 'only a positive exit observation admits shared writers')
  }
  eq(await waitForRelaunchParent([`--waarp-wait-parent=${parent}`], async () => { throw new Error('access denied') }), false, 'native inspection failure blocks handoff')

  // Execute the actual, deliberately small main-process admission blocks. Importing Electron's entire
  // entrypoint would start app services; a duplicate test-only implementation would miss ordering regressions.
  const main = readFileSync('src/main/index.ts', 'utf8')
  const earlyStart = main.indexOf('let waitingForParent = false')
  const earlyEnd = main.indexOf('app.setAppUserModelId', earlyStart)
  const readyMarker = 'app.whenReady().then(async () => {'
  const readyStart = main.indexOf(readyMarker)
  const firstWriter = main.indexOf('store = new Store(', readyStart)
  eq(earlyStart >= 0 && earlyEnd > earlyStart && readyStart > earlyEnd && firstWriter > readyStart, true, 'main exposes admission before shared initialization')
  eq(main.includes('releaseSingleInstanceLock'), false, 'old instance keeps its lock throughout UAC prompt and cleanup')
  const early = main.slice(earlyStart, earlyEnd)
  const ready = main.slice(readyStart + readyMarker.length, firstWriter)
  const bootstrap = (args: string[], wait: Promise<boolean>, acquire: () => boolean) => {
    const events: string[] = []
    const exited = Symbol('app.exit')
    let active = true
    const context = createContext({
      process: { argv: args }, relaunchParent, loadLocale, localized,
      waitForRelaunchParent: () => { events.push('wait'); return wait },
      app: {
        getPreferredSystemLanguages: () => ['ru'],
        requestSingleInstanceLock: () => { events.push('lock'); return acquire() },
        exit: (code: number) => { events.push(`exit:${code}`); throw exited },
        quit: () => { events.push('quit') }
      },
      dialog: { showErrorBox: () => { events.push('dialog') } },
      sharedWrite: () => { events.push('write') }
    })
    try { runInContext(early, context) } catch (error) { if (error !== exited) throw error; active = false }
    return { events, ready: async () => { if (active) await runInContext(`(async () => {${ready}\nsharedWrite()})()`, context) } }
  }
  {
    const ordinary = bootstrap(['--hidden'], Promise.resolve(true), () => true)
    eq(ordinary.events, ['lock'], 'ordinary startup acquires the singleton before readiness')
    await ordinary.ready()
    eq(ordinary.events, ['lock', 'wait', 'write'], 'ordinary startup initializes shared state after one lock acquisition')
  }
  {
    let holder: string | undefined = 'old'
    let parentExited!: (result: boolean) => void
    const waiting = new Promise<boolean>(resolve => { parentExited = resolve })
    const replacement = bootstrap([`--waarp-wait-parent=${parent}`], waiting, () => {
      if (holder !== undefined) return false
      holder = 'replacement'; return true
    })
    const finishing = replacement.ready()
    await new Promise<void>(resolve => setImmediate(resolve))
    eq(replacement.events, ['wait'], 'marked replacement waits without acquiring the lock or touching shared data')
    const third = bootstrap(['--hidden'], Promise.resolve(true), () => holder === undefined)
    await third.ready()
    eq(third.events, ['lock', 'exit:0'], 'ordinary third launch cannot enter while old parent is alive')
    eq(holder, 'old', 'waiting replacement does not take ownership away from the old process')
    holder = undefined // the old process exits only after its cleanup has finished
    parentExited(true)
    await finishing
    eq(replacement.events, ['wait', 'lock', 'write'], 'replacement acquires the singleton only after parent exit and before shared writes')
    eq(holder, 'replacement', 'replacement owns the singleton when it initializes shared state')
  }
  {
    const failed = bootstrap([`--waarp-wait-parent=${parent}`], Promise.resolve(false), () => true)
    await failed.ready()
    eq(failed.events, ['wait', 'dialog', 'quit'], 'unknown or timed-out parent never admits shared writers')
    const contended = bootstrap([`--waarp-wait-parent=${parent}`], Promise.resolve(true), () => false)
    await contended.ready()
    eq(contended.events, ['wait', 'lock', 'quit'], 'a replacement that loses the lock race never opens shared data')
    const invalid = bootstrap(['--waarp-wait-parent=invalid'], Promise.resolve(true), () => true)
    await invalid.ready()
    eq(invalid.events, ['exit:1'], 'invalid handoff cannot bypass ordinary singleton admission')
  }

  if (process.platform === 'win32') {
    // CI-only real Windows primitive, with our own harmless Node child; no app data, adapter, or TUN.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore', windowsHide: true })
    const childPid = child.pid
    if (!childPid) throw new Error('could not create handoff fixture')
    eq(await waitForRelaunchParent(['--waarp-wait-parent', String(childPid)]), true, 'Windows observes own child exit')
  } else console.log('[SKIP] relaunch.check native parent wait requires Windows')
  console.log(`relaunch.check: ${checks} checks`)
})().catch(error => { console.error(error); process.exitCode = 1 })
