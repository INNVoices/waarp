#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
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
  await mkdir(dirname(coreAarPath), { recursive: true });
  const temporaryPath = `${coreAarPath}.${process.pid}.download`;
  let handle;
  try {
    console.log(`Downloading pinned Android core ${pin.version} (${pin.bytes} bytes).`);
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Engine download failed: HTTP ${response.status}.`);
    handle = await open(temporaryPath, 'wx', 0o600);
    let received = 0;
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > pin.bytes) throw new Error('Engine download exceeds its pinned size.');
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    await handle.close();
    handle = undefined;
    if (received !== pin.bytes || hash.digest('hex') !== pin.sha256) throw new Error('Engine download failed integrity verification.');
    await rename(temporaryPath, coreAarPath);
    console.log(`Android core ${pin.version}: SHA-256 verified.`);
    return pin;
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
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
