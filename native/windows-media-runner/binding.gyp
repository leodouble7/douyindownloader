{
  "target_defaults": {
    "type": "executable",
    "win_delay_load_hook": "false",
    "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0A00"],
    "msvs_settings": {
      "VCCLCompilerTool": {"ExceptionHandling": 1, "RuntimeLibrary": 0, "AdditionalOptions": ["/std:c++17", "/W4", "/utf-8"]},
      "VCLinkerTool": {"SubSystem": 1, "TargetMachine": 17}
    }
  },
  "targets": [
    {"target_name": "media_job_runner", "sources": ["media_job_runner.cc"]},
    {"target_name": "media_runner_fixture", "sources": ["../../tests/native/windows-media-fixture.cc"]},
    {"target_name": "media_command_line_test", "sources": ["../../tests/native/media-command-line.test.cc"]}
  ]
}
