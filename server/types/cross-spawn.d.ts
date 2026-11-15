/** `cross-spawn` n'embarque pas ses types : la seule forme qu'Oathrion appelle, celle de `child_process.spawn`. */
declare module "cross-spawn" {
  import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

  function spawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  export default spawn;
}
