import assert from 'node:assert/strict'
import { randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ps } from '../src/main/ps'
import { NATIVE_TEST_CA } from './route-native-tls'

/** The pinned Clash delay handler starts from context.Background(), so its Go
 * TLS verifier uses Windows system roots instead of the configured CA pool.
 * Only a disposable GitHub-hosted Windows native test may own this temporary
 * CurrentUser root. No machine root store or application configuration changes. */
export async function installNativeTestCA(dir: string): Promise<{ thumbprint: string; remove: () => Promise<void> }> {
  assert.equal(process.platform, 'win32', 'fixture trust requires Windows')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'fixture trust requires a disposable hosted runner')
  assert.equal(process.env.WAARP_NATIVE_SWITCH_TEST, '1', 'fixture trust requires explicit native-test opt-in')
  const certificate = new X509Certificate(NATIVE_TEST_CA)
  assert(certificate.ca && certificate.verify(certificate.publicKey), 'fixture CA must be self-signed')
  const thumbprint = certificate.fingerprint.replaceAll(':', '').toUpperCase()
  const expected = certificate.raw.toString('base64')
  const nonce = randomBytes(24).toString('hex'), work = join(dir, 'native-test-trust')
  mkdirSync(work, { recursive: true })
  const file = join(work, 'fixture-ca.cer'), owner = join(work, 'owner')
  writeFileSync(file, certificate.raw, { mode: 0o600, flag: 'wx' })
  const literal = (text: string) => "'" + text.replaceAll("'", "''") + "'"
  const store = `$store=[System.Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser');$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite);`
  const find = `$store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,${literal(thumbprint)},$false)`
  let owns = false
  const remove = async () => {
    // The import writes this exact ownership nonce only after proving absence.
    // A pre-existing certificate is never removed, including on setup failure.
    if (!existsSync(owner)) { assert(!owns, 'owned fixture certificate journal is missing'); return }
    assert.equal(readFileSync(owner, 'utf8').trim(), nonce, 'fixture certificate ownership changed')
    const removed = await ps<boolean>(`$ErrorActionPreference='Stop';${store}try {
      $found=${find};
      foreach($item in $found) {
        if([Convert]::ToBase64String($item.RawData) -cne ${literal(expected)}) { throw 'Fixture root identity changed; refusing removal' }
      }
      foreach($item in $found) { $store.Remove($item) }
      if((${find}).Count -ne 0) { throw 'Fixture root remains after removal' }
      $true|ConvertTo-Json -Compress
    } finally { $store.Close() }`, 12000)
    assert.equal(removed, true, 'fixture root absence must be verified')
    rmSync(owner)
    owns = false
    console.log('ROUTE_NATIVE temporary CurrentUser root removed and absence verified', thumbprint)
  }
  try {
    const installed = await ps<boolean>(`$ErrorActionPreference='Stop';${store}try {
      if((${find}).Count -ne 0) { throw 'Fixture root already exists; refusing ownership' }
      $certificate=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new(${literal(file)});
      try {
        if($certificate.Thumbprint -cne ${literal(thumbprint)} -or [Convert]::ToBase64String($certificate.RawData) -cne ${literal(expected)}) { throw 'Unexpected fixture certificate' }
        [IO.File]::WriteAllText(${literal(owner)},${literal(nonce)},[Text.Encoding]::ASCII);
        $store.Add($certificate);
        $found=${find};
        if($found.Count -ne 1 -or [Convert]::ToBase64String($found[0].RawData) -cne ${literal(expected)}) { throw 'Fixture root import was not verified' }
        $true|ConvertTo-Json -Compress
      } finally { $certificate.Reset() }
    } finally { $store.Close() }`, 12000)
    assert.equal(installed, true, 'fixture root import must be verified')
    owns = true
    console.log('ROUTE_NATIVE temporary CurrentUser root: absence checked; exact certificate installed', thumbprint)
    return { thumbprint, remove }
  } catch (error) {
    try { await remove() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Fixture trust setup and owned cleanup failed') }
    throw error
  }
}
