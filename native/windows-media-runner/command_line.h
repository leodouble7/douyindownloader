#pragma once
#include <string>
#include <vector>
namespace media_runner {
// Windows CRT argv quoting only. CreateProcess receives an explicit application name;
// no command interpreter sees this serialization.
inline std::wstring QuoteArgument(const std::wstring& argument) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') { ++backslashes; continue; }
    if (character == L'"') result.append(backslashes * 2 + 1, L'\\');
    else result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(character);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'"');
  return result;
}
inline std::wstring CommandLine(const std::vector<std::wstring>& arguments) {
  std::wstring result;
  for (const auto& argument : arguments) {
    if (!result.empty()) result.push_back(L' ');
    result += QuoteArgument(argument);
  }
  return result;
}
}
