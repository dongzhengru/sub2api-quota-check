Option Explicit
Dim shell, files, script, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
script = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "sidebar.ps1")
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """ -Action start -Interactive"
If WScript.Arguments.Count > 0 Then
    If WScript.Arguments(0) = "--print-command" Then
        WScript.Echo command
        WScript.Quit 0
    End If
End If
shell.Run command, 0, False
