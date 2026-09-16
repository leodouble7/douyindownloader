#include <windows.h>
#include <cstdio>
#include <string>
#include "../../native/windows-media-runner/command_line.h"
static_assert(sizeof(void*) == 8, "Windows x64 fixture");
int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  const std::wstring mode(argv[1]);
  if (mode == L"job-status") {
    BOOL inJob = FALSE;
    if (!IsProcessInJob(GetCurrentProcess(), nullptr, &inJob)) return 3;
    std::printf("{\"inJob\":%s}", inJob ? "true" : "false");
    return 0;
  }
  if (mode == L"breakaway") {
    wchar_t executable[32768];
    if (!GetModuleFileNameW(nullptr, executable, 32768)) return 3;
    auto command = media_runner::CommandLine({executable, L"job-status"});
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    const BOOL created = CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
                                       CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    const DWORD error = GetLastError();
    if (created) { TerminateProcess(process.hProcess, 5); WaitForSingleObject(process.hProcess, 1000); CloseHandle(process.hThread); CloseHandle(process.hProcess); }
    std::printf("{\"breakawayDenied\":%s}", !created && error == ERROR_ACCESS_DENIED ? "true" : "false");
    return 0;
  }
  return 2;
}
