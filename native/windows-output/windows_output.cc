// N-API ABI-stable filesystem primitives. No operation after openRoot uses an absolute path.
#include <node_api.h>
#include <windows.h>
#include <winternl.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <cstdint>
#include <cmath>
#include <cstddef>
#include <algorithm>
#include <cstring>
#include <new>

struct Failure { std::string message; DWORD code; };
static void fail(const char* message, DWORD code = ERROR_INVALID_PARAMETER) { throw Failure{message, code}; }
static void check(BOOL ok) { if (!ok) fail("filesystem-operation-failed", GetLastError()); }
using CreateFn = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using SetFn = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
using VolumeFn = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
using ErrorFn = ULONG (WINAPI*)(NTSTATUS);
static CreateFn ntCreate;
static SetFn ntSet;
static VolumeFn ntVolume;
static ErrorFn ntError;
static void status(NTSTATUS value) { if (static_cast<ULONG>(value) == 0xC000050BUL) fail("unsafe-reparse-point", ntError(value)); if (value < 0) fail("filesystem-operation-failed", ntError(value)); }
struct Handle { HANDLE value; explicit Handle(HANDLE h) : value(h) {} ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
static Handle* handle(napi_env env, napi_value value) { void* data = nullptr; if (napi_get_value_external(env, value, &data) != napi_ok || !data || static_cast<Handle*>(data)->value == INVALID_HANDLE_VALUE) fail("invalid-handle"); return static_cast<Handle*>(data); }
static napi_value external(napi_env env, HANDLE h) { napi_value out; auto* owner = new Handle(h); if (napi_create_external(env, owner, [](napi_env, void* p, void*) { delete static_cast<Handle*>(p); }, nullptr, &out) != napi_ok) { delete owner; fail("native-allocation-failed"); } return out; }
static napi_value text(napi_env env, const std::string& value) { napi_value out; napi_create_string_utf8(env, value.c_str(), value.size(), &out); return out; }
static napi_value wide(napi_env env, const std::wstring& value) { napi_value out; napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.data()), value.size(), &out); return out; }
static std::wstring string(napi_env env, napi_value value) { size_t size; if (napi_get_value_string_utf16(env, value, nullptr, 0, &size) != napi_ok || size > 32760) fail("invalid-string"); std::vector<char16_t> chars(size + 1); napi_get_value_string_utf16(env, value, chars.data(), chars.size(), &size); return std::wstring(reinterpret_cast<wchar_t*>(chars.data()), size); }
static napi_value number(napi_env env, double v) { napi_value out; napi_create_double(env, v, &out); return out; }
static napi_value boolean(napi_env env, bool v) { napi_value out; napi_get_boolean(env, v, &out); return out; }
static bool truth(napi_env env, napi_value value) { bool result; if (napi_get_value_bool(env, value, &result) != napi_ok) fail("invalid-boolean"); return result; }
static uint64_t integer(napi_env env, napi_value value) { double result; if (napi_get_value_double(env, value, &result) != napi_ok || result < 0 || result > 9007199254740991.0 || std::floor(result) != result) fail("invalid-integer"); return static_cast<uint64_t>(result); }
static void field(napi_env env, napi_value object, const char* key, napi_value value) { napi_set_named_property(env, object, key, value); }
static void component(const std::wstring& name) { if (name.empty() || name.size() > 255 || name == L"." || name == L".." || name.find_first_of(L"\\/:\0", 0, 4) != std::wstring::npos || name.back() == L'.' || name.back() == L' ') fail("unsafe-basename"); }
static BY_HANDLE_FILE_INFORMATION info(HANDLE h) { BY_HANDLE_FILE_INFORMATION result{}; check(GetFileInformationByHandle(h, &result)); if (result.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) fail("unsafe-reparse-point"); return result; }
static HANDLE openRelative(HANDLE root, const std::wstring& name, bool directory, bool create, bool writable = true) {
  component(name); UNICODE_STRING unicode{}; unicode.Buffer = const_cast<wchar_t*>(name.data()); unicode.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t)); unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES attributes{}; attributes.Length = sizeof(attributes); attributes.RootDirectory = root; attributes.ObjectName = &unicode; attributes.Attributes = 0x1040; // OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
  IO_STATUS_BLOCK io{}; HANDLE out;
  const ACCESS_MASK rights = directory ? (FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE | (writable ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_WRITE_ATTRIBUTES : 0)) : (GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE);
  status(ntCreate(&out, rights, &attributes, &io, nullptr, FILE_ATTRIBUTE_NORMAL,
    directory ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_READ,
    create ? 2 : 1, // FILE_CREATE (exclusive) / FILE_OPEN
    0x00200000 | 0x20 | 0x2 | (directory ? 0x1 : 0x40), // OPEN_REPARSE_POINT, SYNCHRONOUS_IO_NONALERT, WRITE_THROUGH, DIRECTORY/NON_DIRECTORY
    nullptr, 0));
  try { const auto metadata = info(out); if (!!(metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) fail("unsafe-file-kind"); }
  catch (...) { CloseHandle(out); throw; }
  return out;
}
static napi_value run(napi_env env, napi_callback_info callback, const std::string& op) {
  size_t argc = 4; napi_value args[4]{}; napi_get_cb_info(env, callback, &argc, args, nullptr, nullptr);
  try {
    if (op == "openRoot") {
      auto selected = string(env, args[0]);
      if (selected.rfind(L"\\\\?\\", 0) == 0) selected.erase(0, 4);
      if (selected.size() < 3 || selected[1] != L':' || (selected[2] != L'\\' && selected[2] != L'/') || !((selected[0] >= L'A' && selected[0] <= L'Z') || (selected[0] >= L'a' && selected[0] <= L'z'))) fail("unsupported-filesystem");
      std::wstring drive = L"\\\\?\\" + selected.substr(0, 2) + L"\\";
      HANDLE current = CreateFileW(drive.c_str(), FILE_TRAVERSE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (current == INVALID_HANDLE_VALUE) fail("filesystem-operation-failed", GetLastError());
      try {
        info(current); size_t start = 3;
        while (start < selected.size()) {
          const size_t end = selected.find_first_of(L"\\/", start); const auto name = selected.substr(start, end == std::wstring::npos ? end : end - start);
          const HANDLE next = openRelative(current, name, true, false, end == std::wstring::npos || end + 1 == selected.size()); CloseHandle(current); current = next;
          if (end == std::wstring::npos) break; start = end + 1;
        }
        return external(env, current);
      } catch (...) { CloseHandle(current); throw; }
    }
    auto* owner = handle(env, args[0]); const HANDLE h = owner->value;
    if (op == "close") { check(CloseHandle(h)); owner->value = INVALID_HANDLE_VALUE; }
    else if (op == "open") return external(env, openRelative(h, string(env, args[1]), string(env, args[2]) == L"directory", truth(env, args[3])));
    else if (op == "stat") {
      const auto i = info(h); const uint64_t size = (uint64_t(i.nFileSizeHigh) << 32) | i.nFileSizeLow;
      if (size > 9007199254740991ULL) fail("unsafe-file-size");
      napi_value out; napi_create_object(env, &out);
      field(env, out, "dev", text(env, std::to_string(i.dwVolumeSerialNumber)));
      field(env, out, "ino", text(env, std::to_string((uint64_t(i.nFileIndexHigh) << 32) | i.nFileIndexLow)));
      field(env, out, "size", number(env, double(size))); field(env, out, "nlink", number(env, i.nNumberOfLinks));
      field(env, out, "isFile", boolean(env, !(i.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))); field(env, out, "reparse", boolean(env, false)); return out;
    } else if (op == "capabilities") {
      wchar_t name[64]; DWORD flags;
      check(GetVolumeInformationByHandleW(h, nullptr, 0, nullptr, nullptr, &flags, name, 64));
      napi_value out; napi_create_object(env, &out);
      field(env, out, "filesystem", wide(env, name)); field(env, out, "hardLinks", boolean(env, flags & FILE_SUPPORTS_HARD_LINKS));
      field(env, out, "stableIds", boolean(env, std::wstring(name) == L"NTFS"));
      field(env, out, "durability", text(env, "write-through-file-flush")); return out;
    } else if (op == "path") {
      std::vector<wchar_t> path(32768); DWORD length = GetFinalPathNameByHandleW(h, path.data(), DWORD(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
      if (!length || length >= path.size()) fail("filesystem-operation-failed", GetLastError()); return wide(env, std::wstring(path.data(), length));
    } else if (op == "flush") {
      if (!FlushFileBuffers(h)) {
        const DWORD error = GetLastError();
        // Windows exposes no unprivileged portable directory fsync. NTFS file writes use WRITE_THROUGH;
        // files must still flush successfully. Report the weaker directory guarantee explicitly.
        if (!(truth(env, args[1]) && (error == ERROR_ACCESS_DENIED || error == ERROR_INVALID_FUNCTION || error == ERROR_INVALID_HANDLE))) fail("filesystem-flush-failed", error);
        return text(env, "write-through-file-flush");
      }
      return text(env, "directory-flush");
    } else if (op == "read" || op == "write") {
      LARGE_INTEGER offset; offset.QuadPart = integer(env, args[1]); check(SetFilePointerEx(h, offset, nullptr, FILE_BEGIN)); DWORD done = 0;
      if (op == "read") {
        const auto length = integer(env, args[2]); if (length > 65536) fail("invalid-read"); std::vector<char> data(static_cast<size_t>(length));
        check(ReadFile(h, data.data(), DWORD(length), &done, nullptr)); napi_value out; napi_create_buffer_copy(env, done, data.data(), nullptr, &out); return out;
      }
      void* data; size_t length; if (napi_get_buffer_info(env, args[2], &data, &length) != napi_ok || length > 65536) fail("invalid-write");
      check(WriteFile(h, data, DWORD(length), &done, nullptr)); return number(env, done);
    } else if (op == "truncate") {
      LARGE_INTEGER length; length.QuadPart = integer(env, args[1]); check(SetFilePointerEx(h, length, nullptr, FILE_BEGIN)); check(SetEndOfFile(h));
    } else if (op == "rename" || op == "link") {
      const auto target = string(env, args[2]); component(target);
      struct NameInfo { BOOLEAN replace; HANDLE root; ULONG length; WCHAR name[1]; };
      static_assert(sizeof(void*) == 8 && sizeof(WCHAR) == 2, "Windows x64 ABI required");
      static_assert(offsetof(NameInfo, name) == 20 && sizeof(NameInfo) == 24 && alignof(NameInfo) <= alignof(uint64_t), "Unexpected FILE_LINK/RENAME_INFORMATION layout");
      const size_t nameBytes = target.size() * sizeof(WCHAR);
      const size_t required = std::max(sizeof(NameInfo), offsetof(NameInfo, name) + nameBytes + sizeof(WCHAR));
      // sizeof-compatible minimum, aligned storage, and a zeroed trailing WCHAR for all name lengths.
      std::vector<uint64_t> storage((required + sizeof(uint64_t) - 1) / sizeof(uint64_t), 0);
      auto* record = new (storage.data()) NameInfo{}; record->replace = op == "rename"; record->root = handle(env, args[1])->value; record->length = ULONG(target.size() * sizeof(wchar_t)); memcpy(record->name, target.data(), record->length);
      IO_STATUS_BLOCK io{}; status(ntSet(h, &io, record, ULONG(required), static_cast<FILE_INFORMATION_CLASS>(op == "rename" ? 10 : 11)));
      if (op == "rename") check(FlushFileBuffers(h));
    } else if (op == "remove") {
      BOOLEAN remove = TRUE; IO_STATUS_BLOCK io{}; status(ntSet(h, &io, &remove, sizeof(remove), static_cast<FILE_INFORMATION_CLASS>(13)));
    } else if (op == "freeBytes") {
      struct FullSize { LARGE_INTEGER total, available, actual; ULONG sectors, bytes; } value{};
      IO_STATUS_BLOCK io{}; status(ntVolume(h, &io, &value, sizeof(value), 7));
      return text(env, std::to_string(uint64_t(value.available.QuadPart) * value.sectors * value.bytes));
    } else fail("unknown-native-operation");
    napi_value undefined; napi_get_undefined(env, &undefined); return undefined;
  } catch (const Failure& error) {
    napi_value message = text(env, error.message), object; napi_create_error(env, nullptr, message, &object);
    const char* code = error.code == ERROR_FILE_NOT_FOUND || error.code == ERROR_PATH_NOT_FOUND ? "ENOENT" : error.code == ERROR_FILE_EXISTS || error.code == ERROR_ALREADY_EXISTS ? "EEXIST" : "EIO";
    field(env, object, "code", text(env, code)); napi_throw(env, object); return nullptr;
  } catch (...) { napi_throw_error(env, nullptr, "native-operation-failed"); return nullptr; }
}
#define METHOD(name) static napi_value name(napi_env env, napi_callback_info callback) { return run(env, callback, #name); }
METHOD(openRoot) METHOD(open) METHOD(close) METHOD(stat) METHOD(capabilities) METHOD(path) METHOD(flush) METHOD(read) METHOD(write) METHOD(truncate) METHOD(rename) METHOD(link) METHOD(remove) METHOD(freeBytes)
static napi_value init(napi_env env, napi_value exports) {
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  ntCreate = reinterpret_cast<CreateFn>(GetProcAddress(module, "NtCreateFile")); ntSet = reinterpret_cast<SetFn>(GetProcAddress(module, "NtSetInformationFile"));
  ntVolume = reinterpret_cast<VolumeFn>(GetProcAddress(module, "NtQueryVolumeInformationFile")); ntError = reinterpret_cast<ErrorFn>(GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!ntCreate || !ntSet || !ntVolume || !ntError) { napi_throw_error(env, nullptr, "native-capability-unavailable"); return nullptr; }
#define EXPORT(name) { napi_value fn; napi_create_function(env, #name, NAPI_AUTO_LENGTH, name, nullptr, &fn); napi_set_named_property(env, exports, #name, fn); }
  EXPORT(openRoot) EXPORT(open) EXPORT(close) EXPORT(stat) EXPORT(capabilities) EXPORT(path) EXPORT(flush) EXPORT(read) EXPORT(write) EXPORT(truncate) EXPORT(rename) EXPORT(link) EXPORT(remove) EXPORT(freeBytes)
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
