#ifndef AppVersion
  #error AppVersion must be supplied by Build-Installer.ps1
#endif
#ifndef PublishDir
  #error PublishDir must be supplied by Build-Installer.ps1
#endif
#ifndef ArtifactDir
  #error ArtifactDir must be supplied by Build-Installer.ps1
#endif

[Setup]
AppId={{A53F4838-7D84-4B92-A9FD-8BF8D66A41AF}
AppName=ScopePilot
AppVersion={#AppVersion}
AppPublisher=umberbyte
AppPublisherURL=https://github.com/umberbyte/ScopePilot
AppSupportURL=https://github.com/umberbyte/ScopePilot/issues
DefaultDirName={localappdata}\Programs\ScopePilot
DefaultGroupName=ScopePilot
PrivilegesRequired=lowest
ArchitecturesAllowed={#Architecture}
ArchitecturesInstallIn64BitMode={#Architecture}
MinVersion=10.0.19044
OutputDir={#ArtifactDir}
OutputBaseFilename=ScopePilot-{#AppVersion}-{#Runtime}-Setup
VersionInfoVersion={#AppVersion}.0
Compression=lzma2
SolidCompression=yes
WizardStyle=modern dynamic
WizardSizePercent=120
DisableWelcomePage=no
DisableDirPage=yes
DisableProgramGroupPage=yes
AllowNoIcons=yes
UninstallDisplayIcon={app}\ScopePilot.exe
UninstallDisplayName=ScopePilot
SetupLogging=yes
AppMutex=Local\ScopePilot.Application
CloseApplications=yes
RestartApplications=no
InfoBeforeFile=BeforeInstall.txt
LicenseFile=..\LICENSE
ChangesAssociations=no
ChangesEnvironment=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Tasks]
Name: "desktopicon"; Description: "デスクトップにショートカットを作成する"; Flags: unchecked

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "FirstRun.html"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\ScopePilot"; Filename: "{app}\ScopePilot.exe"; WorkingDir: "{app}"
Name: "{group}\初回セットアップガイド"; Filename: "{app}\FirstRun.html"
Name: "{autodesktop}\ScopePilot"; Filename: "{app}\ScopePilot.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\FirstRun.html"; Description: "初回セットアップガイドを開く"; Flags: postinstall shellexec skipifsilent
Filename: "{app}\ScopePilot.exe"; Description: "ScopePilotを起動する"; Flags: postinstall nowait skipifsilent unchecked

; Do not add recursive uninstall deletions: project data and Codex settings are user-owned.

[Code]
function InitializeSetup(): Boolean;
var
  ExistingDir: String;
  ExistingMS, ExistingLS: Cardinal;
begin
  Result := True;
  if RegQueryStringValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{A53F4838-7D84-4B92-A9FD-8BF8D66A41AF}_is1',
    'Inno Setup: App Path', ExistingDir) then
  begin
    if GetVersionNumbers(ExistingDir + '\ScopePilot.dll', ExistingMS, ExistingLS) then
    begin
      if (ExistingMS > {#VersionMS}) or
         ((ExistingMS = {#VersionMS}) and (ExistingLS > {#VersionLS})) then
      begin
        SuppressibleMsgBox('より新しいScopePilotがインストールされています。古い版への上書きはできません。', mbError, MB_OK, IDOK);
        Result := False;
      end;
    end;
  end;
end;
