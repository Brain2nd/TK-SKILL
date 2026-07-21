using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace LoopCreatorOs
{
    internal static class Program
    {
        private const string AppUrl = "http://127.0.0.1:8877/";
        private static Mutex mutex;

        [STAThread]
        private static void Main()
        {
            bool created;
            mutex = new Mutex(true, "LOOP.Creator.OS.MVP.Launcher", out created);
            if (!created)
            {
                OpenUrl();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherContext());
            GC.KeepAlive(mutex);
        }

        internal static void OpenUrl()
        {
            try
            {
                Process.Start(new ProcessStartInfo(AppUrl) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                MessageBox.Show("无法打开工作台：" + error.Message, "LOOP Creator OS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal sealed class LauncherContext : ApplicationContext
    {
        private const string AppUrl = "http://127.0.0.1:8877/";
        private readonly NotifyIcon tray;
        private readonly string uiRoot;
        private readonly string logPath;
        private Control dispatcher;
        private string nodeDirectory;
        private Process service;
        private bool ownsService;
        private bool closing;

        internal LauncherContext()
        {
            uiRoot = FindUiRoot();
            if (uiRoot == null)
            {
                MessageBox.Show("找不到 LOOP MVP 运行文件。请把 EXE 保留在项目的 ui/release 目录中。", "LOOP Creator OS", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ExitThread();
                return;
            }

            string dataDirectory = Path.Combine(uiRoot, "server-data");
            Directory.CreateDirectory(dataDirectory);
            logPath = Path.Combine(dataDirectory, "launcher.log");
            dispatcher = new Control();
            dispatcher.CreateControl();
            IntPtr dispatcherHandle = dispatcher.Handle;

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("打开工作台", null, delegate { Program.OpenUrl(); });
            menu.Items.Add("查看启动日志", null, delegate { OpenLog(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出并停止服务", null, delegate { ExitThread(); });
            tray = new NotifyIcon
            {
                Icon = SystemIcons.Application,
                Text = "LOOP Creator OS 正在启动",
                Visible = true,
                ContextMenuStrip = menu
            };
            tray.DoubleClick += delegate { Program.OpenUrl(); };

            Task.Run((Action)StartOrOpen);
        }

        private static string FindUiRoot()
        {
            DirectoryInfo current = new DirectoryInfo(Path.GetDirectoryName(Application.ExecutablePath));
            for (int depth = 0; current != null && depth < 7; depth++, current = current.Parent)
            {
                if (File.Exists(Path.Combine(current.FullName, "package.json")) &&
                    File.Exists(Path.Combine(current.FullName, "scripts", "start-mvp.mjs"))) return current.FullName;
            }
            return null;
        }

        private void StartOrOpen()
        {
            if (IsHealthy())
            {
                Program.OpenUrl();
                SafeExit();
                return;
            }

            try
            {
                AppendLog("\r\n=== " + DateTime.Now.ToString("s") + " LOOP MVP launcher ===");
                if (!HasSupportedNode())
                    throw new InvalidOperationException("未检测到兼容的 Node.js。请安装 Node.js 22.13 或更高版本后重试。");

                string parent = Directory.GetParent(uiRoot).FullName;
                if (!Directory.Exists(Path.Combine(parent, "node_modules")))
                {
                    ShowBalloon("首次启动", "正在安装核心依赖，请稍候…");
                    RunRequired("npm ci", parent, "核心依赖安装失败");
                }
                if (!Directory.Exists(Path.Combine(uiRoot, "node_modules")))
                {
                    ShowBalloon("首次启动", "正在安装界面依赖，请稍候…");
                    RunRequired("npm ci", uiRoot, "界面依赖安装失败");
                }

                service = StartCommand("npm run mvp", uiRoot);
                ownsService = true;
                DateTime deadline = DateTime.UtcNow.AddMinutes(3);
                while (!closing && DateTime.UtcNow < deadline)
                {
                    if (service.HasExited) throw new InvalidOperationException("MVP 服务启动失败，请查看启动日志。");
                    if (IsHealthy())
                    {
                        SetTrayText("LOOP Creator OS 运行中");
                        ShowBalloon("LOOP Creator OS", "工作台已启动。首次使用请按提示配置邮件池和 API。 ");
                        Program.OpenUrl();
                        return;
                    }
                    Thread.Sleep(1000);
                }
                if (!closing) throw new TimeoutException("工作台启动超时，请查看启动日志。");
            }
            catch (Exception error)
            {
                AppendLog("启动失败：" + error);
                ShowError(error.Message);
                SafeExit();
            }
        }

        private bool HasSupportedNode()
        {
            try
            {
                ProcessStartInfo lookup = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = "node",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (Process process = Process.Start(lookup))
                {
                    string[] candidates = process.StandardOutput.ReadToEnd().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                    process.WaitForExit(15000);
                    foreach (string candidate in candidates)
                    {
                        string directory = Path.GetDirectoryName(candidate.Trim());
                        if (!File.Exists(Path.Combine(directory, "npm.cmd"))) continue;
                        string version;
                        if (!IsCompatibleNode(candidate.Trim(), out version)) continue;
                        nodeDirectory = directory;
                        AppendLog("Node.js " + version + " from " + candidate.Trim());
                        return true;
                    }
                }
            }
            catch { return false; }
            return false;
        }

        private static bool IsCompatibleNode(string executable, out string version)
        {
            version = "";
            try
            {
                ProcessStartInfo start = new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = "--version",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (Process process = Process.Start(start))
                {
                    version = process.StandardOutput.ReadToEnd().Trim().TrimStart('v');
                    process.WaitForExit(15000);
                    string[] parts = version.Split('.');
                    int major = parts.Length > 0 ? Int32.Parse(parts[0]) : 0;
                    int minor = parts.Length > 1 ? Int32.Parse(parts[1]) : 0;
                    return process.ExitCode == 0 && (major > 22 || (major == 22 && minor >= 13));
                }
            }
            catch { return false; }
        }

        private void RunRequired(string command, string workingDirectory, string failure)
        {
            using (Process process = StartCommand(command, workingDirectory))
            {
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException(failure + "，请查看 " + logPath);
            }
        }

        private Process StartCommand(string command, string workingDirectory)
        {
            ProcessStartInfo start = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
                Arguments = "/d /s /c \"" + command + "\"",
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            if (!String.IsNullOrEmpty(nodeDirectory))
                start.EnvironmentVariables["PATH"] = nodeDirectory + ";" + (Environment.GetEnvironmentVariable("PATH") ?? "");
            Process process = new Process { StartInfo = start, EnableRaisingEvents = true };
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog(args.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog(args.Data); };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return process;
        }

        private static bool IsHealthy()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(AppUrl);
                request.Method = "GET";
                request.Timeout = 1200;
                request.AllowAutoRedirect = false;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    return (int)response.StatusCode >= 200 && (int)response.StatusCode < 500;
            }
            catch { return false; }
        }

        private void AppendLog(string line)
        {
            try { lock (this) File.AppendAllText(logPath, line + Environment.NewLine); }
            catch { }
        }

        private void OpenLog()
        {
            try
            {
                if (!File.Exists(logPath)) File.WriteAllText(logPath, "尚无启动日志。" + Environment.NewLine);
                Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true });
            }
            catch (Exception error) { ShowError(error.Message); }
        }

        private void SetTrayText(string value)
        {
            if (tray == null) return;
            if (dispatcher != null && dispatcher.InvokeRequired)
            {
                dispatcher.BeginInvoke((Action)delegate { SetTrayText(value); });
                return;
            }
            try { tray.Text = value.Length > 63 ? value.Substring(0, 63) : value; }
            catch { }
        }

        private void ShowBalloon(string title, string message)
        {
            if (tray == null) return;
            if (dispatcher != null && dispatcher.InvokeRequired)
            {
                dispatcher.BeginInvoke((Action)delegate { ShowBalloon(title, message); });
                return;
            }
            try { tray.ShowBalloonTip(5000, title, message, ToolTipIcon.Info); }
            catch { }
        }

        private void ShowError(string message)
        {
            try
            {
                if (dispatcher != null && dispatcher.InvokeRequired)
                    dispatcher.BeginInvoke((Action)delegate { MessageBox.Show(message, "LOOP Creator OS", MessageBoxButtons.OK, MessageBoxIcon.Error); });
                else MessageBox.Show(message, "LOOP Creator OS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { }
        }

        private void SafeExit()
        {
            try
            {
                if (dispatcher != null && dispatcher.InvokeRequired)
                    dispatcher.BeginInvoke((Action)delegate { ExitThread(); });
                else ExitThread();
            }
            catch { }
        }

        protected override void ExitThreadCore()
        {
            if (closing) return;
            closing = true;
            if (ownsService && service != null && !service.HasExited)
            {
                try
                {
                    Process killer = Process.Start(new ProcessStartInfo
                    {
                        FileName = "taskkill.exe",
                        Arguments = "/PID " + service.Id + " /T /F",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    });
                    if (killer != null) killer.WaitForExit(5000);
                }
                catch { }
            }
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            if (dispatcher != null) { dispatcher.Dispose(); dispatcher = null; }
            base.ExitThreadCore();
        }
    }
}
