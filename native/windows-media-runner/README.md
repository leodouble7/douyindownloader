# Windows x64 media tool runner

The media adapter starts this executable with `shell: false` and an argument array:

```
media-job-runner.exe <parent-node-pid> <absolute-tool-executable> <tool-arguments...>
```

This is the only Windows tool launch path. A missing runner is an inconclusive local-tool failure. The runner never invokes a command interpreter.

The runner opens a synchronization handle to its Node host, creates unnamed, non-inheritable runtime and launch-guard Jobs with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, duplicates only stdin/stdout/stderr, and places those three handles in a `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. A Windows 10 `PROC_THREAD_ATTRIBUTE_JOB_LIST` atomically places the child in the launch-guard Job at creation, closing the gap where killing the runner before explicit assignment could orphan a suspended child. It locks the regular executable leaf against replacement, then calls `CreateProcessW` with `CREATE_SUSPENDED`, assigns that process to the Job, and resumes its thread only after assignment succeeds. Assignment failure terminates the still-suspended process. Both Jobs permit no breakaway.

The runner waits for both the initial tool and all remaining Job members. If the leader exits while a descendant holds stdout/stderr, the runner remains alive. Cancelling/timing out the Node child terminates the runner; closing its sole handles to both Jobs kills all members. If the Node host itself exits, the runner notices its parent handle and exits, likewise closing both Jobs. Neither the tool nor its descendants inherit either Job handle. Tool exit codes are preserved; runner failures return the fixed code 125 without path-bearing diagnostics.

The adapter streams FFmpeg media stdout into its already-open private file handle using 64 KiB backpressure and serial partial-write handling. FFmpeg receives `pipe:1`, never a Windows output pathname. Progress is parsed from `pipe:2` separately from binary output. Final ffprobe verification on every platform consumes the owned output handle through stdin; Windows original input paths retain the existing identity checks. Input path identity and publication checks remain in the adapter; this runner is process containment, not a general filesystem sandbox.

## Build, package, and verify

Run `npm run build:windows-media-runner` on a Windows x64 host with the MSVC tools required by node-gyp. The targets are a fixed-x64 standalone runner, a native Job/breakaway fixture, and a portable command-argument test. The runner statically links its CRT and has no Node/Electron ABI dependency. All launch APIs use Unicode.

`npm run build` copies only `media_job_runner.exe` to `out/main/media-job-runner.exe`; Electron Builder unpacks `out/main/*.exe` from ASAR. The runtime resolver uses the physical `app.asar.unpacked` path in packaged builds. Development additionally accepts the native build's Release path. A Windows build fails if its runner is missing.

The existing `.github/workflows/windows-output.yml` now builds the runner and runs `npm run test:windows-media`. That command covers real MP4/WebM stream copy, direct owned-handle streaming and final stdin probing, temp-leaf victim preservation, descendant timeout/cancellation, argument boundaries, native initial Job membership and attempted breakaway. Tests using POSIX-only shebang fault executables remain marked as such. The portable command-argument test also compiles and runs on macOS; Win32 runtime and MSVC compilation require Windows CI.

## Primary API references

- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): inherited job membership and kill-on-close behavior.
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): explicit inherited-handle lists.
- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw): application-name and suspended-process creation contracts.
- [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject): assigning a suspended child before execution.
- [Parsing C command-line arguments](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments): Windows CRT quoting rules used by the small portable serializer.
