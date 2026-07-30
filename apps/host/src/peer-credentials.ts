export async function verifyCurrentUserPeer(socket: Bun.Socket<unknown>): Promise<boolean> {
  const descriptor = Reflect.get(socket, "fd");
  if (typeof descriptor !== "number") return false;
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const implementation: { verifyPeer(fd: number): Promise<boolean> } = await import(
    `./peer-credentials-${platform}.ts`
  );
  return implementation.verifyPeer(descriptor);
}
