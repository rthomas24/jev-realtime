import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Durable, atomic file replace: write a sibling temp file, fsync it, then
 * rename over the target. rename(2) is atomic on the same filesystem, so a
 * crash or power loss mid-write can never leave a truncated file behind — a
 * reader always sees either the complete old contents or the complete new
 * ones. Without the fsync, a plain write+rename can still surface an empty or
 * half-written file after an unclean shutdown, and for `state.json` that means
 * an agent's book (positions, cash, fills) reads as corrupt on next boot.
 */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'w')
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Crash-safe JSON write. */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2))
}

export function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
