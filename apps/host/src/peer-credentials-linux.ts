export async function verifyPeer(fd: number): Promise<boolean> {
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen("libc.so.6", {
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
  });
  try {
    const credentials = new Uint32Array(3);
    const length = new Uint32Array([credentials.byteLength]);
    const status = library.symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(length));
    return (
      status === 0 && length[0] === credentials.byteLength && credentials[1] === process.getuid?.()
    );
  } finally {
    library.close();
  }
}
