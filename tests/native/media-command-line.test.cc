#include "../../native/windows-media-runner/command_line.h"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
int main() {
  using media_runner::QuoteArgument;
  assert(QuoteArgument(L"") == L"\"\"");
  assert(QuoteArgument(L"a b") == L"\"a b\"");
  assert(QuoteArgument(L"a\"b") == L"\"a\\\"b\"");
  assert(QuoteArgument(L"C:\\path with spaces\\") == L"\"C:\\path with spaces\\\\\"");
  assert(QuoteArgument(L"&echo secret|whoami") == L"\"&echo secret|whoami\"");
  assert(media_runner::CommandLine({L"C:\\program files\\tool.exe", L"", L"中文"}) == L"\"C:\\program files\\tool.exe\" \"\" \"中文\"");
}
