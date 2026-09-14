' Windows: double-click to start with no console window.
' Put a shortcut to this on the Desktop or pin it to the Start menu.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' A missing index must not stop the server: a fresh copy has no backup folder
' yet, and the server is what serves the setup that asks for one.
shell.Run "python -m tools.tgindex", 0, True
shell.Run "python serve.py", 0, False
