// 三平台比价工具启动器：双击后自动启动本地模型和网页服务，常驻托盘。
// 使用 Windows 自带的 .NET Framework 编译：csc /target:winexe /out:TakeoutPriceMonitor.exe Launcher.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    static readonly int AppPort = 4318;
    static readonly int ModelPort = 11436;
    static readonly string DataDir = Environment.GetEnvironmentVariable("TAKEOUT_DATA_DIR") ?? Path.Combine(Root, "data");
    static readonly string LogDir = Path.Combine(DataDir, "logs");
    static Process model, server;
    static NotifyIcon tray;
    static Mutex single;
    static bool exiting;

    [STAThread]
    static void Main()
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        bool created;
        single = new Mutex(true, "TakeoutPriceMonitorLauncher", out created);
        if (!created) { MessageBox.Show("工具已经在运行，请查看右下角托盘图标。", "三平台比价工具"); return; }
        Directory.CreateDirectory(LogDir);
        string tempDir = Path.Combine(DataDir, "tmp");
        Directory.CreateDirectory(tempDir);
        Environment.SetEnvironmentVariable("TEMP", tempDir);
        Environment.SetEnvironmentVariable("TMP", tempDir);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        CreateTray();
        try
        {
            EnsureModel();
            StartAll();
        }
        catch (Exception e)
        {
            Log("启动失败: " + e);
            MessageBox.Show("工具启动失败，日志已写入：" + LogDir + "\n\n" + e.Message, "三平台比价工具");
            OpenBrowser("/setup");
        }
        Application.Run();
    }

    static void CreateTray()
    {
        tray = new NotifyIcon();
        tray.Icon = SystemIcons.Application;
        tray.Text = "三平台比价工具";
        tray.Visible = true;
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开工具", null, delegate { OpenBrowser("/bd"); });
        menu.Items.Add("打开设置", null, delegate { OpenBrowser("/setup"); });
        menu.Items.Add("重新启动服务", null, delegate { Restart(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, delegate { ExitAll(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenBrowser("/bd"); };
    }

    static void StartAll()
    {
        if (!PortOpen(AppPort)) {
            if (PortOpen(ModelPort)) Log("模型端口已存在，复用当前模型进程");
            else StartModel();
            Wait("模型服务", ModelPort, 120000);
            StartServer();
            Wait("工具服务", AppPort, 60000);
        } else if (!PortOpen(ModelPort)) {
            StartModel();
        }
        string setup = Path.Combine(DataDir, "setup.json");
        bool done = File.Exists(setup) && File.ReadAllText(setup).IndexOf("\"completed\":true", StringComparison.Ordinal) >= 0;
        OpenBrowser(done ? "/bd" : "/setup");
            tray.ShowBalloonTip(3000, "三平台比价工具", done ? "工具已启动" : "首次使用，请按设置向导完成配置", ToolTipIcon.Info);
    }

    const string ReleaseBase = "https://github.com/lny-cookiie/takeout-price-monitor/releases/latest/download/";

    // 安装包不带模型，第一次启动时从 GitHub Release 下载；下载量约 2.3GB。
    static void EnsureModel()
    {
        string dir = Path.Combine(Root, "model");
        Directory.CreateDirectory(dir);
        string gguf = Path.Combine(dir, "Qwen3-VL-2B-Instruct-Q8_0.gguf");
        string mmproj = Path.Combine(dir, "mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf");
        string server = Path.Combine(dir, "vulkan", "llama-server.exe");
        string key = Path.Combine(dir, "api-key");
        if (!File.Exists(gguf)) DownloadAsset("Qwen3-VL-2B-Instruct-Q8_0.gguf", gguf, "模型主文件");
        if (!File.Exists(mmproj)) DownloadAsset("mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf", mmproj, "视觉模型文件");
        if (!File.Exists(server))
        {
            string zip = Path.Combine(dir, "llama-vulkan.zip");
            DownloadAsset("llama-vulkan.zip", zip, "模型运行程序");
            ZipFile.ExtractToDirectory(zip, dir);
            try { File.Delete(zip); } catch { }
        }
        if (!File.Exists(key)) File.WriteAllText(key, Guid.NewGuid().ToString("N"), new UTF8Encoding(false));
    }

    static void DownloadAsset(string name, string target, string label)
    {
        string url = ReleaseBase + name;
        string curl = Path.Combine(Environment.SystemDirectory, "curl.exe");
        using (var form = new Form())
        using (var text = new Label())
        using (var bar = new ProgressBar())
        {
            form.Text = "三平台比价工具 · 首次准备";
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.MinimizeBox = false;
            form.MaximizeBox = false;
            form.TopMost = true;
            form.Width = 500;
            form.Height = 155;
            text.Text = "正在从 GitHub 下载" + label + "，请保持网络连接…";
            text.Left = 20; text.Top = 16; text.Width = 450; text.Height = 46;
            bar.Left = 20; bar.Top = 70; bar.Width = 450; bar.Height = 20;
            bar.Style = ProgressBarStyle.Marquee;
            form.Controls.Add(text); form.Controls.Add(bar);
            form.Show();
            var psi = new ProcessStartInfo(curl, "-L --fail --retry 3 --silent --show-error --output \"" + target + "\" \"" + url + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            var p = Process.Start(psi);
            var started = DateTime.UtcNow;
            while (!p.HasExited)
            {
                Application.DoEvents();
                try
                {
                    var downloaded = new FileInfo(target).Length / (1024 * 1024);
                    text.Text = "正在从 GitHub 下载" + label + "（已下载 " + downloaded + " MB），请保持网络连接…";
                }
                catch { }
                if ((DateTime.UtcNow - started).TotalMinutes > 90)
                {
                    try { p.Kill(); } catch { }
                    form.Close();
                    throw new Exception("从 GitHub 下载" + label + "超过 90 分钟仍未完成，请检查网络后重试。");
                }
                Thread.Sleep(300);
            }
            form.Close();
            if (p.ExitCode != 0) throw new Exception("从 GitHub 下载" + label + "失败，curl 退出码 " + p.ExitCode + "。地址：" + url);
        }
    }
    static void StartModel()
    {
        string exe = Path.Combine(Root, "model", "vulkan", "llama-server.exe");
        string gguf = Path.Combine(Root, "model", "Qwen3-VL-2B-Instruct-Q8_0.gguf");
        string mmproj = Path.Combine(Root, "model", "mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf");
        string keyFile = Path.Combine(Root, "model", "api-key");
        if (!File.Exists(exe) || !File.Exists(gguf) || !File.Exists(mmproj) || !File.Exists(keyFile))
            throw new FileNotFoundException("安装目录里的模型文件不完整，请重新安装完整版安装包。");
        string args = string.Format("-m \"{0}\" --mmproj \"{1}\" --host 127.0.0.1 --port {2} --alias qwen3-vl-2b-local --ctx-size 16384 --gpu-layers 99 --parallel 2 --api-key-file \"{3}\" --no-ui", gguf, mmproj, ModelPort, keyFile);
        model = StartLogged(exe, args, "model");
    }

    static void StartServer()
    {
        string node = Path.Combine(Root, "runtime", "node.exe");
        string main = Path.Combine(Root, "dist", "main.js");
        if (!File.Exists(node) || !File.Exists(main)) throw new FileNotFoundException("安装目录里的运行环境不完整，请重新安装。");
        Environment.SetEnvironmentVariable("DATA_DIR", DataDir);
        Environment.SetEnvironmentVariable("PORT", AppPort.ToString());
        Environment.SetEnvironmentVariable("MIDSCENE_ADB_PATH", Path.Combine(Root, "tools", "adb", "adb.exe"));
        Environment.SetEnvironmentVariable("TAKEOUT_MODEL_BASE_URL", "http://127.0.0.1:" + ModelPort + "/v1");
        Environment.SetEnvironmentVariable("TAKEOUT_MODEL_NAME", "qwen3-vl-2b-local");
        Environment.SetEnvironmentVariable("TAKEOUT_MODEL_FAMILY", "qwen3-vl");
        Environment.SetEnvironmentVariable("TAKEOUT_MODEL_STRUCTURED_OUTPUT", "json_object");
        string keyFile = Path.Combine(Root, "model", "api-key");
        if (File.Exists(keyFile)) Environment.SetEnvironmentVariable("TAKEOUT_MODEL_API_KEY", File.ReadAllText(keyFile).Trim());
        server = StartLogged(node, "\"" + main + "\"", "server");
    }

    static Process StartLogged(string exe, string args, string name)
    {
        var psi = new ProcessStartInfo(exe, args);
        psi.WorkingDirectory = Root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        var p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[" + name + "] " + e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[" + name + ":err] " + e.Data); };
        p.EnableRaisingEvents = true;
        p.Exited += delegate(object s, EventArgs e) { Log("[" + name + "] 进程退出 code=" + p.ExitCode); };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        Log("已启动 " + name + " pid=" + p.Id + " TEMP=" + Environment.GetEnvironmentVariable("TEMP"));
        return p;
    }

    static void Wait(string label, int port, int timeoutMs)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (PortOpen(port)) return;
            Thread.Sleep(500);
        }
        throw new TimeoutException(label + "没有在 " + (timeoutMs / 1000) + " 秒内就绪，请查看日志：" + LogDir);
    }

    static bool PortOpen(int port)
    {
        try { using (var c = new TcpClient()) { var t = c.ConnectAsync("127.0.0.1", port); if (!t.Wait(700)) return false; return c.Connected; } }
        catch { return false; }
    }

    static void OpenBrowser(string path)
    {
        string url = "http://127.0.0.1:" + AppPort + path;
        string edge = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
        if (!File.Exists(edge)) edge = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
        try
        {
            if (File.Exists(edge)) Process.Start(edge, "--app=" + url + " --window-size=1440,980");
            else Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch { try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception e) { Log("打开浏览器失败: " + e.Message); } }
    }

    static void Restart()
    {
        try { StopProcess(server); StopProcess(model); } catch (Exception e) { Log("停止旧进程失败: " + e.Message); }
        try { StartAll(); } catch (Exception e) { MessageBox.Show("重新启动失败：" + e.Message); }
    }

    static void StopProcess(Process p)
    {
        try { if (p != null && !p.HasExited) { p.Kill(); p.WaitForExit(5000); } } catch { }
        p = null;
    }

    static void ExitAll()
    {
        if (exiting) return;
        exiting = true;
        tray.Visible = false;
        StopProcess(server);
        StopProcess(model);
        Application.Exit();
    }

    static void Log(string line)
    {
        try { File.AppendAllText(Path.Combine(LogDir, "launcher.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine, Encoding.UTF8); } catch { }
    }
}
