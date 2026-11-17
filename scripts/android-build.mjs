#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchCore, repositoryRoot } from './android-core.mjs';

function run(program, args, cwd = repositoryRoot) {
  return new Promise((accept, reject) => {
    // Windows cannot execute .bat files directly with CreateProcess. The only
    // batch command here is our fixed Gradle wrapper and fixed task arguments.
    const batch = process.platform === 'win32' && program === 'gradlew.bat';
    const child = spawn(batch ? 'cmd.exe' : program, batch ? ['/d', '/c', program, ...args] : args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${program} exited with ${code}.`)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--collect')) throw new Error('Usage: node scripts/android-build.mjs [--collect]');
  const pin = await fetchCore();
  if (!args.includes('--collect')) {
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    // Keep lint/compiler state out of the R8 process on ordinary CI machines.
    // Each phase must pass before artifacts are collected or published.
    for (const tasks of [
      [':app:testDebugUnitTest', ':app:lintDebug', ':app:lintRelease'],
      [':app:assembleDebug', ':app:assembleDebugAndroidTest'],
      [':app:assembleRelease', ':acceptance:assembleRelease'],
    ]) {
      await run(wrapper, ['--no-daemon', '--console=plain', ...tasks], resolve(repositoryRoot, 'android'));
    }
  }
  const published = resolve(repositoryRoot, 'out/android');
  await mkdir(resolve(repositoryRoot, 'out'), { recursive: true });
  // Validate a complete new set before replacing out/android. Previous versions,
  // signature modes and reports must not leak into a later release artifact.
  const output = await mkdtemp(resolve(repositoryRoot, 'out/android-stage-'));
  try {
  const artifacts = [];
  for (const variant of ['debug', 'release']) {
    const directory = resolve(repositoryRoot, `android/app/build/outputs/apk/${variant}`);
    const metadata = JSON.parse(await readFile(resolve(directory, 'output-metadata.json'), 'utf8'));
    const seen = new Set();
    for (const entry of metadata.elements) {
      const abi = entry.filters.find(filter => filter.filterType === 'ABI')?.value;
      if (!pin.packagedAbis.includes(abi) || seen.has(abi)) throw new Error(`Unexpected APK ABI in ${variant} metadata.`);
      seen.add(abi);
      const unsigned = variant === 'release' && entry.outputFile.endsWith('-unsigned.apk');
      const kind = variant === 'debug' ? 'debug' : unsigned ? 'release-unsigned' : 'release';
      const version = entry.versionName.replace(/-debug$/, '');
      if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error('Unexpected version name in APK metadata.');
      const name = `waarp-android-${version}-${abi}-${kind}.apk`;
      const destination = resolve(output, name);
      await copyFile(resolve(directory, entry.outputFile), destination);
      await run(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [
        'scripts/android-verify.py', destination, '--expect', kind, '--report', `${destination}.validation.json`,
      ]);
      artifacts.push({ file: name, abi, variant: kind, packageId: metadata.applicationId, versionName: entry.versionName, versionCode: entry.versionCode });
    }
    if (seen.size !== pin.packagedAbis.length) throw new Error(`Missing ABI output for ${variant}.`);
  }
  const testDirectory = resolve(repositoryRoot, 'android/app/build/outputs/apk/androidTest/debug');
  const testMetadata = JSON.parse(await readFile(resolve(testDirectory, 'output-metadata.json'), 'utf8'));
  if (testMetadata.elements.length !== 1) throw new Error('Expected one debug instrumentation APK.');
  const testName = 'waarp-android-debug-instrumentation.apk';
  await copyFile(resolve(testDirectory, testMetadata.elements[0].outputFile), resolve(output, testName));
  const acceptanceDirectory = resolve(repositoryRoot, 'android/acceptance/build/outputs/apk/release');
  const acceptanceMetadata = JSON.parse(await readFile(resolve(acceptanceDirectory, 'output-metadata.json'), 'utf8'));
  if (acceptanceMetadata.elements.length !== 1 || acceptanceMetadata.applicationId !== 'local.waarp.android.acceptance') {
    throw new Error('Expected one standalone release acceptance APK.');
  }
  const acceptanceName = 'waarp-android-release-acceptance.apk';
  await copyFile(resolve(acceptanceDirectory, acceptanceMetadata.elements[0].outputFile), resolve(output, acceptanceName));
  const signatureReports = resolve(repositoryRoot, 'android/app/build/reports/junit-signatures');
  await mkdir(signatureReports, { recursive: true });
  for (const [name, suite] of [[testName, 'debug'], [acceptanceName, 'release']]) {
    // Failure diagnostics must survive removal of the unpublished staging set.
    const report = resolve(signatureReports, `${name}.json`);
    await run(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [
      'scripts/android-junit-signatures.py', resolve(output, name), '--suite', suite,
      '--report', report,
    ]);
    await copyFile(report, resolve(output, `${name}.junit-signatures.json`));
  }
  await run(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [
    'scripts/android-test-report.py', 'android/app/build/test-results/testDebugUnitTest', '--report', resolve(output, 'unit-tests.json'),
  ]);
  await writeFile(resolve(output, 'artifacts.json'), `${JSON.stringify({ schemaVersion: 2, engine: pin.version, artifacts,
    instrumentation: testName, releaseAcceptance: acceptanceName }, null, 2)}\n`);
  let backup;
  if (await stat(published).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    const history = resolve(repositoryRoot, 'out/android-history');
    await mkdir(history, { recursive: true });
    backup = resolve(history, `previous-${Date.now()}`);
    await rename(published, backup);
  }
  try { await rename(output, published); }
  catch (error) { if (backup) await rename(backup, published); throw error; }
  console.log(`Validated ${artifacts.length} APKs and both test APKs in out/android.`);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
