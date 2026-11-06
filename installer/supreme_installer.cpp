// ============================================================================
//  After Effect Supreme MCP - Supreme-MCP.exe  (installer / manager)
//
//  What it does, in order, every time you open it:
//    [1/7] STOPS and CLEANS any previous MCP install
//          (daemon shutdown, old CEP extension folders, stale autostart,
//           stale watchdog processes, stop.flag)
//    [2/7] DETECTS every installed After Effects DYNAMICALLY
//          (registry HKLM/HKCU/WOW6432Node + Program Files scan + manual path)
//    [3/7] INSTALLS the CEP panel (com.aesupreme.mcp) for all of them
//          (+ enables PlayerDebugMode for unsigned panels, CSXS 9-13)
//    [4/7] CHECKS Node.js >= 18 (PATH, known folders, optional winget)
//    [5/7] BUILDS ONLY WHEN NEEDED (skips npm install/build when current)
//    [6/7] INSTALLS watchdog + HKCU autostart entry
//    [7/7] STARTS the daemon and verifies it is healthy on 127.0.0.1:7654
//
//  Flags:
//    --list        show detected After Effects installations and exit
//    --status      show daemon / panel / autostart status and exit
//    --uninstall   clean everything (panel, autostart, daemon) and exit
//    --no-start    install everything but do not start the daemon now
//    --port N      run the daemon on port N (default 7654)
//    --silent      never prompt, automatic answers only
//
//  No admin rights needed: everything lives in HKCU and %APPDATA%.
//  Build (MinGW):  x86_64-w64-mingw32-g++ -std=c++17 -O2 -Wall -Wextra -static
//                    -o Supreme-MCP.exe supreme_installer.cpp
//                    -lws2_32 -lole32 -lshell32 -ladvapi32
//  Build (MSVC):   cl /std:c++17 /O2 /EHsc /MT supreme_installer.cpp /Fe:Supreme-MCP.exe
//                  (libraries auto-linked via #pragma comment below; the code only
//                   uses ANSI "A" Win32 APIs + explicit W structs, so it compiles
//                   identically whether UNICODE is defined or not)
// ============================================================================

#define _CRT_SECURE_NO_WARNINGS
#define _WIN32_WINNT 0x0601
#define WINVER 0x0601

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <iostream>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <ctime>
#include <string>
#include <vector>
#include <map>
#include <fstream>
#include <sstream>
#include <algorithm>

// MSVC: linked automatically via these pragmas. MinGW/GCC: pass on the command
// line instead (-lws2_32 -lole32 -lshell32 -ladvapi32); GCC ignores #pragma comment.
#ifdef _MSC_VER
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")
#endif

// ------------------------------------------------------------------ constants
static const char*  APP_TITLE       = "After Effect Supreme MCP";
static const char*  INSTALLER_VER   = "0.3.9";
static const char*  RUN_KEY_NAME    = "AfterEffectSupremeMCP";
static const char*  BUNDLE_ID       = "com.aesupreme.mcp";
static const char*  LEGACY_EXT_PREFIXES[] = { "com.aesupreme", "com.aemcp", "com.aegod", nullptr };
static const int    DEFAULT_PORT    = 7654;

static std::string  gRoot;          // project folder (package.json + ae-panel/)
static std::string  gNode;          // full path to node.exe
static std::string  gNpm;           // full path to npm.cmd
static int          gPort           = DEFAULT_PORT;
static bool         gSilent         = false;

