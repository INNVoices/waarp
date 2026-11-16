#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const enginePinPath = resolve(repositoryRoot, 'android/app/src/main/res/raw/engine_integrity.json');
export const coreAarPath = resolve(repositoryRoot, 'android/app/libs/libbox.aar');

export async function readEnginePin() {
  return JSON.parse(await readFile(enginePinPath, 'utf8'));
}

export async function verifyCore(file = coreAarPath) {
  const pin = await readEnginePin();
  const info = await stat(file);
  if (!info.isFile() || info.size !== pin.bytes) throw new Error('Engine AAR size does not match the audited pin.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== pin.sha256) throw new Error('Engine AAR SHA-256 does not match the audited pin.');
  return pin;
}

export async function fetchCore() {
  try {
    const pin = await verifyCore();
    console.log(`Android core ${pin.version}: verified cached AAR.`);
    return pin;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // Never replace an unexpected binary silently.
  }
  const pin = await readEnginePin();
  if (!pin.sourceBuild) throw new Error('Engine pin must identify the locked native source build.');
  console.log(`Building pinned Android core ${pin.version} from source.`);
  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn('python3', [
      resolve(repositoryRoot, 'scripts/android-core-build.py'),
      '--output', resolve(repositoryRoot, 'out/android-core'),
    ], { cwd: repositoryRoot, stdio: 'inherit' });
    child.once('error', rejectBuild);
    child.once('close', (code, signal) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Native core source build failed (${signal ? `signal ${signal}` : `exit ${code}`}).`));
    });
  });
  const verified = await verifyCore();
  console.log(`Android core ${verified.version}: source build SHA-256 and size verified.`);
  return verified;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? 'verify';
    if (command === 'fetch') await fetchCore();
    else if (command === 'verify') {
      const pin = await verifyCore();
      console.log(`Android core ${pin.version}: SHA-256 and size verified.`);
    } else throw new Error('Usage: node scripts/android-core.mjs [fetch|verify]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
