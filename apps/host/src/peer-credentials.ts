export async function verifyCurrentUserPeer(socket: Bun.Socket<unknown>): Promise<boolean> {
  if (process.platform === "win32") {
    // Bun does not expose a native named-pipe HANDLE. Windows peers instead prove possession of
    // the random HMAC secret stored beneath the current user's local application-data directory.
    return true;
  }
  const descriptor = Reflect.get(socket, "fd");
  if (typeof descriptor !== "number") return false;
  const implementation: { verifyPeer(fd: number): Promise<boolean> } = await import(
    `./peer-credentials-${process.platform}.ts`
  );
  return implementation.verifyPeer(descriptor);
}
