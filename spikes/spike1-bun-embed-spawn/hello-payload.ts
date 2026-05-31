// Minimal "hello world" binary used as the smoke-test embed payload on macOS.
// Compiled by run.sh into payload/dummy-bin before the spike is built.
// On Windows the run.ps1 uses where.exe instead (a real native .exe).
process.stdout.write("hello from embedded binary\n");
process.exit(0);
