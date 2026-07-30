export async function verifyPeer(fd: number): Promise<boolean> {
  const { dlopen, ptr, read } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    GetNamedPipeClientProcessId: { args: ["u64", "ptr"], returns: "bool" },
    OpenProcess: { args: ["u32", "bool", "u32"], returns: "u64" },
    GetCurrentProcess: { args: [], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "bool" },
    ProcessIdToSessionId: { args: ["u32", "ptr"], returns: "bool" },
    GetCurrentProcessId: { args: [], returns: "u32" },
    LocalFree: { args: ["u64"], returns: "u64" },
  });
  const runtime = dlopen("msvcrt.dll", {
    _get_osfhandle: { args: ["i32"], returns: "i64" },
  });
  const security = dlopen("advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "bool" },
    GetTokenInformation: {
      args: ["u64", "u32", "ptr", "u32", "ptr"],
      returns: "bool",
    },
    EqualSid: { args: ["ptr", "ptr"], returns: "bool" },
    SetEntriesInAclW: { args: ["u32", "ptr", "ptr", "ptr"], returns: "u32" },
    SetSecurityInfo: {
      args: ["u64", "u32", "u32", "ptr", "ptr", "u64", "ptr"],
      returns: "u32",
    },
  });
  try {
    // oxlint-disable-next-line no-underscore-dangle -- The CRT export is named `_get_osfhandle`.
    const pipeHandle = runtime.symbols._get_osfhandle(fd);
    if (pipeHandle === -1n) return false;
    const ownSid = tokenUserSid(kernel.symbols.GetCurrentProcess());
    if (ownSid === undefined || !applyCurrentUserDacl(pipeHandle, ownSid)) return false;
    const peerPid = new Uint32Array(1);
    if (!kernel.symbols.GetNamedPipeClientProcessId(pipeHandle, ptr(peerPid))) return false;
    const peerSession = new Uint32Array(1);
    const ownSession = new Uint32Array(1);
    if (!kernel.symbols.ProcessIdToSessionId(peerPid[0] ?? 0, ptr(peerSession))) return false;
    if (
      !kernel.symbols.ProcessIdToSessionId(kernel.symbols.GetCurrentProcessId(), ptr(ownSession))
    ) {
      return false;
    }
    const processHandle = kernel.symbols.OpenProcess(0x1000, false, peerPid[0] ?? 0);
    if (processHandle === 0n) return false;
    try {
      const peerSid = tokenUserSid(processHandle);
      return (
        peerSession[0] === ownSession[0] &&
        peerSid !== undefined &&
        security.symbols.EqualSid(peerSid, ownSid)
      );
    } finally {
      kernel.symbols.CloseHandle(processHandle);
    }
  } finally {
    runtime.close();
    security.close();
    kernel.close();
  }

  function applyCurrentUserDacl(pipeHandle: bigint, sid: Uint8Array): boolean {
    const explicitAccess = new Uint8Array(48);
    const view = new DataView(explicitAccess.buffer);
    view.setUint32(0, 0x10000000, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 0, true);
    view.setUint32(28, 0, true);
    view.setUint32(32, 1, true);
    view.setBigUint64(40, BigInt(ptr(sid)), true);
    const acl = new BigUint64Array(1);
    if (security.symbols.SetEntriesInAclW(1, ptr(explicitAccess), null, ptr(acl)) !== 0) {
      return false;
    }
    const aclHandle = acl[0] ?? 0n;
    try {
      return security.symbols.SetSecurityInfo(pipeHandle, 6, 4, null, null, aclHandle, null) === 0;
    } finally {
      if (aclHandle !== 0n) kernel.symbols.LocalFree(aclHandle);
    }
  }

  function tokenUserSid(processHandle: bigint) {
    const token = new BigUint64Array(1);
    if (!security.symbols.OpenProcessToken(processHandle, 0x0008, ptr(token))) return undefined;
    const tokenHandle = token[0] ?? 0n;
    try {
      const required = new Uint32Array(1);
      security.symbols.GetTokenInformation(tokenHandle, 1, null, 0, ptr(required));
      const requiredLength = required[0] ?? 0;
      if (requiredLength === 0) return undefined;
      const buffer = new Uint8Array(requiredLength);
      if (
        !security.symbols.GetTokenInformation(
          tokenHandle,
          1,
          ptr(buffer),
          buffer.byteLength,
          ptr(required),
        )
      ) {
        return undefined;
      }
      const base = ptr(buffer);
      const sidAddress = read.ptr(base, 0);
      const sidOffset = sidAddress - base;
      return sidOffset < 0 || sidOffset >= buffer.byteLength
        ? undefined
        : buffer.subarray(sidOffset);
    } finally {
      kernel.symbols.CloseHandle(tokenHandle);
    }
  }
}
