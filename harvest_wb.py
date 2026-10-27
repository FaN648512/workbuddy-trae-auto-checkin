# -*- coding: utf-8 -*-
"""
WorkBuddy 凭证内存收割器（方案 B）

背景：WorkBuddy 客户端自 2026-10-08 起把登录凭证改为加密存储（$wbEncrypted 信封），
      磁盘上再也读不到明文 accessToken。本脚本不尝试破译该加密，而是
      从**正在运行的客户端进程内存**里取出它**自己已经解密好**的 accessToken，
      用只读接口校验后交给签到脚本使用。

安全约定：
  * 全程只读：OpenProcess(PROCESS_VM_READ) + ReadProcessMemory，不写任何目标进程内存。
  * 不打印凭证内容：正常模式只输出一行 JSON 到 stdout；--probe 模式只输出长度与哈希前缀。
  * 不落盘凭证：由调用方（checkin.js）在内存中直接使用。

用法：
  python harvest_wb.py            # 成功 -> stdout 打印一行 JSON，退出码 0
  python harvest_wb.py --probe     # 只报告诊断信息，不输出凭证
"""
import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- Win32 只读接口
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01
READABLE = {0x02, 0x04, 0x08, 0x20, 0x40, 0x80}
MEM_PRIVATE = 0x20000          # 堆 / 栈：凭证实际所在
MEM_IMAGE = 0x1000000          # 可执行映像（DLL/EXE 代码），绝不含凭证


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("a1", wt.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
        ("a2", wt.DWORD),
    ]


JWT = re.compile(rb"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")

VERIFY_URL = "https://copilot.tencent.com/v2/billing/meter/checkin-status"
EXPIRY_URL = "https://copilot.tencent.com/v2/billing/meter/checkin-activity-status"
CTX = ssl.create_default_context()

PROCESS_NAMES = ("WorkBuddy.exe",)
CHUNK = 1 << 20
DEADLINE_SECONDS = 180          # 总扫描时限，避免异常情况下卡死
PER_PROCESS_SECONDS = 60        # 单个进程的扫描上限，防止一个巨无霸吃光总预算
MAX_REGION = 256 << 20          # 单块内存上限


# ---------------------------------------------------------------- 进程发现
def list_processes():
    """返回 [(pid, cmdline)]，主进程优先（命令行不含 --type=）。"""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe'\" | "
             "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
            capture_output=True, text=True, errors="replace", timeout=30,
        ).stdout.strip()
        data = json.loads(out) if out else []
        if isinstance(data, dict):
            data = [data]
    except Exception:
        # 退化到 tasklist（拿不到命令行，按 PID 顺序）
        data = []
        try:
            raw = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WorkBuddy.exe",
                                  "/FO", "CSV", "/NH"], capture_output=True,
                                 text=True, errors="replace", timeout=20).stdout
            for line in raw.splitlines():
                parts = [x.strip('"') for x in line.split('","')]
                if len(parts) >= 2 and parts[0].lower().startswith("workbuddy"):
                    data.append({"ProcessId": int(parts[1]), "CommandLine": ""})
        except Exception:
            pass

    plain, main_like, others = [], [], []
    for row in data:
        pid = row.get("ProcessId")
        cmd = (row.get("CommandLine") or "").strip()
        if not pid:
            continue
        pid = int(pid)
        if "--type=" in cmd:
            others.append(pid)                       # 渲染 / GPU 等子进程
        elif "--" not in cmd and ".js" not in cmd and ".asar" not in cmd:
            plain.append(pid)                        # 纯 exe 启动 = 主进程，凭证最先命中
        else:
            main_like.append(pid)                    # sidecar / daemon / cli-prewarm
    # 实测顺序：主进程最先命中，其次是 daemon-app-server / cli-prewarm，渲染进程没有
    return ([(p, "main") for p in plain]
            + [(p, "sidecar") for p in main_like]
            + [(p, "child") for p in others])


