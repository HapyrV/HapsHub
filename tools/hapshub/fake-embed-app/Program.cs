// A window that draws a few colours and writes what state it's in to the file named by FAKE_EMBED_STATUS,
// so a test can see what HapsHub did to it: held in a pane, minimized, closed or left alone.
// Writing "maximize" to the file named by FAKE_EMBED_COMMAND makes it maximize itself, the way OyasumiVR does on a
// double-click on its title bar.

using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;

internal static class Program
{
    [DllImport("user32.dll")] private static extern nint GetParent(nint window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(nint window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint window, int command);

    [STAThread]
    private static void Main()
    {
        var statusPath = Environment.GetEnvironmentVariable("FAKE_EMBED_STATUS");
        var commandPath = Environment.GetEnvironmentVariable("FAKE_EMBED_COMMAND");
        Application.EnableVisualStyles();
        var form = new Form { Text = "OVR Toolkit (test stand-in)", Width = 900, Height = 600, StartPosition = FormStartPosition.Manual, Left = 60, Top = 60 };
        form.Paint += (_, e) =>
        {
            var colours = new[] { Color.Crimson, Color.SeaGreen, Color.RoyalBlue, Color.Goldenrod };
            var w = Math.Max(1, form.ClientSize.Width / 2);
            var h = Math.Max(1, form.ClientSize.Height / 2);
            for (var i = 0; i < 4; i++)
                using (var brush = new SolidBrush(colours[i])) e.Graphics.FillRectangle(brush, i % 2 * w, i / 2 * h, w, h);
        };
        form.Resize += (_, _) => form.Invalidate();

        var maximizedOnce = false;
        void Write(bool closed)
        {
            if (string.IsNullOrEmpty(statusPath)) return;
            try
            {
                var handle = closed ? 0 : form.Handle;
                var json = JsonSerializer.Serialize(new
                {
                    pid = Environment.ProcessId,
                    closed,
                    held = !closed && GetParent(handle) != 0,
                    visible = !closed && IsWindowVisible(handle),
                    minimized = !closed && IsIconic(handle),
                    maximized = !closed && IsZoomed(handle),
                    // Sticky: HapsHub may undo the maximize before the next status write.
                    wasMaximized = maximizedOnce,
                    width = closed ? 0 : form.Width,
                    height = closed ? 0 : form.Height,
                    time = DateTime.UtcNow.ToString("O"),
                });
                var temp = statusPath + ".tmp";
                File.WriteAllText(temp, json);
                File.Move(temp, statusPath, true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        var timer = new System.Windows.Forms.Timer { Interval = 100 };
        timer.Tick += (_, _) =>
        {
            if (!string.IsNullOrEmpty(commandPath) && File.Exists(commandPath))
            {
                try
                {
                    var command = File.ReadAllText(commandPath).Trim();
                    File.Delete(commandPath);
                    if (command == "maximize") { ShowWindow(form.Handle, 3); maximizedOnce = IsZoomed(form.Handle); } // SW_MAXIMIZE
                }
                catch (IOException) { }
            }
            Write(false);
        };
        timer.Start();
        form.FormClosed += (_, _) => { timer.Stop(); Write(true); };
        Application.Run(form);
    }
}
