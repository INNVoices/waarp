// Release identity and final asset gate. Drafts do not create Git tags until publication.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const intent = JSON.parse(readFileSync(join(root, 'release/preview-2026-11-18.json'), 'utf8'))
const windows = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const android = readFileSync(join(root, 'android/app/build.gradle.kts'), 'utf8').match(/versionName\s*=\s*"([^"]+)"/)?.[1]
const platforms = intent.platforms ?? ['windows', 'android']
assert(Array.isArray(platforms) && platforms.includes('windows') && platforms.every(platform => ['windows', 'android'].includes(platform)))
const includeAndroid = platforms.includes('android')
assert.equal(windows, intent.windows.version, 'Windows intent must match actual package version')
assert.equal(android, intent.android.version, 'Android intent must match actual APK version')
const tag = process.env.INPUT_TAG || intent.tag
assert.match(tag, /^preview-\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)*$/)
const binaries = [`Waarp-${windows}-portable.exe`, ...(includeAndroid ? intent.android.abis.map(abi => `waarp-android-${android}-${abi}-debug.apk`) : [])]
const checksums = ['SHA256SUMS-windows.txt', ...(includeAndroid ? ['SHA256SUMS-android-debug.txt'] : [])]
const required = [...binaries, ...checksums, 'sing-box-lx-1.14.2-lx.11-src.tar.gz', 'package-integrity-windows.json', 'package-inventory.txt', 'portable-lifecycle.json', 'public-catalog-windows.json', ...(includeAndroid ? ['android-artifacts.json'] : [])]
if (process.argv[2] === 'validate') {
  console.log(JSON.stringify({ tag, windows, android, platforms, required }, null, 2))
  process.exit(0)
}
const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY
const sha = process.env.GITHUB_SHA
assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/)
assert.match(sha ?? '', /^[a-f0-9]{40}$/)
const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }).trim()
const api = (path, ...args) => JSON.parse(gh('api', `repos/${repo}/${path}`, ...args))
const optional = path => {
  try { return api(path) } catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) return undefined
    throw error
  }
}
const findRelease = () => {
  for (let page = 1; page <= 5; page++) {
    const releases = api(`releases?per_page=100&page=${page}`)
    const found = releases.find(release => release.tag_name === tag)
    if (found) return found
    if (releases.length < 100) return undefined
  }
  throw new Error('Release lookup exceeded bounded pages')
}
const checkTag = () => {
  const ref = optional(`git/ref/tags/${tag}`)
  if (ref) { assert.equal(ref.object.type, 'commit'); assert.equal(ref.object.sha, sha, 'Existing tag targets another commit') }
  return ref
}

