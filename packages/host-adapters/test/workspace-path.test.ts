import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkspacePath } from "../src/index";

let root = "";
let outside = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pocket-workspace-"));
  outside = await mkdtemp(join(tmpdir(), "pocket-outside-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "src", "index.ts"), "export {};\n");
  await writeFile(join(outside, "secret"), "outside\n");
  await symlink(join(outside, "secret"), join(root, "escape"));
});

afterAll(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

test("workspace validator returns canonical files and directories", async () => {
  expect(validateWorkspacePath(root, "src")).resolves.toMatchObject({
    relativePath: "src",
    kind: "directory",
  });
  expect(validateWorkspacePath(root, "src/index.ts")).resolves.toMatchObject({
    relativePath: join("src", "index.ts"),
    kind: "file",
  });
});

test("workspace validator rejects traversal, escaped symlinks, git internals, and missing paths", async () => {
  expect(validateWorkspacePath(root, join(outside, "secret"))).rejects.toMatchObject({
    code: "OUTSIDE_WORKSPACE",
  });
  expect(validateWorkspacePath(root, "escape")).rejects.toMatchObject({
    code: "OUTSIDE_WORKSPACE",
  });
  expect(validateWorkspacePath(root, ".git")).rejects.toMatchObject({ code: "GIT_INTERNAL" });
  expect(validateWorkspacePath(root, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(validateWorkspacePath(root, "bad\0path")).rejects.toMatchObject({
    code: "INVALID_PATH",
  });
});
