// Native helper contract, with no PowerShell/process invocation. Windows integration lives in runtime-windows.check.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createAdminCheck, isAdmin, POWERSHELL, ps } from '../src/main/ps'

let checks = 0
const eq = (actual: unknown, expected: unknown, name: string) => { assert.deepEqual(actual, expected, name); checks++ }
const original = childProcess.execFile
type NativeError = (Error & { code?: string | number; killed?: boolean }) | null
let error: NativeError = null
let stdout = ''
let call: { file: string; args: string[]; options: { timeout: number; windowsHide: boolean } } | undefined

;(async () => {
  childProcess.execFile = ((file: string, args: string[], options: { timeout: number; windowsHide: boolean }, callback: (error: NativeError, output: string) => void) => {
    call = { file, args, options }
    queueMicrotask(() => callback(error, stdout))
    return {} as childProcess.ChildProcess
  }) as typeof childProcess.execFile
  try {
    stdout = '{"ok":true}'
    eq(await ps('fixture'), { ok: true }, 'complete JSON is decoded')
    eq(call?.file, POWERSHELL, 'helper comes from the Windows system directory')
    eq(call?.options.timeout, 20000, 'default native call has a deadline')
    eq(call?.options.windowsHide, true, 'native inspection does not open a console')
    eq(call?.args.includes('-EncodedCommand'), true, 'script is transported as an encoded argument')
    stdout = ' true\r\n'
    eq(await ps('fixture', 1234), true, 'boolean output is parsed')
    eq(call?.options.timeout, 1234, 'caller deadline is respected')
    stdout = ''; eq(await ps('fixture'), [], 'empty successful pipeline remains compatible')
    stdout = 'not JSON'
    await assert.rejects(ps('fixture'), /некорректный ответ/); checks++
    stdout = 'true'
    error = Object.assign(new Error('sensitive encoded command must not be exposed'), { code: 7 })
    await assert.rejects(ps('fixture'), e => {
      eq(String(e).includes('sensitive'), false, 'native error does not echo the encoded command')
      return /код 7/.test(String(e))
    }); checks++
    error = Object.assign(new Error('timeout'), { killed: true })
    await assert.rejects(ps('fixture'), /отведённое время/); checks++
    error = null
    stdout = 'true'; eq(await isAdmin(), true, 'elevated token is accepted')
    const script = Buffer.from(call!.args.at(-1)!, 'base64').toString('utf16le')
    eq(script.includes('WindowsPrincipal') && script.includes('IsInRole'), true, 'admin check uses the UAC token')
    eq(script.includes('net session'), false, 'admin check does not depend on Server service')
    eq(call?.options.timeout, 10000, 'admin detection is bounded')
    stdout = 'false'; eq(await isAdmin(), false, 'unelevated token is rejected')
    stdout = '"true"'; eq(await isAdmin(), false, 'malformed/string boolean is never elevation')
    error = Object.assign(new Error('native failure'), { code: 1 }); stdout = 'true'
    eq(await isAdmin(), false, 'partial true followed by native failure is not elevation')
    let reads = 0, release!: (value: boolean) => void
    const first = new Promise<boolean>(resolve => { release = resolve })
    const retry = createAdminCheck(async () => ++reads === 1 ? first : true)
    const one = retry(), two = retry()
    eq(one, two, 'concurrent token checks share one native read')
    release(false)
    eq(await one, false, 'failed first read does not permit elevation')
    eq(await retry(), true, 'next explicit check can recover from failed startup detection')
    eq(await retry(), true, 'proven elevated token is cached')
    eq(reads, 2, 'positive cache avoids repeated PowerShell calls')
    let errors = 0
    const interrupted = createAdminCheck(async () => { if (++errors === 1) throw new Error('temporary'); return true })
    eq(await interrupted(), false, 'native rejection stays closed')
    eq(await interrupted(), true, 'native rejection does not poison future checks')
  } finally { childProcess.execFile = original }
  console.log(`ps.check: ${checks} checks`)
})().catch(error => { console.error(error); process.exitCode = 1 })