if (process.argv[2] === 'prepare') {
  checkTag()
  const current = findRelease()
  if (current) {
    assert.equal(current.draft, true, 'Published releases are immutable')
    // An empty failed draft may be retargeted. Partial assets always keep their source identity.
    assert(current.target_commitish === sha || current.assets.length === 0, 'Use a new preview tag for another source commit with existing assets')
  }
  const temporary = mkdtempSync(join(tmpdir(), 'waarp-release-'))
  let draft
  try {
    let notes = readFileSync(join(root, 'release/preview-2026-11-18.md'), 'utf8')
    notes = notes.replace(/\]\(\.\.\/([^)]*)\)/g, `](https://github.com/${repo}/blob/${sha}/$1)`)
    notes += `\n\nSource commit: [${sha.slice(0, 12)}](https://github.com/${repo}/commit/${sha}).\n`
    const path = join(temporary, 'release.json')
    writeFileSync(path, JSON.stringify({ tag_name: tag, target_commitish: sha,
      name: `Waarp preview · Windows ${windows}${includeAndroid ? ` / Android ${android}` : ''}`, body: notes,
      draft: true, prerelease: true, make_latest: 'false' }))
    // A freshly created draft can be absent from the cached release listing.
    // Validate the authoritative mutation response instead of an immediate list reread.
    draft = api(current ? `releases/${current.id}` : 'releases', '--method', current ? 'PATCH' : 'POST', '--input', path)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
  assert(draft?.draft && draft.target_commitish === sha && draft.tag_name === tag && Number.isSafeInteger(draft.id))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nwindows=${windows}\nandroid=${android}\nandroid_enabled=${includeAndroid}\n`)
  console.log(`Prepared draft ${tag} at ${sha}; publication requires the declared ${platforms.join(' + ')} gates.`)
} else if (process.argv[2] === 'publish') {
  const draft = findRelease()
  assert(draft?.draft, 'Expected an unpublished draft')
  assert.equal(draft.target_commitish, sha)
  const assets = api(`releases/${draft.id}/assets?per_page=100`)
  for (const name of required) {
    const matches = assets.filter(asset => asset.name === name)
    assert.equal(matches.length, 1, `Missing or duplicate release asset: ${name}`)
    assert(matches[0].size > 0 && matches[0].state === 'uploaded', `Incomplete release asset: ${name}`)
  }
  assert(!assets.some(asset => /unsigned\.apk$/i.test(asset.name)), 'Unsigned APKs are not installable')
  const temporary = mkdtempSync(join(tmpdir(), 'waarp-release-check-'))
  try {
    gh('release', 'download', tag, '--dir', temporary, '--pattern', 'SHA256SUMS-*.txt', '--pattern', 'package-integrity-windows.json', '--pattern', 'portable-lifecycle.json', '--pattern', 'public-catalog-windows.json', ...(includeAndroid ? ['--pattern', 'android-artifacts.json'] : []))
    const covered = new Set()
    for (const name of checksums) {
      for (const line of readFileSync(join(temporary, name), 'utf8').trim().split(/\r?\n/)) {
        const match = /^([a-f0-9]{64})\s+\*?([^/\\]+)$/.exec(line)
        assert(match, `Invalid checksum line in ${name}`)
        const asset = assets.find(asset => asset.name === match[2])
        assert(asset, `Checksum references missing file ${match[2]}`)
        assert.equal(asset.digest, `sha256:${match[1]}`, `Uploaded bytes differ from checksum: ${asset.name}`)
        assert(!covered.has(asset.name), 'Duplicate checksum entry'); covered.add(asset.name)
      }
    }
    assert(binaries.every(name => covered.has(name)), 'Every installable file needs a verified SHA-256')
    const evidence = JSON.parse(readFileSync(join(temporary, 'package-integrity-windows.json'), 'utf8'))
    assert.equal(evidence.passed, true); assert.equal(evidence.commit, sha); assert.equal(evidence.version, windows)
    assert.equal(evidence.windowIconPresent, true)
    assert.equal(assets.find(asset => asset.name === binaries[0]).digest, `sha256:${evidence.portableSha256}`)
    const portableEvidence = JSON.parse(readFileSync(join(temporary, 'portable-lifecycle.json'), 'utf8'))
    assert.equal(portableEvidence.passed, true); assert.equal(portableEvidence.sourceCommit, sha)
    assert.equal(portableEvidence.candidate.version, windows)
    assert.equal(portableEvidence.candidate.portableSha256, evidence.portableSha256)
    assert.match(portableEvidence.candidate.asarSha256, /^[a-f0-9]{64}$/)
    assert.equal(portableEvidence.candidate.asarSha256, evidence.inventory.asar.sha256)
    assert.equal(portableEvidence.candidate.packageVerificationBound, true)
    assert.equal(portableEvidence.plannedLaunches, 3); assert.equal(portableEvidence.launches.length, 3)
    assert(portableEvidence.launches.every(launch => launch.status === 'PASS'))
    const publicEvidence = JSON.parse(readFileSync(join(temporary, 'public-catalog-windows.json'), 'utf8'))
    assert.equal(publicEvidence.passed, true); assert.equal(publicEvidence.sourceCommit, sha); assert.equal(publicEvidence.version, windows)
    assert.equal(publicEvidence.realPackagedApplication, true); assert.equal(publicEvidence.fixtureResponses, false)
    assert.equal(publicEvidence.profilesBeforeImport, 0); assert(publicEvidence.beforeImport.ready > 0)
    assert(publicEvidence.checksAfterOn > 0); assert.equal(publicEvidence.nativeSessionPreserved, true)
    assert.equal(publicEvidence.selectedRoutePreserved, true); assert.equal(publicEvidence.icon.loaded, true)
    if (includeAndroid) {
    const apkEvidence = JSON.parse(readFileSync(join(temporary, 'android-artifacts.json'), 'utf8'))
    assert.equal(apkEvidence.schemaVersion, 2); assert.equal(apkEvidence.sourceCommit, sha)
    assert.equal(apkEvidence.engine, JSON.parse(readFileSync(join(root, 'android/native-source.json'), 'utf8')).version)
    const debug = apkEvidence.artifacts.filter(artifact => artifact.variant === 'debug')
    assert.equal(debug.length, 3)
    assert.deepEqual(debug.map(artifact => artifact.file).sort(), binaries.slice(1).sort())
    for (const artifact of debug) {
      assert.equal(artifact.versionName, `${android}-debug`)
      assert.equal(artifact.packageId, 'local.waarp.android.debug')
      assert(intent.android.abis.includes(artifact.abi))
    }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
  if (!checkTag()) api('git/refs', '-X', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`)
  const published = api(`releases/${draft.id}`, '--method', 'PATCH', '-F', 'draft=false', '-F', 'prerelease=true', '-f', 'make_latest=false')
  assert(published && !published.draft && published.prerelease && published.tag_name === tag && published.target_commitish === sha)
  console.log(published.html_url)
} else throw new Error('Usage: node scripts/release-preview.mjs validate|prepare|publish')
