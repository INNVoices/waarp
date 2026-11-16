import type { Server } from 'node:net'

/** Windows named pipes are a release gate. Restricted non-Windows workers may forbid Unix sockets.
 * Skip only that unavailable native transport, with an explicit result; never hide a Windows failure. */
export async function localIpcReady(server: Server): Promise<boolean> {
  try {
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      const ready = () => { server.off('error', error); resolve() }
      const error = (e: Error) => { server.off('listening', ready); reject(e) }
      server.once('listening', ready)
      server.once('error', error)
    })
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      console.log(`[SKIP] Local IPC transport: ${code} on ${process.platform}; run these checks on Windows.`)
      return false
    }
    throw error
  }
}
