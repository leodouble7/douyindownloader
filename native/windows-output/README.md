# Windows output actor

The x64 addon implements the existing acknowledged 64 KiB worker protocol's filesystem operations. It uses N-API version 8, so the shipped binary does not depend on a system Node.js, Python, or an Electron-specific V8 ABI. Node tests launch the bundled JS actor with `fork`; Task 11 must supply the Electron utilityProcess launcher and verify packaged IPC/asar behavior.

## Build and executable verification

On Windows x64 with Visual Studio 2022 C++ tools and the Windows 10/11 SDK installed:

```
npm ci
npm run build:windows-output
npm run test:windows-output
npm run build
```

`node-gyp` is locked to 12.4.0. Python is a **build** dependency of node-gyp, never a packaged application dependency. The Windows CI job selects the Windows 2025 image and Node 24.14.0, builds the addon, exercises the actor, and copies the worker/adapter/shared filename contract/addon into `out/main`. Electron-builder unpacks the CJS actor and `.node` binary from asar. Build fails if the Windows binary is missing. No runtime download or system helper fallback exists.

## Security and filesystem contract

- Initial local absolute drive path components are opened one at a time. The drive root uses `CreateFileW` with `BACKUP_SEMANTICS | OPEN_REPARSE_POINT`; child opens use `NtCreateFile`, `RootDirectory`, `OBJ_DONT_REPARSE` and a single validated component. Every opened object is checked for `FILE_ATTRIBUTE_REPARSE_POINT`; junctions and symlinks are rejected before use. Ancestor components require only traversal/read rights; the selected directory gets child-creation rights.
- The parent and worker compare exact volume serial/file-index strings from opened handles. The worker keeps both the original root and private artifact directory handles. All further opens, metadata replacements, hard links and deletions are relative to these handles. A renamed directory or substituted junction cannot redirect them. Returned display paths never authorize mutations.
- Files are opened with `FILE_WRITE_THROUGH`, and active write handles deny other write/delete sharing. Rename/link operate on an opened source handle and target directory handle using `NtSetInformationFile`. Publication's `FileLinkInformation` has `ReplaceIfExists=false`; the shared actor verifies source identity and reports the commit before subsequent flushes. Deletes set disposition on the exact opened handle. Manifest slots retain the shared checksum/sequence/recovery protocol.
- The supported filesystem contract is a local NTFS volume with hard links and stable file IDs. Remote/UNC paths, reparse-mounted volumes and filesystems without this verified contract fail before artifact creation. Extending to another filesystem requires proving its handle/link/flush behavior, rather than adding a pathname fallback.

## Durability limits

Every data/manifest file is opened write-through and explicitly flushed. Source handles are flushed after metadata rename; publication notifies the atomic visibility boundary and then flushes the final handle. Directory handles are also flushed when Windows accepts it. Windows commonly rejects directory `FlushFileBuffers` for unprivileged handles; this is reported as `write-through-file-flush` in sanitized resume metadata, not claimed to be POSIX directory fsync. Other flush errors remain failures. Dual slots and retained receipts recover namespace lifecycle interruptions, but storage hardware/OS guarantees still bound survival of sudden power loss. The native tests simulate process interruptions, not power loss.

## Primary sources

- [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile): handle-relative names, exclusive create, synchronous/write-through/reparse-open flags.
- [OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes): `OBJ_DONT_REPARSE` rejects reparses during name parsing.
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): directory/reparse opening, share modes, NTFS write-through metadata behavior.
- [FILE_LINK_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_link_information): source handle, target directory, no replacement.
- [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers): access rights and write-through semantics; volume-wide flush requires administrator privileges.
- [Node filesystem flags](https://nodejs.org/api/fs.html#file-system-flags): Windows does not expose Node's `O_NOFOLLOW`/`O_DIRECTORY`; these are not used by the native branch.

Windows compile/runtime results must come from the Windows job. A passing macOS unit test with injected native capabilities is not Windows verification.


Round 3 adds compile-time x64 layout assertions and aligned, zeroed, sizeof-compatible variable-name storage with a trailing WCHAR. Windows native tests exercise both link and rename with 1, 2, and 150-character names, plus sanitized one-character actor publication. The junction-substitution test first checks Windows sharing denial while the part handle is open, then closes it, moves the private directory, substitutes the old path, and reopens/reads/writes/publishes/replays receipts through the retained directory handle.
