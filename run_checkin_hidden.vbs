' ============================================================
'  run_checkin_hidden.vbs  --  silent launcher for run_checkin.cmd
'
'  Why this file exists:
'    When a scheduled task runs a .cmd with LogonType=InteractiveToken,
'    Windows pops up a console window. If that window is closed (by
'    accident or by session teardown), the whole process tree is killed
'    with exit code 3221225786 (0xC000013A = STATUS_CONTROL_C_EXIT) and
'    the script loses ALL of its output. Running it through this wrapper
'    hides the window completely, so there is nothing to close.
'
'  How it is wired up:
'    Scheduled task action -> wscript.exe "<this file>"
'    Do NOT point the task at this file directly; it must be run by
'    wscript.exe (the Windows Script Host GUI host).
'
'  Exit code:
'    The exit code of run_checkin.cmd is propagated unchanged
'    (0 = all platforms checked in successfully).
'
'  ASCII-only on purpose: the parent folder name is non-ASCII, and
'  VBScript would mis-decode a non-ANSI source file. The real path is
'  therefore never hardcoded - it is derived from ScriptFullName.
' ============================================================
Option Explicit

Dim fso, sh, baseDir, target, rc

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
target  = fso.BuildPath(baseDir, "run_checkin.cmd")

If Not fso.FileExists(target) Then
  ' Nothing we can do silently; fall back to a visible error.
  WScript.Echo "[ERROR] run_checkin.cmd not found at: " & target
  WScript.Quit 127
End If

' 2nd arg = 0    -> hidden window (no console is ever created)
' 3rd arg = True -> wait for completion, so the scheduled task stays in
'                   "Running" state until node exits and the exit code
'                   reflects what actually happened.
rc = sh.Run("""" & target & """", 0, True)

WScript.Quit rc
