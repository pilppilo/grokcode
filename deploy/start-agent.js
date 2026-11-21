// Windows Script Host (JScript). The scheduled task sets the working directory
// to the installed config directory, which contains start-agent.ps1.
var shell = new ActiveXObject("WScript.Shell");
var fs = new ActiveXObject("Scripting.FileSystemObject");
var powershell = fs.GetSpecialFolder(1) + "\\WindowsPowerShell\\v1.0\\powershell.exe";
var command = '"' + powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".\\start-agent.ps1"';
// Wait and forward the exit code so Task Scheduler can supervise restarts.
WScript.Quit(shell.Run(command, 0, true));