# ---------------------------------------------------------------- 内存扫描
def scan_pid(pid, deadline, which="private", on_candidate=None):
    """只读扫描指定进程，返回 (候选列表, 命中载荷)。

    which:
      "private"    —— 只扫 MEM_PRIVATE 区（凭证实际所在，速度最快）
      "other"      —— 只扫非 PRIVATE 区（兜底：万一将来挪到共享内存）
      "all"        —— 全扫（旧行为，最慢）
    on_candidate: 每发现一个新候选就回调一次；返回非 None 表示已命中，立即停止。
    """
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return [], None
    found = []
    seen = set()
    addr = 0
    mbi = MBI()
    buf = ctypes.create_string_buffer(CHUNK)
    got = ctypes.c_size_t(0)
    try:
        while k32.VirtualQueryEx(handle, ctypes.c_void_p(addr),
                                 ctypes.byref(mbi), ctypes.sizeof(mbi)) == ctypes.sizeof(mbi):
            base = mbi.BaseAddress or 0
            size = mbi.RegionSize
            readable = (
                mbi.State == MEM_COMMIT
                and not (mbi.Protect & PAGE_GUARD)
                and not (mbi.Protect & PAGE_NOACCESS)
                and (mbi.Protect & 0xFF) in READABLE
                and 0 < size <= MAX_REGION
            )
            if which == "private":
                # 关键优化：IMAGE 区（DLL/EXE 代码）实测占 360~380MB 且绝不含凭证，
                # 5.8.3 里主进程正是被这些冷页拖到扫不完。只读堆/栈即可数秒结束。
                readable = readable and mbi.Type == MEM_PRIVATE
            elif which == "other":
                readable = readable and mbi.Type != MEM_PRIVATE
            if readable:
                off = 0
                while off < size:
                    if time.time() > deadline:
                        return found, None
                    n = min(CHUNK, size - off)
                    if k32.ReadProcessMemory(handle, ctypes.c_void_p(base + off),
                                             buf, n, ctypes.byref(got)):
                        data = buf.raw[: got.value]
                        for m in JWT.finditer(data):
                            tok = m.group().decode("ascii", "ignore")
                            if len(tok) >= 60 and tok not in seen:
                                seen.add(tok)
                                found.append(tok)
                                if on_candidate is not None:
                                    hit = on_candidate(tok)
                                    if hit is not None:
                                        return found, hit
                    off += n
            addr = base + size
            if addr <= 0 or addr > (1 << 47):
                break
    finally:
        k32.CloseHandle(handle)
    return found, None


# ---------------------------------------------------------------- 凭证校验
def http_post(url, token, timeout=20):
    body = b"{}"
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "workbuddy-auto-checkin/1.2",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception:
        return -1, ""


def verify(token):
    """用只读的签到状态接口判断该凭证是否有效，返回 (是否有效, 附加信息)。"""
    status, body = http_post(VERIFY_URL, token)
    if status != 200:
        return False, {"http": status}
    try:
        j = json.loads(body)
    except Exception:
        return False, {"http": status, "parse": False}
    if j.get("code") != 0:
        return False, {"http": status, "code": j.get("code")}
    return True, {"today_checked_in": (j.get("data") or {}).get("today_checked_in")}


def probe_expiry(token):
    """尝试拿到活动信息（含结束时间），失败不影响主流程。"""
    status, body = http_post(EXPIRY_URL, token, timeout=12)
    if status != 200:
        return {}
    try:
        j = json.loads(body)
        d = j.get("data") or {}
        return {"end_time": d.get("end_time"), "activity_name": d.get("activity_name")}
    except Exception:
        return {}


# ---------------------------------------------------------------- main
def emit(payload, probe_only):
    """输出结果。probe 模式剔除 token，只给长度与尾号。"""
    if probe_only:
        safe = dict(payload)
        safe.pop("token", None)
        print(json.dumps(safe, ensure_ascii=False))
    else:
        print(json.dumps(payload, ensure_ascii=False))
    return 0


def main():
    probe_only = "--probe" in sys.argv
    deadline = time.time() + DEADLINE_SECONDS
    procs = list_processes()
    if not probe_only:
        sys.stderr.write("[harvest] WorkBuddy 进程: %d 个\n" % len(procs))

    def make_cb(pid, kind):
        def cb(tok):
            ok, info = verify(tok)
            if not probe_only:
                sys.stderr.write("[harvest]   候选 len=%d sha=%s -> %s\n"
                                 % (len(tok), hashlib.sha256(tok.encode()).hexdigest()[:12],
                                    "有效" if ok else "无效"))
            if not ok:
                return None
            payload = {
                "token": tok,
                "pid": pid,
                "kind": kind,
                "source": "memory",
                "harvestedAt": int(time.time() * 1000),
                "tokenLength": len(tok),
                "tokenTail": tok[-6:],
            }
            payload.update(probe_expiry(tok))
            return payload
        return cb

    # 第一轮：只扫 MEM_PRIVATE（堆/栈）。实测 5.8.3 主进程 189MB / 4.8 秒内即可命中。
    # 第二轮：兜底扫非 PRIVATE 区，仅在没命中且还有剩余时间时执行。
    for which in ("private", "other"):
        if which == "other" and deadline - time.time() < 20:
            break
        for pid, kind in procs:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            # 单进程上限，避免一个 700MB+ 的巨无霸进程吃光全部预算
            sub_deadline = min(deadline, time.time() + min(PER_PROCESS_SECONDS, remaining))
            cands, hit = scan_pid(pid, sub_deadline, which, make_cb(pid, kind))
            if not probe_only and cands:
                sys.stderr.write("[harvest] PID %d (%s/%s) 命中 %d 个候选\n"
                                 % (pid, kind, which, len(cands)))
            if hit is not None:
                return emit(hit, probe_only)

    if probe_only:
        print(json.dumps({"error": "no-valid-token", "procs": len(procs)}, ensure_ascii=False))
    else:
        sys.stderr.write("[harvest] 未找到有效凭证\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
