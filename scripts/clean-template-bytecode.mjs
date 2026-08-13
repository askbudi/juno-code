#!/usr/bin/env node
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export async function cleanTemplateBytecode(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name === '__pycache__') {
      await rm(absolute, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await cleanTemplateBytecode(absolute);
    } else if (entry.isFile() && entry.name.endsWith('.pyc')) {
      await rm(absolute, { force: true });
    }
  }
}

const root = path.resolve(process.argv[2] ?? 'dist/templates/scripts');
await cleanTemplateBytecode(root);
