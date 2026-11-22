using System.Runtime.InteropServices;

namespace VRCNext.Services.Helpers;

// WebKitGTK sizes its caches for a web browser unless told otherwise: the largest memory cache, with up to half of it
// holding pictures and files no page shows anymore. HapsHub is one long-lived page whose lists swap pictures in and
// out, so the "document browser" model keeps what's on screen and lets WebKit let go of the rest sooner.
// The photino.cacheModel setting asks for the same thing, but the Photino.Native that Linux uses ignores it, so it's
// set here through WebKit itself. GTK isn't thread-safe: call this on the window's thread.
internal static class LinuxWebKit
{
    private const string WebKitLib = "libwebkit2gtk-4.1.so.0";
    private const int CacheModelDocumentBrowser = 2;   // WEBKIT_CACHE_MODEL_DOCUMENT_BROWSER

    [DllImport(WebKitLib)] private static extern IntPtr webkit_web_context_get_default();
    [DllImport(WebKitLib)] private static extern void webkit_web_context_set_cache_model(IntPtr context, int model);

    public static void UseDocumentBrowserCache()
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            var context = webkit_web_context_get_default();
            if (context != IntPtr.Zero) webkit_web_context_set_cache_model(context, CacheModelDocumentBrowser);
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            CrashHandler.WriteEntry("LinuxWebKit.UseDocumentBrowserCache", ex);
        }
    }
}
