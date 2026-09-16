// Windows x64 tool containment. No shell, IPC interpreter, arbitrary handle
// inheritance, breakaway, or uncontained fallback is permitted.
#include <windows.h>
#include <cerrno>
#include <cwchar>
#include <vector>
#include "command_line.h"

static_assert(sizeof(void*) == 8, "The media runner is packaged for Windows x64 only");
namespace {
constexpr DWORD kFailure = 125;
struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE handle = nullptr) : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
};
struct Attributes {
  std::vector<unsigned char> bytes;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
  bool initialize() {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
    if (!size) return false;
    bytes.resize(size);
    auto candidate = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
    if (!InitializeProcThreadAttributeList(candidate, 2, 0, &size)) return false;
    list = candidate;
    return true;
  }
};
bool DuplicateStandard(DWORD which, Handle& destination) {
  HANDLE source = GetStdHandle(which);
  if (!source || source == INVALID_HANDLE_VALUE) return false;
  return DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &destination.value,
                         0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}
bool AbsolutePath(const std::wstring& path) {
  return (path.size() >= 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) ||
         (path.size() >= 3 && path[0] == L'\\' && path[1] == L'\\');
}
}
int wmain(int argc, wchar_t** argv) {
  if (argc < 3) return kFailure;
  wchar_t* end = nullptr;
  errno = 0;
  const unsigned long parentId = std::wcstoul(argv[1], &end, 10);
  if (errno || !parentId || !end || *end || parentId == GetCurrentProcessId()) return kFailure;
  Handle parent(OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(parentId)));
  if (!parent.valid() || WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT) return kFailure;
  const std::wstring executable(argv[2]);
  if (!AbsolutePath(executable)) return kFailure;
  // Lock the executable leaf against replacement during suspended launch.
  Handle image(CreateFileW(executable.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION imageInfo{};
  if (!image.valid() || GetFileType(image.value) != FILE_TYPE_DISK ||
      !GetFileInformationByHandle(image.value, &imageInfo) ||
      (imageInfo.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) return kFailure;
  std::vector<std::wstring> arguments;
  for (int i = 2; i < argc; ++i) arguments.emplace_back(argv[i]);
  auto commandLine = media_runner::CommandLine(arguments);
  if (commandLine.size() > 32766) return kFailure;
  // Each sole Job handle is deliberately non-inheritable and unnamed.
  Handle job(CreateJobObjectW(nullptr, nullptr));
  Handle launchGuard(CreateJobObjectW(nullptr, nullptr));
  if (!job.valid() || !launchGuard.valid()) return kFailure;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !SetInformationJobObject(launchGuard.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return kFailure;
  Handle input, output, diagnostic;
  if (!DuplicateStandard(STD_INPUT_HANDLE, input) || !DuplicateStandard(STD_OUTPUT_HANDLE, output) ||
      !DuplicateStandard(STD_ERROR_HANDLE, diagnostic)) return kFailure;
  HANDLE inherited[] = {input.value, output.value, diagnostic.value};
  HANDLE launchJobs[] = {launchGuard.value};
  Attributes attributes;
  if (!attributes.initialize() || !UpdateProcThreadAttribute(attributes.list, 0,
      PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 launchJobs, sizeof(launchJobs), nullptr, nullptr)) return kFailure;
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.value;
  startup.StartupInfo.hStdOutput = output.value;
  startup.StartupInfo.hStdError = diagnostic.value;
  startup.lpAttributeList = attributes.list;
  // Atomic Job attachment covers a runner kill between CreateProcess returning
  // and explicit assignment below; even a never-resumed child is contained.
  PROCESS_INFORMATION information{};
  if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
      &startup.StartupInfo, &information)) return kFailure;
  Handle process(information.hProcess), thread(information.hThread);
  // The child cannot execute or spawn descendants before successful containment.
  if (!AssignProcessToJobObject(job.value, process.value)) {
    TerminateProcess(process.value, kFailure);
    WaitForSingleObject(process.value, 1000);
    return kFailure;
  }
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return kFailure;
  HANDLE waits[] = {parent.value, process.value};
  if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0 + 1) return kFailure;
  DWORD exitCode = kFailure;
  if (!GetExitCodeProcess(process.value, &exitCode)) return kFailure;
  // A leader may exit while descendants keep inherited pipes open. Retain the
  // Job until the whole tree exits or the Node host terminates this runner.
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
                                   &accounting, sizeof(accounting), nullptr)) return kFailure;
    if (accounting.ActiveProcesses == 0) break;
    if (WaitForSingleObject(parent.value, 10) != WAIT_TIMEOUT) return kFailure;
  }
  return static_cast<int>(exitCode);
}