// ------------------------------------------------------------------ small utils
static std::string lower(std::string s) {
    for (auto& c : s) c = (char)tolower((unsigned char)c);
    return s;
}
static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n\"");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n\"");
    return s.substr(a, b - a + 1);
}
static std::string envStr(const char* name) {
    char buf[MAX_PATH * 2] = { 0 };
    DWORD n = GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf) : std::string();
}
static bool fileExists(const std::string& p) {
    DWORD a = GetFileAttributesA(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}
static bool dirExists(const std::string& p) {
    DWORD a = GetFileAttributesA(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}
static bool mkdirs(const std::string& p) {
    if (p.empty() || dirExists(p)) return true;
    std::string parent = p;
    size_t pos = parent.find_last_of("\\/");
    if (pos == std::string::npos) return false;
    parent = parent.substr(0, pos);
    if (!mkdirs(parent)) return false;
    return CreateDirectoryA(p.c_str(), nullptr) || dirExists(p);
}
static bool removeTree(const std::string& path) {
    if (!dirExists(path) && !fileExists(path)) return true;
    std::string from = path;
    from.push_back('\0'); from.push_back('\0');        // double-null terminated
    SHFILEOPSTRUCTA op{};
    op.hwnd   = nullptr;
    op.wFunc  = FO_DELETE;
    op.pFrom  = from.c_str();
    op.fFlags = FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
    return SHFileOperationA(&op) == 0 && !dirExists(path);
}
static bool copyDir(const std::string& src, const std::string& dst) {
    if (!dirExists(src)) return false;
    if (!mkdirs(dst)) return false;
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA((src + "\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return false;
    bool ok = true;
    do {
        std::string name = fd.cFileName;
        if (name == "." || name == "..") continue;
        std::string s = src + "\\" + name, d = dst + "\\" + name;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (!copyDir(s, d)) { ok = false; break; }
        } else {
            if (!CopyFileA(s.c_str(), d.c_str(), FALSE)) { ok = false; break; }
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
    return ok;
}
static bool writeTextFile(const std::string& path, const std::string& content) {
    std::ofstream f(path.c_str(), std::ios::binary | std::ios::trunc);
    if (!f.is_open()) return false;
    f << content;
    return f.good();
}
static std::string readTail(const std::string& path, size_t maxBytes) {
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f.is_open()) return "";
    f.seekg(0, std::ios::end);
    std::streamoff len = f.tellg();
    if (len <= 0) return "";
    std::streamoff start = len > (std::streamoff)maxBytes ? len - (std::streamoff)maxBytes : 0;
    f.seekg(start);
    std::string out((size_t)(len - start), '\0');
    f.read(&out[0], len - start);
    return out;
}
static bool getFileTime(const std::string& path, FILETIME* ft) {
    WIN32_FILE_ATTRIBUTE_DATA da;
    if (!GetFileAttributesExA(path.c_str(), GetFileExInfoStandard, &da)) return false;
    *ft = da.ftLastWriteTime;
    return true;
}
static int cmpFileTime(const FILETIME& a, const FILETIME& b) {
    if (a.dwHighDateTime != b.dwHighDateTime) return a.dwHighDateTime < b.dwHighDateTime ? -1 : 1;
    if (a.dwLowDateTime  != b.dwLowDateTime)  return a.dwLowDateTime  < b.dwLowDateTime  ? -1 : 1;
    return 0;
}
// newest LastWriteTime among src\*.ts (drives the rebuild decision)
static FILETIME newestSourceTime() {
    FILETIME best; ZeroMemory(&best, sizeof(best));
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA((gRoot + "\\src\\*.ts").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
                FILETIME ft{ fd.ftLastWriteTime.dwLowDateTime, fd.ftLastWriteTime.dwHighDateTime };
                if (cmpFileTime(ft, best) > 0) best = ft;
            }
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
    return best;
}

// ------------------------------------------------------------------ registry
static std::string regGetStr(HKEY root, const std::string& subkey, const char* value) {
    HKEY k;
    if (RegOpenKeyExA(root, subkey.c_str(), 0, KEY_READ, &k) != ERROR_SUCCESS) return "";
    char buf[1024] = { 0 };
    DWORD type = 0, size = sizeof(buf) - 1;
    std::string out;
    if (RegQueryValueExA(k, value, nullptr, &type, (LPBYTE)buf, &size) == ERROR_SUCCESS) {
        if (type == REG_SZ || type == REG_EXPAND_SZ) {
            out.assign(buf, strnlen(buf, size));
            if (type == REG_EXPAND_SZ) {
                char exp[2048] = { 0 };
                if (ExpandEnvironmentStringsA(out.c_str(), exp, sizeof(exp) - 1)) out = exp;
            }
        }
    }
    RegCloseKey(k);
    return out;
}
static std::vector<std::string> regEnumSubkeys(HKEY root, const std::string& subkey) {
    std::vector<std::string> out;
    HKEY k;
    if (RegOpenKeyExA(root, subkey.c_str(), 0, KEY_READ, &k) != ERROR_SUCCESS) return out;
    DWORD index = 0;
    char name[256];
    for (;;) {
        DWORD size = sizeof(name);
        LONG r = RegEnumKeyExA(k, index++, name, &size, nullptr, nullptr, nullptr, nullptr);
        if (r != ERROR_SUCCESS) break;
        out.push_back(name);
    }
    RegCloseKey(k);
    return out;
}
static void regSetStr(HKEY root, const std::string& subkey, const char* value, const std::string& data) {
    HKEY k;
    if (RegCreateKeyExA(root, subkey.c_str(), 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) != ERROR_SUCCESS) return;
    RegSetValueExA(k, value, 0, REG_SZ, (const BYTE*)data.c_str(), (DWORD)data.size() + 1);
    RegCloseKey(k);
}
static bool regHasValue(HKEY root, const std::string& subkey, const char* value) {
    HKEY k;
    if (RegOpenKeyExA(root, subkey.c_str(), 0, KEY_READ, &k) != ERROR_SUCCESS) return false;
    LONG r = RegQueryValueExA(k, value, nullptr, nullptr, nullptr, nullptr);
    RegCloseKey(k);
    return r == ERROR_SUCCESS;
}
static void regDelStr(HKEY root, const std::string& subkey, const char* value) {
    HKEY k;
    if (RegOpenKeyExA(root, subkey.c_str(), 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
    RegDeleteValueA(k, value);
    RegCloseKey(k);
}
// delete every HKCU Run value whose DATA mentions our install (old installers, old names)
static int cleanRunEntries() {
    const char* RUNKEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    HKEY k;
    if (RegOpenKeyExA(HKEY_CURRENT_USER, RUNKEY, 0, KEY_READ | KEY_SET_VALUE, &k) != ERROR_SUCCESS) return 0;
    int removed = 0;
    std::vector<std::string> doomed;
    DWORD index = 0;
    for (;;) {
        char name[512]; DWORD nameLen = sizeof(name), dataLen = 0, type = 0;
        LONG r = RegEnumValueA(k, index++, name, &nameLen, nullptr, &type, nullptr, &dataLen);
        if (r != ERROR_SUCCESS && r != ERROR_MORE_DATA) break;
        std::string data;
        if (dataLen > 0) {
            std::vector<char> buf(dataLen + 1, 0);
            DWORD nl2 = sizeof(name);
            if (RegEnumValueA(k, index - 1, name, &nl2, nullptr, &type, (LPBYTE)buf.data(), &dataLen) == ERROR_SUCCESS)
                data = buf.data();
        }
        std::string hay = lower(data);
        bool ours = hay.find("ae-mcp") != std::string::npos ||
                    hay.find("aesupreme") != std::string::npos ||
                    hay.find("aftereffectsmcp") != std::string::npos ||
                    hay.find("supreme-mcp") != std::string::npos ||
                    lower(name) == lower(RUN_KEY_NAME);
        if (ours) doomed.push_back(name);
        if (r != ERROR_SUCCESS) break;
    }
    for (size_t i = 0; i < doomed.size(); i++)
        if (RegDeleteValueA(k, doomed[i].c_str()) == ERROR_SUCCESS) removed++;
    RegCloseKey(k);
    return removed;
}

// ------------------------------------------------------------------ process helpers
static std::string b64utf16le(const std::string& s) {   // PowerShell -EncodedCommand payload
    std::string w;
    w.reserve(s.size() * 2);
    for (size_t i = 0; i < s.size(); i++) { w.push_back(s[i]); w.push_back('\0'); }
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t n = w.size();
    for (size_t i = 0; i < n; i += 3) {
        int b0 = (unsigned char)w[i];
        int b1 = (i + 1 < n) ? (unsigned char)w[i + 1] : 0;
        int b2 = (i + 2 < n) ? (unsigned char)w[i + 2] : 0;
        out += T[b0 >> 2];
        out += T[((b0 & 3) << 4) | (b1 >> 4)];
        out += (i + 1 < n) ? T[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += (i + 2 < n) ? T[b2 & 63] : '=';
    }
    return out;
}
// run with console inherited (user sees npm output live). Returns exit code.
static int runConsole(const std::string& cmd, const std::string& cwd, DWORD timeoutMs = INFINITE) {
    std::vector<char> buf(cmd.begin(), cmd.end()); buf.push_back(0);
    STARTUPINFOA si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessA(nullptr, buf.data(), nullptr, nullptr, FALSE, 0, nullptr,
                        cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) return -1;
    WaitForSingleObject(pi.hProcess, timeoutMs);
    DWORD code = STILL_ACTIVE;
    GetExitCodeProcess(pi.hProcess, &code);
    if (code == STILL_ACTIVE) { TerminateProcess(pi.hProcess, 1); WaitForSingleObject(pi.hProcess, 5000); code = 1; }
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return (int)code;
}
// run hidden, capture stdout+stderr
static std::string runCapture(const std::string& exe, const std::string& args,
                              const std::string& cwd, DWORD timeoutMs = 15000) {
    SECURITY_ATTRIBUTES sa{ sizeof(sa), nullptr, TRUE };
    HANDLE rd = nullptr, wr = nullptr;
    if (!CreatePipe(&rd, &wr, &sa, 0)) return "";
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOA si{}; si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
    si.hStdOutput = wr; si.hStdError = wr; si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    std::string cl = "\"" + exe + "\" " + args;
    std::vector<char> buf(cl.begin(), cl.end()); buf.push_back(0);
    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessA(nullptr, buf.data(), nullptr, nullptr, TRUE,
                             CREATE_NO_WINDOW, nullptr, cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
    CloseHandle(wr);
    if (!ok) { CloseHandle(rd); return ""; }
    std::string out; char ch[512]; DWORD n = 0;
    while (ReadFile(rd, ch, sizeof(ch), &n, nullptr) && n) { out.append(ch, n); if (out.size() > 65536) break; }
    WaitForSingleObject(pi.hProcess, timeoutMs);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(rd);
    return out;
}
static void runHidden(const std::string& exe, const std::string& args, const std::string& cwd = "") {
    std::string cl = "\"" + exe + "\" " + args;
    std::vector<char> buf(cl.begin(), cl.end()); buf.push_back(0);
    STARTUPINFOA si{}; si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    if (CreateProcessA(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                       nullptr, cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) {
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    }
}
static void killStaleProcesses() {
    // Only processes whose command line mentions OUR files are killed - never all node/wscript.
    std::string ps =
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='wscript.exe'\" | "
        "ForEach-Object { $c = $_.CommandLine; "
        "if ($c -and ($c -match 'daemon\\.js' -or $c -match 'AfterEffectsMCP' -or "
        "$c -match 'ae-mcp-full' -or $c -match 'ae-supreme-mcp')) "
        "{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }";
    runCapture("powershell.exe", "-NoProfile -NonInteractive -EncodedCommand " + b64utf16le(ps), "", 20000);
}

// ------------------------------------------------------------------ HTTP (winsock)
static bool wsaReady = false;
static void wsaInit() { WSADATA w; if (!wsaReady && WSAStartup(MAKEWORD(2, 2), &w) == 0) wsaReady = true; }
// returns HTTP status code, or 0 when nothing answered
static int httpStatus(const char* method, const char* path, DWORD timeoutMs = 2000) {
    if (!wsaReady) return 0;
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCKET) return 0;
    DWORD tv = timeoutMs;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (char*)&tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (char*)&tv, sizeof(tv));
    sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port   = htons((u_short)gPort);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(s, (sockaddr*)&a, sizeof(a)) != 0) { closesocket(s); return 0; }
    std::string req = std::string(method) + " " + path + " HTTP/1.1\r\n"
                      "Host: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
    if (send(s, req.c_str(), (int)req.size(), 0) < 0) { closesocket(s); return 0; }
    char buf[1024];
    memset(buf, 0, sizeof(buf));
    int n = recv(s, buf, sizeof(buf) - 1, 0);
    closesocket(s);
    if (n <= 0) return 0;
    int maj = 0, min = 0, st = 0;
    if (sscanf(buf, "HTTP/%d.%d %d", &maj, &min, &st) >= 3) return st;
    return 0;
}
static bool daemonHealthy() { return httpStatus("GET", "/api/state", 1500) == 200; }
static bool portInUse() {
    if (!wsaReady) return false;
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCKET) return false;
    sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET; a.sin_port = htons((u_short)gPort); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bool used = connect(s, (sockaddr*)&a, sizeof(a)) == 0;
    closesocket(s);
    return used;
}

// ------------------------------------------------------------------ runtime dir
static std::string runtimeDir() { return envStr("APPDATA") + "\\AfterEffectsMCP"; }

// is a given exe (e.g. AfterFX.exe) currently running? (toolhelp snapshot, no PS)
// NOTE: use the explicit W types/functions here. PROCESSENTRY32 / Process32First
// are macros that switch to the wide variants when a Visual Studio project has
// UNICODE defined (its default), which would make pe.szExeFile a WCHAR[260] and
// break the narrow std::string helpers below.
static bool isProcessRunning(const char* exeName) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32W pe; ZeroMemory(&pe, sizeof(pe));
    pe.dwSize = sizeof(pe);
    bool found = false;
    if (Process32FirstW(snap, &pe)) {
        do {
            char exe[MAX_PATH] = { 0 };
            WideCharToMultiByte(CP_UTF8, 0, pe.szExeFile, -1, exe, MAX_PATH - 1, nullptr, nullptr);
            if (lower(exe) == lower(exeName)) { found = true; break; }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return found;
}

// ------------------------------------------------------------------ [1] stop & clean old install
static void stepStopAndClean() {
    std::cout << "\n[1/7] Cleaning previous installation\n";
    std::string rt = runtimeDir();
    mkdirs(rt);
    writeTextFile(rt + "\\stop.flag", "stop\n");       // watchdog + daemon contract: do not run
    int st = httpStatus("POST", "/api/shutdown", 2500);
    if (st == 200) std::cout << "   .  running daemon stopped (HTTP shutdown OK)\n";
    else           std::cout << "   .  no running daemon on port " << gPort << "\n";

    killStaleProcesses();                              // leftover node/wscript bound to OUR paths only

    for (int i = 0; i < 12 && portInUse(); i++) Sleep(250);   // wait max 3s for the port to free up
    if (portInUse())
        std::cout << "   !  WARNING: something is still listening on port " << gPort
                  << " (not our daemon). The daemon may fail to start; use --port N to pick another.\n";

    // remove ALL old/new CEP extension folders of this project (any bundle-id generation)
    std::string ext = envStr("APPDATA") + "\\Adobe\\CEP\\extensions";
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA((ext + "\\*").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            std::string name = fd.cFileName;
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
            if (name == "." || name == "..") continue;
            std::string ln = lower(name);
            for (int i = 0; LEGACY_EXT_PREFIXES[i]; i++) {
                if (ln.find(LEGACY_EXT_PREFIXES[i]) == 0) {
                    if (removeTree(ext + "\\" + name))
                        std::cout << "   .  removed old CEP extension: " << name << "\n";
                    break;
                }
            }
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
    int removedRuns = cleanRunEntries();
    if (removedRuns > 0) std::cout << "   .  removed " << removedRuns << " stale autostart entr"
                                   << (removedRuns == 1 ? "y" : "ies") << "\n";
    std::cout << "   OK  old install is gone\n";
}

// ------------------------------------------------------------------ [2] detect After Effects
struct AeInstall {
    std::string label;   // e.g. "2024" or "24.0"
    std::string exe;     // full path to AfterFX.exe
    std::string via;     // "registry" / "scan" / "manual"
    int major = 0;       // internal AE version: 2026 -> 26, 2024 -> 24, 2021 -> 18 (0 = unknown)
};
// "After Effects 2024" -> 24 ; "After Effects 2021" -> 18 ; unknown -> 0
static int majorFromLabel(const std::string& label) {
    for (size_t i = 0; i + 3 < label.size(); i++) {
        if (isdigit((unsigned char)label[i]) && isdigit((unsigned char)label[i + 1]) &&
            isdigit((unsigned char)label[i + 2]) && isdigit((unsigned char)label[i + 3])) {
            int year = atoi(label.substr(i, 4).c_str());
            if (year >= 2020 && year <= 2035) {
                if (year >= 2022) return year - 2000;
                if (year == 2021) return 18;
                return 17;                       // 2020
            }
        }
    }
    return 0;
}
// registry subkey "24.0" -> 24, junk -> 0
static int majorFromSubkey(const std::string& s) {
    size_t dot = s.find('.');
    if (dot == std::string::npos || dot == 0) return 0;
    for (size_t i = 0; i < s.size(); i++)
        if (i != dot && !isdigit((unsigned char)s[i])) return 0;
    int n = atoi(s.c_str());
    return (n >= 14 && n <= 40) ? n : 0;
}
static std::string labelFromPath(const std::string& exe) {
    // "...\\Adobe After Effects 2024\\AfterFX.exe" -> "After Effects 2024"
    std::string p = exe;
    std::replace(p.begin(), p.end(), '/', '\\');
    size_t slash = p.find_last_of('\\');
    std::string dir = (slash == std::string::npos) ? p : p.substr(0, slash);
    slash = dir.find_last_of('\\');
    std::string name = (slash == std::string::npos) ? dir : dir.substr(slash + 1);
    return name;
}
static void regAEFrom(HKEY root, const char* base, const char* via, std::vector<AeInstall>& out) {
    std::vector<std::string> subs = regEnumSubkeys(root, base);
    for (size_t i = 0; i < subs.size(); i++) {
        std::string sub = std::string(base) + "\\" + subs[i];
        std::string app = trim(regGetStr(root, sub, "ApplicationPath"));
        std::string ins = trim(regGetStr(root, sub, "InstallPath"));
        std::string exe;
        if (!app.empty()) {
            std::string a = app;
            std::replace(a.begin(), a.end(), '/', '\\');
            if (a.size() >= 4 && lower(a).substr(a.size() - 4) == ".exe") exe = a;
            else exe = a + "\\AfterFX.exe";
        } else if (!ins.empty()) {
            std::string a = ins;
            std::replace(a.begin(), a.end(), '/', '\\');
            while (a.size() && a[a.size() - 1] == '\\') a.erase(a.size() - 1);
            exe = a + "\\AfterFX.exe";
        }
        if (!exe.empty() && fileExists(exe)) {
            AeInstall ae;
            std::string lab = labelFromPath(exe);
            if (lab.find("After Effects") == std::string::npos) lab = "After Effects " + subs[i];
            ae.label = lab; ae.exe = exe; ae.via = via;
            ae.major = majorFromSubkey(subs[i]);
            if (ae.major == 0) ae.major = majorFromLabel(lab);
            out.push_back(ae);
        }
    }
}
static void scanAEIn(const std::string& adobeDir, std::vector<AeInstall>& out) {
    if (!dirExists(adobeDir)) return;
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA((adobeDir + "\\After Effects*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        std::string exe = adobeDir + "\\" + fd.cFileName + "\\AfterFX.exe";
        if (fileExists(exe)) {
            AeInstall ae;
            ae.label = fd.cFileName; ae.exe = exe; ae.via = "scan";
            ae.major = majorFromLabel(fd.cFileName);
            out.push_back(ae);
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
}
static std::vector<AeInstall> detectAE() {
    std::vector<AeInstall> out;
    regAEFrom(HKEY_LOCAL_MACHINE, "SOFTWARE\\Adobe\\After Effects",       "registry", out);
    regAEFrom(HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\Adobe\\After Effects", "registry", out);
    regAEFrom(HKEY_CURRENT_USER,  "Software\\Adobe\\After Effects",       "registry", out);
    scanAEIn(envStr("ProgramFiles")      + "\\Adobe", out);
    scanAEIn(envStr("ProgramFiles(x86)") + "\\Adobe", out);
    scanAEIn(envStr("LocalAppData")      + "\\Programs\\Adobe", out);
    scanAEIn(envStr("SystemDrive") + "\\Program Files\\Adobe", out);
    // dedupe by exe path
    std::vector<AeInstall> uniq;
    std::map<std::string, bool> seen;
    for (size_t i = 0; i < out.size(); i++) {
        std::string key = lower(out[i].exe);
        while (key.size() > 1 && key[key.size() - 1] == '\\') key.erase(key.size() - 1);
        if (seen.count(key)) continue;
        seen[key] = true;
        uniq.push_back(out[i]);
    }
    return uniq;
}
static void printAEList(const std::vector<AeInstall>& list) {
    if (list.empty()) { std::cout << "   (none found)\n"; return; }
    for (size_t i = 0; i < list.size(); i++)
        std::cout << "   " << (i + 1) << ". " << list[i].label << "\n        " << list[i].exe
                  << "   [" << list[i].via << "]\n";
}
static void stepDetectAE(std::vector<AeInstall>& list) {
    std::cout << "\n[2/7] Detecting installed After Effects (dynamic)\n";
    list = detectAE();
    if (list.empty() && !gSilent) {
        std::cout << "   !  no After Effects found automatically.\n"
                  << "      Type the full path of an After Effects folder that contains AfterFX.exe,\n"
                  << "      or press Enter to continue without AE (daemon/panel still install):\n> ";
        std::string line;
        std::getline(std::cin, line);
        line = trim(line);
        if (!line.empty()) {
            std::string p = line;
            std::replace(p.begin(), p.end(), '/', '\\');
            while (p.size() > 1 && p[p.size() - 1] == '\\') p.erase(p.size() - 1);
            std::string exe = (lower(p).find("afterfx.exe") == p.size() - 11) ? p : p + "\\AfterFX.exe";
            if (fileExists(exe)) {
                AeInstall ae; ae.label = labelFromPath(exe); ae.exe = exe; ae.via = "manual";
                ae.major = majorFromLabel(ae.label);
                list.push_back(ae);
            } else {
                std::cout << "   !  no AfterFX.exe at that path - continuing anyway.\n";
            }
        }
    }
    printAEList(list);
    std::cout << "   =>  " << list.size() << " After Effects installation"
              << (list.size() == 1 ? "" : "s") << " found\n";
}

// ------------------------------------------------------------------ [3] install CEP panel
static std::string manifestBundleVersion(const std::string& manifestPath) {
    std::ifstream f(manifestPath.c_str(), std::ios::binary);
    if (!f.is_open()) return "";
    std::stringstream ss; ss << f.rdbuf();
    std::string xml = ss.str();
    const std::string k = "ExtensionBundleVersion=\"";
    size_t p = xml.find(k);
    if (p == std::string::npos) return "";
    size_t e = xml.find('"', p + k.size());
    if (e == std::string::npos) return "";
    return xml.substr(p + k.size(), e - (p + k.size()));
}
// widen the AEFT host range floor (e.g. [18.0,99.9] -> [16.0,99.9]) so older detected AE versions load the panel too
static bool patchManifestHostRange(const std::string& manifestPath, int floorVer) {
    std::ifstream f(manifestPath.c_str(), std::ios::binary);
    if (!f.is_open()) return false;
    std::stringstream ss; ss << f.rdbuf();
    std::string xml = ss.str();
    f.close();
    const std::string needle = "Name=\"AEFT\" Version=\"[";
    size_t p = xml.find(needle);
    if (p == std::string::npos) return false;
    size_t endp = xml.find(']', p);
    if (endp == std::string::npos) return false;
    std::string range = xml.substr(p + needle.size(), endp - (p + needle.size()));
    size_t comma = range.find(',');
    if (comma == std::string::npos) return false;
    std::string hi = trim(range.substr(comma + 1));
    if (hi.empty()) return false;
    xml.replace(p, endp - p + 1, needle + std::to_string(floorVer) + ".0," + hi + "]");
    return writeTextFile(manifestPath, xml);
}
static bool stepInstallPanel(const std::vector<AeInstall>& aeList) {
    std::cout << "\n[3/7] Installing CEP panel into every detected After Effects (dynamic)\n";
    if (isProcessRunning("AfterFX.exe"))
        std::cout << "   !  After Effects is RUNNING right now - RESTART AE after the installer finishes so the panel loads\n";
    std::string ext = envStr("APPDATA") + "\\Adobe\\CEP\\extensions";
    std::string dest = ext + "\\" + BUNDLE_ID;
    if (!mkdirs(ext)) { std::cout << "   !! cannot create " << ext << "\n"; return false; }
    removeTree(dest);                                  // old panel gone before the new one lands
    if (!copyDir(gRoot + "\\ae-panel", dest)) {
        std::cout << "   !! failed to copy ae-panel -> " << dest << "\n"; return false;
    }
    if (!fileExists(dest + "\\CSXS\\manifest.xml")) {
        std::cout << "   !! copied panel is incomplete (CSXS/manifest.xml missing)\n"; return false;
    }
    std::cout << "   .  old panel removed + new panel installed:  %APPDATA%\\Adobe\\CEP\\extensions\\" << BUNDLE_ID << "\n";
    std::string bv = manifestBundleVersion(dest + "\\CSXS\\manifest.xml");
    if (!bv.empty()) std::cout << "   .  panel bundle version: " << bv << "\n";
    // adapt the manifest to the DETECTED AE versions: widen host range if any AE older than 18.0 (pre-2021) was found
    int minMajor = 0;
    for (size_t i = 0; i < aeList.size(); i++)
        if (aeList[i].major >= 14 && (minMajor == 0 || aeList[i].major < minMajor)) minMajor = aeList[i].major;
    if (minMajor > 0 && minMajor < 18) {
        if (patchManifestHostRange(dest + "\\CSXS\\manifest.xml", 16))
            std::cout << "   .  host range widened to [16.0,...] - a pre-2021 AE (v" << minMajor << ".x) was detected\n";
    }
    for (int v = 9; v <= 14; v++)
        regSetStr(HKEY_CURRENT_USER, "Software\\Adobe\\CSXS." + std::to_string(v), "PlayerDebugMode", "1");
    std::cout << "   .  PlayerDebugMode enabled for CSXS 9-14 (unsigned panel loading)\n";
    for (size_t i = 0; i < aeList.size(); i++)
        std::cout << "   .  will appear in: " << aeList[i].label
                  << (aeList[i].major > 0 ? "  (v" + std::to_string(aeList[i].major) + ".x, host range OK)" : "")
                  << "  ->  Window > Extensions > After Effect Supreme MCP\n";
    if (aeList.empty())
        std::cout << "   .  no AE detected - panel installed for any AE installed later (re-run the installer after installing AE)\n";
    std::cout << "   OK  panel installed\n";
    return true;
}

// ------------------------------------------------------------------ [4] node.js
static bool nodeVersionOk(const std::string& nodeExe, std::string* verOut = nullptr) {
    std::string out = runCapture(nodeExe, "--version", "", 10000);
    size_t p = out.find('v');
    if (p == std::string::npos) return false;
    int major = atoi(out.c_str() + p + 1);
    if (verOut) { std::string v = trim(out.substr(p)); if (!v.empty() && v.size() < 16) *verOut = v; }
    return major >= 18;
}
static std::string findNpmFor(const std::string& nodeExe) {
    std::string dir = nodeExe;
    size_t slash = dir.find_last_of("\\/");
    if (slash != std::string::npos) dir = dir.substr(0, slash);
    std::string npm = dir + "\\npm.cmd";
    if (fileExists(npm)) return npm;
    char found[MAX_PATH];
    if (SearchPathA(nullptr, "npm.cmd", nullptr, MAX_PATH, found, nullptr)) return std::string(found);
    return "";
}
static bool findNode() {
    std::string ver;
    char found[MAX_PATH];
    if (SearchPathA(nullptr, "node.exe", nullptr, MAX_PATH, found, nullptr) &&
        nodeVersionOk(found, &ver)) { gNode = found; gNpm = findNpmFor(gNode); return true; }
    std::string dirs[] = {
        envStr("ProgramFiles") + "\\nodejs\\node.exe",
        envStr("ProgramFiles(x86)") + "\\nodejs\\node.exe",
        envStr("LocalAppData") + "\\Programs\\nodejs\\node.exe",
        envStr("APPDATA") + "\\nvm\\current\\node.exe",
        ""
    };
    for (int i = 0; !dirs[i].empty(); i++)
        if (fileExists(dirs[i]) && nodeVersionOk(dirs[i], &ver)) { gNode = dirs[i]; gNpm = findNpmFor(gNode); return true; }
    return false;
}
static bool stepEnsureNode() {
    std::cout << "\n[4/7] Checking Node.js (>= 18 required)\n";
    std::string ver;
    if (findNode()) {
        std::cout << "   .  node " << ver << "  at  " << gNode << "\n   OK  Node.js ready\n";
        return true;
    }
    std::cout << "   !  Node.js 18+ not found\n";
    bool install = gSilent;
    if (!gSilent) {
        std::cout << "      Install Node.js LTS automatically with winget now? [Y/n]: ";
        std::string ans; std::getline(std::cin, ans);
        install = ans.empty() || ans == "y" || ans == "Y" || ans == "yes";
    }
    if (install) {
        char found[MAX_PATH];
        if (SearchPathA(nullptr, "winget.exe", nullptr, MAX_PATH, found, nullptr)) {
            std::cout << "   .  running winget (this can take a few minutes)...\n";
            int rc = runConsole("winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements "
                                "--accept-source-agreements --disable-interactivity", "", 600000);
            if (rc == 0 && findNode()) {
                ver.clear(); nodeVersionOk(gNode, &ver);
                std::cout << "   OK  Node.js " << ver << " installed via winget\n";
                return true;
            }
            std::cout << "   !  winget install failed or Node still not found\n";
        } else {
            std::cout << "   !  winget not available on this system\n";
        }
    }
    std::cout << "   !! Install Node.js LTS from https://nodejs.org and run the installer again.\n";
    return false;
}

// ------------------------------------------------------------------ [5] build only when needed
static bool stepEnsureBuilt() {
    std::cout << "\n[5/7] Checking build (npm install / build run only when missing or outdated)\n";
    if (!fileExists(gRoot + "\\node_modules\\ws\\package.json") ||
        !fileExists(gRoot + "\\node_modules\\@modelcontextprotocol\\sdk\\package.json")) {
        std::cout << "   .  node_modules missing -> running: npm install  (first time only, a few minutes)\n";
        if (gNpm.empty()) { std::cout << "   !! npm.cmd not found next to node\n"; return false; }
        int rc = runConsole("cmd.exe /d /c cd /d \"" + gRoot + "\" && \"" + gNpm +
                            "\" install --no-audit --no-fund --loglevel=error", gRoot);
        if (rc != 0) { std::cout << "   !! npm install failed (exit " << rc << ")\n"; return false; }
        std::cout << "   OK  dependencies installed\n";
    } else {
        std::cout << "   .  node_modules OK\n";
    }
    std::string daemon = gRoot + "\\build\\daemon.js";
    FILETIME srcT = newestSourceTime();
    FILETIME outT;
    bool need = !getFileTime(daemon, &outT) || cmpFileTime(srcT, outT) > 0;
    if (need) {
        std::cout << "   .  build/daemon.js missing or sources changed -> running: npm run build\n";
        if (gNpm.empty()) { std::cout << "   !! npm.cmd not found next to node\n"; return false; }
        int rc = runConsole("cmd.exe /d /c cd /d \"" + gRoot + "\" && \"" + gNpm +
                            "\" run build --loglevel=error", gRoot);
        if (rc != 0) {
            if (fileExists(daemon)) {
                std::cout << "   !  build failed (exit " << rc << ") - continuing with the existing bundle\n";
            } else {
                std::cout << "   !! npm run build failed (exit " << rc << ") and no bundle exists\n";
                return false;
            }
        } else {
            std::cout << "   OK  build/daemon.js fresh\n";
        }
    } else {
        std::cout << "   .  build/daemon.js up to date - nothing to build\n";
    }
    return fileExists(daemon);
}

// ------------------------------------------------------------------ [6] watchdog + autostart
static std::string makeWatchdogVbs() {
    std::string rt = runtimeDir();
    std::string v = R"VBS(' After Effect Supreme MCP - watchdog
' Keeps build\daemon.js alive; exits when stop.flag appears.
Option Explicit
Dim sh, fso, basePath, rootDir, nodeExe, logFile, port
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
basePath = "@BASE@"
rootDir  = "@ROOT@"
nodeExe  = "@NODE@"
port     = "@PORT@"
logFile  = basePath & "\daemon.log"

Function Healthy()
  On Error Resume Next
  Err.Clear
  Dim h
  Set h = CreateObject("MSXML2.ServerXMLHTTP")
  h.Open "GET", "http://127.0.0.1:" & port & "/api/state", False
  h.Send
  If Err.Number <> 0 Then
    Healthy = False
  Else
    Healthy = (h.Status = 200)
  End If
  On Error GoTo 0
End Function

Sub StartDaemon()
  Dim cmd
  cmd = """" & nodeExe & """ """ & rootDir & "\build\daemon.js"" >> """ & logFile & """ 2>&1"
  sh.Run "cmd.exe /d /c " & cmd, 0, False
End Sub

Dim i
For i = 1 To 200000
  If fso.FileExists(basePath & "\stop.flag") Then
    On Error Resume Next
    Err.Clear
    Dim h2
    Set h2 = CreateObject("MSXML2.ServerXMLHTTP")
    h2.Open "POST", "http://127.0.0.1:" & port & "/api/shutdown", False
    h2.Send
    On Error GoTo 0
    WScript.Quit 0
  End If
  If Not Healthy() Then StartDaemon()
  WScript.Sleep 5000
Next
)VBS";
    auto rep = [&](const std::string& token, const std::string& val) {
        size_t p;
        while ((p = v.find(token)) != std::string::npos) v.replace(p, token.size(), val);
    };
    rep("@BASE@", rt);
    rep("@ROOT@", gRoot);
    rep("@NODE@", gNode);
    rep("@PORT@", std::to_string(gPort));
    return v;
}
static void stepInstallWatchdog() {
    std::cout << "\n[6/7] Installing watchdog + autostart (HKCU only, no admin)\n";
    std::string rt = runtimeDir();
    mkdirs(rt);
    std::string vbs = rt + "\\watchdog.vbs";
    writeTextFile(vbs, makeWatchdogVbs());
    std::string runVal = "wscript.exe \"" + vbs + "\" //B";
    regSetStr(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Run", RUN_KEY_NAME, runVal);
    std::cout << "   .  watchdog:    " << vbs << "\n";
    std::cout << "   .  autostart:   HKCU\\...\\Run\\" << RUN_KEY_NAME << "\n";
    // autostart is armed now: release the brake so the watchdog may start the
    // daemon again (next logon, or right away in step 7).
    DeleteFileA((rt + "\\stop.flag").c_str());
    std::cout << "   OK  autostart ready\n";
}

// ------------------------------------------------------------------ [7] start daemon
static bool startDaemonProcess() {
    std::string rt = runtimeDir();
    mkdirs(rt);
    DeleteFileA((rt + "\\stop.flag").c_str());        // release the watchdog brake
    if (gPort != DEFAULT_PORT) {
        char buf[32];
        sprintf(buf, "%d", gPort);
        SetEnvironmentVariableA("AE_MCP_PORT", buf);
    }
    SECURITY_ATTRIBUTES sa{ sizeof(sa), nullptr, TRUE };
    HANDLE logf = CreateFileA((rt + "\\daemon.log").c_str(), FILE_APPEND_DATA,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.wShowWindow = SW_HIDE;
    if (logf != INVALID_HANDLE_VALUE) {
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = logf;
        si.hStdError  = logf;
    }
    std::string cl = "\"" + gNode + "\" \"" + gRoot + "\\build\\daemon.js\"";
    std::vector<char> buf(cl.begin(), cl.end()); buf.push_back(0);
    PROCESS_INFORMATION pi{};
    DWORD flags = CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB;
    BOOL ok = CreateProcessA(nullptr, buf.data(), nullptr, nullptr, TRUE, flags, nullptr,
                             gRoot.c_str(), &si, &pi);
    if (!ok) {
        flags = CREATE_NO_WINDOW;      // not job-controlled: retry without breakaway
        ok = CreateProcessA(nullptr, buf.data(), nullptr, nullptr, TRUE, flags, nullptr,
                            gRoot.c_str(), &si, &pi);
    }
    if (logf != INVALID_HANDLE_VALUE) CloseHandle(logf);
    if (!ok) return false;
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return true;
}
static bool stepStartDaemon() {
    std::cout << "\n[7/7] Starting daemon and verifying health\n";
    if (daemonHealthy()) {
        std::cout << "   .  daemon already running and healthy\n";
    } else {
        if (!startDaemonProcess()) { std::cout << "   !! could not spawn node (is Node installed?)\n"; return false; }
        bool up = false;
        for (int i = 0; i < 40; i++) {           // up to 20 s
            Sleep(500);
            if (daemonHealthy()) { up = true; break; }
        }
        if (!up) {
            std::cout << "   !! daemon did not become healthy on port " << gPort << "\n";
            std::string tail = readTail(runtimeDir() + "\\daemon.log", 1200);
            if (!tail.empty()) std::cout << "   ---- last log lines ----\n" << tail << "\n   ------------------------\n";
            return false;
        }
        std::cout << "   .  daemon started (node build/daemon.js)\n";
    }
    // watchdog guard process for this session (also restarted at every logon)
    std::string vbs = runtimeDir() + "\\watchdog.vbs";
    if (fileExists(vbs)) runHidden("wscript.exe", "\"" + vbs + "\" //B");
    std::cout << "   OK  daemon is UP  ->  http://127.0.0.1:" << gPort << "\n";
    return true;
}

// ------------------------------------------------------------------ project root
static bool looksLikeRoot(const std::string& p) {
    return fileExists(p + "\\package.json") && fileExists(p + "\\ae-panel\\CSXS\\manifest.xml");
}
static bool findRoot() {
    char exePath[MAX_PATH] = { 0 };
    GetModuleFileNameA(nullptr, exePath, MAX_PATH);
    std::string dir = exePath;
    for (int up = 0; up < 5; up++) {
        size_t slash = dir.find_last_of("\\/");
        if (slash == std::string::npos) break;
        dir = dir.substr(0, slash);
        if (looksLikeRoot(dir)) { gRoot = dir; return true; }
    }
    char cwd[MAX_PATH] = { 0 };
    if (GetCurrentDirectoryA(MAX_PATH, cwd)) {
        std::string d = cwd;
        for (int up = 0; up < 5; up++) {
            if (looksLikeRoot(d)) { gRoot = d; return true; }
            size_t slash = d.find_last_of("\\/");
            if (slash == std::string::npos) break;
            d = d.substr(0, slash);
        }
    }
    return false;
}

// ------------------------------------------------------------------ --list / --status / --uninstall
static int cmdList() {
    std::cout << "After Effects installations detected:\n";
    std::vector<AeInstall> list = detectAE();
    printAEList(list);
    std::cout << "=> " << list.size() << " found\n";
    return 0;
}
static int cmdStatus() {
    std::cout << "Status - " << APP_TITLE << "\n";
    std::cout << "  daemon (127.0.0.1:" << gPort << ") : " << (daemonHealthy() ? "RUNNING" : (portInUse() ? "port busy (foreign)" : "stopped")) << "\n";
    std::string ext = envStr("APPDATA") + "\\Adobe\\CEP\\extensions\\" + BUNDLE_ID;
    std::cout << "  CEP panel                  : " << (fileExists(ext + "\\CSXS\\manifest.xml") ? "installed" : "not installed") << "\n";
    std::cout << "  autostart (HKCU Run)       : " << (regHasValue(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Run", RUN_KEY_NAME) ? "on" : "off") << "\n";
    std::cout << "  watchdog                   : " << (fileExists(runtimeDir() + "\\watchdog.vbs") ? "installed" : "not installed") << "\n";
    std::cout << "  project root               : " << (gRoot.empty() ? std::string("(not found - run next to package.json)") : gRoot) << "\n";
    if (findNode()) {
        std::string ver; nodeVersionOk(gNode, &ver);
        std::cout << "  node                       : " << ver << "  (" << gNode << ")\n";
    } else {
        std::cout << "  node                       : NOT FOUND\n";
    }
    std::vector<AeInstall> list = detectAE();
    std::cout << "  After Effects found        : " << list.size() << "\n";
    printAEList(list);
    return 0;
}
static int cmdUninstall() {
    std::cout << "Uninstalling " << APP_TITLE << " ...\n";
    stepStopAndClean();
    regDelStr(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Run", RUN_KEY_NAME);
    removeTree(runtimeDir());                     // watchdog, stop.flag, daemon.log
    cleanRunEntries();
    std::cout << "  .  runtime folder removed: " << runtimeDir() << "\n";
    std::cout << "  .  PlayerDebugMode keys left untouched (harmless; other panels may use them)\n";
    std::cout << "DONE. Restart After Effects to drop the panel from the Extensions menu.\n";
    return 0;
}

// ------------------------------------------------------------------ main
int main(int argc, char** argv) {
    wsaInit();
    SetConsoleOutputCP(CP_ACP);
    std::vector<std::string> args;
    for (int i = 1; i < argc; i++) args.push_back(argv[i]);
    for (size_t i = 0; i < args.size(); i++) {
        const std::string& a = args[i];
        if (a == "--silent") gSilent = true;
        else if (a == "--port" && i + 1 < args.size()) gPort = atoi(args[++i].c_str());
        else if (a == "--help" || a == "-h" || a == "/?") {
            std::cout <<
                "Supreme-MCP v" << INSTALLER_VER << " - installer / manager for " << APP_TITLE << "\n\n"
                "  (no flag)     clean old install, detect After Effects, install, start daemon\n"
                "  --list        list detected After Effects installations\n"
                "  --status      show daemon / panel / autostart status\n"
                "  --uninstall   stop daemon, remove panel, autostart and runtime files\n"
                "  --no-start    install but do not start the daemon now\n"
                "  --port N      daemon port (default 7654)\n"
                "  --silent      no prompts\n";
            return 0;
        }
    }

    if (!findRoot()) {
        std::cout <<
            "ERROR: could not locate the MCP project folder.\n"
            "Supreme-MCP.exe must sit inside the project folder (next to package.json),\n"
            "or up to 4 levels below it. Expected files: package.json + ae-panel\\CSXS\\manifest.xml\n";
        return 2;
    }

    bool doStatus = false, doList = false, doUninstall = false, doStart = true;
    for (size_t i = 0; i < args.size(); i++) {
        if (args[i] == "--status") doStatus = true;
        if (args[i] == "--list") doList = true;
        if (args[i] == "--uninstall") doUninstall = true;
        if (args[i] == "--no-start") doStart = false;
    }
    if (doList)     return cmdList();
    if (doStatus)   return cmdStatus();
    if (doUninstall)return cmdUninstall();

    std::cout <<
        "=====================================================================\n"
        "  " << APP_TITLE << " - installer v" << INSTALLER_VER << "\n"
        "  project : " << gRoot << "\n" <<
        "=====================================================================\n";

    std::vector<AeInstall> aeList;
    stepStopAndClean();                       // [1] clean old install
    stepDetectAE(aeList);                     // [2] dynamic AE detection
    if (!stepInstallPanel(aeList)) return 3;  // [3] CEP panel for every AE
    if (!stepEnsureNode()) return 4;          // [4] node >= 18
    if (!stepEnsureBuilt()) return 5;         // [5] npm install/build only when needed
    stepInstallWatchdog();                    // [6] watchdog + autostart

    if (doStart) {
        if (!stepStartDaemon()) return 6;     // [7] start + health check
        std::cout <<
            "\n=====================================================================\n"
            "  DONE - " << APP_TITLE << " is running\n\n"
            "  MCP endpoint : http://127.0.0.1:" << gPort << "/mcp\n"
            "  Dashboard    : http://127.0.0.1:" << gPort << "\n"
            "  Panel in AE  : Window > Extensions > After Effect Supreme MCP\n"
            "  Daemon log   : " << runtimeDir() << "\\daemon.log\n"
            "  Stop daemon  : run  Supreme-MCP.exe --uninstall  (or delete stop.flag)\n"
            << (isProcessRunning("AfterFX.exe")
                ? "  NOTE         : After Effects is running - RESTART AE to load the panel\n" : "") <<
            "=====================================================================\n"
            "Restart After Effects, then open the panel from the Extensions menu.\n";
    } else {
        std::cout << "\nInstalled. Daemon NOT started (--no-start).\n"
                  << "Start later with: Supreme-MCP.exe  (or just log off/on)\n";
    }
    return 0;
}

