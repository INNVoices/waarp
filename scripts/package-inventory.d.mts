export interface InventoryFile {
  path: string
  bytes: number
  group: string
  storage?: 'packed' | 'external'
}
export interface InventoryGroup { name: string; files: number; bytes: number }
export interface MissingInventory { status: 'not_measured'; bytes: null; reason: string }
export interface FileInventory { status: 'measured'; bytes: number; sha256: string }
export interface DirectoryInventory {
  status: 'measured'
  bytes: number
  groups: InventoryGroup[]
  files: InventoryFile[]
  top20: InventoryFile[]
}
export interface AsarInventory extends FileInventory, DirectoryInventory {
  packedBytes: number
  metadataBytes: number
  externalBytes: number
  logicalBytes: number
  accounting: string
  classification: string
  links: { path: string; target: string }[]
  runtimeModules: { path: string; name: string; version: string | null; files: number; bytes: number }[]
}
export interface WindowsInventory {
  schemaVersion: number
  accounting: string
  portable: MissingInventory | FileInventory
  unpacked: MissingInventory | DirectoryInventory
  asar: MissingInventory | AsarInventory
  context?: Record<string, unknown>
}
export function fileSha256(path: string): Promise<string>
export function peArchitecture(path: string): { machine: number; architecture: string }
export function windowsPackageInventory(options: { directory: string; portable: string; asar: unknown }): Promise<WindowsInventory>
export function formatWindowsInventory(inventory: WindowsInventory): string
