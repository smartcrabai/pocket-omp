export async function verifyPeer(fd: number): Promise<boolean> {
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen("libc.dylib", {
    getpeereid: { args: ["i32", "ptr", "ptr"], returns: "i32" },
  });
  try {
    const uid = new Uint32Array(1);
    const gid = new Uint32Array(1);
    const status = library.symbols.getpeereid(fd, ptr(uid), ptr(gid));
    return status === 0 && uid[0] === process.getuid?.();
  } finally {
    library.close();
  }
}
