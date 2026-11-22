namespace VRCNext;

public static class AppInfo
{
    public const string AppName = HubPaths.AppName;
    /// <summary>HapsHub's own version. The VRCNext release it's built on is HubRelease.UpstreamVersion.</summary>
    public const string Version = "1.1.0";
    public const string ContactEmail = "hapyr.businesss@gmail.com";
    public const string UserAgent = $"{AppName}/{Version} ({ContactEmail})";

    public static string SelfExecutable
    {
        get
        {
            var appImage = Environment.GetEnvironmentVariable("APPIMAGE");
            if (!string.IsNullOrEmpty(appImage) && File.Exists(appImage)) return appImage;
            return Environment.ProcessPath ?? "";
        }
    }
}
