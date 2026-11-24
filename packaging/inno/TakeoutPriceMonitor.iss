; 三平台比价工具 Windows 安装包。模型不在安装包里，启动器首次运行时从 GitHub Release 下载。
#define MyAppName "三平台比价工具"
#define MyAppVersion "0.5.0"
#define MyAppPublisher "Takeout Price Monitor"
#define MyAppExeName "TakeoutPriceMonitor.exe"

[Setup]
AppId={{8E6B7C4A-6D2F-4C7B-9D5E-3A1F0C8B2D64}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName=D:\TakeoutPriceMonitor
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=no
OutputDir=..\..\dist-release\installer
OutputBaseFilename=TakeoutPriceMonitor-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Files]
Source: "..\..\dist-release\app\TakeoutPriceMonitor\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "model\*,data\*"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动{#MyAppName}"; Flags: nowait postinstall skipifsilent
