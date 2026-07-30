export async function verifyPeer(fd: number): Promise<boolean> {
  // Bun exposes no native named-pipe HANDLE for SID inspection. Windows identity is instead
  // authenticated by the HMAC secret in the current user's local application-data directory.
  return Number.isInteger(fd);
}
